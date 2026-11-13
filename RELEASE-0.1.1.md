# PyForge 0.1.1

**测试版，不是产品。** 基于 [OpenIDEA](https://github.com/l0ng-ai/openidea)（Apache 2.0）修改的
Python IDE 实验版，目标只有一个：验证「不启动 JVM 也能有像样的 Python 开发体验」。

这个版本把上一版里还留着上游名字的地方全部换掉了，并且让它在**不装任何语言服务器**的
情况下能回答更多问题。

---

## 相对 0.1.0 的变化

### 1. 彻底改名为 PyForge

上一版只是改了产品名，代码里到处还是 `openidea`。这一版全部清理（942 个文件）：

| 之前 | 现在 |
| --- | --- |
| crate `openidea` / `openidea_lib` | `pyforge` / `pyforge_lib` |
| 项目配置目录 `.openidea/` | **`.pyforge/`** |
| 工具清单 `.openidea-tool.json` | `.pyforge-tool.json` |
| 日志 `openidea.log` | `pyforge.log` |
| 插件 CLI `openidea-plugin` | `pyforge-plugin` |
| 浏览器 local storage 键 `openidea.*` | `pyforge.*` |
| 图标 | 新的蓝绿面板 + `pf` |

**升级注意**：`.openidea/` 里的运行配置**不会自动迁移**。如果想保留，手动复制：

```bash
cp .openidea/run.local.toml .pyforge/
cp .openidea/settings.toml  .pyforge/
```

### 2. 「语法级智能」变强了

不装 basedpyright 也能用，而且比上一版准得多：

| 功能 | 之前 | 现在 |
| --- | --- | --- |
| **跳转到定义** | `obj.method` 给一堆同名候选 | 按 `import` 语句和 `x = ClassName()` 排优先级 |
| **文档悬停** | 没有 | 显示定义处的 docstring |
| **高亮引用** | 只高亮局部变量 | 也高亮 import 进来的名字、`self.属性` |
| **成员补全** | 没有 | 能证明类型时列出成员 |

**具体到你这个场景**：

```python
from ...service.plan_service import plan_service
...
plan_service.get_plan_detail(req.plan_id)   # ← 悬停有文档，Ctrl+点击跳到 plan_service.py
```

以前会跳到 `controller.py` 里同名的另一个方法（签名都不一样）。

**「能证明」的含义**：

| 写法 | 补全 |
| --- | --- |
| `x = ClassName()` 然后 `x.` | ✅ 该类的成员 |
| `self.` 在类体内 | ✅ 当前类的成员 |
| `from a import mod` 然后 `mod.` | ✅ 该模块的顶层名字 |
| `x = some_call()` 然后 `x.` | ❌ 不猜 |
| `def f(x):` 然后 `x.` | ❌ 不猜 |

**刻意不给猜测的答案**。空的列表比错的列表有用。

### 3. 多窗口共享项目

拖一个标签到窗口外，现在会：

| | 之前 | 现在 |
| --- | --- | --- |
| 新窗口 | 重新索引整个项目（1–3 秒） | **共享索引，几乎瞬间** |
| 界面 | 完整项目窗口 | **单文件窗口**（无项目树、标题不显示项目名）|
| 标签 | 恢复了原窗口的所有标签 | **只有这一个** |
| 跳转/重构 | — | ✅ 因为共享索引，全部可用 |

两个窗口编辑同一个文件时，也不会再各自持有一份文档互相覆盖。

### 4. 其他

- **Flask / FastAPI / Django 各有自己的图标**，不再共用 Python 那个。
- 启动画面用新图标（上一版的 logo 在画面里溢出了）。
- 加了 CI：每次提交自动跑类型检查、lint、格式、8908 个前端测试、Rust 测试和 clippy。

---

## 安装和运行

下载 `pyforge.exe`（便携版），双击即可，**不需要安装**。

### ⚠️ 使用前必读

**未签名** — Windows SmartScreen 会拦截，点「更多信息」→「仍要运行」。

**需要 WebView2**
- Windows 11：自带
- Windows 10：可能没有，缺了会闪退

检查：
```powershell
Get-ItemProperty "HKLM:\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}" -ErrorAction SilentlyContinue
```
没有输出就去 [Microsoft Edge WebView2 Runtime](https://developer.microsoft.com/microsoft-edge/webview2/) 装。

**数据存在两处**（删除 exe 不会清理）：
- `%APPDATA%\ai.pyforge.ide\` — 设置、最近项目
- `%LOCALAPPDATA%\ai.pyforge.ide\` — WebView2 profile、日志、语言服务器

**没有自动更新** — 更新功能还没启用，新版本手动下载。

**与 OpenIDEA 数据不互通** — 标识符不同，首次启动是空的。

---

## 已知不足

- **不做类型检查**：`x: int = "s"` 不报错。要类型检查得自己装 basedpyright（约 700 MB 起，会吃掉内存优势）
- **执行了 `@sql_func` / `@egg` 的类完全看不到类型**：这些装饰器在运行时用 `inspect.getmembers` + `type()` 重建类，静态分析无从下手。PyCharm 同样如此
- **JVM 功能已移除**：Gradle / Maven / Spring Boot / Tomcat 不在配置列表里
- **自动探测运行配置已移除**：配置需要手写
- **只验证过 Windows**
- **这是 fork 不是插件**：上游更新要手动合

完整清单见仓库 [README](https://github.com/ppk159/pyforge#已知不足)。

---

## 实测数据

| | PyForge | IntelliJ IDEA |
| --- | --- | --- |
| 打开项目 | **2.4 秒** | 3.1 秒 |
| 内存（Rust 进程） | **142 MB** | — |
| 内存（含 WebView2） | 约 1.0 GB | 2.0 GB |

> 内存数字需要说明：早先说「170 MB」只算了 Rust 进程。完整窗口含 WebView2 渲染进程
> 大约 1 GB。装 basedpyright 后接近 PyCharm 的水平。

---

## 报告问题

大部分问题可能来自上游。提 issue 前请先看 README 的「已知不足」，并附上
`%LOCALAPPDATA%\ai.pyforge.ide\logs\` 里的日志。

**最想收到的反馈**：拿它重构你的真实 Python 代码，把「该支持但被拒绝了」的情况贴出来。

---

Apache 2.0。基于 OpenIDEA 修改。**非官方项目**，与 OpenIDEA 团队、JetBrains 均无隶属关系。
PyCharm / IntelliJ IDEA 是 JetBrains s.r.o. 的商标。
