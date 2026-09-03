# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.6.2] - 2026-09-05 (unreleased)

### Changed

- **sessionPersistence 只读路径双版本兼容（dsh 0.1.2-rc.1 缝 + 工作树 handle
  缝）**：新版 harness 把持久化服务重构为 handle-based seam——list() 直接返回
  带 revision/sizeBytes 的快照形态、inspect/listSnapshots/readFrom 移除、
  改由 open(id, "read") + SessionHandle.read() 读全量事件。此版本按能力探测
  双版本兼容，只读折叠路径两种宿主下均恢复：
  - **normalizePersistenceList 列举归一**：优先 listSnapshots()，否则 list()
    后逐项归一为 {header, revision, sizeBytes}——rc.1 的 list() 返回裸
    SessionHeader（header 自身即条目）、工作树的 list() 返回快照形态（header
    在 h.header 上）。未归一前工作树宿主上 spend/预折叠把快照条目当裸头读
    （h.id 缺失）会静默丢弃全部持久化会话；
  - **foldSessionCached 全量回退链**：inspect（rc.1 缝）→ open(id, "read",
    { signal }) + handle.read() 读全量后 close()（工作树 handle 缝，事件数组
    来自 handle.read(undefined, undefined)，继承水位取 handle.inheritedEventCount）
    → 两者皆无返回 undefined（冷会话不可用，不抛异常）；
  - **预折叠排序键**：Number(header.createdAt) || Number(header.updatedAt) || 0
    （rc.1 的 SessionHeader 无 updatedAt，原排序键恒为 0，「最近更新优先」失效）；
  - engines.dsh 提升到 >=0.1.2-rc.1。

## [0.6.1] - 2026-09-05 (unreleased)

### Fixed

- **适配 dsh 0.1.2-alpha.4 的 Session 事件读取契约**：alpha.4 移除了
  `Session#events` getter（改为 `snapshotEvents()`，返回冻结缓存数组）并把
  逻辑头里的 `seedLength` 换成 `isSeeded` + `Session#inheritedEventCount`。
  未适配时：活会话折叠读到空事件（当前会话花费显示 ¥0）、子代理会话把
  继承前缀重复计费。此版本按能力探测双版本兼容——活会话与冷会话均恢复。
  - 活会话：`snapshotEvents()`（引用稳定，增量折叠判定不受影响）；
  - 冷会话：`inspect` 返回的 `inheritedEventCount` 作为继承前缀水位；
  - alpha.3 宿主上保持旧行为（`.events` / `header.seedLength` 回退）。
## [0.6.0] - 2026-09-05 (unreleased)

### Fixed

- **切换会话后 context 额度记录 5-10s 才出的根因**：(a) 活跃会话之前每次计算
  都是**在内存里全量折叠**整条事件列表（大会话几十万事件，每次数百 ms~数 s）；
  (b) 首次访问从未算过的会话要全量解压日志。修复：
  - **活会话内存增量折叠**：按事件数组引用建立状态，只在新增事件区间上折叠
    （后续 30s 轮询/流式 2s 节流刷新变毫秒级）；事件数组被替换时自动全量重建；
  - **启动后台预折叠**：最近活跃的 32 个会话在低优先级后台任务中预建检查点
    落库（会话间让出事件循环），用户打开"最近用过的会话"时 context 零等待；
    可用 `DSH_QUOTA_DISABLE_WARMUP=1` 关闭。

## [0.5.9] - 2026-09-05 (unreleased)

### Changed

- **折叠检查点存储改为 SQLite（node:sqlite，零原生依赖）**：冷启动
  `SELECT` 全量装载到内存表；热对话每个会话折叠后**逐行 upsert**（WAL，亚毫秒），
  不再整文件重写/防抖。数据库：`~/.dsh/deepseek-quota/quota.db`，
  表 `session_folds(session_id PK, revision, created_at, cwd, from_seq,
  last_provider, last_model, started_turn, samples, updated_at)`。旧的
  JSON 检查点路径移除；若运行 Node 不支持 node:sqlite（<22.5），插件退化为
  仅内存折叠（结果仍正确，重启后自动重建）。测试数据目录可用
  `DSH_QUOTA_DATA_DIR` 指定。

## [0.5.8] - 2026-09-05 (unreleased)

### Changed

