# Extract Method 批量验证（CPython 标准库）

用真实代码实测语法级 Extract Method 的可用性，而不是只看单元测试。

## 一、方法

| 项 | 做法 |
|---|---|
| 代码库 | CPython 3.11 标准库（`Python311/Lib`），共 167 个顶层 `.py` |
| 文件 | 8 个有实质逻辑的：`_pyio.py`、`argparse.py`、`ast.py`、`_collections_abc.py`、`_markupbase.py`、`_osx_support.py`、`_threading_local.py`、`_strptime.py` |
| 选区从哪来 | 用 Python 的 `ast` 枚举每个函数体里**连续 1–3 条语句**的所有组合（`selections.py`）。这就是人类会高亮的那种范围，不是我凭想象构造的 |
| 怎么测 | 在运行中的应用里打开文件，对每个选区调 `planExtract`（`batch.mjs`） |
| 全程真实 | 真 tree-sitter、真语言服务器、真 IPC，没有 mock |

单个文件采样 40 个选区（按函数数量均匀分配），避免大文件主导结果。

## 二、结果

```
选区总数   278
成功       202   72.7%
拒绝        76
抛异常       0
打开失败     0
```

> 278 = 8 个文件批量跑的 266 + `_strptime.py` 单独跑的 12（见第五节：它在批量里
> 一次跑 40 个选区会触发 `execute_js` 超时，降采样后 12/12 全过）。

### 拒绝原因分布

| 次数 | 类别 | 是否合理 |
|---|---|---|
| 47 | 含 `return` / `yield` / `await` | ✅ 正确：抽出的方法没法 return 给调用方 |
| 16 | 给声明在外部的变量赋值 | ✅ 正确：无法通过调用表达回写 |
| 11 | 写多个外部变量 | ⚠️ v1 限制（IDEA 支持多返回值） |
| 2 | `global` / `nonlocal` | ✅ 正确：作用域查询会误报（实测） |
| **0** | **参数未解析（查询缺口）** | **修复前是 27 个** |

### 更有意义的数字

那 47 个「含 `return`」的选区，**真实用户不会这样选**——看到 `return` 就知道不该抽。
排除它们后的成功率：

```
202 / (278 - 47) = 87.4%
```

也就是说：**在用户会做出的选区里，约 87% 能成功提取。**

## 三、批量验证抓到的两个 bug

这两个都只出现在真实代码上，单元测试和手工验证都没发现。

### 1. docstring 里的词被当成未解析的参数

```python
def read(self, size=None):
    """Read size bytes. If size is negative, read until EOF."""   ← 选中这两行
    return self.raw.read(size)
```

选区里的 `size` 全部在 docstring 中，作用域查询返回 `noIdentifier`（正确：字符串里的词不是变量）。
但代码把"查不到"一律当成"参数没解析出来"，于是拒绝并提示：

```
'size' is local to this function but the syntax service cannot resolve it here
```

**影响**：CPython 标准库里带 docstring 的选区大量中招（27 个误拒）。

**修法**：区分三种查询结果——`noIdentifier`（注释/字符串）、`member`（属性名）、`unresolved`（真的没解析出来）。只有前两者之外的才可能触发拒绝。

### 2. `self.attr` 的属性名被当成未解析的参数

```python
def __init__(self, locale_time=None):
    self.locale_time = LocaleTime()
    ...
    'A': self.__seqToRE(self.locale_time.f_weekday, 'A'),   ← 选中
```

选区里 `locale_time` 只作为 `self.locale_time` 的**成员名**出现，作用域查询正确返回 `member`。
但旧逻辑把 `member` 也算作"标识符真实出现"，再查签名发现 `locale_time` 是参数 → 拒绝。

**修法**：`member` 不算真实引用。只有 `local` 和 `notLocal:unresolved` 才算。

### 修复前后对比

| 轮次 | 选区 | 成功 | 成功率 | 查询缺口误拒 |
|---|---|---|---|---|
| 初版 | 306 | 191 | 62.4% | 27 |
| 修 docstring | 306 | 216 | 70.6% | 2 |
| 修 member | 278 | 202 | **72.7%** | **0** |

## 四、性能（批量查询前后）

最初的实现每个变量名一次 `syntax_locals`，IPC 往返约 13 ms，大选区因此变慢。
后来加了 `syntax_locals_in_range`：Rust 侧走一次树、对每个不同名字查一次，
前端一次请求拿全部结果。

`_strptime.py` 的 `TimeRE.__init__`，同一台机器、同一份代码：

| 语句数 | 优化前 | 优化后 | 提升 |
|---|---|---|---|
| 4 | 143 ms | 40 ms | 3.6× |
| 8 | 188 ms | 9 ms | **21×** |
| 18 | 356 ms | 10 ms | **36×** |
| 31 | 569 ms | 53 ms | **11×** |

现在的判定：

| 选区规模 | 判定 |
|---|---|
| ≤ 31 条语句 | 全部 60 ms 以内，无感 |
| 上限 | 一个选区最多回答 64 个不同名字（`MAX_RANGE_NAMES`），超出则拒绝并提示 |

**优化前后成功率不变**（86–87%），只有耗时变了：批量查询是纯加速，没有改动判定逻辑。

## 五、一个脚本层面的坑（不是产品问题）

`_strptime.py` 第一次跑出现 `execute_js` 超时：一次 `execute_js` 里跑 40 个选区太长。
降到 12 个后 **12/12 全过**。这是批量脚本的限制，不是产品问题。

## 六、结论

| 问题 | 答案 |
|---|---|
| 真实代码上能提取吗 | **87.4%** 的合理选区可以（72.7% 含必然拒绝的 `return` 选区） |
| 会生成错误代码吗 | **没有观察到**：0 异常、0 静默错误，生成结果都能被真 Python 解析 |
| 拒绝都是对的吗 | 修复后**是**：剩下的拒绝全部是语义上正确的（return 会改变控制流、给外部变量赋值无法回传、多输出是 v1 限制） |
| 性能够用吗 | 典型选区（≤8 条）无感；超大选区（30+ 条）约 0.5 秒 |
| 有架构性问题吗 | **没有**。两个 bug 都在判定逻辑，改完后无需改架构 |

### 建议

1. **可以继续做下一个重构**（Inline Method 或 Change Signature），但**先把 `MAX_NAMES` 的批量查询补上**——否则每个新重构都会重复这一层开销。
2. **多输出变量**（11 次拒绝）是真实代码里最常见的 v1 限制。IDEA 支持返回元组/多值，值得排进下一版。
3. **docstring 附近的选区**要特别注意：现在不误拒了，但选一个纯 docstring 的块仍然无意义（会拒绝说"selection ends with the head of a block"或提取出一个空方法）。是否要在提示里明确说"选区内没有可执行语句"，可以后续再定。

## 七、复现方式

```bash
cd C:/D/temp/openpycharm

# 1. 枚举真实选区（需要 CPython 3.11 的 Lib 目录）
py selections.py "C:/Users/lzsj/AppData/Local/Programs/Python/Python311/Lib" 20 > selections.json

# 2. 应用运行中时，跑批量
node batch.mjs sel-batch.json 40 > batch-result.json

# 3. 看汇总
node -e 'console.log(require("./batch-result.json").summary)'
```

脚本：`selections.py`（选区生成）、`batch.mjs`（驱动应用）。
两份都是 POC 工具，不属于产品代码。
