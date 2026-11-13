# 产品身份：PyForge 与上游 OpenIDEA 的关系

改一次名，涉及的不只是图标和标题。这份文档记录**哪些地方叫 PyForge、哪些仍然叫 openidea，以及为什么**。

## 一、当前约定

| 层面                             | 值                                                          | 用户可见             |
| -------------------------------- | ----------------------------------------------------------- | -------------------- |
| 产品名（窗口标题、菜单、关于框） | `PyForge`                                                   | 是                   |
| 安装后的可执行文件               | `pyforge.exe` / `PyForge.app`                               | 是                   |
| CLI 命令                         | `pyforge`                                                   | 是                   |
| 应用标识符（identifier）         | `ai.pyforge.ide`                                            | 间接（决定数据目录） |
| 数据目录                         | `%APPDATA%\ai.pyforge.ide`、`%LOCALAPPDATA%\ai.pyforge.ide` | 间接                 |
| 开发版数据目录                   | `…\ai.pyforge.ide.dev.w<hash>`                              | 否                   |
| 凭据管理器服务名                 | `ai.pyforge.ide` / `ai.pyforge.ide.plugin.<id>`             | 否                   |
| crate 名、二进制 crate 内部名    | `openidea`、`openidea_lib`、`ide-*`                         | 否                   |

## 二、为什么 crate 名不改

crate 名和 Rust target 名是**内部标识**，用户看不到。改它们要全量重编译，
还会让和上游的 diff 变得不可读——这个 POC 的价值之一就是改动可以逐条对照上游。
`PyForge` 的安装包里有 `pyforge.exe`，里面是 `openidea_lib`，这是正常做法
（VS Code 的进程叫 `Code.exe`，内部 crate 是 `code-oss`）。

## 三、为什么 identifier 必须改

一开始的约定是「POC 阶段不改 identifier」，理由是改了数据目录会丢。那个约定
**只对「从源码跑」成立**。一旦要做一个能给别人的构建，它就不再成立：

1. **无法并存**：`tauri-plugin-single-instance` 按 identifier 判定。同 identifier
   意味着启动 PyForge 时，它会被转交给已经运行的 OpenIDEA，然后自己退出——
   用户看到的是 OpenIDEA 的窗口，PyForge 根本没起来。
2. **数据目录冲突**：两者共用 `%APPDATA%\ai.l0ng.pyforge`，共享设置、最近项目，
   以及同一个 WebView2 profile 目录。
3. **自动更新会把它换掉**：上游的 updater endpoint 指向
   `github.com/l0ng-ai/openidea`。装了这个版本的人会被「更新」成上游 OpenIDEA。

所以 identifier 改成 `ai.pyforge.ide`，代价是首次启动时数据目录是空的——
这对一个 POC 分发包是正确取舍。

## 四、updater 的处理

`bundle.createUpdaterArtifacts` 关闭、`plugins.updater` 整段移除。

理由同上：这个 POC 没有自己的更新通道，留着上游的 endpoint 等于给对方一个
把 PyForge 覆盖掉的机会。要发布自己的版本时，重新生成一对密钥，
并把 endpoint 指向 PyForge 自己的 release。

## 五、两个版本能同时装吗

能。identifier、可执行文件名、CLI 命令名、数据目录、凭据服务名全部不同：

|            | 上游 OpenIDEA               | 本仓库构建                 |
| ---------- | --------------------------- | -------------------------- |
| 可执行文件 | `openidea.exe`              | `pyforge.exe`              |
| identifier | `ai.l0ng.pyforge`           | `ai.pyforge.ide`           |
| 数据       | `%APPDATA%\ai.l0ng.pyforge` | `%APPDATA%\ai.pyforge.ide` |
| CLI        | `openidea`                  | `pyforge`                  |

唯一的共同点是**源码**：两者都来自同一个上游仓库。

## 六、改名的完整清单

改 identifier 时同步过的地方（漏一个就会不一致）：

| 文件                                             | 内容                                           |
| ------------------------------------------------ | ---------------------------------------------- |
| `src-tauri/tauri.conf.json`                      | `identifier`、`mainBinaryName`、updater        |
| `src-tauri/tauri.{windows,linux}.conf.json`      | 窗口 `title`（覆盖主配置，容易漏）             |
| `src-tauri/tauri.macos.conf.json`                | CLI 启动脚本的 bundle 资源路径                 |
| `src-tauri/cli/pyforge`                          | 脚本内指向 `MacOS/pyforge`                     |
| `src-tauri/src/cli.rs`                           | 报错前缀、bundle 内可执行文件路径              |
| `src-tauri/src/dev.rs`                           | 开发版 identifier（每个 worktree 一个）        |
| `src-tauri/src/commands/plugin.rs`               | 插件凭据的服务名                               |
| `crates/ide-cli/src/install.rs`                  | `COMMAND` 常量、`LAUNCHER` 路径、`.cmd` 包装器 |
| `crates/ide-cli/src/socket.rs`                   | 单实例管道/套接字名                            |
| `crates/ide-ssh/src/secrets.rs`                  | 凭据管理器服务名                               |
| `crates/ide-host/src/bin/pyforge-plugin/main.rs` | 插件助手查找数据目录用的 identifier            |
| `scripts/dev-session.ts`                         | 与 `dev.rs` 必须算出同一个开发版 identifier    |

**没改**的两处：

- `perf/compare/apps.toml` —— 性能对比工具的基准配置，它描述的是**外部已安装的
  应用**，不是本仓库的产物。
- 各 crate 内的路径字面量测试 —— 已一并改成 `ai.pyforge.ide`，让测试描述的
  就是产品真实的目录形状。

## 七、升级到新 identifier 后的影响

从旧构建升级过来的人（如果存在）：

- 最近项目列表、窗口布局、插件、设置**不会自动迁移**——数据在旧目录里。
- 凭据管理器里的 SSH/Git 密码条目在旧服务名下，需要重新输入。
- 旧的 `openidea` CLI 链接仍然存在，指向旧的可执行文件。

POC 阶段不做迁移。要做迁移的话，是在首次启动时读旧目录并复制，属于发布工程，
不是重构能力本身。
