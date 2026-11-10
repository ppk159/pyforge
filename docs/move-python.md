# Move（Python，语法级）—— 支持范围与拒绝清单

适用于 `src/editor/refactor/move.ts`：语言服务器做不了时 `F6` 走的路径。
服务器可用时由 `refactor.move` 回答，本文的规则不适用。

## v1 只做「同包内的顶层声明移动」

```python
# models.py
from __future__ import annotations
from dataclasses import dataclass

@dataclass
class Widget:
    name: str

class Other:
    pass
```

选中 `Widget` → `F6` → 目标模块 `extra`：

```python
# extra.py（原来只有 Existing）
from __future__ import annotations

from dataclasses import dataclass      ← 移动的代码需要的 import 跟着走


@dataclass                              ← 装饰器一起移动
class Widget:
    name: str


class Existing:
    pass
```

```python
# models.py
from __future__ import annotations
from dataclasses import dataclass

class Other:
    pass
```

```python
# user.py
from .extra import Widget              ← from ._mv_src 改成 .extra
```

**为什么限定同包**：包内相对导入的层级不变（`from .x` 还是 `from .x`），
不需要改任何 `__init__.py`，也不需要重算 `from ..x` 的深度。

## 一、语言与服务前提

| 条件 | 拒绝原因 |
|---|---|
| 语言不是 Python | `Move needs the language server for this language` |
| 该语言没有 tree-sitter 语法 | `Move needs the language server here` |
| 文件只读 | `Cannot perform refactoring: the file is read-only` |
| 视图里没有文档 | `no document` |
| 文档在编辑期间变了 | `the document changed` |

## 二、光标与声明形态

| 场景 | 拒绝原因 |
|---|---|
| 光标不在类或函数上 | `place the caret on a class or function declaration` |
| 声明读不出来 | `the declaration could not be read` |
| 声明是嵌套的（类里的方法、函数里的函数） | `the declaration is nested; only a top-level class or function can be moved` |
| 声明有缩进 | `the declaration is indented; only a top-level class or function can be moved` |
| 声明的名字读不出来 | `the declaration's name could not be read` |

## 三、目标模块

| 场景 | 拒绝原因 |
|---|---|
| 目标和源是同一个文件 | `the destination is the same module` |
| 目标在另一个包 | `the destination is in another package` |
| 目标是 `__init__.py` | `moving into __init__.py is not supported` |
| 目标读不出来 | `the destination could not be read: <path>` |
| 目标里已有同名声明 | `'X' is already defined in <module>` |

### 为什么 `__init__.py` 要拒绝

把类搬进包的 `__init__.py` 会让所有 `from .pkg import X` 的形式变成
`from .pkg import X`（从包本身导入），但同时改变了这个包被导入时的行为——
包被 import 就会执行类定义。这需要判断每个调用点的语义，超出 v1 能证明的范围。

## 四、引用形态

| 场景 | 拒绝原因 |
|---|---|
| 有地方用 `<module>.<name>` | `<module>.<name> is used in <file>` |
| 没有任何地方 `from <module> import <name>` | `nothing imports 'X' from .<module>` |

### 为什么 `<module>.<name>` 要拒绝

```python
import tasks.models

x = tasks.models.Widget(...)
```

这种写法要改成 `tasks.extra.Widget`，还要判断 `tasks.models` 这个 import 是否还有别的用途
（没有就得删掉）。v1 不做这个判断，直接拒绝。

### 为什么「没人 import」也要拒绝

那说明这个符号只有定义、没人用，或者用的方式 v1 理解不了。此时搬走等于让它从视野里消失。
拒绝比沉默更安全。

## 五、随行内容

| 内容 | 行为 |
|---|---|
| 装饰器（`@dataclass` 等） | **一起移动**（属于用户看到的声明） |
| 声明里用到的 import | **复制到目标文件**（目标已有的不重复） |
| `from __future__ import …` | **总是复制**（去掉会改变注解语义） |
| 不相关的 import（如 `import os`） | 不复制 |

判定方式：看 import 行绑定的名字有没有出现在移动的代码里。

## 六、格式

插入位置在目标的 import 块之后，间距按 PEP 8：

- 移动的代码自带的 import 接在现有 import 后面，空一行
- 声明前**两个空行**
- 声明后**两个空行**（与后面的内容分隔）

不会产生三个以上连续空行。

## 七、应用方式

产出一个 `WorkspaceEdit`，经 `prepare_workspace_edit`（记录文件指纹）后
`apply_workspace_edit` 应用：

- **三个文件的修改是一次原子操作**
- 走和文件移动同一个撤销历史，一次 `Ctrl+Z` 全部还原（实测）
- 应用前校验文件指纹，计算期间文件被改过就拒绝

## 八、证据

| 结论 | 出处 |
|---|---|
| 路径/import/间距等纯函数 | `src/editor/refactor/move.test.ts`（27 个用例） |
| 真机端到端 | `fixtures/python-app` 的三个临时模块（验证后已删除） |

真机实测：

```
选中 models 里的 Widget，目标 extra
  extra.py   ← from dataclasses import dataclass + @dataclass class Widget
  _mv_src.py ← Widget 移除，Other 保留
  _mv_user.py ← from ._mv_src import Widget  →  from .extra import Widget

真 Python 验证：
  tasks.extra.Widget             存在
  tasks._mv_user.build('w')      返回 Widget(name='w')
  tasks._mv_src 已无 Widget      True
  tasks._mv_src.Other 还在       True

Problems 面板 9 秒 0 错误 0 警告
一次 Ctrl+Z 三个文件全部还原
```

## 九、下一阶段

| 能力 | 需要什么 |
|---|---|
| 跨包移动 | 重算相对导入深度，改 `__init__.py` |
| 移动方法到另一个类 | 判断 `self` 的使用，可能需要提取为函数 |
| 移动进 `__init__.py` | 判断包级导入的副作用 |
| `<module>.<name>` 形式 | 连同 `import <module>` 语句一起判断和清理 |
| 移动后删除无用 import | 需要判断源文件里还有没有别的符号用这个 import |
| 移动整个模块（文件） | 已有 `refactor_move_files`（Rust 侧），与本篇不同 |
