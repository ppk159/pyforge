# PyForge 0.1.3

**测试版，不是产品。**
**如果你装了 0.1.2，这一版要手动下载一次**——原因在下面第一条。

---

## 0.1.2 的更新提示是错的，必须修

0.1.2 里，中文界面每次启动都会弹：

> **PyForge 0.1.49 is available**
> OpenIDEA 0.1.49 adds java-analyzer as an alternative Java language server…

**那个版本号、那段说明，全是 OpenIDEA 的，不是 PyForge 的。**

### 为什么会这样

改名的时候漏了一个常量：

```rust
// 上游的 CNB 镜像，作为 GitHub 慢的时候的备份
const CNB_ENDPOINT: &str = "https://cnb.cool/l0ng-ai/openidea/.../latest.json";
```

而更新源在**中文界面下默认优先选 CNB**。于是检查顺序变成：

1. 先查 CNB → 拿到 OpenIDEA 的 `0.1.49` → 提示你装它
2. GitHub 上真正的 0.1.2 → **根本没被查过**

点「安装」会失败（签名是我们自己的密钥，对不上上游的包），所以**没有真的装成别的东西**。但提示本身是错的，而且每次启动都弹。

### 修了什么

- **CNB 镜像删除**。PyForge 没有 CNB 镜像，留着只会再指错地方
- 连带删掉「更新源」设置项和设置里的下拉框 —— 现在只有一个源，`tauri.conf.json` 里那一个
- 加了一个测试：读 `tauri.conf.json` 的 `endpoints`，**每个都必须以 `https://github.com/ppk159/pyforge/` 开头**，否则失败

我把旧地址填回去试过，测试确实会报：

```
https://cnb.cool/l0ng-ai/openidea/... is not this project's releases
```

### 为什么这一版要手动装

0.1.2 的检查永远先走那个错的源。你现在手动装 0.1.3，之后就能自动升级了。

---

## 其他修掉的

| 问题                                   | 说明                                                                                                                   |
| -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `package.json` 里 `"name": "openidea"` | 改名漏了                                                                                                               |
| `pnpm gen:bindings` 跑不动             | 里面写 `cargo test -p openidea`，这个 crate 已经不存在，命令直接报错                                                   |
| `OPENIDEA_UPDATE_ENDPOINT`             | 改成 `PYFORGE_UPDATE_ENDPOINT`，7 个语言包里提到它的提示文本一起改                                                     |
| `OPENIDEA_BUILD`                       | 改成 `PYFORGE_BUILD`，**并且现在真的设置了** —— 之前从没设置过，所以「关于 › Build」永远显示 `dev`，跟本地构建分不出来 |
| 发版缓存                               | 去掉了一行多余的 `key:`（它把 `Cargo.lock` 整个哈希进 key，而改版本号会改 78 行版本号；那 78 行没有一条是依赖变更）    |

关于最后一条要说清楚：**发版构建仍然是冷的**。我实测过，GitHub 的缓存**不跨 tag 共享**（同一个 commit、两个 tag、同一个 key，第二个仍然 `Cache not found`；同一个 tag 重跑才会命中）。所以每次发版还是约 63 分钟，删那行只是把那行多余的逻辑去掉，不代表变快。想变快得改成在 `master` 上构建，那是另一件事。

---

## 下载哪个

| 文件                              | 用途                                        |
| --------------------------------- | ------------------------------------------- |
| **`PyForge_0.1.3_x64-setup.exe`** | **安装包（推荐）** — 自动更新只对安装版生效 |
| `PyForge_0.1.3_x64_en-US.msi`     | MSI 格式，企业部署用                        |
| `pyforge.exe`                     | 便携版，不支持自动更新                      |

### ⚠️ 使用前必读

**未签名** — Windows SmartScreen 会拦截，点「更多信息」→「仍要运行」。

**需要 WebView2**

- Windows 11：自带
- Windows 10：可能没有，安装包会先检测并安装

**数据存在两处**（删 exe 不会清理）：

- `%APPDATA%\ai.pyforge.ide\` — 设置、最近项目
- `%LOCALAPPDATA%\ai.pyforge.ide\` — WebView2 profile、日志、语言服务器

**与 OpenIDEA 数据不互通** — 标识符不同，可以并存。

---

## 从 0.1.2 带过来的功能

这一版相对 0.1.2 只有上面那些修复。0.1.2 的新东西仍然有效：

**DataFrame 表格视图** — 右键变量 → `View as Table`。分页 200 行、拖选 `Ctrl+C` 复制 TSV、`Export…` 写 CSV/XLSX。导出是在调试进程里写的，数据不过线。

**标签可以拖回另一个窗口** — 拖到另一个 PyForge 窗口就移过去，拖到桌面开新窗口。移走最后一个文件的窗口会自动关闭。

**窗口不再比屏幕大** — 会夹到显示器工作区。

---

## 已知不足

- **不做类型检查**：`x: int = "s"` 不报错。要检查得自己装 basedpyright
- **`@sql_func` / `@egg` 这类装饰器让类型完全丢失**：运行时用 `type()` 重建类，静态分析无从下手。PyCharm 同样如此
- **DataFrame 表格只显示前 100 列**
- **JVM 功能已移除**：Gradle / Maven / Spring Boot / Tomcat 不在配置列表里
- **不自动探测运行配置**：配置需要手写
- **只验证过 Windows**
- **独立仓库，不与上游同步**：代码库从 OpenIDEA v0.1.39 的源码快照独立演进，上游的修复不会自动进来

完整清单见仓库 [README](https://github.com/ppk159/pyforge#已知不足)。

---

## 报告问题

提 issue 前请先看 README 的「已知不足」，并附上
`%LOCALAPPDATA%\ai.pyforge.ide\logs\` 里的日志。

**最想收到的反馈**：拿它重构你的真实 Python 代码，把「该支持但被拒绝了」的情况贴出来。

---

Apache 2.0。基于 OpenIDEA 修改。**非官方项目**，与 OpenIDEA 团队、JetBrains 均无隶属关系。
PyCharm / IntelliJ IDEA 是 JetBrains s.r.o. 的商标。
