# 项目协作规则

## 发版

当用户明确要求“发版”、发布版本或创建 GitHub Release 时：

1. 先完整阅读并严格执行 `docs/RELEASING.md`，以 `package.json` 为唯一版本源。
2. 更新 `CHANGELOG.md`，完成全部必需验证，再提交、推送 `main`、创建 annotated `vX.Y.Z` 标签并推送。
3. 任一必需检查失败时立即停止；不得创建或推送标签，不得创建 GitHub Release，也不得把失败检查描述为已完成。
4. 不移动或强制覆盖已推送的版本标签；已发布版本需要修复时递增版本号。
5. 标签工作流成功、正式 Release 及其 ZIP 和 SHA-256 资产都已验收后，才能宣告发版完成。
