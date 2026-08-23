# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
