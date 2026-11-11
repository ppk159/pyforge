# Python 运行配置（Python / Flask Server）

适用于 `src/features/run/` 下的 `pythonTypes.ts`、`flaskTypes.ts`、`fastapiTypes.ts`。
这三个类型让 Python 项目和框架项目按 PyCharm 的方式配置运行与调试；
在此之前 Python 只能用通用的 `Program` 类型，写成一个可执行文件加一串参数。

## 一、两个类型

| 类型             | 分组    | 说明                                           |
| ---------------- | ------- | ---------------------------------------------- |
| **Python**       | —       | 跑一个脚本文件或一个模块（`-m`）               |
| **Flask Server** | Servers | `flask run`，外加 Flask 环境变量与 `.env` 文件 |

FastAPI 用 **Python** 类型的模块模式配：`Module name = uvicorn`，
`Parameters = src/webapp/fastapi_app:app --port 5066`。

## 二、Python

| 字段        | 说明                                                                                            |
| ----------- | ----------------------------------------------------------------------------------------------- |
| Run         | `Script path` 或 `Module name`                                                                  |
| Interpreter | 下拉：`Project interpreter`、PATH 上的 `python3`、后端探测到的各个 SDK（`Python 3.12 (.venv)`） |
| Script path | 文件选择器；`Module name` 模式下隐藏                                                            |
| Module name | 用 `-m` 运行；工作目录在导入路径上                                                              |
| Parameters  | 程序参数                                                                                        |

### 解释器为什么是异步解析的

`commandLine()` 是同步的（表单要即时预览命令行），但「项目解释器」要问后端
（`sdk_python_effective`：设置里选的那个，否则项目自己的 venv）。所以：

- `commandLine()` 先把 `interpreter` 原样写入（默认 `python3`）；
- `prepareLaunch: resolveInterpreter` 在进程启动前把裸 `python3` 换成后端给的绝对路径。

**这一步在 Windows 上是必须的**：那里的 `python3` 至多是 Microsoft Store 的占位别名，
运行后静默退出 0，看起来像「什么都没发生」。

### `paramsFrom`：把已有配置读回表单

探测生成的 `kind: "python"` 配置现在能用这张表单编辑（此前没有类型注册，
编辑时退化成纯命令行）。认得两种命令行：

| 命令行                        | 读回          |
| ----------------------------- | ------------- |
| `python <script> <params>`    | `mode=script` |
| `python -m <module> <params>` | `mode=module` |

其余（例如 `pytest tests`）返回 `null`，交给别的类型。

## 三、Flask Server

在 Python 的基础上固定 `-m flask run`，增加：

| 字段               | 说明                                                                                                         |
| ------------------ | ------------------------------------------------------------------------------------------------------------ |
| Application        | `--app` 的目标（`src/webapp/flask_app.py` 或 `webapp:create_app()`）；留空让 Flask 自己找 `app.py`/`wsgi.py` |
| Additional options | `--host`、`--port` 等 `run` 的子命令选项                                                                     |
| Flask environment  | `development` / `production` → `FLASK_ENV`                                                                   |
| .env files         | 逗号分隔，按顺序加载，早于下面的环境变量                                                                     |

### `--app` 的位置是最容易写错的地方

```
✅ python -m flask --app src/webapp/flask_app.py run --port 5055
❌ python -m flask run --app src/webapp/flask_app.py --port 5055
```

`--app` 是 `flask` **主命令**的选项，不是 `run` 子命令的选项。放错位置 Flask 直接报
`Error: No such option '--app'`，退出码 2。这个错误在真机验证时才暴露。

### `FLASK_DEBUG` 跟着环境走

| Flask environment | 导出的变量                               |
| ----------------- | ---------------------------------------- |
| `development`     | `FLASK_ENV=development`、`FLASK_DEBUG=1` |
| `production`      | `FLASK_ENV=production`（不开调试器）     |

## 三点五、FastAPI Server

