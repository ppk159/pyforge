# Change Signature（Python，语法级）—— 支持范围与拒绝清单

适用于 `src/editor/refactor/changeSignature.ts`：语言服务器做不了时，光标在函数声明上按 `Ctrl+F6` 走的路径。
服务器可用时由 `refactor.rewrite` 回答，本文的规则不适用。

## v1 支持两种变更

| 变更                   | 为什么安全                                                                             |
| ---------------------- | -------------------------------------------------------------------------------------- |
| **追加带默认值的参数** | 已有调用点全部不受影响：位置参数仍按位绑定，关键字参数不变                             |
| **重命名参数**         | 签名和函数体跟着改；**按关键字传参的调用点**跟着改；位置调用点按位置绑定，本来就不用改 |

两种都是能从语法上**证明**不破坏调用方的变更。其余（改顺序、删参数、加无默认值参数）都会改变调用点的含义，一律拒绝。

## 一、语言与服务前提

| 条件                        | 拒绝原因                                                       |
| --------------------------- | -------------------------------------------------------------- |
| 语言不是 Python             | `Change Signature needs the language server for this language` |
| 该语言没有 tree-sitter 语法 | `Change Signature needs the language server here`              |
| 文件只读                    | `Cannot perform refactoring: the file is read-only`            |
| 视图里没有文档              | `no document`                                                  |
| 文档在编辑期间变了          | `the document changed`                                         |

## 二、光标位置与签名形态

| 场景                        | 拒绝原因                                    |
| --------------------------- | ------------------------------------------- |
| 光标不在函数声明上          | `place the caret on a function declaration` |
| 声明无法读取                | `the declaration could not be read`         |
| 声明没有参数列表            | `the declaration has no parameter list`     |
| 参数列表括号不匹配          | `the parameter list is not closed`          |
| 声明没有签名（找不到 `:`）  | `the declaration has no signature`          |
| 参数名读不出来              | `a parameter name could not be read`        |
| 声明带 `*args` / `**kwargs` | `the declaration takes *args or **kwargs`   |

## 三、追加参数

| 场景               | 拒绝原因                                                         |
| ------------------ | ---------------------------------------------------------------- |
| 名字不是合法标识符 | `'1b' is not a valid parameter name`                             |
| 与已有参数重名     | `the declaration already has a parameter 'x'`                    |
| 没有给默认值       | `a new parameter needs a default so existing calls keep working` |

## 四、重命名参数

| 场景                           | 拒绝原因                                       |
| ------------------------------ | ---------------------------------------------- |
| 声明里没有这个参数             | `the declaration has no parameter 'x'`         |
| 新名字不是合法标识符           | `'1b' is not a valid parameter name`           |
| 新名字与已有参数重名           | `the declaration already has a parameter 'y'`  |
| 新名字在函数体里已经被用       | `'y' is already used in this function`         |
| 参数无法解析（拿不到它的引用） | `the parameter 'x' could not be resolved`      |
| 参数在函数体里被遮蔽           | `'x' is shadowed inside the body`              |
| 其他文件的出现位置读不到       | `the occurrences of 'x' could not be read (…)` |

### 关键字传参 vs 位置传参

这是重命名唯一需要小心的地方：

```python
def f(a, b):
    return a + b

f(1, 2)        ← 位置传参：按位置绑定，不用改
f(1, b=2)      ← 关键字传参：标签 b= 要跟着改
```

作用域服务的 `IdentifierOccurrence.role` 直接给出答案：

| role              | 含义                         | 重命名时               |
| ----------------- | ---------------------------- | ---------------------- |
| `keywordArgument` | `f(x=1)` 里的标签 `x`        | **改**                 |
| `parameter`       | 签名里的形参                 | 改（整条签名一起替换） |
| `other`           | 普通引用、位置实参、局部变量 | 看是否在函数体内       |

函数体内的引用用 `locals()` 取，而不是靠同名文本匹配——否则会把**别的函数**里的同名局部变量也改掉。

## 五、能做什么