- **折叠增量检查点（性能）**：context / spend 不再每次全量重放日志——
  用持久化服务的 `listSnapshots()`（廉价 per-log revision）做变更检测，
  revision 未变的会话**零读**；已变的会话用 `readFrom(id, fromSeq)`
  只折叠增量（水位线 := 上次折叠的 seq + 1）。检查点按会话保存
  `~/.dsh/deepseek-quota/checkpoints.json`（防抖批量写，失败静默回退全量），
  重启后仍增量。效果：首建完成后 context/spend 刷新从「全量重放（8s/30s 预算
  常触发、partial、当前API 显示 0）」变为毫秒级增量；旧版 harness 无
  `listSnapshots/readFrom` 时自动回退全量路径。
- **检查点日志身份校验 + 已删除会话清理**：检查点携带日志身份
  （`createdAt + cwd`，对齐 session-projection-cache 的 checkpointIdentity）。
  会话删除后重建/日志被整个替换时，身份不一致 → 丢弃旧检查点回退全量
  （只慢不错），杜绝"无关日志的样本被水位线增量误折叠"；spend/context
  计算时同步清出已删除会话的检查点（含磁盘冗余）。
- **DSH 0.1.2-alpha.1 兼容**：`dsh.client.inject` 移除已更名的 `@deepseek-ai/dsh-client-runtime`
  （alpha.1 中更名 `@deepseek-ai/dsh-client-store`，客户端运行时是 shell 基线，不再作为
  插件注入边声明；未知的旧包名会被 boot 图静默忽略，但会丢失模块到达边）。其余宿主/客户端
  API（`webServer.register`、`sessions.list`、`sessionPersistence.list/inspect`、
  `subagents.listDescendants`、`credentials.resolve`，客户端 `useProjection("tokenUsage")`/
  `useSessions`/`useSession` 座席与 `conversation.composer.dock` 槽）经核对在 alpha.1 保持兼容，
  无需改动。

## [0.5.7] - 2026-08-26

### Changed

- **子代理明细卡片**：子代理名字（label，缺失时回退到 id）与模型名超长时
  按与模型列相同的上限（16 字符）**截断显示省略号**，完整名字保留在单元格
  title（悬停可见）；截断逻辑抽为通用 `truncateLong`，与「本轮对话」模型列
  共用。

## [0.5.6] - 2026-08-26

### Fixed

- **「余额明细-变化量（当前API）」出现大量 0 的根因**：全局消耗折叠复用了
  `contextTimeoutMs`（8 秒）预算。会话多时逐个持久化读取+解析超时中断
  （`partial: true`），漏掉的会话用量在累计曲线上没有变化，窗口差值就显示
  为 0。修复：
  - spend 路由改用**独立预算 `spendTimeoutMs`（默认 30 秒，可配置）**；
  - 客户端在余额明细面板显示提示「全局统计未完整：部分会话超时未计入，
    当前API变化量偏低」（红色），不再静默显示偏小的 0。
- 顺带修正 README 中 spend 路由标题的重复 `###`。

## [0.5.5] - 2026-08-23

### Changed

- 额度行首列的峰谷标记改为**彩色**：高峰时段「峰」显示红色
  （`--dsw-alias-state-error-primary`），低谷时段「谷」显示绿色
  （`--dsw-alias-state-success-primary`），随主题样式渲染。

## [0.5.4] - 2026-08-23

### Changed

- **峰谷阶段移到额度行首列（余额之前）**：额度行现在显示为
  `峰 | 余额：¥… | 当前会话：… | 本轮对话：… | 子代理：…`——首列「峰谷」
  实时显示当前时段（峰显示「峰」、谷显示「谷」；北京时间，含周末全天低谷
  规则），由客户端按渲染时刻判断（与宿主端 `isPeak` 同一规则），无需依赖
  宿主端字段，纯刷新页面即生效；加载/出错时也显示真实阶段。
- **计费规则集中到峰谷详情卡片**：悬停「峰谷」打开**计费规则卡片**
  （价目表版本、峰谷时段、周末规则、计价方式）；
  「当前会话」「本轮对话」等明细卡片中不再显示计费规则说明
  （「当前会话」面板首列的当前峰谷阶段列保留，改由客户端实时判断）。

## [0.5.3] - 2026-08-23

### Changed

