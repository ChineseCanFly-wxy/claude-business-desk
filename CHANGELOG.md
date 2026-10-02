# 更新日志

本文件记录 Claude Business Desk 的重要变化。格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [Semantic Versioning](https://semver.org/lang/zh-CN/)。

## [Unreleased]

### Added

- 管理端与客户入口分离，支持管理员、客户、项目和项目授权管理。
- 问题审核、Claude 执行、答案审核与客户回复组成的完整双审核流程。
- 独立 WebView2 审核窗口与 Windows 通知两种互斥的管理员提醒方式。
- 后台自动处理与可见 Claude 终端两种互斥的执行方式。
- 连续追问、已发布业务上下文快照、单客户未完成问题限制与全局串行队列。
- Windows 托盘启动器、SQLite 一致性备份、数据迁移和管理员导出。
- Windows x64 自包含发行包及 GitHub Actions 自动构建。

### Security

- 管理端保持本机监听，客户内网 HTTP 监听必须由管理员显式确认。
- 启动器事件接口使用本机 token，并校验后端 PID 与端口后再连接。
- Claude 执行不使用 `bypassPermissions`；取消与退出时通过 JobObject 清理子进程树。
- 发行包排除用户数据、环境文件、数据库、token 和 Claude 登录凭证。

[Unreleased]: https://github.com/ChineseCanFly-wxy/claude-business-desk/commits/main
