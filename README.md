# 沐雨橙风 · Claude Business Desk

[![Build Windows package](https://github.com/ChineseCanFly-wxy/claude-business-desk/actions/workflows/build-windows.yml/badge.svg)](https://github.com/ChineseCanFly-wxy/claude-business-desk/actions/workflows/build-windows.yml)

面向 Windows 内网环境的 Claude Code 业务问答工作台。客户只需登录网页提问；管理员在本机审核问题、调用 Claude、审核答案并发布回复。

项目采用 [MIT License](LICENSE) 开源。版本变化见 [CHANGELOG](CHANGELOG.md)，部署、安全与备份细节见 [部署说明](docs/deployment.md)。

## 下载与运行要求

正式版本发布后，从 [GitHub Releases](https://github.com/ChineseCanFly-wxy/claude-business-desk/releases/latest) 下载 `claude-business-desk-v*-win-x64.zip` 和对应的 SHA-256 校验文件。开发分支的临时构建可在 [GitHub Actions](https://github.com/ChineseCanFly-wxy/claude-business-desk/actions/workflows/build-windows.yml) 对应任务的 Artifacts 中下载。

运行要求：

- Windows x64；Windows 10/11 为主要运行环境。
- 管理员主机已安装 WebView2 Runtime，用于独立审核窗口。
- 管理员主机已安装并登录 Windows 原生 Claude Code CLI；在设置中填写其 `.exe` 完整路径。
- 待分析的项目目录位于管理员主机，且运行 Claude Business Desk 的 Windows 账号有权访问。

发行包已包含 Node.js 与 .NET 运行时，不包含 Claude Code、Claude 账号、项目文件或任何本机凭证。客户电脑无需安装客户端、Claude Code 或浏览器通知组件。

## 安装与首次配置

1. 对照随版本提供的 `.sha256` 文件，用 `Get-FileHash <压缩包> -Algorithm SHA256` 核对下载文件。
2. 将 ZIP 完整解压到普通可写目录；不要直接在压缩包内运行，也不要放入数据目录。
3. 双击 `ClaudeBusinessDesk.Launcher.exe`。托盘菜单可启动/停止服务、打开管理端、复制客户地址和退出。
4. 打开管理端，创建首个管理员账号。密码非空即可、最多 128 字符，因此实际部署应使用不易猜测的密码并限制管理端访问。
5. 在“工作台设置”中配置 Claude Code 路径、提醒方式和网络地址，再创建项目、客户账号并授权项目。没有公开注册。

管理端默认地址为 `http://localhost:4310`，客户入口默认为 `http://localhost:4311`。Claude 路径可暂时留空；管理与网络配置仍可保存，但真正处理问题前必须完成 CLI 配置和登录。

客户监听地址错误、端口被占用或未获内网监听授权时，管理端仍可启动。修正设置后，从托盘停止并重新启动服务；程序不会擅自改写已保存的网络配置，也不会复制不可用的客户地址。

## 使用流程

1. 客户登录网页、选择已授权项目并提交问题。每位客户跨项目只允许一个未完成问题，Claude 任务全局串行排队。
2. 管理员收到问题审核提醒，选择同意或拒绝。同意后，系统按当前执行方式调用 Claude。
3. Claude 成功返回后进入答案审核。管理员可编辑最终答案，再选择同意发布或拒绝。
4. 发布后，客户网页弹出“你的问题已回复”，只显示原问题；点击“查看回复”后在对话中读取完整答案。网页关闭期间不发送系统通知，再次打开或登录时补上尚未确认的新答复。
5. 本轮已发布、拒绝、失败或取消后，客户可以继续追问或开启新问题。每轮追问仍经过问题审核和答案审核。

“问答详情”只从管理端“问答记录”打开。工作概览仅展示摘要；审核收件箱和独立审核窗口只保留完成审核所需的内容及同意/拒绝操作。账号、项目、详情、错误和取消等操作都在页面内处理，不额外弹窗。

## 提醒与执行方式

管理员提醒只有两个互斥选项：

- **独立审核窗口（默认）**：通过 WebView2 显示待审核内容。缺少 Runtime 时，窗口会说明原因并提供浏览器审核入口。
- **Windows 通知**：由桌面启动器接入系统通知中心，不依赖内网 HTTP 网页的通知权限。点击通知只打开审核页面，不代表同意或拒绝。

两种提醒方式不会同时启用。启动时已有待审核项也会提醒；提醒按身份、审核阶段和更新时间去重。切换模式会清空尚未打开的窗口队列，但保留已打开窗口中未保存的编辑。通知不可用、启动器故障等状态写入托盘状态和数据目录的 `launcher.log`，待办始终保留在管理页面。

Claude 执行也只有两个互斥选项：

- **后台自动处理（默认）**：使用 Claude Code 的 print/stream-json 与 `auto` 权限分类。需要人工确认或被明确禁止的动作会失败，并提示改用可见终端。
- **可见 Claude 终端**：打开原生 Claude 对话并使用 `manual` 权限模式。管理员只处理本轮权限提示，不应追加新的业务问题；回答完成后输入 `/exit`，系统核验同一会话、原问题、结束状态、Stop hook 与最终正文后才进入答案审核。

两种方式都保留本机正常的项目说明、Skills、插件、MCP 与 hooks，且不会启用 `bypassPermissions` 或危险跳过参数。取消或退出时，JobObject 会清理整棵子进程树。执行方式只影响随后开始的任务，不改变正在运行的任务。

## 连续追问与模型上下文

连续追问使用应用保存的已发布完整问答，包括管理员编辑后的最终答案。提交时冻结业务历史；拒绝、失败、取消轮仍显示在时间线中，但其问题、拒绝理由和未审草稿不会进入模型历史。每次真实调用都会创建新的原生 CLI session，因此连续上下文是已发布的业务问答，不包含旧终端会话的全部工具输出；新对话不带旧对话历史。

上下文不会静默截断或自动摘要。接近输入或 Windows 命令行上限时，页面会提示开启新问题；这些上限不等于模型 token 上限。附加业务指令采用执行时已保存的设置，项目文件和 CLI 配置不会随提问冻结。只有最新失败或取消轮可以重试，已有后续轮次的旧轮不能倒序重试。

固定业务指令与附加业务指令通过 `--append-system-prompt` 追加，不覆盖 Claude 默认提示。设置页可预览组合内容；保存后只影响新的调用。提示词不是访问控制或 OS 沙箱，现有插件、MCP 与 hooks 仍可能运行命令或访问网络，因此只应批准可信、已获授权的项目和环境。

## 网络、数据与升级

默认数据目录是 `%LOCALAPPDATA%\ClaudeBusinessDesk`，可通过 `DESK_DATA_DIR` 指定其他位置。账号、项目、配置、历史和审计记录保存在该目录，不在发行包内。管理页面不展示原始执行日志，但数据库、管理员导出和备份仍可能包含敏感业务信息。

管理端只应绑定本机地址，绝不要暴露到公网。需要其他员工从内网访问客户入口时，应优先配置 HTTPS 反向代理；直接使用内网 HTTP 前必须在设置中显式确认风险，并自行配置防火墙、访问控制和网络隔离。浏览器限制普通 HTTP IP 页面调用系统通知属于浏览器安全策略，项目不会要求客户申请通知权限。

升级前先通过已认证的管理员备份功能下载一致性 SQLite 快照，然后退出旧启动器：

1. 下载并校验新版本，解压到新的程序目录。
2. 保留旧程序包和升级前备份，不要将新旧程序目录混合覆盖。
3. 启动新版本并核对账号、授权、问题数量、端口和关键历史。
4. 如需回退数据库版本，先停止服务并恢复与旧程序匹配的一致性备份；不要让旧程序直接打开已由新版本迁移的数据。

运行中直接复制主 `.sqlite` 文件可能遗漏 WAL 中的事务，不能作为一致性备份。完整的网络授权、备份恢复与验收清单见 [部署说明](docs/deployment.md)。

## 开发与构建

开发环境需要 Node.js 22.x、npm 和 .NET 8 SDK：

```powershell
npm ci
npm run typecheck
dotnet publish apps/native-host/ClaudeTerminalHost.csproj -c Release -r win-x64 --self-contained true -p:PublishSingleFile=true -o dist/native
npm test
.\scripts\启动.cmd
```

生成完整 Windows 发行目录：

```powershell
node scripts/build-release.mjs
```

脚本在工作区的 `release-staging` 中重新构建服务、网页、Claude 原生宿主和启动器，验证关键文件后才替换 `release`；上一版保留在 `release-backup`。它不会复制用户数据、`.env`、token、SQLite 数据库或 Claude 凭证。

其他本机验证命令：

```powershell
.\scripts\check-notifications.ps1 -Launcher .\release\ClaudeBusinessDesk.Launcher.exe
npx tsx scripts/native-smoke.ts
```

通知检查应在生成完整发行目录后运行；它不会发送系统通知或显示窗口。原生 smoke 只调用测试进程，不调用模型。`npx tsx scripts/smoke-claude.ts` 会真实调用本机 Claude 并可能产生费用，只在明确需要时运行。浏览器、独立审核窗口、Windows 通知和另一台设备访问仍需在实际部署环境中验收。

## 文档与发版

- [版本记录](CHANGELOG.md)
- [部署、安全与备份](docs/deployment.md)
- [维护者发版流程](docs/RELEASING.md)
- [MIT License](LICENSE)

每次推送 `main`，GitHub Actions 都会执行类型检查、测试和 Windows 打包，并保留短期 Artifact。推送符合 `vX.Y.Z` 的版本标签后，工作流会校验标签与 `package.json` 版本一致，生成版本化 ZIP 和 SHA-256 文件，并创建持久的 GitHub Release。具体步骤以 [发版流程](docs/RELEASING.md) 为准。
