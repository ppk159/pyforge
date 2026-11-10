# Extract Method（Python，语法级）—— 拒绝清单

适用于 `src/editor/refactor/extractMethod.ts`：语言服务器做不了时 `Ctrl+Alt+M` 走的路径。
服务器可用时由 `refactor.extract` 回答，本文的规则不适用。

## 为什么要有一份拒绝清单

语法级实现只做**能证明正确**的转换。它不是尽力而为：判定不了就拒绝，说明原因
（`Cannot perform refactoring: <理由>`），并且一个字符都不改。**它绝不生成可能错误的代码。**

其中三条来自实测发现的**静默错误**，是最要紧的部分：

| 静默错误 | 后果 | 对策 |
|---|---|---|
| `global x` 之后的 `x = 1` 被报成局部定义 | 新方法读一个未定义的名字 | 选区含 `global` / `nonlocal` 即拒绝 |
| `first, *rest = pair` 的 `rest` 查不到 | 静默丢掉一个输出变量 | 选区含星号赋值目标即拒绝 |
| `*args: int` 不被作用域查询覆盖 | 静默丢掉一个参数 | 已修 `locals.scm`；仍查不到则拒绝 |

## 一、语言与服务前提

| 条件 | 拒绝原因 |
|---|---|
| 语言不是 Python | `Extract Method needs the language server for this language` |
| 该语言没有 tree-sitter 语法 | `Extract Method needs the language server here` |
| 文件只读 | `Cannot perform refactoring: the file is read-only` |
| 视图里没有文档 | `no document` |
| 服务读不了选区 | `the syntax service could not read the selection` |
| 选区里不同名字超过 64 个 | `the selection mentions too many different names` |

## 二、选区形状

| 场景 | 拒绝原因 |
|---|---|
| 空选区（只有一个光标） | `select the statements to extract` |
| 首行没有从行首开始选 | `the selection must start at a statement boundary` |
| 末行没有选到行尾 | `the selection must end at a statement boundary` |
| 选区全是空白 | `the selection has no statements` |
| 模块级或类体（没有缩进） | `the selection must be inside a function body` |
| 某行比首行缩进更浅 | `the selection is not one run of statements at the same level` |
| 最后一行是块头（`if x:`、`for …:`、`def …:`） | `the selection ends with the head of a block` |
| 选区起点早于块内那条语句 | `the selection must start at a statement of the enclosing block` |
| 起点所在语句有语法错误 | `the selection contains syntax errors` |
| 选区内任意位置有语法错误 | `the selection contains syntax errors` |
| 不在函数内 | `select statements inside a function` |

### 「选区起点必须落在块内语句上」

这条挡住的是**从构造中间开始**的选区：

```python
def parse(p):
    try:
        return load(p)
    except ValueError as e:      ← 从这里开始选
        log(e)
```

`except` 块里的第一条语句是 `log(e)`，它在选区起点**之后**。抽出去就是半个子句，
生成的代码无法解析。同类情况还有 `else:` / `elif:` / `finally:` / `case …:` 的子块、
`with` 的第二项、装饰器与 `def` 之间那一行。

反过来说，**缩进更深的行没问题**：把 `if x:` 连同它的函数体一起选中，仍然是一个完整的语句串。

## 三、语句内容

| 场景 | 拒绝原因 | 为什么 |
|---|---|---|
| 含 `return` / `yield` / `await` | `the selection contains return, yield or await` | 方法没法 return 给调用方；`yield`/`await` 还会改变调用的形态 |
| 含 `global` / `nonlocal` 声明 | `the selection declares a global or nonlocal name` | 作用域查询会把这种名字报成局部定义（实测） |
| 含 `match …:` / `case …:` | `the selection contains a match statement, which the syntax service does not resolve` | `locals.scm` 没有模式绑定的规则（实测），会漏参数 |
| 含星号赋值目标 | `the selection uses a starred assignment target ('*rest'), which the syntax service does not resolve` | `rest` 查不到（实测），会丢输出 |

星号**调用**不算星号目标：

```python
first, *rest = pair     ← 拒绝
out = g(*args)          ← 允许
```

变量名叫 `match` 也允许（它是软关键字）：

```python
match = re.search(s)    ← 允许
match value:            ← 拒绝
    case …
```

## 四、数据流

| 场景 | 拒绝原因 |
|---|---|
| 选区内给**外部声明的变量**赋值 | `the selection assigns 'x', which is declared outside it` |
| 某名字查不到，但外层函数**签名**里有它 | `'x' is local to this function but the syntax service cannot resolve it here` |
| 某名字在作用域里声明不止一次 | `'x' is declared more than once here` |

### 为什么给外部变量赋值要拒绝

```python
def f(order):
    order = order.strip()    ← 拒绝：调用方看不到这个结果
    return order
```

在抽出的方法里给参数或外层局部变量重新赋值，**没法通过调用表达出来**，所以拒绝，
而不是悄悄丢掉。

### 最后一道防线：只看签名，不看函数体

`*tags: str` 当时不被作用域查询覆盖：

```python
def add(self, title: str, *tags: str) -> Task:
    task = Task(title, tags=set(tags))     ← tags 查不到
```

- **静默跳过**：生成的方法读一个未定义名字；
- **当成模块级**：`tags` 会从签名里彻底消失。

所以规则是：**查不到 + 外层参数表里有它 → 拒绝。**

