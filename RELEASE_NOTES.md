# Release Notes

每个版本的发布说明写在对应章节。发布 workflow 会优先使用本节内容作为 GitHub release notes；没有对应章节时自动从 git log 生成。

<!-- 发布新版本时，在顶部插入新章节，例如：
## v0.2.0

### Features

- ...

### Fixes

- ...

-->

## v0.1.0

### Features

- Hash-anchored `read` / `replace` / `undo_last_replace` tools（每行唯一 3 字符内容哈希，锚点定位编辑，过期锚点写入前拦截）
- 锚点稳定映射：编辑后未触碰行锚点保持不变，支持链式连续编辑
- served-state 守卫：只能替换模型实际见过的行
- undo 记录持久化（重启后可回滚），外部修改后拒绝回滚（`[E_UNDO_STALE]`）
- 纯 JS xxh32 + 位图探测分配（零 npm 运行时依赖），支持动态插件 / 静态挂载 / npm bundle 三种安装方式
