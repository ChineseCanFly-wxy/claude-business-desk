# 发版流程

本文是 Claude Business Desk 的正式发版清单。`package.json` 是版本号的唯一来源；`package-lock.json`、原生程序版本、压缩包名称、Git 标签和 GitHub Release 必须与它一致。

## 1. 选择版本号

版本号遵循 SemVer，格式为 `X.Y.Z`：

- `PATCH`：向后兼容的缺陷修复、文档或打包修正。
- `MINOR`：向后兼容的新功能；`0.x` 阶段的不兼容变化也递增 `MINOR`。
- `MAJOR`：`1.0.0` 以后不向后兼容的接口、配置或数据变化。

正式版标签必须是 `vX.Y.Z`。

当前流程只发布稳定版本，不创建 Draft 或 Prerelease；需要预发布渠道时再单独扩展工作流。

## 2. 准备版本内容

```powershell
git switch main
git pull --ff-only
git status --short
npm ci
$targetVersion = '0.1.0' # 替换为目标版本
$currentVersion = (Get-Content package.json -Raw | ConvertFrom-Json).version
if ($currentVersion -ne $targetVersion) { npm version $targetVersion --no-git-tag-version }
```

工作区非空时，先确认每项修改都属于本次版本。`npm version` 只同步 `package.json` 和 `package-lock.json`，不创建提交或标签。随后把 `CHANGELOG.md` 的 `Unreleased` 内容移入 `[X.Y.Z] - YYYY-MM-DD`，保留空的 `Unreleased` 小节并更新比较链接；日期使用发版当天的北京时间日期。

检查锁文件版本一致：

```powershell
node -e "const p=require('./package.json'),l=require('./package-lock.json');if(p.version!==l.version)throw new Error('package-lock version mismatch')"
```

## 3. 完整验证

```powershell
npm run typecheck
dotnet publish apps/native-host/ClaudeTerminalHost.csproj -c Release -r win-x64 --self-contained true -p:PublishSingleFile=true -o dist/native
npm test
node scripts/build-release.mjs
node scripts/verify-release.mjs
.\scripts\check-notifications.ps1 -Launcher .\release\ClaudeBusinessDesk.Launcher.exe
npx tsx scripts/native-smoke.ts
```

确认 `release\ClaudeBusinessDesk.Launcher.exe`、服务、网页和原生宿主均已生成，`release\package.json` 的版本正确，且发行目录不含 `.env`、数据库、token、日志、Claude 登录信息或其他开发机数据。涉及页面、审核窗口、Windows 通知或内网访问的变化，还须在相应环境完成手动 smoke。

`npx tsx scripts/smoke-claude.ts` 会真实调用 Claude 并可能产生费用；只有改动涉及真实 CLI 协议且用户明确同意时才运行。

任何必需检查失败都必须停止。修复并重新执行完整验证前，不得创建或推送标签，也不得创建 GitHub Release。

## 4. 提交并验证 main

```powershell
$version = (Get-Content package.json -Raw | ConvertFrom-Json).version
git diff --check
git status --short
git add package.json package-lock.json CHANGELOG.md
# 按实际情况显式添加本次版本包含的其他文件
git commit -m "Release v$version"
git push origin main
```

确认 `Build Windows package` 的 `main` 构建成功，包括干净 Windows 主机上的 `scripts/smoke-release.ps1` 启动验收：实际启动打包后的 EXE，使用临时数据检查自带 Node、管理端、客户入口及网页资源，再停止测试进程。本机已有工作台运行时不要为此中断服务；GitHub 的干净主机承担这项验证。失败时在 `main` 上修复、重新验证并推送；不要用标签绕过失败的分支构建。

## 5. 创建并推送标签

```powershell
$version = (Get-Content package.json -Raw | ConvertFrom-Json).version
git fetch origin main --tags
if ((git rev-parse HEAD) -ne (git rev-parse origin/main)) { throw 'HEAD is not origin/main' }
if (git status --porcelain) { throw 'Working tree is not clean' }
$notesFile = Join-Path $env:TEMP "claude-business-desk-v$version.md"
# 将 CHANGELOG.md 中本版本小节的正文复制到 $notesFile；不要包含下一个版本标题或比较链接。
git tag -a "v$version" --cleanup=verbatim -F $notesFile
git show "v$version" --no-patch
git push origin "v$version"
```

`--cleanup=verbatim` 保留 Markdown 小标题，避免 Git 将以 `#` 开头的内容当作注释删除。创建标签前必须打开 `$notesFile`，确认内容与 `CHANGELOG.md` 的本版本小节一致且非空。推送标签后，GitHub Actions 应校验标签与项目版本，重新构建和测试，生成 Windows ZIP 与 SHA-256 文件，并把 annotated tag 的正文复用为非草稿 GitHub Release 说明。不要同时手工创建同名 Release；不要移动或强制覆盖已推送的标签。发布后发现问题时，修复并递增版本号。

## 6. Release 验收

```powershell
gh run list --workflow "Build Windows package" --limit 5
gh release view "v$version" --json tagName,isDraft,isPrerelease,url
```

必须确认：

- 标签和标题均为稳定版本 `vX.Y.Z`，Release 不是 Draft 或 Prerelease。
- 说明来自对应版本的 `CHANGELOG.md`。
- 版本化 Windows ZIP 和 `.sha256` 文件都存在，且重新计算的 SHA-256 一致。
- 解压后的启动器可启动、管理端可打开、版本正确，发行包不含本机数据或凭证。

验收完成后发版才算结束，交付 GitHub Release 链接；短期 Actions Artifact 不是正式版本下载地址。

## 7. 失败处理

- 标签推送前失败：修复并重新完整验证。
- 标签工作流失败：在 `main` 修复并发布新的补丁版本，不移动旧标签。
- Release 已创建但程序不可用：标明版本问题，立即发布新补丁；涉及数据库兼容时要求用升级前一致性备份回退。
