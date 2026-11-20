# 产品身份：PyForge 与上游 OpenIDEA 的关系

改一次名，涉及的不只是图标和标题。这份文档记录**哪些地方叫 PyForge、哪些仍然
叫 openidea，以及为什么**。

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
| crate 名                         | `pyforge`、`pyforge_lib`、`ide-*`                           | 否                   |
| 远程开发服务端                   | `pyforge-server`                                            | 否                   |
| 插件 CLI / SDK                   | `pyforge-plugin`、`pyforge_plugin`                          | 是（插件作者）       |
| 项目配置目录                     | `.pyforge/`                                                 | 是                   |
| 日志文件                         | `pyforge.log`                                               | 间接                 |
| **插件 ABI 命名空间**            | **`openidea:plugin@x.y.z`**                                 | 是（插件作者）       |

## 二、插件 ABI 为什么不改

`openidea:plugin` 是 **WebAssembly 插件的 ABI 命名空间**，写在各插件包的
`plugin.wit` 里。它和产品名是两回事：

- `sdk/rust/pyforge-plugin/tests/api/released/` 下有 19 份**已发布的 ABI 快照**，
  记录每个版本承诺给插件的接口。
- 改命名空间等于宣布所有已发布的插件不兼容，而它们内部实现没变。

所以：crate 名、可执行文件名、目录名都改了，**唯独这个命名空间保持
`openidea:plugin`**。这也解释了为什么 `sdk/` 和 `plugins/` 里仍能看到它。

（VS Code 有同样的做法：进程叫 `Code.exe`，内部 crate 是 `code-oss`。）

## 三、为什么 identifier 必须改

一开始的约定是「POC 阶段不改 identifier」，理由是改了数据目录会丢。那个约定
**只对「从源码跑」成立**。一旦要做一个能给别人的构建，它就不再成立：

1. **无法并存**：`tauri-plugin-single-instance` 按 identifier 判定。同 identifier
   意味着启动 PyForge 时，它会被转交给已经运行的 OpenIDEA，然后自己退出——
   用户看到的是 OpenIDEA 的窗口，PyForge 根本没起来。
2. **数据目录冲突**：两者共用 `%APPDATA%\ai.l0ng.openidea`，共享设置、最近项目，
   以及同一个 WebView2 profile 目录。
3. **自动更新会把它换掉**：上游的 updater endpoint 指向
   `github.com/l0ng-ai/openidea`。装了这个版本的人会被「更新」成上游 OpenIDEA。

所以 identifier 改成 `ai.pyforge.ide`，代价是首次启动时数据目录是空的——
这对一个 POC 分发包是正确取舍。

## 四、updater 的处理

从 0.1.2 起走自己的更新通道：

```json
"bundle": { "createUpdaterArtifacts": true },
"plugins": {
  "updater": {
    "endpoints": ["https://github.com/ppk159/pyforge/releases/latest/download/latest.json"],
    "pubkey": "…"
  }
}
```

0.1.0 / 0.1.1 发布时通道是关的（`endpoints: []`、`createUpdaterArtifacts: false`），
那两版没有 updater，需要手动装一次 0.1.2 才能进入自动升级。**通道一旦启用，
之后每个版本都必须带正确签名**，否则老用户无法升级。

**为什么当初是重置而不是删除整个 `plugins.updater`**：`lib.rs` 无条件注册 updater
插件，配置缺失会让它 panic（`invalid type: null, expected struct Config`）。
空 `endpoints` 让 `updates_configured()` 返回 false，UI 显示「更新已禁用」。

### 公钥格式：整段 base64，不要再解码

`npx tauri signer generate` 写出的 `pyforge.key.pub` **本身就是 base64**
（解码后才是 `untrusted comment: …` 那种文本）。`plugins.updater.pubkey`
要的是**这段 base64 原样**，插件自己会解码。0.1.2 首次发版构建时我把解码后的
文本填了进去，签名步骤直接崩：

```
failed to decode pubkey: Invalid symbol 32, offset 9
```

