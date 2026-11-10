# Inline Variable（Python，语法级）—— 拒绝清单

适用于 `src/editor/refactor/inline.ts`：语言服务器做不了时 `Ctrl+Alt+N` 走的路径。
服务器可用时由 `refactor.inline` 回答，本文的规则不适用。

## 为什么要有这份清单

内联有两种方式会**把代码改错**，而且都不报错：

| 错误 | 后果 |
|---|---|
| 把有副作用的表达式复制到多处 | 表达式被求值多次（少调一次接口、多写一行日志） |
| 把表达式搬到依赖已改变的位置 | 值变了，但看起来完全正常 |

语法级实现只做能证明正确的变换：判定不了就拒绝，说明原因，一个字符都不改。

## 一、语言与服务前提

| 条件 | 拒绝原因 |
|---|---|
| 语言不是 Python | `Inline needs the language server for this language` |
| 该语言没有 tree-sitter 语法 | `Inline needs the language server here` |
| 文件只读 | `Cannot perform refactoring: the file is read-only` |
| 视图里没有文档 | `no document` |
| 作用域查询失败 | `the scope query failed (…)` |

## 二、光标位置

| 场景 | 拒绝原因 |
|---|---|
| 光标不在局部变量上 | `place the caret on a local variable` |
| 有选区，但选区不是恰好这个名字 | `the selection does not name one variable` |
| 该名字在作用域里声明不止一次 | `'x' is declared more than once here` |
| 该名字从未被使用 | `'x' is never used` |

「选区必须恰好是这个名字」是为了避免半个选区误触发内联：选中一行的一半再按快捷键，
不该把别的东西内联掉。

## 三、声明的形态

| 场景 | 拒绝原因 |
|---|---|
| 是函数参数 | `the variable is a parameter; it has no initializer` |
| 是 `import` / 函数 / 类 / 类型名 | `the variable is a import, not a local assignment`（`${kind}` 处为实际种类） |
| 不是 `name = value` 形式（如 `a, b = …`、`for a in …`、`a += …`） | `the variable is not declared by a plain \`name = value\`` |
| 声明没有初始化 | `the declaration has no initializer` |
| 链式赋值 `x = y = 1` | `the declaration chains assignments` |
| 声明或初始化定位失败 | `the declaration could not be located` / `the initializer could not be located` |

### 「不是普通的 `name = value`」覆盖的情况

```python
first, second = pair      ← 目标是 pattern_list，拒绝
first, *rest = pair       ← 同上
x += 1                    ← augmented_assignment，拒绝
for x in items:            ← for 的目标，拒绝
with open(p) as x:        ← as 绑定，拒绝
if (x := f()):            ← walrus，拒绝
x: int = 1                ← 允许（注解不影响）
x = y = 1                 ← 链式赋值，拒绝
```

## 四、使用点

| 场景 | 拒绝原因 |
|---|---|
| 该变量被重新赋值 | `'x' is reassigned; only a variable assigned once can be inlined` |
| 在声明之前被读取 | `'x' is read before it is declared` |
| 在嵌套函数里被读取 | `'x' is read inside a nested function, which would move when it is evaluated` |
| 用了多次，且初始化可能带副作用 | `'x' is used 3 times and its initializer may have side effects` |
| 初始化读的某个名字在使用之前被改过 | `'a' changes between the declaration and the use of 'x'` |

### 为什么「嵌套函数里读」要拒绝

```python
def f():
    v = expensive()      # 在 f() 里求值
    def g():
        return v         # g() 被调用时才读
    return g
```

内联后变成 `def g(): return expensive()`——**求值时机从「f 调用时」变成「g 调用时」**，
副作用次数和顺序都变了。所以拒绝。

### 为什么「依赖被改过」要拒绝

```python
a = 1
x = a + 1     # x == 2
a = 5
return x      # 若内联成 return a + 1，就变成 6
```

### 「可能带副作用」的判定

只按节点种类判断，不猜：

| 初始化 | 多次使用 |
|---|---|
| 名字、属性、下标、字面量、`f""`（无插值） | 允许 |
| 算术 / 比较 / 逻辑运算、三元、推导式、列表/字典/集合/元组 | 允许 |
| **函数调用** | **拒绝** |
| **含插值的 f-string**（`f"{load()}"`） | **拒绝** |

只用在**一处**时，副作用无关紧要（求值次数不变），所以不再拒绝调用：

```python
rows = load(items)
return rows          ← 允许，变成 return load(items)
```

## 五、能做什么

| 场景 | 结果 |
|---|---|
| 纯表达式，用在多处 | 每处都替换，加括号 |
| 纯表达式（原子：名字、属性、下标、调用、字面量），用在一处 | 不加括号 |
| 函数调用，只用在**一处** | 允许，不加括号 |
| 非原子表达式（`a + 1`） | 加括号，避免优先级被上下文改变 |
| 声明独占的行 | 整行删除（含换行，不留空行） |
| 声明后同一行还有别的语句（`x = 1; f(x)`） | 只删声明部分，保留 `; f(x)` 所在行 |

## 六、生成结果长什么样

```python
# 之前
def total(items, rate):
    factor = rate * 2
    scaled = factor * 3
    return factor + scaled

# 光标放在 factor 上，Ctrl+Alt+N
def total(items, rate):
    scaled = (rate * 2) * 3
    return (rate * 2) + scaled
```

```python
# 单处使用、调用型初始化
def once(items):
    rows = load(items)
    return rows

# →
def once(items):
    return load(items)
```

| 细节 | 行为 |
|---|---|
| undo | 一次 `Ctrl+Z` 完全还原（实测：10 行变回 10 行，`factor = rate * 2` 回来） |
| 光标 | 落在第一处替换的起点之后 |
| 编辑之后 | 语言服务器重新分析，Problems 面板**保持为空**（实测：12 秒，0 错误 0 警告） |
| 语言 | 只支持 Python；其他语言需要语言服务器 |

## 七、证据

| 结论 | 出处 |
|---|---|
| 单元测试 | `src/editor/refactor/inline.test.ts`（16 个） |
| 真机端到端 | `fixtures/python-app` 的临时探针文件（验证后已删除） |

真机实测记录：

```
reassigned      'x' is reassigned; only a variable assigned once can be inlined
impureTwice     'rows' is used 2 times and its initializer may have side effects
tuple target    the variable is not declared by a plain `name = value`
plain           plan: text 'a + 1', 1 use, parens true
dependency      'a' changes between the declaration and the use of 'b'

factor = rate * 2  (2 处使用)  →  scaled = (rate * 2) * 3 / return (rate * 2) + scaled
rows = load(items) (1 处使用)  →  return load(items)
Ctrl+Z                          一步还原
Problems 面板                   12 秒，0 错误 0 警告
```

## 八、尚未实现

| IDEA 有、这里没有 | 说明 |
|---|---|
| Inline Method | 需要形参替换 + `return` 改写 + 局部变量改名 |
| Inline Field / 内联常量 | 需要跨文件搜索使用点 |
| Inline 到类常量并使用 | 同上 |
| 「内联所有出现处」的选择框 | IDEA 在部分场景会问；这里总是内联全部使用点 |