- **峰谷阶段显示位置调整**：
  - 「当前会话」明细面板**首列新增「峰谷」列**，显示**当前峰谷阶段**
    （峰时显示「峰」、谷时显示「谷」；北京时间，含周末全天低谷规则）；
    表头悬停可见说明；
  - 「本轮对话」明细面板**移除逐请求的峰/谷列**（表头、行、合计行、列宽
    同步调整），面板不再需要该列；
  - 宿主端 `/api/deepseek-quota/context` 响应新增 `currentPeak` 字段
    （计算时刻是否处于高峰），供首列渲染。

## [0.5.2] - 2026-08-23

### Changed

- 「本轮对话」明细表优化：
  - 模型名列固定 120px 宽度内**超长截断**——模型 id 超过 16 字符时显示省略号，
    完整 id 保留在单元格 title（悬停可见）；单元格同时叠加 CSS 裁剪兜底，
    长模型名（如 `deepseek-v4-flash-vision-exp`）不再与「输入(未命中)」列重叠；
  - 峰/谷列：空闲时段由「空」改为**「谷」**显示，表头改为「峰/谷」，说明文字
    同步更新（“谷”=空闲时段，含周末全天）。

## [0.5.1] - 2026-08-23

### Changed

- **适配 DeepSeek 官方新计费规则（2026-08-23 00:00 北京时间起生效）**：周末
  （周六/周日）全天不再区分峰谷时段，统一按空闲（低谷）时段价格计费；工作日
  峰谷时段不变（09:00–12:00 / 14:00–18:00，空闲 = 高峰的一半）。`isPeak` 按
  时间截断：生效前已产生的历史调用仍按原规则（周末也分峰谷）计价，保证历史
  明细数字不回改。价目表版本号更新为 `deepseek-v4-2026-08-23`。
- 「本轮对话」明细表的峰谷说明改为「工作日 09-12时 / 14-18时」，并注明周末
  全天按空闲价。

### Added

- 模型档位识别覆盖新发布的 `deepseek-v4-flash-vision-exp`（价格与 Flash
  一致，归入 `deepseek-chat` 档）。

## [0.5.0] - 2026-08-21

### Added

- **「变化量（当前API）」列现在有真实数值了**：新增宿主路由
  `GET /api/deepseek-quota/spend?boundaries=<ms1,ms2,…>`，重放**所有会话**
  （在线 + 持久化，按 id 去重；子代理日志的父会话继承前缀从 seed 边界跳过，
  绝不重复计费）的持久日志，仅统计 DeepSeek 模型样本，按峰谷价目表在每一
  个边界时间戳返回**自日志起始的累计消耗**；任意窗口消耗 =
  `end.cost - start.cost`。浏览器端每次余额刷新后一次性请求余额明细表所需的
  全部边界（逐次刷新、每 1 小时、每 1 天三个视图 + 实时「截至当前」），逐行
  填出该窗口内 DSH 所有会话的 DeepSeek 消耗（红色负值）；窗口无法计价时仍
  显示 `-`。消耗曲线随余额快照一起持久化在 localStorage，刷新页面即时恢复。
- 全局样本折叠按 `spendCacheTtlMs`（默认 60 秒）缓存，边界查询
  O(样本数 + 边界数)；受 `contextTimeoutMs` 预算与 512 会话上限约束，超限时
  返回 `partial: true` 的偏小数值而非失败。

## [0.4.6] - 2026-08-20

### Added

- 余额明细表的变化量列拆分为 `变化量（总）` 与 `变化量（当前API）` 两列，
  用于区分账户总余额的变化与当前 API 的消耗变化（即 DSH 所有会话的总消耗）。
  后者暂不计算实际数值、始终显示 `-`，为后续全量会话消耗统计预留。

## [0.4.5] - 2026-08-19

### Changed

- Hourly / daily balance records are now solidified on a **time threshold**
  instead of wall-clock bucketing: a new record is committed only when at
  least 1 hour (or 1 day) has elapsed since the previous record, so every
  delta covers a genuine >= 1h / >= 1d window. Both tabs lead with a live
  "截至当前" row that updates on every 5-minute refresh and shows the change
  since the last solidified record. Committed lists keep 9 entries so the
  live row plus records still fill the fixed 10-row panel.

## [0.4.4] - 2026-08-19

### Added

