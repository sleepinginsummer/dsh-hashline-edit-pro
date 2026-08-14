# dsh-hashline-edit-pro

哈希锚点编辑工具（`hashline_read` / `replace` / `undo_last_replace`）——DSH 动态插件，移植自 Pi Coding Agent 生态的 [pi-hashline-edit-pro](https://www.npmjs.com/package/pi-hashline-edit-pro)（RimuruW pi-hashline-edit 系列）。

每行文本携带一个唯一的 3 字符内容哈希作为地址；编辑用哈希定位，**绝不依赖行号或字符串匹配**。文件在读取后被修改时，过期的锚点会在写入前被拦截并返回新锚点反馈——不会出现"改错行"的静默损坏。

## 核心特性

- **`hashline_read`** — 以 `HASH│content` 行形式读取文件（3 字符字母数字哈希，无行号）；支持 `offset`/`limit` 分页、`raw: true` 返回普通带行号内容、空文件输出 `HASH│` 单行锚点；图片/二进制/UTF-16 拒绝并给出指引。
- **`replace`** — 用 `remove_from`/`remove_to`（裸 3 字符哈希）圈定行范围，`replacement_text` 提供新内容（`""` 删除范围）。锚点校验不通过抛 `[E_STALE_ANCHOR]` / `[E_AMBIGUOUS_ANCHOR]` / `[E_RANGE_STALE]` 并附带当前上下文新锚点；反向范围自动纠正；粘贴带 `HASH│` 前缀的行自动剥离并警告；结果附带 `HASH│` 锚点 diff（`+` 行即新锚点，可链式连续编辑）。
- **`undo_last_replace`** — 回滚某个文件最后一次 `replace`，undo 记录持久化（重启后仍可回滚）；文件在 replace 后被外部修改则拒绝回滚（`[E_UNDO_STALE]`）。
- **锚点稳定映射** — 编辑后未触碰的行保留原锚点（content-derived base + 位图探测分配 + 编辑时稳定哈希映射），链式编辑无需重新读取。
- **served-state 守卫** — 只能替换模型真正"见过"的行（读取/diff 展示过的哈希），杜绝模型凭空编造锚点。
- **文件安全** — BOM、行尾（LF/CRLF/CR）保留；UTF-8 解码错误警告；100MB/238328 行上限；原子写入走 DSH `fs` 服务；sandbox 拒绝映射为标准 `[sandbox: ...]` 标记并提示用内置 `write` 升级。

## 安装（DSH 动态插件）

`src/host.js` 是一个自包含的 JavaScript **函数体**：`(async () => { <文件内容> })()` 返回 Cordis 插件对象。

在 DSH 会话中：

1. `cordis_define`：`plugin.kind: "new"`，`idPrefix` 如 `hashl`，`code.host` = `src/host.js` 的完整内容（逐字）。
2. `cordis_run` 激活（纯 Host 插件，无客户端 UI，无需授权）。
3. 模型工具集中出现 `hashline_read` / `replace` / `undo_last_replace` 即生效。

> 插件代码是会话进程内的临时运行时扩展（`cordis_stop` 可停用）。文件系统中的 `src/host.js` 是源码真源；每次修改后把新内容重新 `cordis_define` 为一个新 Package 再 `update`。

## 安装（静态挂载，永久生效）

同一份 `src/host.js` 也以静态插件形式挂载到 DSH 部署（`index.js` 用 `new Function(body)` 在普通 Node 模块里求值同一函数体；无 `harness` 时走 `staticDefineTool` + `ctx.tools.register` 双模式适配层，不依赖任何 npm 包）。

已安装位置：

```
~/.dsh/profiles/web/plugins/dsh-hashline-edit-pro/   # 插件本体（部署内镜像）
~/.dsh/profiles/web/cordis.patch.yml                 # 补丁行：
#   - insert:
#       - id: dsh-hashline-edit-pro
#         name: ./plugins/dsh-hashline-edit-pro/index.js
```

**生效方式**：DSH web 的 HMR 被部署禁用，修改补丁后需**重启 DSH** 才加载；重启后工具对全部会话可见。**源码同步**：改 `/Volumes/syy2t/project/dsh-plugins/dsh-hashline-edit-pro/src/host.js` 后，需同步复制到部署镜像（`cp src/host.js ~/.dsh/profiles/web/plugins/dsh-hashline-edit-pro/src/host.js`）再重启。

> **fs/tools 服务依赖**：静态挂载时插件通过 `inject: ['fs', 'tools']` 声明依赖（`src/host.js` 的 return 对象）。include 条目是**并行加载**的，`fs` 服务由部署内置的 `fs-sandbox` 插件（`@deepseek-ai/dsh-fs-sandbox`）提供——没有 inject 声明，`apply()` 可能在 fs 挂载前执行，`ctx.get('fs')` 返回 undefined 导致整个插件树加载失败（报 `the fs service is not mounted`）。inject 声明让 cordis 在服务就绪前保持插件 pending，加载顺序不再敏感。

## 安装（npm bundle，官方标准分发）

发布到 npm 后，任意 DSH 用户可标准安装（包声明 `dsh.bundle`，安装时自动加入 profile 的 bundle 层）：

```bash
dsh plugin --profile <name> add dsh-hashline-edit-pro
```

## 使用示例

```
hashline_read path=src/main.ts
→
  <content>
  ve7│function hello() {
  szJ│  console.log("world");
  kQm│}

  [End of file - total 3 lines]
  </content>

replace path=src/main.ts remove_from=szJ remove_to=szJ
        replacement_text='  console.log("hi");'
→
  Successfully replaced in src/main.ts. Added 1 line(s), removed 1 line(s).

  Diff (HASH│anchored; "+" rows carry the fresh anchors for chained edits, "-" rows the removed lines):

   ve7│function hello() {
  -szJ│  console.log("world");
  +aB3│  console.log("hi");
   kQm│}
```

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
