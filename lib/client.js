// @dsh-external/dsh-deepseek-quota — browser half.
//
// Registered through the client-modules system: this bundle is served at
// `/plugins/@dsh-external/dsh-deepseek-quota/client.js`, executed once to register a factory
// under `window.__ModuleLoader__`, and materialized lazily. The factory returns
// the Cordis client plugin (`inject` + `apply`), which registers one piece of
// UI in `conversation.composer.dock` (order 1, right below the built-in stats
// line at order 0) — a per-conversation DeepSeek spend line:
//
//        余额：¥274.70 | 当前会话：¥0.1234 | 本轮对话：¥0.0234 | 子代理：¥0.0056
//
// The leading balance segment comes from `/api/deepseek-quota` (60s poll);
// the spend numbers come from the host route `/api/deepseek-quota/context`
// which replays the durable session log (session totals, latest turn,
// descendant subagents) and applies the official peak/off-peak rate
// table. The component refetches when the session's `tokenUsage`
// projection or the session list moves (throttled), so the line tracks
// streaming turns and running subagents live; on reload the same numbers
// recompute from the persisted log.
//
// Only `react` is required (a platform seed word); `react-dom` is used for
// the portal when the loader provides it. No JSX: build elements with
// React.createElement. Inline styles reference the theme CSS variables so the
// indicator follows the active theme.

