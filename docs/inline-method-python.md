# Inline Method（Python，语法级）—— 拒绝清单

适用于 `src/editor/refactor/inlineFunction.ts`：语言服务器做不了时，光标在函数调用上按 `Ctrl+Alt+N` 走的路径。
服务器可用时由 `refactor.inline` 回答，本文的规则不适用。

`refactor.inline` 是 IDEA 的**一个**动作：光标在函数调用上时内联方法，在局部变量上时内联变量
（`inline.ts`，见 `inline-variable-python.md`）。

## v1 的范围

只做一个**能从语法证明正确**的变换：**同文件里函数体恰好是一条 `return <表达式>`**。

```python
def double(x):
    return x * 2

y = double(a + 1)      →      y = (a + 1) * 2
```

函数体里没有其他语句，就没有局部变量要改名、没有控制流要重写、没有提前 `return` 要处理——
这些正是更大范围实现必须处理、而这里**直接拒绝**的情况。

## 一、语言与服务前提

| 条件 | 拒绝原因 |
|---|---|
| 语言不是 Python | `Inline Method needs the language server for this language` |
| 该语言没有 tree-sitter 语法 | `Inline Method needs the language server here` |
| 文件只读 | `Cannot perform refactoring: the file is read-only` |
| 视图里没有文档 | `no document` |

## 二、光标位置

| 场景 | 拒绝原因 |
|---|---|
| 光标不在调用上 | `place the caret on a call` |
| 被调的不是裸函数名（`obj.method(...)`、`(f)(...)`） | `the call is not to a plain function name` |
| 调用没有参数列表 | `the call has no argument list` |

## 三、被调用的函数

| 场景 | 拒绝原因 |
|---|---|
| 不在本文件声明 | `'name' is not declared in this file` |
| 声明无法读取 | `the declaration could not be read` |
| 声明没有函数体 | `the declaration has no body` |
| 声明没有参数列表 | `the declaration has no parameter list` |
| 参数列表括号不匹配 | `the parameter list is not closed` |
| 调用出现在它自己体内（递归） | `the call is inside its own declaration` |
| 签名有 `*args` / `**kwargs` | `the declaration takes *args or **kwargs` |
| 参数名读不出来 | `a parameter name could not be read` |

### 函数体的形态

| 场景 | 拒绝原因 |
|---|---|
| 有装饰器 | `the declaration is decorated` |
| 是 `async def` | `the declaration is a coroutine` |
| 含 `yield` | `the declaration is a generator` |
| 含 `await` | `the declaration is a coroutine` |
| `return` 之前有语句 | `the declaration does more than return an expression` |
| 出现两个 `return` | `the declaration returns from more than one place` |
| 没有 `return`，`return` 后为空 | `the declaration returns nothing` |

### 为什么「return 之前有语句」要拒绝

```python
def f(x):
    total = x + 1      ← 这条也得内联进来
    return total
```

内联它要引入一个临时变量并保证不撞名，属于更大范围的实现。v1 拒绝。

### 为什么装饰器要拒绝

```python
@cache
def f(x):
    return x * 2
```

`f(a)` 实际调用的是 `cache` 包装后的对象，不是 `f` 本身。内联成 `a * 2` 会**悄无声息地去掉缓存**。

## 四、参数与实参

| 场景 | 拒绝原因 |
|---|---|
| 调用展开了参数 `f(*xs)` / `f(**kw)` | `the call unpacks its arguments` |
| 传的实参比形参多 | `the call passes more arguments than the declaration takes` |
| 同一个形参被传两次 | `the call passes 'x' twice` |
| 关键字实参的标签不是形参名 | `the call passes an unknown keyword 'x'` |
| 实参无法对应到形参 | `the call's arguments could not be matched to the parameters` |
| 省略的形参没有默认值 | `the call does not pass 'x' and it has no default` |

省略的形参**有**默认值时，默认值直接代入，不拒绝：

