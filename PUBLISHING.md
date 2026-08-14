# 发布流程（Publishing）

本仓库通过 **GitHub Actions + npm Trusted Publishing（OIDC）** 自动发布到 npm。
**无需 NPM_TOKEN、无需手动输入 2FA、无 token 过期问题**——身份由 GitHub Actions 的 OIDC 令牌与 npm 侧的 Trusted Publisher 配置共同认证。

## 发布前置（一次性，已完成）

- [x] npm 包已发布（`dsh-hashline-edit-pro`，0.1.0）
- [x] npm 侧 Trusted Publisher 已配置：
  - Owner/User: `sleepinginsummer`
  - Repository: `dsh-hashline-edit-pro`
  - Workflow: `publish.yml`
- [x] GitHub 仓库 workflow `.github/workflows/publish.yml`（含 `id-token: write` + `npm publish --provenance`）

## 日常发布（3 步）

```bash
cd /Volumes/syy2t/project/dsh-plugins/dsh-hashline-edit-pro

# 1. 在 RELEASE_NOTES.md 顶部添加本章节的发布说明（**必须**，缺了会被 workflow 拦截）：
#    ## vX.Y.Z
#
#    ### Features
#    - ...
#
#    ### Fixes
#    - ...

# 2. 更新版本号（自动打 tag）
npm version patch        # patch | minor | major

# 3. 推送（触发 workflow）
git push && git push --tags
```

> 版本号与 tag 必须一致（`npm version patch` 会把 package.json 版本和 tag 一起更新，天然一致）。

## Workflow 自动完成

| 步骤 | 内容 | 失败时 |
|---|---|---|
| 1. test | `npm test`（单元测试） | 直接失败 |
| 2. 校验版本 | tag（`vX.Y.Z`）与 package.json 版本一致 | 报错提示 |
| 3. 校验章节 | `RELEASE_NOTES.md` 必须有 `## vX.Y.Z` 章节 | 报错提示去补章节 |
| 4. publish | OIDC 认证 + `npm publish --provenance --access public`（幂等：已发布则跳过） | 已发布版本不报错 |
| 5. release | 用 RELEASE_NOTES.md 章节生成 GitHub release（同名 release 自动更新） | 幂等 |

## 手动触发（不推 tag）

仓库 Actions 页 → **Publish npm** → Run workflow：
- 不校验 tag 版本（无 tag）
- 发布当前 package.json 版本
- release notes 自动从 git log 生成（无 `## 分支名` 章节时）

## 常见问题

- **workflow 报 "RELEASE_NOTES.md has no '## vX.Y.Z' section"**：忘了写发布说明，去 RELEASE_NOTES.md 顶部加章节后重新推送 tag（已打 tag 需删掉重打：`git tag -d vX.Y.Z && git push origin :vX.Y.Z`）。
- **npm 报 401/403**：Trusted Publisher 与 workflow 的 `id-token: write` 是否匹配；确认 npm 侧配置的 Repository 名与 workflow 文件名无误。
- **想重新生成 release notes**：直接 `gh release edit vX.Y.Z --notes-file <notes.md>` 或重跑 workflow（同名 release 会自动更新）。

## 相关链接

- 源码: https://github.com/sleepinginsummer/dsh-hashline-edit-pro
- npm: https://www.npmjs.com/package/dsh-hashline-edit-pro
- npm Trusted Publishing 文档: https://docs.npmjs.com/generating-provenance-statements
