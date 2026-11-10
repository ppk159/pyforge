# Change Signature（Python，语法级）—— 支持范围与拒绝清单

适用于 `src/editor/refactor/changeSignature.ts`：语言服务器做不了时，光标在函数声明上按 `Ctrl+F6` 走的路径。
服务器可用时由 `refactor.rewrite` 回答，本文的规则不适用。

## v1 只做一件事：追加带默认值的参数

```python
def report(items, labels):                def report(items, labels, sep=", "):
    return f"{labels}: {len(items)}"  →       return f"{labels}: {len(items)}"
```

**为什么只做这个**：追加一个带默认值的参数**不会改变任何已有调用点的绑定**。
位置参数仍然按位绑定前几个，关键字参数完全不受影响，所以调用点一个都不需要改。

这是唯一能从语法上**证明**不破坏调用方的签名变更。其他变更都要么需要分析每个调用点
（改顺序、删参数、改默认值），要么会让现有调用失效（加无默认值的参数）。

## 一、语言与服务前提

| 条件 | 拒绝原因 |
|---|---|
| 语言不是 Python | `Change Signature needs the language server for this language` |
| 该语言没有 tree-sitter 语法 | `Change Signature needs the language server here` |
| 文件只读 | `Cannot perform refactoring: the file is read-only` |
| 视图里没有文档 | `no document` |

## 二、光标位置

| 场景 | 拒绝原因 |
|---|---|
| 光标不在函数声明上 | `place the caret on a function declaration` |
| 声明无法读取 | `the declaration could not be read` |

## 三、签名形态

| 场景 | 拒绝原因 |
|---|---|
| 声明没有参数列表 | `the declaration has no parameter list` |
| 参数列表括号不匹配 | `the parameter list is not closed` |
| 声明没有签名（找不到 `:`） | `the declaration has no signature` |
| 声明带 `*args` / `**kwargs` | `the declaration takes *args or **kwargs` |

## 四、新参数

| 场景 | 拒绝原因 |
|---|---|
| 名字不是合法标识符 | `'1b' is not a valid parameter name` |
| 与已有参数重名 | `the declaration already has a parameter 'x'` |
| 没有给默认值 | `a new parameter needs a default so existing calls keep working` |
| 名字以 `*` 开头 | `a starred parameter cannot be appended this way` |

## 五、能做什么

| 场景 | 结果 |
|---|---|
| `def f(a, b)` + `c=0` | `def f(a, b, c=0)` |
| `def f()` + `c=0` | `def f(c=0)` |
| `def f(a: int)` + `b=1` | `def f(a: int, b=1)` |
| `def f(a, b=(1, 2))` + `c=0` | `def f(a, b=(1, 2), c=0)`——默认值里的逗号不误切 |
| `def f(a: int) -> int:` | 返回值注解保留，只在参数列表尾部插入 |

参数列表的解析用括号深度计数，所以：

- `b=(1, 2)` 这种含逗号的默认值不会被切成两段
- `b=g(1, 2)` 同理
- `a: int`、`b: str = 'x'` 的注解和默认值都保留

签名范围的判定按括号深度找第一个顶层 `:`，并且跳过字符串字面量，所以
`def f(a: int) -> int:` 会在 `-> int` 之后收住，不会误停在注解里的 `:`。

## 六、生成结果

```python
# 之前
def report(items, labels):
    return f"{labels}: {len(items)}"

def caller(items, labels):
    return report(items, labels)

# Ctrl+F6，输入 sep=", " 之后
def report(items, labels, sep=", "):
    return f"{labels}: {len(items)}"

def caller(items, labels):          # ← 一行都没变
    return report(items, labels)
```

| 细节 | 行为 |
|---|---|
| 调用点 | **完全不动**（这正是选这个变更的理由） |
| undo | 一次 `Ctrl+Z` 完全还原 |
| 编辑之后 | Problems 面板保持为空（实测：9 秒 0 错误 0 警告） |
| 光标 | 移到新参数之后 |

## 七、为什么其余的拒绝

IDEA 的 Change Signature 支持增、删、改顺序、改名、改默认值。语法级实现只做“追加带默认值”，因为：

| 变更 | 为什么拒绝 |
|---|---|
| 追加**无**默认值的参数 | 所有已有调用点都会缺这个参数 → 全部失效 |
| 删除参数 | 所有传入它的调用点都要改，且要判断是位置还是关键字 |
| 改参数顺序 | 每个位置参数的调用点都要重排，风险最高 |
| 改参数名 | 关键字调用点要改；位置调用点不用改。判定需要区分两种，且必须跨文件搜索 |
| 改默认值 | 语义变了，但看不出来；应静默吗？IDEA 会提示，这里不做 |

这些都需要**枚举并分类每个调用点**，是 `identifiersInFiles` 加数据流分析的范畴，属于下一阶段。

## 八、证据

| 结论 | 出处 |
|---|---|
| 参数列表解析（含默认值里的逗号） | `src/editor/refactor/changeSignature.test.ts` |
| 签名范围（注解里的 `:`） | 同上 |
| 真机端到端 | `fixtures/python-app` 的临时探针（验证后已删除） |

真机实测：

```
追加 sep=", "   → def report(items, labels, sep=", ")
重名 items      → 拒绝：the declaration already has a parameter 'items'
无默认值        → 拒绝：a new parameter needs a default so existing calls keep working
非法名 1z       → 拒绝：'1z' is not a valid parameter name

生成文件被真 Python 执行：
  caller([1,2], "n") == 'n: 2'    ← 调用点未改，仍然正确
  report([1,2], "n") == 'n: 2'
Problems 面板 9 秒 0 错误 0 警告
一次 Ctrl+Z 完全还原
```

## 九、下一阶段

| 能力 | 需要什么 |
|---|---|
| 改名参数 | `identifiersInFiles` 区分关键字标签与位置参数（已有一半：`qualified` 字段） |
| 删除参数 | 同上，加默认值回填 |
| 改顺序 | 每个调用点的实参重排 + 解包/关键字混用的处理 |
| 追加无默认值参数 | 所有调用点补默认值 |
| 跨文件 | 已可用 `identifiersInFiles`（Rust 侧 rayon 并行） |