| 场景                         | 结果                                            |
| ---------------------------- | ----------------------------------------------- |
| `def f(a, b)` + `c=0`        | `def f(a, b, c=0)`                              |
| `def f()` + `c=0`            | `def f(c=0)`                                    |
| `def f(a: int)` + `b=1`      | `def f(a: int, b=1)`                            |
| `def f(a, b=(1, 2))` + `c=0` | `def f(a, b=(1, 2), c=0)`——默认值里的逗号不误切 |
| `def f(a: int) -> int:`      | 返回值注解保留，只在参数列表尾部插入            |
| 重命名 `a` → `alpha`         | 签名 + 函数体 + **所有文件里**的关键字调用点    |

参数列表的解析用括号深度计数，所以 `b=(1, 2)`、`b=g(1, 2)` 不会被切成两段。

签名范围的判定按括号深度找第一个顶层 `:`，并跳过字符串字面量，所以
`def f(a: int) -> int:` 会在 `-> int` 之后收住，不会误停在注解里的 `:`。

## 六、应用方式：一个 workspace edit

两种变更都产出一个 `WorkspaceEdit`，经 `prepare_workspace_edit`（记录文件指纹）后
`apply_workspace_edit` 应用。所以：

- 重命名跨多个文件时是**一次原子操作**
- 走的是和文件移动同一个撤销历史，一次 `Ctrl+Z` 全部还原
- 应用前会校验文件指纹，文件在计算期间被改过就拒绝

## 七、生成结果

```python
# 追加参数
def report(items, labels):                def report(items, labels, sep=", "):
    return f"{labels}: {len(items)}"  →       return f"{labels}: {len(items)}"

def caller(items, labels):                def caller(items, labels):       # 没变
    return report(items, labels)              return report(items, labels)

# 重命名参数
def f(a, b):                              def f(alpha, b):
    return a + b                      →       return alpha + b

f(1, b=2)                                 f(1, b=2)    # 位置实参 1 不用改
f(b=2, a=1)                               f(b=2, alpha=1)
```

| 细节     | 行为                                              |
| -------- | ------------------------------------------------- |
| 调用点   | 追加时不改；重命名时只改关键字标签                |
| undo     | 一次 `Ctrl+Z`（workspace edit 历史）              |
| 编辑之后 | Problems 面板保持为空（实测：9 秒 0 错误 0 警告） |

## 八、为什么其余的拒绝

| 变更                   | 为什么拒绝                                         |
| ---------------------- | -------------------------------------------------- |
| 追加**无**默认值的参数 | 所有已有调用点都会缺这个参数 → 全部失效            |
| 删除参数               | 所有传入它的调用点都要改，且要判断是位置还是关键字 |
| 改参数顺序             | 每个位置参数的调用点都要重排，风险最高             |
| 改默认值               | 语义变了但看不出来，需要用户确认；这里不做         |

## 九、证据

| 结论                             | 出处                                                       |
| -------------------------------- | ---------------------------------------------------------- |
| 参数列表解析、签名范围、改名计划 | `src/editor/refactor/changeSignature.test.ts`（22 个用例） |
| `role` 的判定                    | `crates/ide-syntax/src/tests/locals_langs.rs`（2 个用例）  |
| 真机端到端                       | `fixtures/python-app` 的临时探针（验证后已删除）           |

真机实测（追加参数）：

```
追加 sep=", "   → def report(items, labels, sep=", ")
重名 items      → 拒绝：the declaration already has a parameter 'items'
无默认值        → 拒绝：a new parameter needs a default so existing calls keep working
非法名 1z       → 拒绝：'1z' is not a valid parameter name

生成文件被真 Python 执行：
  caller([1,2], "n") == 'n: 2'    ← 调用点未改，仍然正确
Problems 面板 9 秒 0 错误 0 警告
```

## 十、下一阶段

| 能力             | 需要什么                                             |
| ---------------- | ---------------------------------------------------- |
| 删除参数         | 关键字/位置调用点分类（`role` 已具备），加默认值回填 |
| 改顺序           | 每个调用点的实参重排，处理解包与关键字混用           |
| 追加无默认值参数 | 所有调用点补参数                                     |
| 改默认值         | 需要用户确认的交互，不是纯语法判断                   |