这个检查**只读参数表**。如果扫函数体，`task = Task(...)` 会被读成「绑定 `Task`」，
于是任何提到类名的选区都会被拒——这是实现里真实出现过的 bug。

### 什么情况**不**拒绝

| 名字 | 处理 |
|---|---|
| 模块级函数、类、常量（`Task`、`Priority`） | 不传参：新方法也声明在模块级，作用域没变 |
| 内置函数（`print`、`len`、`set`） | 同上 |
| `self` / `cls` | **作为参数传**（Python 的隐式参数，虽然它们是 Rust 和 Ruby 的关键字） |
| 属性名（`self._tasks`、`obj.append`） | 不算变量 |
| 关键字参数标签（`f(tags=tags)` 里的 `tags=`） | 不算变量；同一名字的其他出现会正常处理 |
| 注释和字符串里的词 | 不算变量 |

## 五、能做什么

| 场景 | 结果 |
|---|---|
| 没有任何外部依赖的语句块 | 无参数，无返回值 |
| 读外层局部变量、参数或 `self` | 变成参数，**按首次使用顺序** |
| 在选区内定义、选区外使用的**一个**变量 | 作为返回值 |
| 在选区内定义、选区外使用的**多个**变量 | 返回元组，调用处一次解包：`a, b = f()` |
| 在选区内定义、只在选区内用掉的变量 | 无返回值 |
| 嵌套函数内提取 | 新方法插在同一层级 |
| 方法内提取 | 新方法成为**同级方法**（缩进对齐外层 `def`） |
| 模块级函数内提取 | 新方法跟在该函数之后，模块级 |
| `with … as` / `except … as` | 支持（`as_pattern` 覆盖） |
| walrus `:=`、`for` 解包、推导式、f-string | 支持 |
| `*args` / `**kwargs` / `*args: int` / `**kwargs: str` | 支持 |

## 六、生成结果长什么样

```python
# 选中（models.py 第 35–36 行）
task = Task(title.strip(), priority, due, tags=set(tags))
self._tasks.append(task)

# 结果
def add(self, title: str, priority: Priority = Priority.NORMAL, due: date | None = None, *tags: str) -> Task:
    if not title.strip():
        raise ValueError("title must not be empty")
    task = compute_task(title, priority, due, tags, self)   # 调用
    return task

def compute_task(title, priority, due, tags, self):          # 新方法，同级
    task = Task(title.strip(), priority, due, tags=set(tags))
    self._tasks.append(task)
    return task
```

| 细节 | 行为 |
|---|---|
| 命名 | 恰好一个返回值 → `compute_<输出名>`，否则 `extracted`；生成后弹改名框 |
| 改名 | 先 undo，再用新名字重跑整次重构，因此**仍是一步 undo** |
| undo | 一次 `Ctrl+Z` 完全还原（实测：62 行 → 58 行） |
| 缩进 | 新方法体 = 外层函数缩进 + 4 |
| 编辑之后 | 语言服务器重新分析，Problems 面板**保持为空**（实测：18 秒，0 错误） |
| 语言 | 只支持 Python；其他语言需要语言服务器 |

### 多个输出

选中区定义了好几个变量、而选区外还要用到时，新方法返回元组，调用处一次解包：

```python
# 选中
def f(a):
    x = a + 1
    y = a + 2
    return x + y

# 结果
def f(a):
    x, y = extracted(a)
    return x + y

def extracted(a):
    x = a + 1
    y = a + 2
    return x, y
```

两个约束：

- **顺序是选区内的声明顺序**，因为调用处的解包依赖它。
- **只对声明在选区内的变量有效**。给声明在外部的变量赋值仍然拒绝：那无法通过返回值回写（见下一节）。

多个输出时命名不再用 `compute_<输出名>`（没有唯一输出可用），而是 `extracted`。

## 七、作用域查询的缺口

`crates/ide-syntax/queries/python/locals.scm` 新增了两条规则（用 `include_str!` 编译期嵌入，需要重新构建）：

```scheme
; *args: int / **kwargs: str —— 注解把 splat 包进了 typed_parameter
(typed_parameter (list_splat_pattern (identifier) @local.definition.parameter))
(typed_parameter (dictionary_splat_pattern (identifier) @local.definition.parameter))
```

**仍未覆盖**、靠第三节的拒绝兜底的：`match`/`case` 的模式绑定，以及星号赋值目标 `*rest = …`。

## 八、证据

| 结论 | 出处 |
|---|---|
| 作用域查询能解析什么 | `crates/ide-syntax/src/tests/probe_dataflow.rs`（13 个用例） |
| 生成的 Python 能解析 | `src/editor/refactor/pocSyntax.test.ts`（10 种形态，真 `ast.parse`） |
| 真机端到端 | `fixtures/python-app` / `src/tasks/models.py` 第 35–36 行 |
| 本文这份清单 | `src/editor/refactor/extractMethod.test.ts`（31 个用例，**15 条固定消息逐条断言**） |

15 条固定的拒绝消息全部单独断言过，另外 5 条带变量名的消息
（`'x' is declared more than once here` 这类）也有对应用例。

真机实测记录（提交 `3e75e45`）：

```
params   [title, priority, due, tags, self]   （修复前只有 [title, priority, due]）
output   task
defIndent '    '
真 Python 解析                                PARSE OK
Problems 面板                                 18 秒，0 错误 0 警告
Ctrl+Z                                       62 行 → 58 行，无残留
```
