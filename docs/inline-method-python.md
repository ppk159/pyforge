# Inline Method（Python，语法级）—— 支持范围与拒绝清单

适用于 `src/editor/refactor/inlineFunction.ts`：语言服务器做不了时，光标在函数调用上按 `Ctrl+Alt+N` 走的路径。
服务器可用时由 `refactor.inline` 回答，本文的规则不适用。

## 两种形态

函数体的形状决定改动的方式，只有两种。

### A. 末尾一条 `return 表达式`：调用变表达式

```python
def tag(vrtl, bd):
    """Return the tag."""
    _sz = 32 if vrtl == (2**31 - 1) else 64
    _bd = bd if bd != 0 else 9988
    return f"{vrtl}-{_bd}-{_sz}"
```

`x = tag(a, b)` 内联后：

```python
a = 1
b = 0
_sz = 32 if a == (2**31 - 1) else 64
_bd = b if b != 0 else 9988
x = f"{a}-{_bd}-{_sz}"
```

| 项                | 说明                                 |
| ----------------- | ------------------------------------ |
| 参数              | 按实参代入；省略的参数用自己的默认值 |
| `return 表达式`   | 替换调用处                           |
| `return` 前的声明 | **搬到调用语句之前**，按调用处缩进   |
| docstring         | **丢弃而不搬**（移过去没有意义）     |
| 行尾注释          | 丢弃                                 |

### B. 有早返或没有 `return`：整段搬进调用方

```python
def classify(n):
    if n < 0:
        return "neg"
    if n == 0:
        return "zero"
    return "pos"
```

`label = classify(n)` 内联后：

```python
while True:
    if n < 0:
        label = "neg"
        break
    if n == 0:
        label = "zero"
        break
    label = "pos"
    break
```

三条规则：

1. `return X` → `目标 = X` + `break`；裸 `return` → `目标 = None` + `break`。
2. 外层包一层 `while True:`，让 `break` **只跳出这段搬过来的代码**，
   调用方后面的语句照常执行。
3. 函数体可能「走到末尾」（例如只在 `if` 里 `return`）时，末尾补
   `目标 = None` + `break` —— 原来的语义就是返回 `None`，不补会死循环。

`while` 只包跳转，不包作用域，所以搬过来的变量仍在调用方的作用域里，后续语句能看到。

## 局部变量重名（最关键的正确性）

如果调用方已经有同名变量，搬过去的声明会**静默覆盖**它：

```python
def tag(v):
    _sz = 64
    return v + _sz

def caller(v):
    _sz = 100
    x = tag(v)        # 直接搬会覆盖 _sz
    return _sz + 1    # 期望 101，实际拿到 65
```

所以搬之前先查调用方作用域里有没有这个名字，有就加后缀（`_sz` → `_sz_1`），
并把**声明里的引用**和**返回表达式里的引用**一起改名：

```python
def caller(v):
    _sz = 100
    _sz_1 = 64
    x = v + _sz_1
    return _sz + 1    # 仍是 101
```

判定用 `identifiers` 找同名出现，落在调用方函数（模块级调用则是整个模块）范围内即视为冲突，
且排除被调函数自己的范围。

## 一、语言与服务前提

| 条件                        | 拒绝原因                                                    |
| --------------------------- | ----------------------------------------------------------- |
| 语言不是 Python             | `Inline Method needs the language server for this language` |
| 该语言没有 tree-sitter 语法 | `Inline Method needs the language server here`              |
| 文件只读                    | `Cannot perform refactoring: the file is read-only`         |
| 视图里没有文档              | `no document`                                               |

## 二、光标位置

| 场景               | 拒绝原因                                   |
| ------------------ | ------------------------------------------ |
| 光标不在调用上     | `place the caret on a call`                |
| 被调的不是裸函数名 | `the call is not to a plain function name` |
| 调用没有参数列表   | `the call has no argument list`            |

## 三、被调用的函数

| 场景                       | 拒绝原因                                  |
| -------------------------- | ----------------------------------------- |
| 不在本文件声明             | `'name' is not declared in this file`     |
| 声明读不出来               | `the declaration could not be read`       |
| 声明没有函数体             | `the declaration has no body`             |
| 声明没有参数列表           | `the declaration has no parameter list`   |
| 参数列表括号不匹配         | `the parameter list is not closed`        |
| 参数名读不出来             | `a parameter name could not be read`      |
| 带 `*args` / `**kwargs`    | `the declaration takes *args or **kwargs` |
| 调用在自己的声明里（递归） | `the call is inside its own declaration`  |

## 四、函数体的形态

