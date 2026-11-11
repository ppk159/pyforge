# Inline Variable（Python，语法级）—— 拒绝清单

适用于 `src/editor/refactor/inline.ts`：语言服务器做不了时 `Ctrl+Alt+N` 走的路径。
服务器可用时由 `refactor.inline` 回答，本文的规则不适用。

## 为什么要有这份清单

内联有两种方式会**把代码改错**，而且都不报错：

| 错误                         | 后果                                           |
| ---------------------------- | ---------------------------------------------- |
| 把有副作用的表达式复制到多处 | 表达式被求值多次（少调一次接口、多写一行日志） |
| 把表达式搬到依赖已改变的位置 | 值变了，但看起来完全正常                       |

语法级实现只做能证明正确的变换：判定不了就拒绝，说明原因，一个字符都不改。

## 一、语言与服务前提

| 条件                        | 拒绝原因                                             |
| --------------------------- | ---------------------------------------------------- |
| 语言不是 Python             | `Inline needs the language server for this language` |
| 该语言没有 tree-sitter 语法 | `Inline needs the language server here`              |
| 文件只读                    | `Cannot perform refactoring: the file is read-only`  |
| 视图里没有文档              | `no document`                                        |
| 作用域查询失败              | `the scope query failed (…)`                         |

## 二、光标位置

| 场景                           | 拒绝原因                                   |
| ------------------------------ | ------------------------------------------ |
| 光标不在局部变量上             | `place the caret on a local variable`      |
| 有选区，但选区不是恰好这个名字 | `the selection does not name one variable` |
| 该名字在作用域里声明不止一次   | `'x' is declared more than once here`      |
| 该名字从未被使用               | `'x' is never used`                        |

「选区必须恰好是这个名字」是为了避免半个选区误触发内联：选中一行的一半再按快捷键，
不该把别的东西内联掉。

## 三、声明的形态

| 场景                                                              | 拒绝原因                                                                        |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| 是函数参数                                                        | `the variable is a parameter; it has no initializer`                            |
| 是 `import` / 函数 / 类 / 类型名                                  | `the variable is a import, not a local assignment`（`${kind}` 处为实际种类）    |
| 不是 `name = value` 形式（如 `a, b = …`、`for a in …`、`a += …`） | `the variable is not declared by a plain \`name = value\``                      |
| 声明没有初始化                                                    | `the declaration has no initializer`                                            |
| 链式赋值 `x = y = 1`                                              | `the declaration chains assignments`                                            |
| 声明或初始化定位失败                                              | `the declaration could not be located` / `the initializer could not be located` |

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

| 场景                                                       | 拒绝原因                                                                      |
| ---------------------------------------------------------- | ----------------------------------------------------------------------------- |
| 这次赋值的值在窗口内没有任何读取                           | `'x' is not read between this assignment and the next write to it`            |
| 在声明之前被读取                                           | `'x' is read before it is declared`                                           |
| 在嵌套函数里被读取                                         | `'x' is read inside a nested function, which would move when it is evaluated` |
| 用了多次、初始化可能带副作用、**且使用点之间隔着别的语句** | `'x' is used 3 times and its initializer may have side effects`               |
| 初始化读的某个名字在使用之前被改过                         | `'a' changes between the declaration and the use of 'x'`                      |

### 「被重新赋值」的实际判定：赋值窗口

不是「被赋值过一次就不行」，而是只看**这一次赋值之后、下一次赋值之前**的使用点：

```python
x = 1
use(x)        ← 在窗口内，内联成 use(1)
x = 2         ← 窗口到此结束
return x      ← 在窗口外，属于 x = 2，原样不动
```

内联后：

```python
use(1)
x = 2
return x
```

**声明什么时候保留？** 窗口外的使用点如果可能读到这里赋的值，`x = 1` 必须留下——
否则那条路径上 `x` 没有绑定。判定方式：窗口外每个使用点之前，是否**一定**执行过
一次更晚的赋值。写和读是同一个 block 的直接子语句时算「一定」（中间没有分支），
其余情况一律保守保留：

