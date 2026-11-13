# PyForge

> 一个偏执的 Python IDE 实验：用 Rust + tree-sitter 重做 IDE 的骨架，
> 试着让「打开一个 Python 项目」这件事不再吃掉 2 GB 内存。

<p align="center">
  <img src="src-tauri/icons/source/pyforge.svg" alt="PyForge" height="72">
</p>

---

## ⚠️ 叠甲（请先读完这一段）

**这是测试阶段的个人实验项目，不是产品，也不建议你现在就替换掉手上的 PyCharm。**

- **本项目是修改版，不是原创 IDE。** 骨架来自开源项目
  [OpenIDEA](https://github.com/l0ng-ai/openidea)（Rust + Tauri + tree-sitter），
  交互范式参考 JetBrains PyCharm 的**公开行为**（快捷键、对话框布局、重构语义）。
  与 JetBrains 无任何关系，PyCharm / IntelliJ IDEA 是 JetBrains s.r.o. 的商标。
- **主要动机是缓解小职员的电脑内存占用。** 不是要做「更好的 PyCharm」，
  而是想验证「不启动 JVM 能不能也有像样的 Python 开发体验」。
- **大量功能是残缺的、删减的、或者干脆没有。** 见下方[已知不足](#已知不足)。
- **重构只做能从语法证明正确的那一部分**，其余**明确拒绝并给原因**，绝不静默
  生成可能错误的代码。所以「覆盖率」不高，这是设计取舍，不是 bug。
- **不承诺稳定性。** 可能丢设置、可能崩溃、可能改坏你的代码（重构前请确保已提交）。
- **欢迎一起改。** 提 issue、提 PR、指出我判断错的地方，都比「不好用」三个字有用得多。

如果你需要一个**现在就能用来上班**的 IDE：请用 PyCharm 社区版，或者直接用上游
[OpenIDEA](https://github.com/l0ng-ai/openidea)。本项目的价值目前只是
「证明这条路走得通」以及一份可复现的实测数据（见 [`docs/poc-report.md`](docs/poc-report.md)）。

---

## 为什么做这个

PyCharm 很强，但它跑在 JVM 上。一台 16 GB 的办公电脑，开着 PyCharm + Chrome +
几个后端服务，内存就告急了。

上游 OpenIDEA 已经证明了「Rust 内核 + tree-sitter + LSP」可以在 **169 MB** 下
打开一个 770 文件的 Python 项目（[上游 benchmark](https://github.com/l0ng-ai/openidea#benchmark)，
对比 IDEA 2011 MB）。

**但 OpenIDEA 的 Python 重构是不可用的**——它的重构菜单是把 LSP 的
`refactor.extract` / `refactor.inline` / `refactor.move` code action 转发给语言服务器，
而 Python 的四个主流服务器（basedpyright / pyright / ty / pyrefly）**一个都不提供这些
code action**。所以打开 Python 项目时，Extract Method 是灰的。

PyForge 做的事情就是：**把这些重构自己实现掉**，不再等服务器。

### 这个定位的代价，要先说清

**PyForge 不装语言服务器，也不做类型推断。** 它读的是语法树，不是类型。所以：

| 它做得到                 | 它做不到                                      |
| ------------------------ | --------------------------------------------- |
| 跳转、符号索引、结构视图 | `x: int = "s"` 这类**类型错误**不报           |
| 类 PyCharm 的语义高亮    | `obj.` 后面**没有成员补全**（除非能静态证明） |
| 语法错误（`def f(:`）    | 未使用导入 / 未定义变量                       |
| 6 个重构                 | 跨文件引用的精确符号绑定                      |

**这不是缺陷列表，是产品选择。** 好处是：不做推断就不会给出错误的建议；
代价是类型相关的能力没有。装了 basedpyright 可以补上，但内存从 170 MB 变成 700 MB 起，
省内存的初衷就没了。

所以准确地说，**这是一个懂语法、不懂类型的 Python 编辑器和重构工具**，
而不是「轻量版 PyCharm」。

---

## 内存这件事，必须说清楚

上游 169 MB 那个数字是**只做语法分析**时测的。一旦装上类型检查器，账就不一样了：

| 配置                 | 常驻内存         | 全量检查耗时   | 你能得到                                     |
| -------------------- | ---------------- | -------------- | -------------------------------------------- |
| **不装语言服务器**   | **约 170 MB**    | —              | 跳转、符号索引、语法高亮、语法错误、6 个重构 |
| 装 `ty`（Rust 写的） | 约 665 MB        | 2.4 s          | 类型检查，但 0.0.x 版本，动态装饰器支持存疑  |
| 装 `basedpyright`    | **约 700 MB 起** | 数十秒至数分钟 | 完整 PyCharm 级类型分析                      |

> `basedpyright` 的 700 MB 是**单个语言服务器进程**的数字（任务管理器里看到的就是它）。
> 大项目全量分析时整棵进程树会涨到 1.5 GB 以上——我实测过一个 2138 个 py 文件的后端，
> 稳态约 1.7 GB、峰值近 2.9 GB。所以这个区间取决于你项目的规模，**开大项目别指望省内存**。

**所以「省内存」和「PyCharm 级智能」是有冲突的**，两者不可兼得。本项目默认
**不自动安装**任何语言服务器，你要类型检查就自己装（Settings › Languages › Python）。

内存实测数字见 [`docs/poc-report.md`](docs/poc-report.md)，测试环境是 Windows 11 + 真项目
（Flask 后端 2137 个 py 文件 / Vue 2 前端 4160 个模块）。

---

## 实际有什么

### 六个 Python 重构（这是唯一实质性的独占能力）

全部**不依赖语言服务器**，直接基于 tree-sitter 的语法树 + 结构服务实现。

| 重构                     | 快捷键        | 实测覆盖率     | 说明                                                       |
| ------------------------ | ------------- | -------------- | ---------------------------------------------------------- |
| **Extract Method**       | `Ctrl+Alt+M`  | 91.7%          | 自由变量变参数，输出变返回值/元组                          |
| **Inline Variable**      | `Ctrl+Alt+N`  | 29.7%          | 只内联单次赋值；拒绝副作用重复                             |
| **Inline Method**        | `Ctrl+Alt+N`  | 78.0%          | 六档递进，含早返 `while True:`+`break`、`*args`/`**kwargs` |
| **Change Signature**     | `Ctrl+F6`     | 94.2%          | 追加带默认值参数；**跨文件**重命名参数                     |
| **Move**                 | `F6`          | 100%（识别率） | 同包内移顶层类/函数，重写 `from ... import`                |
| **Loop ↔ Comprehension** | Refactor 菜单 | 两向已实现     | list/set/dict、多子句；循环变量被后续读取时拒绝            |

覆盖率的分母是什么、为什么有些数字看起来低，全部写在
[`docs/poc-report.md`](docs/poc-report.md) 里，**没有粉饰**。

### Python 运行与调试

- **运行配置**：Python（脚本/模块）、Flask Server、FastAPI Server、pytest
- **调试**：debugpy，断点、变量面板（带类型）、调用栈、Step Over 均可用
- **解释器解析**：`commandLine()` 同步预览，`prepareLaunch` 启动前把裸 `python3`
  换成后端给出的绝对路径（Windows 上 `python3` 是 Store 占位符，会静默退出）

### 没有语言服务器也能用的功能

这套是上游就有的「dumb mode」回退，本项目沿用并扩展：

| 功能       | 降级行为                                                    |
| ---------- | ----------------------------------------------------------- |
| 跳转到定义 | tree-sitter + 符号索引；`obj.method` 只能给同名候选         |
| 语义高亮   | 类 PyCharm 分类色（局部变量/参数/实例属性/常量…）           |
| 语法错误   | tree-sitter 的 `ERROR`/`MISSING` 节点；服务器在跑时主动让位 |
| 查找引用   | 降级为「文本出现」，会在结果里标注                          |

---

## 已知不足

**这一节比上面长，是故意的。**

<details open>
<summary><b>功能缺失（有意删减）</b></summary>

- **JVM 相关全部隐藏**：Gradle / Maven / Spring Boot / Application / Tomcat /
  Remote JVM Debug 从「Add New Configuration」里移除，三个 JVM 设置页（Java/Gradle/Maven）
  已删除。底层模块仍在（没有用户可见入口），但你用不到。
- **自动探测运行配置已移除**：不再根据 `manage.py` / `pytest.ini` 猜你要跑什么。
  配置需要手写——这是故意的，PyCharm 也不会自动猜。
- **没有 Django Server 类型**（只有 `manage.py test` 那部分保留）。

</details>

<details open>
<summary><b>能力边界</b></summary>

- **重构只在 Python 上验证过**。其他语言（JS/TS/Java/Go…）没有做同类改造。
- **符号没有类型信息**。结构索引只存 `name / kind / container / range`，
  所以 `obj.method` 的跳转只能给候选列表，不能精确定位。
- **动态特性一律看不懂**：`getattr`、运行时生成的属性、`type()` 重建的类。
  典型例子是你项目里的 `@sql_func` / `@egg`（用 `inspect.getmembers` + `type()`
  重建类），加了这个装饰器的类在类型分析里退化成 `Any`，
  参数传错**不会报错**。PyCharm 同样如此，这是 Python 的固有代价。
- **重构的正确性靠「拒绝」保证**，不是靠「更聪明」。遇到没把握的情况会弹提示
  告诉你为什么不做，而不是猜一个结果给你。

</details>

<details open>
<summary><b>工程与稳定性</b></summary>

- **这是 fork，不是插件**。上游每发一版都要手动合；我改动约 37 个文件、
  跨 Rust 与 TS，且删/隐藏了 JVM 相关 UI，**每次同步都会冲突**。
- **测试基线里有预先存在的失败**：前端 `scripts/check-webkit.test.ts`（Windows 路径）
  与 `reviewDiff.test.tsx`（超时抖动）；Rust `ide-core`/`ide-sdk` 有 2 个 venv 测试。
  这些与本次改动无关，但确实没修。
- **只做了 Windows 验证**。macOS / Linux 理论可构建，但没测过。
- **release 构建很慢**：单 CGU + LTO，约 50–70 分钟，rustc 峰值 7.7 GB。
- **开发模式启动 35–45 秒**（vite 按需编译），release 约 2.4 秒。
- **设置可能丢**。改过应用 identifier（`ai.l0ng.pyforge` → `ai.pyforge.ide`），
  所以**与 OpenIDEA 的数据目录不互通**，首次启动是空的。

</details>

---

## 构建与运行

环境要求：**Rust**（stable）、**Node.js 22**、**pnpm**。
Windows 还需 WebView2（Win11 自带）。

```bash
# 依赖
pnpm install

# 开发（会先起 vite，再起 Tauri）
pnpm tauri dev

# 测试
pnpm vitest run                    # 前端
cargo test -p ide-run --lib         # Rust

# 发布构建（约 50–70 分钟）
pnpm tauri build
```

**注意**：Windows 下 `python3` / `python` 往往是 Microsoft Store 的占位别名，
调用会静默 exit 0。请确认 PATH 里是真正的 Python，或在运行配置里指定绝对路径。

语言服务器需要单独安装（不自动装）：

```bash
pip install basedpyright    # 或 uv tool install basedpyright
pip install debugpy         # 调试必需
```

---

## 文档索引

| 文档                                                                 | 内容                                                   |
| -------------------------------------------------------------------- | ------------------------------------------------------ |
| [`docs/poc-report.md`](docs/poc-report.md)                           | **总报告**：6 个重构的实测数据、拒绝原因分布、投入产出 |
| [`docs/identity.md`](docs/identity.md)                               | 为什么改名、哪些还叫 openidea、identifier 为何必须改   |
| [`docs/extract-method-python.md`](docs/extract-method-python.md)     | Extract Method 实现与边界                              |
| [`docs/inline-method-python.md`](docs/inline-method-python.md)       | Inline Method 六档递进的过程                           |
| [`docs/inline-variable-python.md`](docs/inline-variable-python.md)   | Inline Variable                                        |
| [`docs/change-signature-python.md`](docs/change-signature-python.md) | Change Signature                                       |
| [`docs/move-python.md`](docs/move-python.md)                         | Move 类/模块                                           |
| [`docs/loops-python.md`](docs/loops-python.md)                       | Loop ↔ Comprehension                                   |
| [`docs/python-run-configs.md`](docs/python-run-configs.md)           | Python / Flask / FastAPI 运行配置                      |
| [`docs/extract-method-batch.md`](docs/extract-method-batch.md)       | 批量验证方法与原始数据                                 |

---

## 关于上游与许可

本项目基于 [OpenIDEA](https://github.com/l0ng-ai/openidea)（Apache 2.0）修改。
上游是一个相当完整的 IDE（60+ 语言、数据库、HTTP、Git、终端、插件系统），
这些能力**都不是我做的**，请把赞誉给上游。

- License: [Apache 2.0](LICENSE)
- 第三方资源见 [`THIRD_PARTY_LICENSES.md`](THIRD_PARTY_LICENSES.md)
- **非官方项目**，与 OpenIDEA 团队、JetBrains 均无隶属关系
- 上游的 [Discord](https://discord.gg/2Zy4yn7gP) 和 issue 区适合问
  **IDE 本身**的问题；只有「这 6 个重构」的问题才适合提到本项目

---

## 想一起优化？

这个项目最需要帮助的地方，按优先级：

1. **在更多真实项目上跑，把拒绝的原因贴出来**——最想知道「哪些该支持但被拒了」
2. **补语法级智能的短板**：`obj.method` 的候选排序、可证明情况下的成员补全
3. **修预先存在的测试失败**（上面列的那些）
4. **macOS / Linux 验证**

重构和补全的实现原则只有一条，改动时请遵守：

> **只做能从语法证明正确的变换。证明不了就拒绝，并告诉用户为什么。**

宁可少做一次重构，也不生成一次错代码。
