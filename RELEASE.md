# PyForge 0.1.0 (POC) — 测试版，不是产品

基于 [OpenIDEA](https://github.com/l0ng-ai/openidea) 修改的 Python 专用 IDE 实验版。
主要目的：验证「不启动 JVM 也能有像样的 Python 开发体验」。

**这不是从头写的 IDE。** 编辑器、LSP 客户端、Git、终端、数据库、HTTP 客户端等
绝大多数能力都来自上游 OpenIDEA，请把赞誉给上游。这个仓库改的是 Python 相关的部分。

---

## 这个版本独占的能力

**6 个不依赖语言服务器的 Python 重构** —— 上游的重构是转发 LSP code action，
而 Python 的四个主流服务器（basedpyright / pyright / ty / pyrefly）
一个都不提供这些 action，所以上游打开 Python 项目时菜单是灰的。

| 重构                 | 快捷键                       | 实测覆盖率     |
| -------------------- | ---------------------------- | -------------- |
| Extract Method       | `Ctrl+Alt+M`                 | 91.7%          |
| Inline Variable      | `Ctrl+Alt+N`                 | 29.7%          |
| Inline Method        | `Ctrl+Alt+N`（光标在调用上） | 78.0%          |
| Change Signature     | `Ctrl+F6`                    | 94.2%          |
| Move 类/模块         | `F6`                         | 100%（识别率） |
| Loop ↔ Comprehension | Refactor 菜单                | 两向已实现     |

覆盖率的分母、以及为什么有些数字低，全部写在仓库的
[`docs/poc-report.md`](https://github.com/ppk159/pyforge/blob/master/docs/poc-report.md) 里。

实现原则只有一条：**只做能从语法证明正确的变换，证明不了就拒绝并告诉原因。**
所以你会遇到「这个重构做不了」的提示，这是设计取舍，不是 bug。

## 另外包含

- **Python / Flask / FastAPI 运行配置**，pytest 支持
- **debugpy 调试**：断点、变量面板（带类型）、调用栈、Step Over
- 不装语言服务器也能用的跳转、语义高亮、语法错误提示

---

## ⚠️ 使用前必读

### 1. 未签名

Windows SmartScreen 会拦截，显示「已保护你的电脑」。
点 **更多信息** → **仍要运行**。

这个 exe 没有代码签名证书，所以每次下载都是这样。

### 2. 需要 WebView2

- **Windows 11**：自带，直接能跑
- **Windows 10**：可能没有，缺了会闪退

检查方法（PowerShell）：

```powershell
Get-ItemProperty "HKLM:\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}" -ErrorAction SilentlyContinue
```

有输出就是装了。没有的话去
[Microsoft Edge WebView2 Runtime](https://developer.microsoft.com/microsoft-edge/webview2/) 装。

### 3. 免安装，但也拉不干净

双击 `pyforge.exe` 就能用，**不会安装到 Program Files**，程序文件就在你放它的地方。

但运行会在两处留数据：

- `%APPDATA%\ai.pyforge.ide\` — 设置、最近项目
- `%LOCALAPPDATA%\ai.pyforge.ide\` — WebView2 profile、日志、语言服务器（可能几百 MB）

「卸载」= 删掉 exe + 删掉这两个目录。

### 4. 没有自动更新

刻意关闭的。上游的 updater 指向 `github.com/l0ng-ai/openidea`，
如果保留，用户会被「更新」成上游 OpenIDEA，那这个 fork 就消失了。
新版本要手动下载。

### 5. 数据与 OpenIDEA 不互通

应用标识符改成了 `ai.pyforge.ide`，所以和 OpenIDEA 的设置、最近项目、
WebView2 profile 都是分开的。首次启动是空的。

---

## 已知不足

**这一节比上面长，是故意的。**

- **JVM 功能已移除**：Gradle / Maven / Spring Boot / Application / Tomcat /
  Remote JVM Debug 都不在「Add New Configuration」里
- **自动探测运行配置已移除**：不再根据 `manage.py` / `pytest.ini` 猜要跑什么，
  配置需要手写（PyCharm 也不会猜）
- **只验证过 Windows**，macOS / Linux 没测
- **重构只在 Python 上验证过**
- **没有类型检查**：除非你自己装 basedpyright（装了约 700 MB 起，会吃掉内存优势）
- **符号无类型信息**：`obj.method` 的跳转只能给候选列表
- **动态特性看不懂**：`getattr`、`type()` 重建的类（比如 `@sql_func` 这种装饰器）
- **这是 fork 不是插件**：上游更新要手动合，会有冲突
- **测试基线里有预先存在的失败**（与本次改动无关，但没修）

完整清单见仓库 README 的「已知不足」。

---

## 报告问题

大部分问题可能来自上游。提 issue 前请：

1. 看看 [README 的已知不足](https://github.com/ppk159/pyforge#已知不足) 里有没有
2. 附上日志：`%LOCALAPPDATA%\ai.pyforge.ide\logs\`

**最想收到的反馈**：拿它重构你的真实 Python 代码，把「该支持但被拒绝了」的情况贴出来。

---

## 许可

Apache 2.0。基于 [OpenIDEA](https://github.com/l0ng-ai/openidea)（同为 Apache 2.0）修改。

**非官方项目**，与 OpenIDEA 团队、JetBrains 均无隶属关系。
PyCharm / IntelliJ IDEA 是 JetBrains s.r.o. 的商标。