| 场景                                   | 拒绝原因                                                 |
| -------------------------------------- | -------------------------------------------------------- |
| 有装饰器                               | `the declaration is decorated`                           |
| 是 `async def`                         | `the declaration is a coroutine`                         |
| 含 `yield`                             | `the declaration is a generator`                         |
| 含 `await`                             | `the declaration is a coroutine`                         |
| 函数体和签名在同一行                   | `the declaration has its body on the signature line`     |
| 缩进不一致（续行、`match` 等）         | `the declaration is not indented`                        |
| 语句边界读不出来                       | `a statement of the declaration could not be read`       |
| 语句伸出函数体                         | `the declaration has a statement this scope cannot move` |
| 没有语句（或只有 docstring）           | `the declaration returns nothing`                        |
| 给参数赋值                             | `the declaration assigns to its parameter 'x'`           |
| 搬移的文本里有自己的作用域且重绑了该名 | `'x' is rebound by a scope of the declaration's own`     |
| `return` 落在函数体自己的循环里        | `the declaration returns from inside a loop`             |

### `if` / `for` / `try` / `with`：整体搬移

语句边界取自语法树，不取自缩进：一个复合语句是**一个**节点，带完整范围。

```python
def check(x, items):
    if x < 0:
        raise ValueError("neg")
    for i in items:
        use(i)
    return x * 2
```

`y = check(a, b)` 内联后：

```python
while True:
    if a < 0:
        raise ValueError("neg")
    for i in b:
        use(i)
    y = a * 2
    break
```

搬移的是整段文本，缩进按「先减掉函数体缩进、再加回调用方缩进」重算，
所以调用点在模块级（缩进 0）或更深一层都成立。

### 为什么「`return` 落在函数体自己的循环里」要拒绝

```python
def f(xs):
    for x in xs:
        if x:
            return x        # 这里改成 break 会跳出 for，而不是外层 while
    return 0
```

`break` 只认最近的那层循环。把上面那个 `return` 改写成 `break`，跳出的是
`for x in xs`，外层 `while True:` 会接着跑下一轮 —— 死循环。

语法上可以解决（加结果标记 + 每层循环后判断），但那要求把 `break` 分类到
「跳出 wrapper」和「跳出自己的循环」两种，并重写每层循环的尾部。v1 不做，直接拒绝。

### 为什么「给参数赋值」要拒绝

```python
def f(x):
    x = x + 1
    return x
```

参数代入后 `x = a + 1` 会覆盖调用方的 `a`（如果实参是裸名）。语义完全不同，所以拒绝。
要支持得先引入临时变量保存实参 —— v1 不做。

## 五、参数与实参

| 场景                    | 拒绝原因                                                      |
| ----------------------- | ------------------------------------------------------------- |
| 调用展开了参数 `f(*xs)` | `the call unpacks its arguments`                              |
| 传的实参比形参多        | `the call passes more arguments than the declaration takes`   |
| 同一形参传两次          | `the call passes 'x' twice`                                   |
| 关键字标签不是形参名    | `the call passes an unknown keyword 'x'`                      |
| 实参无法对应到形参      | `the call's arguments could not be matched to the parameters` |
| 省略的形参没有默认值    | `the call does not pass 'x' and it has no default`            |

## 六、调用出现的位置

**形态 A（纯表达式）**：调用可以出现在任何表达式位置，直接替换成表达式。
但函数体还有声明（要被搬到调用语句之前）时，搬来的多行代码塞不进表达式，
所以调用必须自己占满一条语句，否则拒绝：`the call is part of an expression and its declaration has statements`。

**形态 B（整段搬移）**：调用必须占满一条语句，因为搬过来的是一段多行代码。

| 位置                                         | 形态 B                                |
| -------------------------------------------- | ------------------------------------- |
| `y = f(...)`（右侧就是整个调用，目标为裸名） | ✅                                    |
| `f(...)` 单独一行                            | ✅（返回值丢弃）                      |
| `return f(...)`                              | ✅（不包 `while`，`return` 直接保留） |
| `self.y = f(...)`、`d[k] = f(...)`           | ❌ 结果不是赋给裸名                   |
| `y = f(...) + 1`、`g(f(...))`、`f(...).attr` | ❌ 调用是更大表达式的一部分           |

两种拒绝原因：

| 场景                                    | 拒绝原因                                                                                           |
| --------------------------------------- | -------------------------------------------------------------------------------------------------- |
| 赋值目标是 `self.y` / `d[k]` / 元组解包 | `the declaration returns from more than one place and the call's result is not assigned to a name` |
| 调用是更大表达式的一部分                | `the declaration returns more than once and the call is part of a larger expression`               |

另外，整段搬移还要求：

| 场景                                              | 拒绝原因                                                                             |
| ------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `return` 和别的代码挤在同一行（`if x: return 1`） | `the declaration writes a return beside other code`                                  |
| 语句和别的代码挤在同一行（`y = f(a); z = 1`）     | `the declaration returns more than once and the call is part of a larger expression` |

### 为什么 `return f(a)` 不用包 `while`

搬过来的每条 `return` 本来就该从**调用方的函数**返回，和原来的 `return f(a)` 一样。
既不赋值也不跳转，就没有需要 `break` 的地方，也不受「循环里的 `return`」限制。

## 七、括号策略

只有形态 A 才需要考虑优先级：

| 调用位置                   | 是否包括号 |
| -------------------------- | ---------- |
| `y = f(a)`（赋值右侧整块） | 否         |
| `return f(a)`              | 否         |
| `g(f(a))`（实参）          | 否         |
| `y = f(a) + 1`             | **是**     |
| `y = f(a).attr`            | **是**     |

