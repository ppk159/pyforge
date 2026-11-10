# Inline Method（Python，语法级）—— 支持范围与拒绝清单

适用于 `src/editor/refactor/inlineFunction.ts`：语言服务器做不了时，光标在函数调用上按 `Ctrl+Alt+N` 走的路径。
服务器可用时由 `refactor.inline` 回答，本文的规则不适用。

## 支持的函数体形态

函数体必须是「若干条 `name = value` 声明，然后一条 `return 表达式`」：

```python
def tag(vrtl, bd):
    """Return the tag."""
    _sz = 32 if vrtl == (2**31 - 1) else 64
    _bd = bd if bd != 0 else 9988
    return f"{vrtl}-{_bd}-{_sz}"
```

内联后：

```python
a = 1
b = 0
_sz = 32 if a == (2**31 - 1) else 64
_bd = b if b != 0 else 9988
x = f"{a}-{_bd}-{_sz}"
```

| 项 | 说明 |
|---|---|
| 参数 | 按实参代入；省略的参数用自己的默认值 |
| `return 表达式` | 替换调用处 |
| `return` 前的声明 | **搬到调用语句之前**，按调用处缩进 |
| docstring | **丢弃而不搬**（移过去没有意义） |
| 行尾注释 | 丢弃 |

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
| 被调的不是裸函数名 | `the call is not to a plain function name` |
| 调用没有参数列表 | `the call has no argument list` |

## 三、被调用的函数

| 场景 | 拒绝原因 |
|---|---|
| 不在本文件声明 | `'name' is not declared in this file` |
| 声明读不出来 | `the declaration could not be read` |
| 声明没有函数体 | `the declaration has no body` |
| 声明没有参数列表 | `the declaration has no parameter list` |
| 参数列表括号不匹配 | `the parameter list is not closed` |
| 参数名读不出来 | `a parameter name could not be read` |
| 带 `*args` / `**kwargs` | `the declaration takes *args or **kwargs` |
| 调用在自己的声明里（递归） | `the call is inside its own declaration` |

## 四、函数体的形态

| 场景 | 拒绝原因 |
|---|---|
| 有装饰器 | `the declaration is decorated` |
| 是 `async def` | `the declaration is a coroutine` |
| 含 `yield` | `the declaration is a generator` |
| 含 `await` | `the declaration is a coroutine` |
| **有嵌套块**（`if` / `for` / `try` / `with` / 内层 `def`） | `the declaration has a nested block` |
| 缩进不一致 | `the declaration is not indented` |
| docstring 没闭合 | `the declaration has an unterminated docstring` |
| `return` 前有 `raise`/`assert`/`del`/`import` 等 | `the declaration does more than declare locals and return` |
| `return` 前有本范围处理不了的语句（如元组解包 `a, b = …`、`out.x = …`） | `the declaration has a statement this scope cannot move` |
| 最后一条语句不是 `return` | `the declaration ends without a return` |
| 多个 `return` | `the declaration returns from more than one place` |
| 没有 `return` 或 `return` 后为空 | `the declaration returns nothing` |
| 给参数赋值 | `the declaration assigns to its parameter 'x'` |

### 为什么「有嵌套块」要拒绝

```python
def _type_repr(obj):
    if isinstance(obj, GenericAlias):
        return repr(obj)
    return repr(type(obj))
```

把这段搬进调用方意味着**复制整个控制流**，并且要把每个 `return` 改写成对目标的赋值。
这是「内联带控制流的函数」的另一个量级，不在 v1 内。

### 为什么「给参数赋值」要拒绝

```python
def f(x):
    x = x + 1
    return x
```

参数代入后 `x = a + 1` 会覆盖调用方的 `a`（如果实参是裸名）。语义完全不同，所以拒绝。

## 五、参数与实参

| 场景 | 拒绝原因 |
|---|---|
| 调用展开了参数 `f(*xs)` | `the call unpacks its arguments` |
| 传的实参比形参多 | `the call passes more arguments than the declaration takes` |
| 同一形参传两次 | `the call passes 'x' twice` |
| 关键字标签不是形参名 | `the call passes an unknown keyword 'x'` |
| 实参无法对应到形参 | `the call's arguments could not be matched to the parameters` |
| 省略的形参没有默认值 | `the call does not pass 'x' and it has no default` |