```python
def shift(x, by=1):
    return x + by

y = shift(a)      →      y = a + 1
```

## 五、能做什么

| 场景 | 结果 |
|---|---|
| 函数体是 `return <表达式>` | 调用处替换成表达式，形参按实参代入 |
| 形参在表达式里出现多次 | 每处都替换（出现位置重叠时拒绝：`a parameter occurrence could not be replaced`） |
| 实参是原子（名字、属性、调用、字面量、列表…） | 直接代入，不加括号 |
| 实参是复合表达式（`a + 1`） | 加括号：`(a + 1) * 2` |
| 调用在赋值右侧 / return / 实参位置 | 结果不再包一层括号 |
| 调用在运算符、比较、属性访问里 | 结果包一层括号 |
| 调用的形参被省略且有默认值 | 默认值代入 |

### 括号策略

不是简单「一律加括号」，而是看**调用所在的上下文**：

| 调用位置 | 是否包括号 | 例子 |
|---|---|---|
| `y = f(a)`（赋值右侧整块） | 否 | `y = (a + 1) * 2` |
| `return f(a)` | 否 | `return a * 2` |
| `g(f(a))`（实参） | 否 | `g(a * 2)` |
| `y = f(a) + 1` | **是** | `y = (a * 2) + 1` |
| `y = f(a).attr` | **是** | `y = (a + 1).attr` |

这样既不产生 `((a + 1) * 2)` 这种冗余括号，也不会改变优先级。

## 六、生成结果

```python
# 之前
def double(x):
    return x * 2

def shift(x, by=1):
    return x + by

def same(x):
    return x

def caller(a, b):
    one = double(a + 1)
    two = shift(b)
    three = same(a)
    return one + two + three

# 内联 three 处之后
def caller(a, b):
    one = (a + 1) * 2
    two = b + 1
    three = a
    return one + two + three
```

| 细节 | 行为 |
|---|---|
| undo | 一次 `Ctrl+Z` 还原一处内联（每处一个独立编辑） |
| 被调函数 | **不删除**，只替换调用点（IDEA 的 Inline Method 同样保留声明） |
| 编辑之后 | Problems 面板保持为空（实测：9 秒 0 错误 0 警告） |

## 七、与 Inline Variable 的分派

`refactor.inline` 用一个入口，按光标下的节点决定走哪条：

```
光标在调用上（文本匹配 /^[A-Za-z_]\w*\s*\(/）  → Inline Method（本文）
否则                                          → Inline Variable（inline-variable-python.md）
```

## 八、证据

| 结论 | 出处 |
|---|---|
| 纯函数（参数/实参解析、括号判定） | `src/editor/refactor/inlineFunction.test.ts`（19 个用例） |
| 真机端到端 | `fixtures/python-app` 的临时探针（验证后已删除） |

真机实测：

```
double(a + 1)                  → (a + 1) * 2        wrap=false
shift(b)     (by=1 省略)        → b + 1             wrap=false
same(a)      (原子)            → a                 wrap=false
helper_with_statements(a)      → 拒绝：return 之前有语句

三处内联后文件被真 Python 执行：caller(3, 10) == 26（手算一致）
Problems 面板 9 秒 0 错误 0 警告
三次 Ctrl+Z 完全还原
```

## 九、尚未实现

| IDEA 有、这里没有 | 为什么难 |
|---|---|
| `return` 前有语句的函数 | 要把局部变量带进调用处，还要避免撞名 |
| 多个 `return` / 分支 | 要把控制流改写成表达式（三元或提前返回） |
| 递归内联 | 需要展开深度限制 |
| 跨文件内联 | 需要读另一个文档并处理 import |
| 内联后删除无人使用的声明 | 需要全项目引用搜索 |
| `obj.method()` 形式 | 需要 `self` 绑定和类层次分析 |
| 生成器 / 协程 | 不是表达式替换，语义完全不同 |