形态 B 的调用必然占满一条语句，`wrap` 总是 false。

## 八、实测覆盖率

CPython 标准库 13 个模块、175 个「本文件函数被调用」的位置：

| 版本                                            | 成功           | 原因                  |
| ----------------------------------------------- | -------------- | --------------------- |
| 只支持单 `return`                               | 3/52 = 5.8%    | —                     |
| 支持 `return` 前有声明                          | 6/52 = 11.5%   | 见下方五轮修复        |
| 语句边界取自语法树（`if`/`for`/`try` 整体搬移） | 20/175 = 11.4% | 样本变大 3.4 倍，见下 |
| 早返搬移（`while True:` + `break`）             | 36/175 = 20.6% | 见下                  |

前三行不可直接相比：第二行是 52 个位置的小样本，后两行是同一批模块的更大样本。
可比的量是拒绝分布。

五轮修复过程中暴露的真缺陷：

| #   | 缺陷                                     | 后果                                                              |
| --- | ---------------------------------------- | ----------------------------------------------------------------- |
| 1   | `vrtl == (2**31-1)` 被判成「给参数赋值」 | 误拒（只看后 2 个字符，`==` 被看成 `=`）→ 改用 `isWriteTarget`    |
| 2   | 多行 docstring 被当成「无法移动的语句」  | 误拒（`_aix_bos_rte` 这类函数全部中招）                           |
| 3   | 行尾注释让 `nodeAt` 返回整个 block       | 误拒（`out = ... # type: ignore`）                                |
| 4   | 按缩进分组，导致复合语句被判「有嵌套块」 | 误拒 21 个 → 改为逐行问语法树取节点完整范围                       |
| 5   | 用 `indexOf(":")` 找函数体起点           | 带注解的参数 `def f(x: int)` 全部误拒 → 改为找括号深度为 0 的冒号 |

**当前拒绝分布（175 个）**：

| 次数 | 原因                               |
| ---- | ---------------------------------- |
| 52   | 不在本文件声明                     |
| 28   | 没有 `return`（纯过程体）          |
| 17   | 带 `*args`/`**kwargs`              |
| 12   | 给参数赋值                         |
| 10   | 生成器                             |
| 7    | 调用是更大表达式的一部分（形态 B） |
| 7    | 调用在表达式里且有声明（形态 A）   |
| 5    | 结果不是赋给裸名（形态 B）         |
| 1    | 缩进不一致                         |

三条最保守的守卫在真实代码上代价为 **0**：「`return` 在循环里」、
「`return` 和别的代码同行」、「被自己的嵌套作用域重绑」各 0 次。

**结论：早返这一档把成功率从 11.4% 翻到 20.6%，且没有引入任何新的误拒。**
下一个大桶是「没有 `return` 的纯过程体」（28 个），那只需要把语句原样搬过去。

## 九、证据

| 结论                     | 出处                                           |
| ------------------------ | ---------------------------------------------- |
| 纯函数（参数/实参/括号） | `src/editor/refactor/inlineFunction.test.ts`   |
| 声明搬移 + 重名          | 同上（含「不覆盖调用方变量」的端到端用例）     |
| docstring 丢弃           | 同上                                           |
| `while True:` 早返搬移   | 同上（赋值 / 丢弃 / `return` 三种形态）        |
| 走到末尾补 `break`       | 同上（否则会死循环）                           |
| 循环里的 `return` 拒绝   | 同上                                           |
| 真机端到端               | `fixtures/python-app` 临时探针（验证后已删除） |

真机实测（形态 B，三条路径一次跑完）：

```python
def caller(n):
    label = classify(n)     ← 内联：三条 return 变成 while True + 三次 break
    return label

def caller2(n):
    return classify(n)      ← 内联：return 原样保留，不包 while

def caller3(n):
    h = half(n)             ← 内联：half 只在 if 里 return，末尾补 h = None; break
    return h
```

```
结果：
  真 Python 执行：内联前后输出完全一致（pos neg 3 None）
  Problems 面板 0 错误 0 警告
  一次 Ctrl+Z 还原
```

## 十、尚未实现

| IDEA 有、这里没有        | 为什么难                                                  |
| ------------------------ | --------------------------------------------------------- |
| 没有 `return` 的过程体   | 不难：语句原样搬过去即可（当前 28/175 卡在这里）          |
| `self.y = f(...)` 形式   | `self` 无副作用，判断一下就能放开（当前 5/175）           |
| 调用是更大表达式的一部分 | 需要引入临时结果变量，再把表达式改写成后续语句            |
| 参数被赋值               | 需要引入临时变量保存实参（当前 12/175）                   |
| `return` 在循环里        | 需要把 `break` 分类成「跳出 wrapper」和「跳出自己的循环」 |
| 跨文件内联               | 需要读另一个文档并处理 import                             |
| `obj.method()` 形式      | 需要 `self` 绑定和类层次分析                              |