uvicorn 的目标是**位置参数**，而且只接受点分模块——
`uvicorn app.py:app` 会 `ModuleNotFoundError`，这一点和 Flask 收文件路径不同。
所以表单把它拆成三个字段：

| 字段                  | 变成                                             |
| --------------------- | ------------------------------------------------ |
| Module                | `<模块>`（`webapp.fastapi_app`）                 |
| Application           | `<变量>`（默认 `app`）                           |
| Application directory | `--app-dir <目录>`（`src/` 布局用）              |
| Additional options    | 目标之后的参数（`--host`、`--port`、`--reload`） |

```
python -m uvicorn --app-dir src webapp.fastapi_app:app --port 8000
```

`--app-dir` 是 uvicorn 自己的选项，所以排在目标**之前**。

### 读回命令行时的一个陷阱

「target 是第一个不以 `-` 开头的参数」这条规则是错的：`--port 8000` 里的 `8000` 会被当成
target。所以按形状识别（`^[A-Za-z_][\w.]*(:[\w.()]+)?$`），没有 target 的 uvicorn 命令行
直接拒绝，而不是把端口号读成模块名。

## 四、PYTHONPATH 的两个开关

对应 PyCharm 的同名勾选项，存在 `RunConfig` 的 run extras 上（进程要用），
不是 params：

| 字段                            | 加入导入路径的目录                                     |
| ------------------------------- | ------------------------------------------------------ |
| Add content roots to PYTHONPATH | 项目的内容根（Project Structure 里配的）               |
| Add source roots to PYTHONPATH  | Project Structure 里标记为 Sources/Test Sources 的目录 |

**项目根永远在导入路径上**——它是 `import` 和 `python -m package` 解析的基准，
不受这两个开关影响。开关只决定「在此之上还加什么」，与 PyCharm 一致。

`src/` 布局的项目要靠 `Add source roots`：不加的话 `import webapp.flask_app`
会 ImportError。**但这依赖 Project Structure 里确实标了 source root**——
没配就没有额外效果，这是忠实 PyCharm 的行为，不做自动推断。

## 五、`.env` 文件

`RunConfig.envFiles` 字段早就有，`launch_env` 也一直在读它（本地运行同样生效），
只是此前没有类型暴露这个字段。本地运行的加载顺序：

```
includeSystemEnv 决定的基础环境 → envFiles（按顺序）→ config.env
```

## 六、实测记录

真机（Windows 11 / Python 3.11.9 / Flask 3.1.3）：

```
配置：Flask Server
  Interpreter  C:/.../python-app/.venv/Scripts/python.exe
  Application  src/webapp/flask_app.py
  Additional   --port 5055
  Flask env    development

命令：python.exe -m flask --app src/webapp/flask_app.py run --port 5055
结果：curl /ping → {"framework":"flask","status":"ok"}
```

调试：`debugpy` 断点验证通过（停在断点、变量面板有值、调用栈三层、单步正常）。

## 七、尚未实现

| 场景                         | 说明                                                             |
| ---------------------------- | ---------------------------------------------------------------- |
| FastAPI / uvicorn 专用类型   | 目前用 Python 类型的模块模式配                                   |
| Django Server 类型           | 现有的是 `Django tests`，跑 server 仍靠探测的 `django:runserver` |
| 框架自动探测                 | 打开含 `import flask` 的文件时自动推荐一条 Flask 配置            |
| Add content roots 的字段提示 | 目前只知道「加或不加」，不显示会加哪些目录                       |

## 八、证据

| 结论                           | 出处                                            |
| ------------------------------ | ----------------------------------------------- |
| Python 类型的字段与命令行      | `src/features/run/pythonTypes.test.ts`（14 个） |
| Flask 类型的命令行与往返       | `src/features/run/flaskTypes.test.ts`（10 个）  |
| PYTHONPATH 开关落到 run extras | 同上                                            |
| `--app` 的位置                 | 真机验证（错误消息 `No such option '--app'`）   |
| 调试可用                       | 真机验证（断点 / 变量 / 栈 / 单步）             |