- Balance detail panel is now tabbed: 每 5 分钟 (per-refresh deltas), 每 1
  小时 (per-hour deltas between each hour's closing balance), and 每 1 天
  (per-day deltas), each fixed at 10 rows without a scrollbar. Hourly/daily
  buckets are maintained incrementally by the balance store and persisted
  with the snapshot.

## [0.4.3] - 2026-08-19

### Added

- Balance snapshot (value, delta, and the last 10 refresh changes) is now
  persisted to `localStorage` (`dsh-deepseek-quota.balance`). A page reload
  restores the balance display and its change history instantly; the first
  refresh after the reload re-anchors the delta against the stored value.
  Corrupt or unavailable storage degrades to memory-only behavior.

## [0.4.2] - 2026-08-19

### Fixed

- Balance is account-level state and is now shared across all session views:
  it moved from the per-session slot component (which remounts on session
  switches, resetting the value, delta, and history) into a module-level
  store with one poller and one snapshot, read through
  `useSyncExternalStore`. Switching sessions no longer changes or resets the
  balance display.

## [0.4.1] - 2026-08-19

### Added

- Balance segment now shows a signed delta against the previous refresh in
  parentheses (`余额：¥274.70（-0.05）`), green when the balance increased,
  red when it decreased. Hovering it opens a fixed 10-row panel (no
  scrollbar) listing the last 10 balance refreshes with time, total, and the
  per-refresh delta.

## [0.4.0] - 2026-08-19

### Changed

- Removed the sidebar-footer balance indicator (`sidebar.footer.action`
  registration). The balance now lives as the leading segment of the
  composer-dock quota line (`余额：¥274.70 | 当前会话：… | 本轮对话：… | 子代理：…`),
  polled at the same 60s cadence with the granted/topped-up breakdown on
  hover; the `dsh.client.inject` edge for the sidebar bundle was dropped.

## [0.3.0] - 2026-08-19

### Added

- Host half: the context route now returns drill-down data — `session.models`
  (per-model-tier token and cost breakdown of the whole session),
  `turn.requests` (every request of the latest turn with its own time, peak
  flag, model, tokens, and cost; capped at 200 rows with `requestsTruncated`),
  and per-subagent `steps`/`tier`.
- Browser half: the quota line's three segments (当前会话 / 本轮对话 / 子代理)
  are individually hoverable and open a portaled detail panel:
  per-model rows for the session, a per-request calculation table for the
  latest turn (like the manual breakdown), and per-subagent rows with totals.
  Panels follow the theme, reposition when the data refreshes, and close on
  pointer leave / scroll / resize.

## [0.2.0] - 2026-08-17

### Added

- Host half: `GET /api/deepseek-quota/context?sessionId=<id>` route that
  replays the durable session log and reports per-conversation DeepSeek spend:
  whole-session totals, the latest turn, and every durable descendant
  subagent (live or cold, via `ctx.subagents.listDescendants`). Child usage
  starts at the seed boundary so inherited parent-history is never double
  counted.
- Official DeepSeek-V4 peak/off-peak time-of-use pricing (effective
  2026-08-17, Beijing time): peak 09:00–12:00 and 14:00–18:00, off-peak
  otherwise (off-peak = half of peak). Per-request pricing uses the event
  timestamp converted to Beijing time; model ids map to tiers
  (`*chat*`/`*flash*` → V4-Flash, `*reasoner*`/`*pro*` → V4-Pro, unknown
  falls back to `deepseek-chat`). The rate table is overridable through
  `config.pricing`.
- Browser half: per-conversation spend line registered in the
  `conversation.composer.dock` slot (order 1, directly below the built-in
  stats line): `当前会话：¥x | 本轮对话：¥y | 子代理：¥z`. It refetches
  when the session's `tokenUsage` projection or the session list moves
  (throttled) and polls every 30s; hover shows model/tier/token/price-table
  details. No API key needed — everything derives from the persisted log.

## [0.1.0] - 2025-06-XX

### Added

- Host half: `GET /api/deepseek-quota` route on the web profile's `webServer`,
  resolving the API key through the `credentials` service (falling back to the
  environment), with a short TTL cache and `refresh=1` bypass.
- Browser half: real-time DeepSeek balance indicator in the
  `sidebar.footer.action` slot (60s polling, click to refresh, wide/rail
  layouts, granted/topped-up tooltip, warning/danger states).
- Bundle manifest: `dsh.bundle.patch` (`cordis.patch.yml`) and
  `dsh.client` (platform `web`).
- Repository scaffolding: README (EN/ZH), LICENSE, CHANGELOG, .gitignore,
  .editorconfig, type declarations, and zero-dependency smoke tests.