```python
y = 10
use(y)          ← 内联成 use(10)
if c:
    y = 20      ← 在分支里，不能保证执行
return y        ← 可能读到 10，所以 y = 10 必须保留
```

```python
x = 1
use(x)          ← 内联成 use(1)
x = 2           ← 和 return 同一个 block，一定执行
return x
```

此时 `x = 1` 被删掉，`x = 2` 和 `return x` 原样保留。

### 窗口延伸到下一次赋值的**整条语句**

Python 先算右边的值再绑定，所以 `x = g(x)` 里的读看见的是**旧值**：

```python
build_date = config("DATE")
build_date = int(build_date)     ← 这里的读属于上一条赋值
```

所以窗口的右端是「下一次赋值所在语句的末尾」，不是那个名字的位置。

### 本次赋值的值没人读

```python
x = 1
x = 2
return x
```

窗口里没有使用点——`x = 1` 的值从未被读。这不是「不能内联」，而是没有可内联的对象，
拒绝消息单独说明。

## 五、能做什么

| 场景                                                       | 结果                               |
| ---------------------------------------------------------- | ---------------------------------- |
| 纯表达式，用在多处                                         | 每处都替换，加括号                 |
| 纯表达式（原子：名字、属性、下标、调用、字面量），用在一处 | 不加括号                           |
| 函数调用，只用在**一处**                                   | 允许，不加括号                     |
| 非原子表达式（`a + 1`）                                    | 加括号，避免优先级被上下文改变     |
| 声明独占的行                                               | 整行删除（含换行，不留空行）       |
| 声明后同一行还有别的语句（`x = 1; f(x)`）                  | 只删声明部分，保留 `; f(x)` 所在行 |

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

| 细节     | 行为                                                                        |
| -------- | --------------------------------------------------------------------------- |
| undo     | 一次 `Ctrl+Z` 完全还原（实测：10 行变回 10 行，`factor = rate * 2` 回来）   |
| 光标     | 落在第一处替换的起点之后                                                    |
| 编辑之后 | 语言服务器重新分析，Problems 面板**保持为空**（实测：12 秒，0 错误 0 警告） |
| 语言     | 只支持 Python；其他语言需要语言服务器                                       |

## 七、证据

| 结论       | 出处                                                 |
| ---------- | ---------------------------------------------------- |
| 单元测试   | `src/editor/refactor/inline.test.ts`（21 个）        |
| 真机端到端 | `fixtures/python-app` 的临时探针文件（验证后已删除） |

真机实测记录：

```
deadWrite       'x' is not read between this assignment and the next write to it
impureTwice     'rows' is used 2 times and its initializer may have side effects
tuple target    the variable is not declared by a plain `name = value`
plain           plan: text 'a + 1', 1 use, parens true
dependency      'a' changes between the declaration and the use of 'b'

factor = rate * 2  (2 处使用)  →  scaled = (rate * 2) * 3 / return (rate * 2) + scaled
rows = load(items) (1 处使用)  →  return load(items)
reassigned+read   x = raw; x = int(x)  →  int(raw)（窗口延伸到整条语句）
kept declaration  y = 10; use(y); if c: y = 20; return y
                  →  use(10)，y = 10 保留（分支里的赋值不保证执行）
dropped declaration  x = 1; use(x); x = 2; return x
                  →  use(1), x = 2, return x（x = 1 删掉）
Ctrl+Z                          一步还原
Problems 面板                   12 秒，0 错误 0 警告
```

## 八、尚未实现

| IDEA 有、这里没有          | 说明                                        |
| -------------------------- | ------------------------------------------- |
| Inline Method              | 需要形参替换 + `return` 改写 + 局部变量改名 |
| Inline Field / 内联常量    | 需要跨文件搜索使用点                        |
| Inline 到类常量并使用      | 同上                                        |
| 「内联所有出现处」的选择框 | IDEA 在部分场景会问；这里总是内联全部使用点 |