window.__ModuleLoader__.load({
  id: "@dsh-external/dsh-deepseek-quota",
  factory: (require) => {
    const React = require("react");
    const { useState, useEffect, useCallback, useRef, useLayoutEffect, useSyncExternalStore, Fragment } = React;

    // Optional portal support: the module map of this deployment ships
    // react-dom; if it ever does not, panels degrade to inline fixed divs.
    let ReactDOM = null;
    try {
      ReactDOM = require("react-dom");
    } catch {
      ReactDOM = null;
    }

    const inject = ["slots"];

    const BALANCE_POLL_MS = 5 * 60_000;
    const CONTEXT_POLL_MS = 30_000;
    const CONTEXT_THROTTLE_MS = 2_000;
    const CONTEXT_CACHE_MAX = 24;
    const BALANCE_HISTORY_MAX = 10;
    // Hourly/daily records are solidified on a time threshold (>= 1h / >= 1d
    // since the previous record); the live "截至当前" row sits on top, so the
    // committed list keeps one slot less than the fixed 10-row panel.
    const BUCKET_HISTORY_MAX = BALANCE_HISTORY_MAX - 1;
    // Cap on boundary timestamps asked of /api/deepseek-quota/spend per fetch:
    // 10 refresh rows + 9 hourly + 9 daily + the live "now" fits comfortably.
    const SPEND_BOUNDARIES_CAP = 48;
    const HOUR_MS = 3_600_000;
    const DAY_MS = 86_400_000;
    const CURRENCY_SYMBOL = { CNY: "\u00a5", USD: "$" };
    const DELTA_UP_COLOR = "var(--dsw-alias-state-success-primary, #30a46c)";
    const DELTA_DOWN_COLOR = "var(--dsw-alias-state-error-primary, #e5484d)";

    // Last successful host response per session id, so switching back to a
    // session renders its spend instantly instead of waiting for a refetch.
    const contextCache = new Map();

    function cacheContext(sessionId, data) {
      contextCache.set(sessionId, { data });
      if (contextCache.size > CONTEXT_CACHE_MAX) {
        const oldest = contextCache.keys().next().value;
        contextCache.delete(oldest);
      }
    }

    // The DeepSeek balance and its refresh history are ACCOUNT-level facts,
    // shared by every session view. The quota line's slot entry remounts per
    // session, so this store lives at module level: one poller, one snapshot,
    // and switching sessions never resets the value, the delta, or the
    // 10-refresh history. The snapshot is also persisted to localStorage so a
    // page reload keeps the balance and the recent-change history (the very
    // first refresh after the reload re-anchors the delta against the stored
    // value).
    const BALANCE_STORAGE_KEY = "dsh-deepseek-quota.balance";

    function validateBucketList(list) {
      return Array.isArray(list)
        ? list.filter(
            (entry) =>
              entry !== null &&
              typeof entry === "object" &&
              typeof entry.at === "number" &&
              typeof entry.total === "string",
          ).slice(0, BUCKET_HISTORY_MAX)
        : [];
    }

    function validateSpendField(value) {
      if (value === null || typeof value !== "object") return null;
      return {
        fetchedAt: typeof value.fetchedAt === "number" ? value.fetchedAt : 0,
        at: typeof value.at === "number" ? value.at : 0,
        boundaries:
          value.boundaries !== null && typeof value.boundaries === "object"
            ? Object.fromEntries(
                Object.entries(value.boundaries)
                  .filter(
                    ([key, entry]) =>
                      /^\d+$/.test(key) &&
                      entry !== null &&
                      typeof entry === "object" &&
                      typeof entry.cost === "number",
                  )
                  .slice(0, SPEND_BOUNDARIES_CAP),
              )
            : {},
      };
    }

    function loadStoredBalance() {
      try {
        const raw = window.localStorage.getItem(BALANCE_STORAGE_KEY);
        if (raw === null) return null;
        const parsed = JSON.parse(raw);
        if (parsed === null || typeof parsed !== "object") return null;
        const state = parsed.state;
        if (state === null || typeof state !== "object" || typeof state.status !== "string") return null;
        const history = Array.isArray(parsed.history)
          ? parsed.history.filter(
              (entry) =>
                entry !== null &&
                typeof entry === "object" &&
                typeof entry.at === "number" &&
                typeof entry.total === "string" &&
                (entry.delta === null || typeof entry.delta === "number"),
            ).slice(0, BALANCE_HISTORY_MAX)
          : [];
        return {
          state,
          history,
          hourly: validateBucketList(parsed.hourly),
          daily: validateBucketList(parsed.daily),
          spend: validateSpendField(parsed.spend),
        };
      } catch {
        return null;
      }
    }

    function storeBalanceSnapshot(snapshot) {
      try {
        window.localStorage.setItem(BALANCE_STORAGE_KEY, JSON.stringify(snapshot));
      } catch {
        // storage unavailable (private mode / quota) — memory-only is fine
      }
    }

    const balanceStore = {
      snapshot: loadStoredBalance() ?? {
        state: { status: "loading" },
        history: [],
        hourly: [],
        daily: [],
        spend: { fetchedAt: 0, at: 0, boundaries: {} },
      },
      listeners: new Set(),
      pollStarted: false,
      subscribe(listener) {
        balanceStore.listeners.add(listener);
        return () => {
          balanceStore.listeners.delete(listener);
        };
      },
      getSnapshot() {
        return balanceStore.snapshot;
      },
      publish() {
        storeBalanceSnapshot(balanceStore.snapshot);
        for (const listener of balanceStore.listeners) listener();
      },
      async refresh() {
        try {
          const response = await fetch("/api/deepseek-quota", { cache: "no-store" });
          const data = await response.json();
          if (data && data.ok) {
            const primary = data.balances[0];
            const snapshot = balanceStore.snapshot;
            const history = snapshot.history;
            const current = primary === undefined ? NaN : Number(primary.total);
            const previous = history.length > 0 ? Number(history[0].total) : NaN;
            const delta = Number.isFinite(current) && Number.isFinite(previous)
              ? Math.round((current - previous) * 100) / 100
              : null;
            const at = Date.now();
            // Hourly / daily records are SOLIDIFIED on a time threshold: a
            // new record is committed only when at least 1 hour (or 1 day)
            // has passed since the previous committed record, so every delta
            // covers a genuine >= 1h / >= 1d window. The live "截至当前" row
            // always reflects the latest refresh instead.
            const hourly = snapshot.hourly ?? [];
            const daily = snapshot.daily ?? [];
            const nextHourly = primary !== undefined && (hourly.length === 0 || at - hourly[0].at >= HOUR_MS)
              ? [{ at, total: primary.total }, ...hourly].slice(0, BUCKET_HISTORY_MAX)
              : hourly;
            const nextDaily = primary !== undefined && (daily.length === 0 || at - daily[0].at >= DAY_MS)
              ? [{ at, total: primary.total }, ...daily].slice(0, BUCKET_HISTORY_MAX)
              : daily;
            balanceStore.snapshot = {
              // Spread first so the persisted global-spend map survives.
              ...snapshot,
              state: { status: "ok", data },
              history: primary === undefined
                ? history
                : [{ at, total: primary.total, delta }, ...history].slice(0, BALANCE_HISTORY_MAX),
              hourly: primary === undefined ? hourly : nextHourly,
              daily: primary === undefined ? daily : nextDaily,
            };
          } else {
            balanceStore.snapshot = { ...balanceStore.snapshot, state: { status: "error" } };
          }
        } catch {
          balanceStore.snapshot = { ...balanceStore.snapshot, state: { status: "error" } };
        }
        balanceStore.publish();
        balanceStore.refreshSpend();
      },
      /**
       * Fetch cumulative DeepSeek spend (all sessions) at every boundary the
       * balance tables need — each refresh row, each hourly/daily record, and
       * the live "now" — in ONE request. The snapshot's spend map is replaced
       * on success and left untouched on failure (stale boundaries still
       * price the rows they cover; rows with unknown windows show "-").
       */
      async refreshSpend() {
        const snapshot = balanceStore.snapshot;
        const ats = new Set();
        for (const entry of snapshot.history) ats.add(entry.at);
        for (const entry of snapshot.hourly ?? []) ats.add(entry.at);
        for (const entry of snapshot.daily ?? []) ats.add(entry.at);
        const now = Date.now();
        ats.add(now);
        const boundaries = [...ats].sort((a, b) => a - b).slice(-SPEND_BOUNDARIES_CAP);
        try {
          const response = await fetch(
            "/api/deepseek-quota/spend?boundaries=" + boundaries.join(","),
            { cache: "no-store" },
          );
          const data = await response.json();
          if (!data || !data.ok || !Array.isArray(data.boundaries)) return;
          const map = {};
          for (const row of data.boundaries) {
            if (row !== null && typeof row === "object" && typeof row.at === "number") {
              map[String(row.at)] = row;
            }
          }
          balanceStore.snapshot = {
            ...balanceStore.snapshot,
            spend: { fetchedAt: Date.now(), at: now, boundaries: map },
          };
          balanceStore.publish();
        } catch {
          // keep the previous spend map; the next refresh retries
        }
      },
      /** Start the single poller once for the page lifetime. */
      ensurePolling() {
        if (balanceStore.pollStarted) return;
        balanceStore.pollStarted = true;
        balanceStore.refresh();
        setInterval(() => balanceStore.refresh(), BALANCE_POLL_MS);
      },
    };

    /** Compact money: 4 decimals for small amounts, trimming trailing zeros. */
    function formatCost(value) {
      if (typeof value !== "number" || !Number.isFinite(value)) return "\u2014";
      if (value === 0) return "0";
      if (value > 0 && value < 0.0001) return "<0.0001";
      const digits = value >= 100 ? 2 : value >= 1 ? 3 : 4;
      return String(Number(value.toFixed(digits)));
    }

    /** Thousands-separated token counts for panel tables. */
    function formatTokens(value) {
      return typeof value === "number" && Number.isFinite(value) ? value.toLocaleString("en-US") : "\u2014";
    }

    // The turn table pins the model column at 120px; anything longer would
    // bleed into the next column, so model ids are truncated here. The full
    // name stays available through the cell's title attribute.
    const MODEL_NAME_MAX = 16;

    /** Model id with a hard length cap; longer ids are cut with an ellipsis. */
    function formatModel(model) {
      const text = String(model ?? "\u2014");
      return text.length <= MODEL_NAME_MAX ? text : text.slice(0, MODEL_NAME_MAX) + "\u2026";
    }

    /** Local wall-clock time for a request (the machine runs Beijing time). */
    function formatTime(ms) {
      if (typeof ms !== "number") return "\u2014";
      const date = new Date(ms);
      return Number.isNaN(date.getTime())
        ? "\u2014"
        : date.toLocaleTimeString("zh-CN", { hour12: false });
    }

    // -----------------------------------------------------------------------
    // Detail panels
    // -----------------------------------------------------------------------

    const PANEL_STYLE = {
      position: "fixed",
      zIndex: 100,
      boxSizing: "border-box",
      maxWidth: "min(760px, calc(100vw - 16px))",
      maxHeight: "min(480px, calc(100vh - 16px))",
      overflow: "auto",
      background: "var(--dsw-specific-menu)",
      border: "1px solid var(--dsw-alias-border-inverted)",
      boxShadow: "var(--dsw-shadow-lv3)",
      color: "var(--dsw-alias-label-secondary)",
      borderRadius: "12px",
      padding: "10px 12px",
      fontSize: "12px",
      lineHeight: "20px",
      fontFamily: "inherit",
    };
    const PANEL_TITLE_STYLE = {
      fontWeight: 500,
      color: "var(--dsw-alias-label-primary)",
      marginBottom: "4px",
      whiteSpace: "nowrap",
    };
    const PANEL_NOTE_STYLE = {
      color: "var(--dsw-alias-label-tertiary)",
      marginBottom: "6px",
      whiteSpace: "nowrap",
    };
    const TABLE_STYLE = {
      borderCollapse: "collapse",
      fontVariantNumeric: "tabular-nums",
      width: "100%",
    };
    // Detail tables show at most 5 data rows (plus the header row) before
    // scrolling internally. Row height ≈ 22px (20px line-height + 2px padding).
    const PANEL_TABLE_WRAP_STYLE = {
      maxHeight: `${5 * 22 + 24}px`,
      overflowY: "auto",
    };
    const TH_R = {
      textAlign: "right",
      fontWeight: 500,
      color: "var(--dsw-alias-label-tertiary)",
      padding: "1px 8px",
      whiteSpace: "nowrap",
      lineHeight: "20px",
    };
    const TH_L = { ...TH_R, textAlign: "left" };
    const TD_R = {
      textAlign: "right",
      padding: "1px 8px",
      whiteSpace: "nowrap",
      color: "var(--dsw-alias-label-secondary)",
      lineHeight: "20px",
    };
    const TD_L = { ...TD_R, textAlign: "left" };
    const TD_R_TOTAL = { ...TD_R, fontWeight: 500, color: "var(--dsw-alias-label-primary)" };
    const TD_L_TOTAL = { ...TD_L, fontWeight: 500, color: "var(--dsw-alias-label-primary)" };

    function headCell(text, style, key, title) {
      return React.createElement("th", { style, key, title }, text);
    }

    function dataCell(text, style, key) {
      return React.createElement("td", { style, key }, text);
    }

    function tableRow(cells, key, rowStyle) {
      return React.createElement("tr", { key, style: rowStyle }, cells);
    }

    /** Fixed column widths for the turn table (request list + total row). */
    const TURN_COL_WIDTHS = [44, 74, 120, 96, 84, 64, 88];

    /** A colgroup pinning column widths so two tables share identical columns. */
    function columnGroup(widths) {
      return React.createElement(
        "colgroup",
        null,
        widths.map((width, index) =>
          React.createElement("col", { key: `c${index}`, style: { width: `${width}px` } }),
        ),
      );
    }

    /** 计费规则：peak/valley windows, weekend rule, rate-table version. */
    function buildPricingPanel(data) {
      const header = React.createElement("div", { style: PANEL_TITLE_STYLE }, "\u8ba1\u8d39\u89c4\u5219");
      const note = React.createElement(
        "div",
        { style: PANEL_NOTE_STYLE },
        `\u4ef7\u76ee\u8868 ${data.pricingVersion} \u00b7 \u5143/\u767e\u4e07 tokens`,
      );
      const head = tableRow(
        [
          headCell("\u65f6\u6bb5", TH_L, "h-when"),
          headCell("\u8ba1\u8d39\u89c4\u5219", TH_L, "h-rule"),
        ],
        "head",
      );
      const rules = [
        [
          "\u5cf0",
          "\u5de5\u4f5c\u65e5 09:00\u201312:00 / 14:00\u201318:00\uff08\u5317\u4eac\u65f6\u95f4\uff09",
        ],
        [
          "\u8c37",
          "\u5176\u4f59\u65f6\u95f4\uff0c\u8c37\u4ef7\u4e3a\u5cf0\u4ef7\u7684\u4e00\u534a",
        ],
        [
          "\u5468\u672b",
          "\u5468\u516d/\u5468\u65e5\u5168\u5929\u4f4e\u8c37\u4ef7\uff082026-08-23 00:00 \u8d77\uff09",
        ],
        [
          "\u8ba1\u4ef7",
          "\u6bcf\u4e2a\u8bf7\u6c42\u6309\u53d1\u751f\u65f6\u523b\uff08\u5317\u4eac\u65f6\u95f4\uff09\u8ba1\u4ef7",
        ],
      ];
      const rows = rules.map(([label, rule], index) =>
        tableRow(
          [
            dataCell(label, TD_L, "label"),
            dataCell(rule, TD_L, "rule"),
          ],
          `rule-${index}`,
        ),
      );
      return React.createElement(
        "div",
        null,
        header,
        note,
        React.createElement(
          "table",
          { style: TABLE_STYLE },
          React.createElement("thead", null, head),
          React.createElement("tbody", null, rows),
        ),
      );
    }

    /** 当前会话：per-model rows showing consumed quota split by bucket. */
    function buildSessionPanel(session, data) {
      const models = session.models ?? [];
      const header = React.createElement(
        "div",
        { style: PANEL_TITLE_STYLE },
        `\u5f53\u524d\u4f1a\u8bdd \u00b7 \u6309\u6a21\u578b\u7ec6\u5206\uff08\u5171 ${session.steps} \u4e2a\u8bf7\u6c42\uff09`,
      );
      // The leading column shows the CURRENT peak/valley stage (Beijing
      // time; weekends are all-day off-peak since 2026-08-23), computed on
      // the client at render time so it is live and needs no host field.
      const stage = isPeakNow() ? "\u5cf0" : "\u8c37";
      const head = tableRow(
        [
          headCell(
            "\u5cf0\u8c37",
            TH_L,
            "h-peak",
            "\u5f53\u524d\u5cf0\u8c37\u9636\u6bb5\uff08\u5317\u4eac\u65f6\u95f4\uff0c\u5468\u672b\u5168\u5929\u4f4e\u8c37\uff09",
          ),
          headCell("\u6a21\u578b", TH_L, "h-model"),
          headCell("\u8f93\u5165(\u672a\u547d\u4e2d)", TH_R, "h-unc"),
          headCell("\u7f13\u5b58\u8f93\u5165", TH_R, "h-hit"),
          headCell("\u8f93\u51fa", TH_R, "h-out"),
          headCell("\u5408\u8ba1", TH_R, "h-cost"),
        ],
        "head",
      );
      const rows = models.map((entry, index) =>
        tableRow(
          [
            dataCell(stage, TD_L, "peak"),
            dataCell(`${entry.model ?? entry.tier}`, TD_L, "model"),
            dataCell(`\u00a5${formatCost(entry.costUncachedInput)}`, TD_R, "unc"),
            dataCell(`\u00a5${formatCost(entry.costCacheRead)}`, TD_R, "hit"),
            dataCell(`\u00a5${formatCost(entry.costOutput)}`, TD_R, "out"),
            dataCell(`\u00a5${formatCost(entry.cost)}`, TD_R, "cost"),
          ],
          `model-${index}`,
        ),
      );
      const total = tableRow(
        [
          dataCell(stage, TD_L_TOTAL, "peak"),
          dataCell("\u5408\u8ba1", TD_L_TOTAL, "model"),
          dataCell(`\u00a5${formatCost(session.costUncachedInput)}`, TD_R_TOTAL, "unc"),
          dataCell(`\u00a5${formatCost(session.costCacheRead)}`, TD_R_TOTAL, "hit"),
          dataCell(`\u00a5${formatCost(session.costOutput)}`, TD_R_TOTAL, "out"),
          dataCell(`\u00a5${formatCost(session.cost)}`, TD_R_TOTAL, "cost"),
        ],
        "total",
      );
      return React.createElement(
        "div",
        null,
        header,
        React.createElement(
          "table",
          { style: TABLE_STYLE },
          React.createElement("thead", null, head),
          React.createElement("tbody", null, rows, total),
        ),
      );
    }

    /** 本轮对话：every request of the latest turn, tokens and cost per request. */
    function buildTurnPanel(turn) {
      const requests = turn.requests ?? [];
      const header = React.createElement(
        "div",
        { style: PANEL_TITLE_STYLE },
        `\u672c\u8f6e\u5bf9\u8bdd \u00b7 \u7b2c ${turn.turn} \u8f6e \u00b7 ${requests.length} \u4e2a\u8bf7\u6c42\uff08\u5408\u8ba1 \u00a5${formatCost(turn.cost)}\uff09`,
      );
      const head = tableRow(
        [
          headCell("\u6b65\u9aa4", TH_R, "h-step"),
          headCell("\u65f6\u95f4", TH_L, "h-time"),
          headCell("\u6a21\u578b", TH_L, "h-model"),
          headCell("\u8f93\u5165(\u672a\u547d\u4e2d)", TH_R, "h-unc"),
          headCell("\u7f13\u5b58\u8f93\u5165", TH_R, "h-hit"),
          headCell("\u8f93\u51fa", TH_R, "h-out"),
          headCell("\u5408\u8ba1", TH_R, "h-cost"),
        ],
        "head",
      );
      const rows = requests.map((request) =>
        tableRow(
          [
            dataCell(String(request.step), TD_R, "step"),
            dataCell(formatTime(request.time), TD_L, "time"),
            // Model ids are truncated to the pinned 120px column (the full
            // id stays in the title attribute); the cell also clips via CSS
            // so nothing can bleed into the next column.
            dataCell(
              React.createElement(
                "span",
                {
                  title:
                    request.model === null || request.model === undefined
                      ? undefined
                      : String(request.model),
                },
                formatModel(request.model),
              ),
              { ...TD_L, overflow: "hidden", textOverflow: "ellipsis" },
              "model",
            ),
            dataCell(`\u00a5${formatCost(request.costUncachedInput)}`, TD_R, "unc"),
            dataCell(`\u00a5${formatCost(request.costCacheRead)}`, TD_R, "hit"),
            dataCell(`\u00a5${formatCost(request.costOutput)}`, TD_R, "out"),
            dataCell(`\u00a5${formatCost(request.cost)}`, TD_R, "cost"),
          ],
          `req-${request.step}`,
        ),
      );
      const footer = [];
      if (turn.requestsTruncated === true) {
        footer.push(
          React.createElement(
            "div",
            { key: "truncated", style: PANEL_NOTE_STYLE },
            `\u8bf7\u6c42\u8d85\u8fc7 200 \u6761\uff0c\u4ec5\u5c55\u793a\u524d 200 \u6761`,
          ),
        );
      }
      // Total row (fixed below the scrollable request list; always covers the
      // FULL turn, even when the request list is truncated). Values fall back
      // to summing the visible requests when the host does not provide the
      // turn-level bucket costs yet.
      const sumOf = (key) => requests.reduce((total, request) => total + (request[key] ?? 0), 0);
      const turnUncached = turn.costUncachedInput ?? sumOf("costUncachedInput");
      const turnCacheRead = turn.costCacheRead ?? sumOf("costCacheRead");
      const turnOutput = turn.costOutput ?? sumOf("costOutput");
      const turnCost = turn.cost ?? sumOf("cost");
      const totalRow = tableRow(
        [
          dataCell("\u5408\u8ba1", TD_L_TOTAL, "t-label"),
          dataCell("", TD_L, "t-time"),
          dataCell("", TD_L, "t-model"),
          dataCell(`\u00a5${formatCost(turnUncached)}`, TD_R_TOTAL, "t-unc"),
          dataCell(`\u00a5${formatCost(turnCacheRead)}`, TD_R_TOTAL, "t-hit"),
          dataCell(`\u00a5${formatCost(turnOutput)}`, TD_R_TOTAL, "t-out"),
          dataCell(`\u00a5${formatCost(turnCost)}`, TD_R_TOTAL, "t-cost"),
        ],
        "total",
        { borderTop: "1px solid var(--dsw-alias-border-l2)" },
      );
      // Both tables share the fixed column widths so the total row aligns
      // with the request list columns exactly.
      const fixedTableStyle = { ...TABLE_STYLE, tableLayout: "fixed" };
      return React.createElement(
        "div",
        null,
        header,
        React.createElement(
          "div",
          { style: PANEL_TABLE_WRAP_STYLE },
          React.createElement(
            "table",
            { style: fixedTableStyle },
            columnGroup(TURN_COL_WIDTHS),
            React.createElement("thead", null, head),
            React.createElement("tbody", null, rows),
          ),
        ),
        React.createElement(
          "table",
          { style: fixedTableStyle },
          columnGroup(TURN_COL_WIDTHS),
          React.createElement("tbody", null, totalRow),
        ),
        ...footer,
      );
    }

    /** 子代理：each descendant subagent with its own totals. */
    function buildSubagentsPanel(subagents) {
      const children = subagents.children ?? [];
      const header = React.createElement(
        "div",
        { style: PANEL_TITLE_STYLE },
        `\u5b50\u4ee3\u7406 \u00b7 \u5171 ${subagents.count} \u4e2a \u00b7 \u5408\u8ba1 \u00a5${formatCost(subagents.cost)}`,
      );
      const head = tableRow(
        [
          headCell("\u5b50\u4ee3\u7406", TH_L, "h-id"),
          headCell("\u6a21\u578b", TH_L, "h-model"),
          headCell("\u8f93\u5165(\u672a\u547d\u4e2d)", TH_R, "h-unc"),
          headCell("\u7f13\u5b58\u8f93\u5165", TH_R, "h-hit"),
          headCell("\u8f93\u51fa", TH_R, "h-out"),
          headCell("\u5408\u8ba1", TH_R, "h-cost"),
        ],
        "head",
      );
      const rows = children.map((child, index) =>
        tableRow(
          [
            dataCell(child.label ?? child.id, TD_L, "id"),
            dataCell(String(child.model ?? "\u2014"), TD_L, "model"),
            // Unpriced (non-DeepSeek) subagents show "-" placeholders.
            ...child.unpriced === true || child.cost === null
              ? [
                  dataCell("-", TD_R, "unc"),
                  dataCell("-", TD_R, "hit"),
                  dataCell("-", TD_R, "out"),
                  dataCell("-", TD_R, "cost"),
                ]
              : [
                  dataCell(`\u00a5${formatCost(child.costUncachedInput)}`, TD_R, "unc"),
                  dataCell(`\u00a5${formatCost(child.costCacheRead)}`, TD_R, "hit"),
                  dataCell(`\u00a5${formatCost(child.costOutput)}`, TD_R, "out"),
                  dataCell(`\u00a5${formatCost(child.cost)}`, TD_R, "cost"),
                ],
          ],
          `child-${index}`,
        ),
      );
      const footer = [];
      if (subagents.unpricedCount !== undefined && subagents.unpricedCount > 0) {
        footer.push(
          React.createElement(
            "div",
            { key: "unpriced", style: PANEL_NOTE_STYLE },
            `\u5176\u4e2d ${subagents.unpricedCount} \u4e2a\u5b50\u4ee3\u7406\u4f7f\u7528\u975e DeepSeek \u6a21\u578b\uff0c\u4e0d\u8ba1\u5165\u989d\u5ea6`,
          ),
        );
      }
      if (subagents.error !== undefined) {
        footer.push(
          React.createElement(
            "div",
            { key: "error", style: { ...PANEL_NOTE_STYLE, color: "var(--dsw-alias-state-error-primary, #e5484d)" } },
            `\u5b50\u4ee3\u7406\u679a\u4e3e\u5931\u8d25\uff1a${subagents.error}`,
          ),
        );
      }
      return React.createElement(
        "div",
        null,
        header,
        React.createElement(
          "div",
          { style: PANEL_TABLE_WRAP_STYLE },
          React.createElement(
            "table",
            { style: TABLE_STYLE },
            React.createElement("thead", null, head),
            React.createElement("tbody", null, rows),
          ),
        ),
        ...footer,
      );
    }

    /**
     * Render the quota segments with the official StatsLine separator
     * (`|` with `margin: 0 10px`, separator color) so the spacing matches the
     * built-in context line exactly. Each segment is an interactive span.
     */
    function renderSegmentLine(segments, style) {
      const sepStyle = {
        color: "var(--dsw-alias-label-tertiary)",
        margin: "0 10px",
      };
      const children = [];
      segments.forEach((segment, index) => {
        if (index > 0) {
          children.push(
            React.createElement(
              "span",
              { key: `sep${index}`, style: sepStyle, "aria-hidden": true },
              "|",
            ),
            " ",
          );
        }
        children.push(
          React.createElement(
            "span",
            {
              key: `seg${index}`,
              onMouseEnter: segment.onEnter,
              title: segment.title,
              "aria-label": segment.label ?? segment.text,
            },
            ...(segment.content ?? [segment.text]),
          ),
        );
      });
      return React.createElement("div", { style }, children);
    }

    /** Signed delta text: +0.05 / -0.05 / 0.00. */
    function formatDelta(delta) {
      if (typeof delta !== "number" || !Number.isFinite(delta)) return "\u2014";
      const sign = delta > 0 ? "+" : delta < 0 ? "-" : "";
      return `${sign}${Math.abs(delta).toFixed(2)}`;
    }

    /** Balance-delta color: green when increased, red when decreased. */
    function deltaColor(delta) {
      if (typeof delta !== "number" || !Number.isFinite(delta)) return undefined;
      if (delta > 0) return DELTA_UP_COLOR;
      if (delta < 0) return DELTA_DOWN_COLOR;
      return undefined;
    }

    // Current peak/valley stage on the CLIENT, mirroring host-side isPeak
    // (lib/index.js) so the quota line shows it even before host changes
    // land. Peak windows: 09:00–12:00 & 14:00–18:00 Beijing time; since
    // 2026-08-23 00:00 Beijing, weekends (Sat/Sun) are all-day off-peak.
    const CLIENT_PEAK_WINDOWS = [
      { start: 9 * 60, end: 12 * 60 },
      { start: 14 * 60, end: 18 * 60 },
    ];
    const CLIENT_BEIJING_OFFSET_MS = 8 * 60 * 60 * 1000;
    const CLIENT_DAY_MS = 24 * 60 * 60 * 1000;
    // 2026-08-23 00:00 北京时间 = 2026-08-22 16:00 UTC.
    const CLIENT_WEEKEND_OFFPEAK_SINCE_MS = Date.UTC(2026, 7, 22, 16, 0, 0);

    /** Whether NOW falls in a Beijing-time peak window (weekend rule included). */
    function isPeakNow() {
      const beijingMs = Date.now() + CLIENT_BEIJING_OFFSET_MS;
      if (beijingMs >= CLIENT_WEEKEND_OFFPEAK_SINCE_MS) {
        const day = new Date(beijingMs).getUTCDay();
        if (day === 0 || day === 6) return false;
      }
      const minutes = Math.floor((beijingMs % CLIENT_DAY_MS) / 60_000);
      return CLIENT_PEAK_WINDOWS.some((window) => minutes >= window.start && minutes < window.end);
    }

    /** The quota line's leading stage segment: 峰 (red) during peak, 谷 (green) otherwise. */
    function peakStageSegment(onEnter) {
      const peak = isPeakNow();
      const text = peak ? "\u5cf0" : "\u8c37";
      return {
        text,
        label: peak
          ? "\u5f53\u524d\u9ad8\u5cf0\u65f6\u6bb5\uff08\u60ac\u505c\u67e5\u770b\u8ba1\u8d39\u89c4\u5219\uff09"
          : "\u5f53\u524d\u4f4e\u8c37\u65f6\u6bb5\uff08\u60ac\u505c\u67e5\u770b\u8ba1\u8d39\u89c4\u5219\uff09",
        title: peak
          ? "\u5f53\u524d\u4e3a\u9ad8\u5cf0\u65f6\u6bb5\uff08\u5de5\u4f5c\u65e5 09:00-12:00 / 14:00-18:00\uff1b\u5468\u672b\u5168\u5929\u4f4e\u8c37\uff09"
          : "\u5f53\u524d\u4e3a\u4f4e\u8c37\uff08\u7a7a\u95f2\uff09\u65f6\u6bb5\uff08\u5176\u4f59\u65f6\u95f4\uff1b\u5468\u672b\u5168\u5929\u4f4e\u8c37\uff09",
        onEnter,
        // 峰 = 高峰价（贵）→ 红；谷 = 低谷价 → 绿。
        content: [
          React.createElement(
            "span",
            {
              style: {
                color: peak ? DELTA_DOWN_COLOR : DELTA_UP_COLOR,
              },
            },
            text,
          ),
        ],
      };
    }

    /** Hour label for an hourly bucket (the closing sample's HH:MM). */
    function formatHour(ms) {
      if (typeof ms !== "number") return "\u2014";
      const date = new Date(ms);
      return Number.isNaN(date.getTime())
        ? "\u2014"
        : date.toLocaleTimeString("zh-CN", { hour12: false, hour: "2-digit", minute: "2-digit" });
    }

    /** Date label for a daily bucket. */
    function formatDay(ms) {
      if (typeof ms !== "number") return "\u2014";
      const date = new Date(ms);
      return Number.isNaN(date.getTime())
        ? "\u2014"
        : date.toLocaleDateString("zh-CN", { month: "numeric", day: "numeric" });
    }

    /**
     * One balance-table row: time label, closing balance, the total-balance
     * delta (变化量（总）), and the current-API consumption delta
     * (变化量（当前API）). The last column shows the DeepSeek spend across
     * EVERY DSH session inside the row's window (a negative number — the
     * balance shrank by that much), priced from the durable session logs;
     * null means the window cannot be priced yet and renders "-".
     */
    function balanceRow(timeLabel, total, delta, key, consumed) {
      const color = deltaColor(delta);
      const consumedColor = typeof consumed === "number" && consumed < 0 ? DELTA_DOWN_COLOR : undefined;
      return tableRow(
        [
          dataCell(timeLabel, TD_L, "time"),
          dataCell(`\u00a5${total}`, TD_R, "total"),
          dataCell(
            color === undefined
              ? formatDelta(delta)
              : React.createElement("span", { style: { color } }, formatDelta(delta)),
            TD_R,
            "delta",
          ),
          dataCell(
            consumed === null
              ? "-"
              : React.createElement(
                  "span",
                  { style: consumedColor === undefined ? {} : { color: consumedColor } },
                  formatDelta(consumed),
                ),
            TD_R,
            "consumed",
          ),
        ],
        key,
      );
    }

    /**
     * DeepSeek spend inside the window (start, end], as a NEGATIVE balance
     * change (consumption shrinks the account). Both boundaries must be
     * present in the cumulative spend map; otherwise null.
     */
    function consumedDelta(spend, start, end) {
      if (spend === null || typeof spend !== "object") return null;
      if (typeof start !== "number" || typeof end !== "number") return null;
      const startRow = spend.boundaries[String(start)];
      const endRow = spend.boundaries[String(end)];
      if (startRow === undefined || endRow === undefined) return null;
      if (typeof startRow.cost !== "number" || typeof endRow.cost !== "number") return null;
      const delta = Math.round((endRow.cost - startRow.cost) * 100) / 100;
      return Number.isFinite(delta) ? -delta : null;
    }

    /** Delta of a bucket against its predecessor (newest-first list). */
    function bucketDelta(buckets, index) {
      const next = buckets[index + 1];
      if (next === undefined) return null;
      const current = Number(buckets[index].total);
      const previous = Number(next.total);
      return Number.isFinite(current) && Number.isFinite(previous)
        ? Math.round((current - previous) * 100) / 100
        : null;
    }

    /**
     * 余额：tabbed detail — per-refresh (5min) deltas, per-hour deltas, and
     * per-day deltas, each fixed at BALANCE_HISTORY_MAX rows without a
     * scrollbar.
     */
    function buildBalancePanel(snapshot, primary, tab, onTabChange) {
      const history = snapshot.history;
      const hourly = snapshot.hourly ?? [];
      const daily = snapshot.daily ?? [];
      // Cumulative global spend map (all sessions) plus the live "now"
      // boundary it was fetched at; rows price their window against it.
      const spend = snapshot.spend ?? null;
      const now = spend !== null && typeof spend.at === "number" ? spend.at : null;

      const tabDefs = [
        { id: "5min", label: "\u6bcf 5 \u5206\u949f" },
        { id: "1h", label: "\u6bcf 1 \u5c0f\u65f6" },
        { id: "1d", label: "\u6bcf 1 \u5929" },
      ];
      const tabBar = React.createElement(
        "div",
        { style: { display: "flex", gap: "6px", marginBottom: "6px" } },
        tabDefs.map((def) =>
          React.createElement(
            "button",
            {
              key: def.id,
              type: "button",
              onClick: () => onTabChange(def.id),
              style: {
                cursor: "pointer",
                background: "transparent",
                border: "1px solid var(--dsw-alias-border-l1)",
                borderRadius: "999px",
                padding: "2px 10px",
                fontSize: "12px",
                lineHeight: "18px",
                color: "var(--dsw-alias-label-tertiary)",
                ...(tab === def.id
                  ? {
                      color: "var(--dsw-alias-label-primary)",
                      background: "var(--dsw-alias-interactive-bg-hover)",
                      borderColor: "var(--dsw-alias-border-l2)",
                    }
                  : {}),
              },
            },
            def.label,
          ),
        ),
      );

      let rows;
      let titleText;
      if (tab === "1h") {
        titleText = `\u4f59\u989d\u53d8\u52a8 \u00b7 \u6bcf 1 \u5c0f\u65f6\uff08\u9996\u884c\u622a\u81f3\u5f53\u524d\uff09`;
        const currentTotal = primary !== undefined ? primary.total : (history[0]?.total ?? null);
        const lastCommitted = hourly[0];
        const liveDelta = currentTotal !== null && lastCommitted !== undefined
          ? Math.round((Number(currentTotal) - Number(lastCommitted.total)) * 100) / 100
          : null;
        rows = [
          balanceRow(
            "\u622a\u81f3\u5f53\u524d",
            currentTotal ?? "\u2014",
            liveDelta,
            "live",
            lastCommitted !== undefined && now !== null
              ? consumedDelta(spend, lastCommitted.at, now)
              : null,
          ),
          ...hourly.slice(0, BUCKET_HISTORY_MAX).map((entry, index) =>
            balanceRow(
              formatHour(entry.at),
              entry.total,
              bucketDelta(hourly, index),
              `bal-${index}`,
              hourly[index + 1] === undefined
                ? null
                : consumedDelta(spend, hourly[index + 1].at, entry.at),
            ),
          ),
        ];
      } else if (tab === "1d") {
        titleText = `\u4f59\u989d\u53d8\u52a8 \u00b7 \u6bcf 1 \u5929\uff08\u9996\u884c\u622a\u81f3\u5f53\u524d\uff09`;
        const currentTotal = primary !== undefined ? primary.total : (history[0]?.total ?? null);
        const lastCommitted = daily[0];
        const liveDelta = currentTotal !== null && lastCommitted !== undefined
          ? Math.round((Number(currentTotal) - Number(lastCommitted.total)) * 100) / 100
          : null;
        rows = [
          balanceRow(
            "\u622a\u81f3\u5f53\u524d",
            currentTotal ?? "\u2014",
            liveDelta,
            "live",
            lastCommitted !== undefined && now !== null
              ? consumedDelta(spend, lastCommitted.at, now)
              : null,
          ),
          ...daily.slice(0, BUCKET_HISTORY_MAX).map((entry, index) =>
            balanceRow(
              formatDay(entry.at),
              entry.total,
              bucketDelta(daily, index),
              `bal-${index}`,
              daily[index + 1] === undefined
                ? null
                : consumedDelta(spend, daily[index + 1].at, entry.at),
            ),
          ),
        ];
      } else {
        titleText = `\u4f59\u989d\u53d8\u52a8 \u00b7 \u6bcf 5 \u5206\u949f\uff08\u6700\u8fd1 ${history.length} \u6b21\u5237\u65b0\uff09`;
        rows = history.map((entry, index) =>
          balanceRow(
            formatTime(entry.at),
            entry.total,
            entry.delta,
            `bal-${index}`,
            history[index + 1] === undefined
              ? null
              : consumedDelta(spend, history[index + 1].at, entry.at),
          ),
        );
      }
      // Pad with empty rows so the panel height is constant across tabs —
      // otherwise switching to a sparser tab would shrink the card under the
      // pointer and the panel would close.
      for (let index = rows.length; index < BALANCE_HISTORY_MAX; index += 1) {
        rows = rows.concat(
          tableRow(
            [
              dataCell("", TD_L, "time"),
              dataCell("", TD_R, "total"),
              dataCell("", TD_R, "delta"),
              dataCell("-", TD_R, "consumed"),
            ],
            `pad-${index}`,
          ),
        );
      }

      const header = React.createElement("div", { style: PANEL_TITLE_STYLE }, titleText);
      const note = primary === undefined
        ? null
        : React.createElement(
            "div",
            { style: PANEL_NOTE_STYLE },
            `\u5f53\u524d\u4f59\u989d \u00a5${primary.total}\uff08\u8d60\u91d1 ${primary.granted}\uff0c\u5145\u503c ${primary.toppedUp}\uff09`,
          );
      const head = tableRow(
        [
          headCell("\u65f6\u95f4", TH_L, "h-time"),
          headCell("\u4f59\u989d", TH_R, "h-total"),
          headCell("\u53d8\u5316\u91cf\uff08\u603b\uff09", TH_R, "h-delta"),
          headCell(
            "\u53d8\u5316\u91cf\uff08\u5f53\u524dAPI\uff09",
            TH_R,
            "h-consumed",
            "\u5f53\u524d API \u7684\u4f59\u989d\u6d88\u8017\u53d8\u5316\uff08DSH \u6240\u6709\u4f1a\u8bdd\u7684\u603b\u6d88\u8017\uff09",
          ),
        ],
        "head",
      );
      // Fixed height (header + exactly BALANCE_HISTORY_MAX rows), never a
      // maxHeight: the card must not change size when switching tabs. Both
      // axes clipped: a longer CJK title must never raise a horizontal
      // scrollbar.
      return React.createElement(
        "div",
        null,
        header,
        tabBar,
        note,
        React.createElement(
          "div",
          { style: { height: `${(BALANCE_HISTORY_MAX + 1) * 22}px`, overflowY: "hidden", overflowX: "hidden" } },
          React.createElement(
            "table",
            { style: TABLE_STYLE },
            React.createElement("thead", null, head),
            React.createElement("tbody", null, rows),
          ),
        ),
      );
    }

    /**
     * Per-conversation DeepSeek spend line, rendered directly below the
     * built-in stats line inside the composer dock.
     *
     * Standard kit props: `sessionId`, `useSession`, `useProjection`, `useSessions`.
     */
    function QuotaContextLine({ sessionId, useSession, useProjection, useSessions }) {
      // Seed from the per-session cache so switching back to a known session
      // renders its numbers immediately; otherwise start in "loading" (which
      // still renders a placeholder line, so the dock never jumps).
      const [state, setState] = useState(() => {
        const cached = sessionId !== undefined ? contextCache.get(sessionId) : undefined;
        return cached !== undefined ? { status: "ok", data: cached.data } : { status: "loading" };
      });
      const lastFetchRef = useRef(0);

      // Balance is shared account state (module-level store), not per-session:
      // every session view renders the same value, delta, and history, and a
      // session switch never resets them. The single poller starts on first
      // mount and runs for the page lifetime.
      const balanceSnapshot = useSyncExternalStore(balanceStore.subscribe, balanceStore.getSnapshot);
      const balance = balanceSnapshot.state;
      const balanceHistory = balanceSnapshot.history;
      // Active balance-detail tab: per-refresh (5min) / hourly / daily.
      const [balanceTab, setBalanceTab] = useState("5min");
      useEffect(() => {
        balanceStore.ensurePolling();
      }, []);

      // Hover panel state: which segment is open and the anchor rect.
      const [hover, setHover] = useState(null);
      const [anchorRect, setAnchorRect] = useState(null);
      const lineRef = useRef(null);
      const panelRef = useRef(null);
      const anchorRef = useRef(null); // the hovered segment element

      useEffect(() => {
        console.info(`[deepseek-quota] context line mounted (session ${sessionId ?? "none"})`);
      }, [sessionId]);

      const refresh = useCallback(async (force = false) => {
        if (sessionId === undefined) return;
        const now = Date.now();
        if (!force && now - lastFetchRef.current < CONTEXT_THROTTLE_MS) return;
        lastFetchRef.current = now;
        try {
          // force → bypass the host's short TTL cache for the freshest data.
          const response = await fetch(
            `/api/deepseek-quota/context?sessionId=${encodeURIComponent(sessionId)}${force ? "&refresh=1" : ""}`,
            { cache: "no-store" },
          );
          const data = await response.json();
          console.info(`[deepseek-quota] context fetched (HTTP ${response.status})`);
          if (data && data.ok) {
            cacheContext(sessionId, data);
            setState({ status: "ok", data });
          } else {
            setState({ status: "error", data });
          }
        } catch (error) {
          console.warn("[deepseek-quota] context fetch failed:", error);
          setState({ status: "error", message: error instanceof Error ? error.message : String(error) });
        }
      }, [sessionId]);

      useEffect(() => {
        refresh(true);
        const timer = setInterval(() => refresh(false), CONTEXT_POLL_MS);
        return () => clearInterval(timer);
      }, [refresh]);

      // Refetch while the session streams (its durable tokenUsage projection
      // advances) or the session list moves (running subagents push their own
      // projection frames). The session snapshot is a third trigger: a fresh
      // turn/start carries no usage yet, so tokenUsage does not move — the
      // snapshot does, and 本轮 must flip to empty promptly. Throttled inside
      // refresh; a failed fetch also retries on the next change.
      const usage = useProjection("tokenUsage");
      const sessions = useSessions((s) => s);
      const sessionState = useSession((s) => s);
      useEffect(() => {
        refresh(false);
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [usage, sessions, sessionState, refresh]);

      const closePanel = useCallback(() => {
        setHover(null);
        setAnchorRect(null);
        anchorRef.current = null;
      }, []);

      const openPanel = useCallback((key) => (event) => {
        anchorRef.current = event.currentTarget;
        setAnchorRect(event.currentTarget.getBoundingClientRect());
        setHover(key);
      }, []);

      // Re-measure the anchor and reposition the panel. Used on scroll/resize
      // instead of closing: during streaming the chat auto-scrolls constantly,
      // and closing on that would make the panel flicker away.
      const reposition = useCallback(() => {
        const anchor = anchorRef.current;
        if (anchor === null) {
          closePanel();
          return;
        }
        const rect = anchor.getBoundingClientRect();
        if (rect.bottom < 0 || rect.top > window.innerHeight) {
          closePanel(); // the anchor scrolled out of view
          return;
        }
        setAnchorRect(rect);
      }, [closePanel]);

      // Grace period before closing: the pointer must cross the 8px gap
      // between the line and the panel, so a naive "left the line" close
      // would kill the panel before the pointer ever reaches it.
      const closeTimerRef = useRef(null);
      // True while the pointer has LEFT the card and the close timer is
      // armed. While leaving, page/chat scroll and resize must NOT cancel the
      // pending close: streaming auto-scroll fires scroll events constantly,
      // and cancelling on each one would keep the card open forever (the
      // pointer is already outside, so no mouseover ever re-arms the close).
      // Only moving back INSIDE the card cancels a pending leave-close.
      const leavingRef = useRef(false);
      const cancelPendingClose = useCallback(() => {
        leavingRef.current = false;
        if (closeTimerRef.current !== null) {
          clearTimeout(closeTimerRef.current);
          closeTimerRef.current = null;
        }
      }, []);
      const scheduleClose = useCallback(() => {
        if (closeTimerRef.current !== null) return;
        leavingRef.current = true;
        closeTimerRef.current = setTimeout(() => {
          closeTimerRef.current = null;
          leavingRef.current = false;
          closePanel();
        }, 150);
      }, [closePanel]);

      // The panel closes only when the pointer leaves both the line and the
      // panel (after the grace period) or the anchor scrolls out of view.
      // Scrolling inside the panel itself is ignored; scrolling the page or
      // chat repositions the panel instead of closing it — and never cancels
      // a close that is already pending because the pointer left.
      useEffect(() => {
        if (hover === null) return;
        const onMove = (event) => {
          const target = event.target;
          const inside =
            (lineRef.current !== null && lineRef.current.contains(target)) ||
            (panelRef.current !== null && panelRef.current.contains(target));
          if (inside) cancelPendingClose();
          else scheduleClose();
        };
        const onScroll = (event) => {
          if (event.target instanceof Node && panelRef.current !== null && panelRef.current.contains(event.target)) return;
          // A pending leave-close must survive scrolling (streaming auto-
          // scroll would otherwise cancel it forever); scrolling while the
          // pointer is still inside never has a pending close anyway.
          if (!leavingRef.current) cancelPendingClose();
          reposition();
        };
        const onResize = () => {
          if (!leavingRef.current) cancelPendingClose();
          reposition();
        };
        document.addEventListener("mouseover", onMove);
        window.addEventListener("scroll", onScroll, true);
        window.addEventListener("resize", onResize);
        return () => {
          document.removeEventListener("mouseover", onMove);
          window.removeEventListener("scroll", onScroll, true);
          window.removeEventListener("resize", onResize);
          cancelPendingClose();
        };
      }, [hover, closePanel, cancelPendingClose, scheduleClose, reposition]);

      // Position the panel above the anchor (below when it does not fit).
      useLayoutEffect(() => {
        if (hover === null || anchorRect === null) return;
        const el = panelRef.current;
        if (el === null) return;
        const width = el.offsetWidth;
        const height = el.offsetHeight;
        let left = anchorRect.left + anchorRect.width / 2 - width / 2;
        left = Math.max(8, Math.min(left, window.innerWidth - width - 8));
        let top = anchorRect.top - height - 8;
        if (top < 8) top = anchorRect.bottom + 8;
        el.style.left = `${left}px`;
        el.style.top = `${top}px`;
      }, [hover, anchorRect, state, balanceSnapshot, balanceTab]);

      // Mirror the official StatsLine root stylesheet exactly so the quota
      // line is visually identical to the built-in context line above it.
      const baseStyle = {
        textAlign: "center",
        maxWidth: "var(--dsh-chat-content-width)",
        boxSizing: "border-box",
        width: "100%",
        padding: "4px calc(var(--dsh-composer-side-clearance) + 16px) 0px",
        color: "var(--dsw-alias-label-tertiary)",
        whiteSpace: "nowrap",
        textOverflow: "ellipsis",
        margin: "0 auto",
        fontSize: "12px",
        lineHeight: "20px",
        display: "block",
        overflow: "hidden",
      };

      // Balance segment (leading): total remaining quota, from the same route
      // the sidebar indicator uses. After the first refresh it carries a
      // colored delta in parentheses (red decrease / green increase), and
      // hovering opens the recent-refresh breakdown panel.
      const balancePrimary = balance.status === "ok" ? balance.data.balances[0] : undefined;
      const balanceSymbol = balancePrimary === undefined
        ? "\u00a5"
        : CURRENCY_SYMBOL[balancePrimary.currency] ?? `${balancePrimary.currency} `;
      const latestDelta = balanceHistory.length > 0 ? balanceHistory[0].delta : null;
      const deltaText = formatDelta(latestDelta);
      const balanceSegment = {
        text: balancePrimary !== undefined
          ? `\u4f59\u989d\uff1a${balanceSymbol}${balancePrimary.total}`
          : `\u4f59\u989d\uff1a${balance.status === "error" ? "\u2014" : "\u2026"}`,
        content: [
          balancePrimary !== undefined
            ? `\u4f59\u989d\uff1a${balanceSymbol}${balancePrimary.total}`
            : `\u4f59\u989d\uff1a${balance.status === "error" ? "\u2014" : "\u2026"}`,
          ...(latestDelta !== null
            ? [React.createElement(
                "span",
                {
                  key: "delta",
                  style: { ...deltaColor(latestDelta) === undefined ? {} : { color: deltaColor(latestDelta) } },
                },
                `\uff08${deltaText}\uff09`,
              )]
            : []),
        ],
        title: balancePrimary !== undefined
          ? `DeepSeek \u603b\u5269\u4f59\u989d\uff08\u8d60\u91d1 ${balancePrimary.granted}\uff0c\u5145\u503c ${balancePrimary.toppedUp}\uff09`
          : undefined,
        onEnter: openPanel("balance"),
      };

      // While loading, render a placeholder line (same height as the real
      // one) so the dock never jumps when the numbers arrive; on error the
      // placeholder turns red and hover shows the reason.
      if (state.status !== "ok") {
        // The stage marker does not depend on the context fetch: show the
        // real 峰/谷 even while loading / on error (the billing panel needs
        // context data, so no onEnter here — the native title suffices).
        if (state.status === "loading") {
          return renderSegmentLine(
            [
              peakStageSegment(),
              balanceSegment,
              { text: "\u5f53\u524d\u4f1a\u8bdd\uff1a\u2026" },
              { text: "\u672c\u8f6e\u5bf9\u8bdd\uff1a\u2026" },
              { text: "\u5b50\u4ee3\u7406\uff1a\u2026" },
            ],
            baseStyle,
          );
        }
        return renderSegmentLine(
          [
            peakStageSegment(),
            { ...balanceSegment, text: `\u4f59\u989d\uff1a${balance.status === "error" ? "\u2014" : "\u2026"}` },
            { text: "\u5f53\u524d\u4f1a\u8bdd\uff1a\u2014" },
            { text: "\u672c\u8f6e\u5bf9\u8bdd\uff1a\u2014" },
            { text: "\u5b50\u4ee3\u7406\uff1a\u2014" },
          ],
          { ...baseStyle, color: "var(--dsw-alias-state-error-primary, #e5484d)" },
        );
      }
      const data = state.data;

      const session = data.session;
      const turn = data.turn;
      const subagents = data.subagents;
      if (session === undefined) return null;

      const sessionCost = formatCost(session.cost);
      const turnCost = turn === null || turn === undefined ? "\u2014" : formatCost(turn.cost);
      const subagentCost = subagents === undefined || subagents.cost === null || subagents.cost === undefined
        ? "\u2014"
        : formatCost(subagents.cost);

      const line = renderSegmentLine(
        [
          // Leading stage marker (峰/谷) directly in front of the balance;
          // hover opens the billing-rules panel.
          peakStageSegment(openPanel("billing")),
          balanceSegment,
          {
            text: `\u5f53\u524d\u4f1a\u8bdd\uff1a${sessionCost}`,
            label: `\u5f53\u524d\u4f1a\u8bdd \u00a5${sessionCost}\uff08\u60ac\u505c\u67e5\u770b\u6309\u6a21\u578b\u7ec6\u5206\uff09`,
            onEnter: openPanel("session"),
          },
          {
            text: `\u672c\u8f6e\u5bf9\u8bdd\uff1a${turnCost}`,
            label: `\u672c\u8f6e\u5bf9\u8bdd \u00a5${turnCost}\uff08\u60ac\u505c\u67e5\u770b\u6bcf\u8bf7\u6c42\u660e\u7ec6\uff09`,
            onEnter: openPanel("turn"),
          },
          {
            text: `\u5b50\u4ee3\u7406\uff1a${subagentCost}`,
            label: `\u5b50\u4ee3\u7406 \u00a5${subagentCost}\uff08\u60ac\u505c\u67e5\u770b\u5404\u5b50\u4ee3\u7406\u660e\u7ec6\uff09`,
            onEnter: openPanel("subagents"),
          },
        ],
        baseStyle,
      );

      let panelContent = null;
      if (hover === "billing") panelContent = buildPricingPanel(data);
      else if (hover === "balance") panelContent = buildBalancePanel(balanceSnapshot, balancePrimary, balanceTab, setBalanceTab);
      else if (hover === "session") panelContent = buildSessionPanel(session, data);
      else if (hover === "turn" && turn !== null && turn !== undefined) panelContent = buildTurnPanel(turn);
      else if (hover === "subagents" && subagents !== undefined) panelContent = buildSubagentsPanel(subagents);

      let panel = null;
      if (panelContent !== null) {
        const panelElement = React.createElement(
          "div",
          {
            ref: panelRef,
            // The balance panel is tabbed: pin its width (420px fits the
            // four columns 时间/余额/变化量（总）/变化量（当前API）) and clip
            // horizontal overflow so switching tabs never resizes or scrolls
            // the card.
            style: hover === "balance"
              ? { ...PANEL_STYLE, width: "420px", overflowX: "hidden" }
              : PANEL_STYLE,
            role: "tooltip",
          },
          panelContent,
        );
        panel = ReactDOM !== null
          ? ReactDOM.createPortal(panelElement, document.body)
          : panelElement;
      }

      return React.createElement(
        Fragment,
        null,
        React.createElement("div", { ref: lineRef, onMouseLeave: () => {} }, line),
        panel,
      );
    }

    function apply(ctx) {
      ctx.slots.inject("conversation.composer.dock", () =>
        ctx.slots.register(
          { name: "conversation.composer.dock", id: "deepseek-quota-context", order: 1 },
          QuotaContextLine,
        ),
      );
    }

    return { inject, apply };
  },
});
