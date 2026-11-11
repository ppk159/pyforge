# Loop ↔ Comprehension（Python，语法级）

适用于 `src/editor/refactor/loops.ts`：语言服务器不提供这两个转换，`Refactor` 菜单里
`Convert Comprehension to Loop` / `Convert Loop to Comprehension` 走的都是这个模块。

## 为什么两个方向的门槛不一样

**推导式说的是确定的**：`[f(x) for x in items if p(x)]` 每个元素最多加一次，不会
`break`，除了目标集合不碰别的名字。把它改写成循环是机械的——循环就是「每个通过
测试的元素加一次」，这正是推导式已经在做的事。

**循环说的少得多**：把它改写成推导式，只有在循环体**除了那一次加入之外什么都没有**时
才成立。`break`、第二条语句、`else` 子句、写别的名字，都会改变推导式的含义。

还有一个方向不对称：循环变量在循环之后**仍然存在**，而推导式的变量在自己的作用域里，
转换之后就不存在了。所以循环之后还读循环变量时，转换是错的。

## 一、推导式 → 循环

```python
squares = [x * x for x in items if x > 0]
```

```python
squares = []
for x in items:
    if x > 0:
        squares.append(x * x)
```

| 推导式       | 初始化         | 每个元素         |
| ------------ | -------------- | ---------------- |
| `[...]`      | `name = []`    | `name.append(v)` |
| `{...}`      | `name = set()` | `name.add(v)`    |
| `{k: v ...}` | `name = {}`    | `name[k] = v`    |

多个 `for` 逐层嵌套，每个 `for` 后面的 `if` 跟在那一层里：

```python
pairs = [(a, b) for a in xs for b in ys if b]
```

```python
pairs = []
for a in xs:
    for b in ys:
        if b:
            pairs.append((a, b))
```

### 拒绝

| 场景                                         | 拒绝原因                                                           |
| -------------------------------------------- | ------------------------------------------------------------------ |
| 语言不是 Python                              | `Loop ↔ Comprehension needs the language server for this language` |
| 该语言没有 tree-sitter 语法                  | `Loop ↔ Comprehension needs the language server here`              |
| 光标不在推导式上                             | `place the caret on a list, set or dict comprehension`             |
| 括号不成对                                   | `the comprehension is not bracketed`                               |
| 子句切不开                                   | `the comprehension's clauses could not be read`                    |
| 字典项的冒号找不到                           | `the dictionary entry could not be read`                           |
| 推导式不是 `name = …` 的整个右侧             | `assign the comprehension to a name first`                         |
| 目标不是裸名（`d[k] = […]`、`self.x = […]`） | `assign the comprehension to a plain name first`                   |

**为什么目标必须是裸名**：循环是往一个已经存在的集合里加东西。`d[k] = [x for …]`
里的 `d[k]` 每次取子集合都可能不同，写成循环要先求一次下标再持有它，语义就不一样了。

## 二、循环 → 推导式

```python
squares = []
for x in items:
    if keep(x):
        squares.append(x * x)
```

```python
squares = [x * x for x in items if keep(x)]
```

### 条件（全部满足才转换）

1. 循环**紧跟在** `name = []` / `name = set()` / `name = {}` 后面，同一个缩进。
2. 循环体只有「若干层 `if` + 最后一次加入」。
3. 加入的形式与集合类型一致：list 用 `.append`，set 用 `.add`，dict 用 `name[k] = v`。
4. 循环体里没有 `break` / `continue` / `return` / `yield` / `await`。
5. 循环没有 `else` 子句。
6. 循环之后不再读循环变量。

### 拒绝

| 场景                                                   | 拒绝原因                                                    |
| ------------------------------------------------------ | ----------------------------------------------------------- |
| 光标不在 `for` 上                                      | `place the caret on a for loop`                             |
| 循环头读不出来                                         | `the loop's header could not be read`                       |
| 循环目标是元组解包（`for a, b in …`）                  | `the loop's target is not a plain name`                     |
| 有 `else` 子句                                         | `the loop has an else clause`                               |
| 含 `break` / `continue` / `return` / `yield` / `await` | `the loop contains 'break'`（消息里带具体词）               |
| 缩进不是一层的整数倍                                   | `the loop's body is indented inconsistently`                |
| 循环体不是「若干 if + 一次加入」                       | `the loop's body is not a single append`                    |
| 上面一行不是空集合                                     | `the loop does not follow an empty collection`              |
| 加入的集合不是构建的集合                               | `the loop appends to a different collection than it builds` |
| 字典循环的加入不是 `d[k] = v`                          | `the loop's append is not a dictionary entry`               |
| 循环之后还读循环变量                                   | `the loop variable 'x' is read after the loop`              |

**为什么「循环变量之后还被读」必须拒绝**：

```python
out = []
for x in items:
    out.append(x)
return x          ← 这里读到的是循环最后一次的 x
```

推导式把它变成 `out = [x for x in items]`，而推导式的 `x` 在结束后就不存在了，
`return x` 会直接 `NameError`。

**为什么「必须紧跟在空集合后面」**：推导式一次把整个集合建出来。如果集合在循环前
已经有内容（`out = [1]`），或者中间隔着别的语句，那个内容会被推导式覆盖掉。

**顺序不会变**：推导式按同样的顺序遍历同样的元素，`append` 也只对被 `if` 放行的
元素执行一次。所以改成推导式不改变任何可观察的结果——除了上面那两条。

## 三、实测

| 项目     | 结果                                                                    |
| -------- | ----------------------------------------------------------------------- |
| 单元测试 | `src/editor/refactor/loops.test.ts`（16 个）                            |
| 真机     | `fixtures/python-app/src/tasks/_cv.py` 临时探针（验证后删除）           |
| 语义     | 四个函数（list / set / dict / 循环→推导式）转换前后 Python 输出逐字一致 |

真机实测记录：

```
squares   [x * x for x in items if x > 0]  →  out = [] / for / if / append
seen_set  {x for x in items}               →  got = set() / for / add
index_of  for k in keys: d[k] = len(k)     →  d = {k: len(k) for k in keys if k.strip()}
doubled   for x in items: out.append(x*2)  →  out = [x * 2 for x in items]

转换前后 py 执行：[1, 9] {1, 2} {'a': 1, 'bb': 2} [2, 4]   ← 完全一致
Problems 面板：0 错误 0 警告
一次 Ctrl+Z 还原
```

## 四、尚未实现

| 场景                         | 为什么难                                                       |
| ---------------------------- | -------------------------------------------------------------- |
| 生成器表达式 ↔ 循环          | 生成器是惰性的，循环是立即执行的，改写会改变求值时机           |
| `if` / `else` ↔ 条件表达式   | 需要语句有赋值目标，且两个分支都要产出同一个名字               |
| `for` ↔ `while`              | `while` 没有迭代对象，需要证明终止与递增                       |
| 推导式 → `map` / `filter`    | 需要判断函数引用的纯净性与参数顺序                             |
| 嵌套推导式的合并不是一次一条 | 多子句已支持，但 `[[y for y in r] for r in rows]` 是两层推导式 |