## 六、调用出现的位置

函数体只有一条 `return` 时，调用可以出现在任何表达式位置（直接替换成表达式）。
**函数体有声明时**，调用必须是：

| 位置 | 允许 |
|---|---|
| `x = f(...)`（赋值右侧整块） | ✅ |
| `f(...)` 单独一行 | ✅ |
| `return f(...)` | ✅ |
| `y = f(...) + 1`、`g(f(...))`、`f(...).attr` | ❌ `the call is part of an expression and its declaration has statements` |

因为多行声明塞不进一个表达式。

## 七、括号策略

只有单表达式体才需要考虑优先级：

| 调用位置 | 是否包括号 |
|---|---|
| `y = f(a)`（赋值右侧整块） | 否 |
| `return f(a)` | 否 |
| `g(f(a))`（实参） | 否 |
| `y = f(a) + 1` | **是** |
| `y = f(a).attr` | **是** |

有声明时，调用必然在语句位置，`wrap` 总是 false。

## 八、实测覆盖率

CPython 标准库 20 个模块、52 个「本文件函数被调用」的位置：

| 版本 | 成功 | 原因 |
|---|---|---|
| 只支持单 `return` | 3/52 = 5.8% | — |
| 支持 `return` 前有声明 | 6/52 = 11.5% | 见下方四轮修复 |

四轮修复过程中暴露的真缺陷：

| # | 缺陷 | 后果 |
|---|---|---|
| 1 | `vrtl == (2**31-1)` 被判成「给参数赋值」 | 误拒（只看后 2 个字符，`==` 被看成 `=`）→ 改用 `isWriteTarget` |
| 2 | 多行 docstring 被当成「无法移动的语句」 | 误拒（`_aix_bos_rte` 这类函数全部中招） |
| 3 | 行尾注释让 `nodeAt` 返回整个 block | 误拒（`out = ... # type: ignore`） |

**最终拒绝分布（52 个）**：

| 次数 | 原因 |
|---|---|
| 21 | 有嵌套块（`if`/`for`/`try`）——真实的控制流 |
| 4 | 带 `*args` |
| 4 | 生成器 |
| 2 | 无法移动的语句（元组解包等） |
| 2 | 没有 `return` |
| 11 | 不在本文件声明 |
| 2 | 调用在表达式里且有声明 |
| ~6 | 其他 |

**结论：真实瓶颈是控制流（21/52），不是「`return` 前有语句」。**
把「`return` 前有声明」做完只从 5.8% 提到 11.5%，因为标准库的小函数大多带分支。
下一步要提升，必须做「内联带控制流的函数」，那是另一个量级。

## 九、证据

| 结论 | 出处 |
|---|---|
| 纯函数（参数/实参/括号） | `src/editor/refactor/inlineFunction.test.ts` |
| 声明搬移 + 重名 | 同上（含「不覆盖调用方变量」的端到端用例） |
| docstring 丢弃 | 同上 |
| 真机端到端 | `fixtures/python-app` 临时探针（验证后已删除） |

真机实测：

```
def tag(vrtl, bd):
    _sz = 32 if vrtl == (2**31-1) else 64
    _bd = bd if bd != 0 else 9988
    return f"{vrtl}-{_bd}-{_sz}"

a = 1; b = 0
before = tag(a, b)
x = tag(a, b)          ← 内联

结果：
  真 Python 执行：before == x == "1-9988-64"   （完全等价）
  调用方已有的 _sz 保留，搬过去的改名为 _sz_1
  Problems 面板 9 秒 0 错误 0 警告
  一次 Ctrl+Z 还原
```

## 十、尚未实现

| IDEA 有、这里没有 | 为什么难 |
|---|---|
| 带控制流的函数体 | 要把 `if`/`for`/`try` 复制到调用方，并把每个 `return` 改写成赋值 |
| 多个 `return` | 同上，且需要引入"结果"变量和标记 |
| 跨文件内联 | 需要读另一个文档并处理 import |
| `obj.method()` 形式 | 需要 `self` 绑定和类层次分析 |
| 参数被赋值 | 需要引入临时变量保存实参 |
