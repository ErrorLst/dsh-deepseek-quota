// dsh-deepseek-quota — browser half.
//
// Registered through the client-modules system: this bundle is served at
// `/plugins/dsh-deepseek-quota/client.js`, executed once to register a factory
// under `window.__ModuleLoader__`, and materialized lazily. The factory returns
// the Cordis client plugin (`inject` + `apply`), which registers a small quota
// indicator into the sidebar footer's `sidebar.footer.action` slot.
//
// Only `react` is required (a platform seed word). No JSX: build elements with
// React.createElement. Inline styles reference the theme CSS variables so the
// indicator follows the active theme.

window.__ModuleLoader__.load({
  id: "dsh-deepseek-quota",
  factory: (require) => {
    const React = require("react");
    const { useState, useEffect, useCallback } = React;

    const inject = ["slots"];

    const POLL_MS = 60_000;
    const CURRENCY_SYMBOL = { CNY: "\u00a5", USD: "$" };

    function formatLabel(primary) {
      if (primary === undefined) return "\u2014";
      const symbol = CURRENCY_SYMBOL[primary.currency] ?? `${primary.currency} `;
      return `${symbol}${primary.total}`;
    }

    function QuotaIndicator({ wide }) {
      const [state, setState] = useState({ status: "loading" });

      const refresh = useCallback(async () => {
        try {
          const response = await fetch("/api/deepseek-quota", { cache: "no-store" });
          const data = await response.json();
          setState(data && data.ok ? { status: "ok", data } : { status: "error", data });
        } catch (error) {
          setState({ status: "error", message: error instanceof Error ? error.message : String(error) });
        }
      }, []);

      useEffect(() => {
        refresh();
        const timer = setInterval(refresh, POLL_MS);
        return () => clearInterval(timer);
      }, [refresh]);

      const primary = state.status === "ok" ? state.data.balances[0] : undefined;
      const label = formatLabel(primary);

      let title = "\u6b63\u5728\u67e5\u8be2 DeepSeek \u989d\u5ea6\u2026"; // 正在查询 DeepSeek 额度…
      if (state.status === "ok" && primary !== undefined) {
        title = `DeepSeek \u989d\u5ea6 ${label}\uff08\u8d60\u91d1 ${primary.granted}\uff0c\u5145\u503c ${primary.toppedUp}\uff09`; // 额度（赠金，充值）
        if (!state.data.isAvailable) title += " \u2014 \u989d\u5ea6\u4e0d\u8db3/\u4e0d\u53ef\u7528"; // 额度不足/不可用
      } else if (state.status === "error") {
        const message = state.data && state.data.message ? state.data.message : state.message;
        title = `DeepSeek \u989d\u5ea6\u67e5\u8be2\u5931\u8d25\uff1a${message ?? "unknown"}`; // 额度查询失败
      }

      const color =
        state.status === "error"
          ? "var(--dsw-alias-danger, #e5484d)"
          : state.status === "ok" && !state.data.isAvailable
            ? "var(--dsw-alias-warning, #f5a524)"
            : "var(--dsw-alias-label-secondary, #8a8f98)";

      const style = {
        cursor: "pointer",
        background: "transparent",
        border: "none",
        color,
        fontSize: "12px",
        lineHeight: "1",
        padding: "6px 8px",
        borderRadius: "6px",
        whiteSpace: "nowrap",
        maxWidth: "100%",
        overflow: "hidden",
        textOverflow: "ellipsis",
      };

      return React.createElement(
        "button",
        { type: "button", title, onClick: refresh, "aria-label": title, style },
        wide ? label : "\u00a5",
      );
    }

    function apply(ctx) {
      ctx.slots.inject("sidebar.footer.action", () =>
        ctx.slots.register(
          { name: "sidebar.footer.action", id: "deepseek-quota" },
          QuotaIndicator,
        ),
      );
    }

    return { inject, apply };
  },
});
