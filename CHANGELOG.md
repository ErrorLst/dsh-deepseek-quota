# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