偏移 9 是 `untrusted` 后的空格。构建本身是成功的（62 分 55 秒、两个安装包都产出了），
只有签名失败，所以没有 `.sig`、没有 Release，tag 可以安全移掉重打。

### CNB 镜像：已删除，不要再加回来

上游用一个 CNB 镜像作为 GitHub 慢时的备份：

```
https://cnb.cool/l0ng-ai/openidea/-/releases/latest/download/latest.json
```

改名时漏了这一条，而前端在**中文界面下默认优先用它**，于是 0.1.2 的用户一启动就
被告知「OpenIDEA 0.1.49 is available」并列出上游的更新说明。点安装会因签名不匹配
失败（签名保护住了，没有真的装成别的东西），但提示本身就是错的。

镜像和「更新源」设置项一起删掉了：本仓库没有 CNB 镜像，留着只会再指错地方。
`update_endpoints_belong_to_this_project` 这个测试读取 `tauri.conf.json`，
要求每个 endpoint 都以 `https://github.com/ppk159/pyforge/` 开头。

要把通道指到别处（镜像、内网），改 `tauri.conf.json` 的 `endpoints` 并同步改那条测试。

## 五、两个版本能同时装吗

能。identifier、可执行文件名、CLI 命令名、数据目录、凭据服务名全部不同：

|            | 上游 OpenIDEA                | 本仓库构建                 |
| ---------- | ---------------------------- | -------------------------- |
| 可执行文件 | `openidea.exe`               | `pyforge.exe`              |
| identifier | `ai.l0ng.openidea`           | `ai.pyforge.ide`           |
| 数据       | `%APPDATA%\ai.l0ng.openidea` | `%APPDATA%\ai.pyforge.ide` |
| CLI        | `openidea`                   | `pyforge`                  |

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
| `src-tauri/src/logging.rs`                       | 日志文件前缀 `pyforge`                         |
| `crates/ide-core/src/project_dir.rs`             | 项目配置目录常量 `.pyforge`                    |
| `crates/ide-tools/src/lib.rs`                    | 工具清单 `.pyforge-tool.json`                  |
| `crates/ide-cli/src/install.rs`                  | `COMMAND` 常量、`LAUNCHER` 路径、`.cmd` 包装器 |
| `crates/ide-cli/src/socket.rs`                   | 单实例管道/套接字名                            |
| `crates/ide-ssh/src/secrets.rs`                  | 凭据管理器服务名                               |
| `crates/ide-host/src/bin/pyforge-plugin/main.rs` | 插件助手查找数据目录用的 identifier            |
| `scripts/dev-session.ts`                         | 与 `dev.rs` 必须算出同一个开发版 identifier    |
| `src/platform/locales/*.json`                    | 七种语言里的产品名                             |

**刻意保留 `openidea` 的地方**：

| 位置                                    | 为什么                                       |
| --------------------------------------- | -------------------------------------------- |
| `openidea:plugin@x.y.z`（WIT ABI）      | 插件兼容性契约，见第二节                     |
| `crates/**/tests/` 里的 mock 与 fixture | 描述外部工具/服务的形状，不是本产品          |
| `perf/compare/apps.toml`                | 性能对比工具的基准，描述**外部已安装的应用** |
| 上游仓库链接（README、LICENSE）         | Apache 2.0 的出处标注                        |

## 七、升级到新 identifier 后的影响

从旧构建升级过来的人（如果存在）：

- 最近项目列表、窗口布局、插件、设置**不会自动迁移**——数据在旧目录里。
- **项目级的 `.openidea/` 也不会迁移**：运行配置、变更列表留在旧目录。手动复制：
  ```bash
  cp .openidea/run.local.toml .pyforge/
  cp .openidea/settings.toml  .pyforge/
  ```
- 凭据管理器里的 SSH/Git 密码条目在旧服务名下，需要重新输入。
- 旧的 `openidea` CLI 链接仍然存在，指向旧的可执行文件。

POC 阶段不做自动迁移。要做的话，是在首次启动时读旧目录并复制，属于发布工程，
不是重构能力本身。
