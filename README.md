# dsh-hashline-edit-pro

[![npm version](https://img.shields.io/npm/v/dsh-hashline-edit-pro.svg)](https://www.npmjs.com/package/dsh-hashline-edit-pro)

哈希锚点编辑工具（`hashline_read` / `replace` / `undo_last_replace`）——DSH 动态插件，移植自 Pi Coding Agent 生态的 [pi-hashline-edit-pro](https://www.npmjs.com/package/pi-hashline-edit-pro)（RimuruW pi-hashline-edit 系列）。

每行文本携带一个唯一的 3 字符内容哈希作为地址；编辑用哈希定位，**绝不依赖行号或字符串匹配**。文件在读取后被修改时，过期的锚点会在写入前被拦截并返回新锚点反馈——不会出现"改错行"的静默损坏。

## 核心特性

- **`hashline_read`** — 以 `HASH│content` 行形式读取文件（3 字符字母数字哈希，无行号）；支持 `offset`/`limit` 分页、`raw: true` 返回普通带行号内容、空文件输出 `HASH│` 单行锚点；图片/二进制/UTF-16 拒绝并给出指引。
- **`replace`** — 用 `remove_from`/`remove_to`（裸 3 字符哈希）圈定行范围，`replacement_text` 提供新内容（`""` 删除范围）。锚点校验不通过抛 `[E_STALE_ANCHOR]` / `[E_AMBIGUOUS_ANCHOR]` / `[E_RANGE_STALE]` 并附带当前上下文新锚点；反向范围自动纠正；粘贴带 `HASH│` 前缀的行自动剥离并警告；结果附带 `HASH│` 锚点 diff（`+` 行即新锚点，可链式连续编辑）。
- **`undo_last_replace`** — 回滚某个文件最后一次 `replace`，undo 记录持久化（重启后仍可回滚）；文件在 replace 后被外部修改则拒绝回滚（`[E_UNDO_STALE]`）。
- **锚点稳定映射** — 编辑后未触碰的行保留原锚点（content-derived base + 位图探测分配 + 编辑时稳定哈希映射），链式编辑无需重新读取。
- **served-state 守卫** — 只能替换模型真正"见过"的行（读取/diff 展示过的哈希），杜绝模型凭空编造锚点。
- **文件安全** — BOM、行尾（LF/CRLF/CR）保留；UTF-8 解码错误警告；100MB/238328 行上限；原子写入走 DSH `fs` 服务；sandbox 拒绝映射为标准 `[sandbox: ...]` 标记并提示用内置 `write` 升级。

## 安装

```bash
dsh plugin --profile <name> add dsh-hashline-edit-pro
```

安装后重启 DSH，工具 `hashline_read` / `replace` / `undo_last_replace` 对所有会话生效。

## 与 pi-hashline-edit-pro 的差异（有意为之）

| 项目 | Pi 原版 | 本移植 |
|---|---|---|
| 工具名 | 覆盖内置 `read` + 新 `replace` + `undo_last_replace`，禁用内置 `edit` | **新增** `hashline_read`/`replace`/`undo_last_replace`；内置 read/edit/write 保留（DSH 沙箱无法发 `fs/observed` 事件、无法跑 `fs/write-intent` 瀑布，遮蔽内置工具会破坏观察策略） |
| 哈希实现 | xxhash-wasm (WASM) + node:sqlite 持久化 | 纯 JS xxh32 + JSON 状态文件 `~workspace/.dsh-hashline-state.json`（快照/served/undo 均持久化，256 路径上限） |
| undo 持久化失败 | 拒绝执行本次编辑 | 仍执行但附带 `[E_UNDO_UNAVAILABLE]` 警告 |
| 图片读取 | 透传给内置 read 作为附件 | 拒绝并指引使用内置 `read_image` |

其余行为（哈希分配、稳定映射、锚点校验、diff 格式、错误码 `[E_*]`、自动纠正）与 Pi 原版对齐。

## 开发

```bash
npm test          # node --test：32 个用例，覆盖纯核心（xxh32 参考向量、锚点唯一性、
                  # 空行段、稳定映射、stale/ambiguous/noop/range 校验、diff、EOL/BOM、
                  # 静态求值预检）
```

结构：

```
dsh-hashline-edit-pro/
├── src/host.js        # 唯一源码：//PURE-CORE-START..END 之间为纯核心（可单测），
│                      # 之后为 apply(ctx) 插件体；整文件即 cordis_define 的 code.host
├── test/core.test.js  # 切片纯核心 + 整文件解析预检（对齐 DSH precheck）
└── package.json
```

## 参考

- [pi-hashline-edit-pro (npm)](https://www.npmjs.com/package/pi-hashline-edit-pro)
- [pi-hashline-edit (GitHub, RimuruW)](https://github.com/RimuruW/pi-hashline-edit)
