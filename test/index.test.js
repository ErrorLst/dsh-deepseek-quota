// @dsh-external/dsh-deepseek-quota — host half smoke tests (node:test, zero dependencies).
//
// Covers the plugin surface (name/inject), both route registrations, the
// balance handler with a stubbed global fetch (missing key, success
// normalization, auth failure, method rejection, TTL cache + refresh=1),
// the pricing helpers (peak/off-peak windows, tier resolution), the durable
// usage fold (per-step last-wins, per-turn aggregation, seed skipping), and
// the context route end-to-end with stubbed session/subagent services.

import { test } from "node:test";
import assert from "node:assert/strict";

import { name, inject, apply, cumulativeSpend, foldSessionUsage, isPeak, normalizePricing, resolveTier } from "../lib/index.js";

/** Minimal Cordis-like context: captures the registered routes. */
function makeCtx() {
  const routes = [];
  return {
    ctx: {
      get: () => undefined,
      webServer: {
        register(desc) {
          routes.push(desc);
          return () => {};
        },
      },
      effect: (fn) => fn(),
    },
    routes,
  };
}

/** Context whose `get` dispatches on service name. */
function makeServiceCtx({ sessions, subagents, persistence }) {
  const routes = [];
  return {
    ctx: {
      get: (service) => {
        if (service === "sessions") return sessions === undefined ? undefined : { list: () => sessions };
        if (service === "subagents") return subagents;
        if (service === "sessionPersistence") return persistence;
        return undefined;
      },
      webServer: {
        register(desc) {
          routes.push(desc);
          return () => {};
        },
      },
      effect: (fn) => fn(),
    },
    routes,
  };
}

/** Invoke a captured route handler and resolve with the response object. */
function invoke(desc, { method = "GET", url = "/api/deepseek-quota" } = {}) {
  return new Promise((resolve, reject) => {
    const res = {
      status: 0,
      headers: undefined,
      body: undefined,
      writeHead(status, headers) {
        this.status = status;
        this.headers = headers;
      },
      end(body) {
        this.body = body;
        resolve(this);
      },
    };
    Promise.resolve(desc.handler({ method, url }, res)).catch(reject);
  });
}

/** Run fn with a stubbed global fetch; restores the previous global afterwards. */
async function withFetch(impl, fn) {
  const prev = globalThis.fetch;
  globalThis.fetch = impl;
  try {
    return await fn();
  } finally {
    globalThis.fetch = prev;
  }
}

/** Run fn with process.env[key] set (or removed when value is undefined). */
async function withEnv(key, value, fn) {
  const prev = process.env[key];
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
  try {
    return await fn();
  } finally {
    if (prev === undefined) delete process.env[key];
    else process.env[key] = prev;
  }
}

const BALANCE_PAYLOAD = {
  is_available: true,
  balance_infos: [
    {
      currency: "CNY",
      total_balance: "123.45",
      granted_balance: "10.00",
      topped_up_balance: "113.45",
    },
  ],
};

// ---------------------------------------------------------------------------
// Session-log event builders
// ---------------------------------------------------------------------------

function headerEvent(model, provider = "deepseek", seq = 0) {
  return { type: "request/header", seq, time: 0, data: { header: { config: { provider, model } } } };
}

function usageMessageEvent(seq, turn, step, usage, time) {
  return { type: "assistant/message", seq, time, data: { turn, step, usage } };
}

function usageChunkEvent(seq, turn, step, usage, time) {
  return { type: "assistant/chunk", seq, time, data: { turn, step, chunk: { type: "usage", usage } } };
}

// 2026-08-17 02:00 UTC = 10:00 北京（高峰）；12:00 UTC = 20:00 北京（空闲）。
const PEAK_MS = Date.UTC(2026, 7, 17, 2, 0, 0);
const OFFPEAK_MS = Date.UTC(2026, 7, 17, 12, 0, 0);

// ---------------------------------------------------------------------------
// Plugin surface
// ---------------------------------------------------------------------------

test("plugin surface declares the expected identity", () => {
  assert.equal(name, "deepseek-quota");
  assert.deepEqual(inject, ["webServer"]);
});

test("apply registers all three routes", () => {
  const { ctx, routes } = makeCtx();
  apply(ctx);
  assert.equal(routes.length, 3);
  assert.deepEqual(
    routes.map((route) => ({ kind: route.kind, path: route.path })).sort((a, b) => a.path.localeCompare(b.path)),
    [
      { kind: "exact", path: "/api/deepseek-quota" },
      { kind: "exact", path: "/api/deepseek-quota/context" },
      { kind: "exact", path: "/api/deepseek-quota/spend" },
    ],
  );
});

// ---------------------------------------------------------------------------
// Balance route
// ---------------------------------------------------------------------------

test("responds MISSING_KEY when no credentials service and no env key", async () => {
  await withEnv("DEEPSEEK_API_KEY", undefined, async () => {
    const { ctx, routes } = makeCtx();
    apply(ctx);
    const res = await invoke(routes[0]);
    assert.equal(res.status, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.ok, false);
    assert.equal(body.code, "MISSING_KEY");
  });
});

test("fetches with the env key and normalizes the balance payload", async () => {
  let captured;
  await withEnv("DEEPSEEK_API_KEY", "test-key-123", async () => {
    await withFetch(async (url, opts) => {
      captured = { url, opts };
      return { ok: true, status: 200, json: async () => BALANCE_PAYLOAD };
    }, async () => {
      const { ctx, routes } = makeCtx();
      apply(ctx);
      const res = await invoke(routes[0]);
      assert.equal(res.status, 200);
      assert.equal(captured.url, "https://api.deepseek.com/user/balance");
      assert.equal(captured.opts.headers.authorization, "Bearer test-key-123");
      const body = JSON.parse(res.body);
      assert.equal(body.ok, true);
      assert.equal(body.isAvailable, true);
      assert.deepEqual(body.balances, [
        {
          currency: "CNY",
          total: "123.45",
          granted: "10.00",
          toppedUp: "113.45",
        },
      ]);
      assert.equal(typeof body.fetchedAt, "number");
    });
  });
});

test("maps HTTP 401 to the AUTH code with the upstream message", async () => {
  await withEnv("DEEPSEEK_API_KEY", "bad-key", async () => {
    await withFetch(async () => ({
      ok: false,
      status: 401,
      json: async () => ({ error: { message: "Authentication Fails" } }),
    }), async () => {
      const { ctx, routes } = makeCtx();
      apply(ctx);
      const res = await invoke(routes[0]);
      const body = JSON.parse(res.body);
      assert.equal(body.ok, false);
      assert.equal(body.code, "AUTH");
      assert.equal(body.status, 401);
      assert.equal(body.message, "Authentication Fails");
    });
  });
});

test("rejects non-GET methods with 405", async () => {
  await withEnv("DEEPSEEK_API_KEY", "test-key-123", async () => {
    await withFetch(async () => ({
      ok: true,
      status: 200,
      json: async () => BALANCE_PAYLOAD,
    }), async () => {
      const { ctx, routes } = makeCtx();
      apply(ctx);
      const res = await invoke(routes[0], { method: "POST" });
      assert.equal(res.status, 405);
      assert.equal(JSON.parse(res.body).code, "METHOD");
    });
  });
});

test("serves the cached body within the TTL and refreshes on refresh=1", async () => {
  await withEnv("DEEPSEEK_API_KEY", "test-key-123", async () => {
    let calls = 0;
    await withFetch(async () => {
      calls += 1;
      return { ok: true, status: 200, json: async () => BALANCE_PAYLOAD };
    }, async () => {
      const { ctx, routes } = makeCtx();
      apply(ctx);
      const handler = routes[0];
      const first = await invoke(handler);
      assert.equal(JSON.parse(first.body).ok, true);
      const cached = await invoke(handler); // second call: cache hit
      assert.equal(calls, 1, "cached hit must not refetch");
      assert.equal(JSON.parse(cached.body).ok, true);
      const fresh = await invoke(handler, { url: "/api/deepseek-quota?refresh=1" });
      assert.equal(calls, 2, "refresh=1 must bypass the cache");
      assert.equal(JSON.parse(fresh.body).ok, true);
    });
  });
});

// ---------------------------------------------------------------------------
// Pricing helpers
// ---------------------------------------------------------------------------

test("weekends are all-day off-peak since 2026-08-23 (Beijing time)", () => {
  // 2026-08-22 (周六) 10:00 北京 — 新规则生效前：仍按原峰谷规则 → 高峰。
  assert.equal(isPeak(Date.UTC(2026, 7, 22, 2, 0, 0)), true, "8/22 周六 10:00 北京（生效前）高峰");
  // 2026-08-23 00:00 北京 = 2026-08-22 16:00 UTC — 新规则生效边界 → 低谷。
  assert.equal(isPeak(Date.UTC(2026, 7, 22, 16, 0, 0)), false, "8/23 周日 00:00 北京 周末低谷");
  // 2026-08-23 (周日) 10:00 北京 — 周末不再有高峰时段。
  assert.equal(isPeak(Date.UTC(2026, 7, 23, 2, 0, 0)), false, "8/23 周日 10:00 北京 周末低谷");
  // 2026-08-23 (周日) 15:00 北京 — 原 14:00–18:00 高峰窗口在周末也不生效。
  assert.equal(isPeak(Date.UTC(2026, 7, 23, 7, 0, 0)), false, "8/23 周日 15:00 北京 周末低谷");
  // 2026-08-29 (周六) 14:30 北京 — 同样按低谷。
  assert.equal(isPeak(Date.UTC(2026, 7, 29, 6, 30, 0)), false, "8/29 周六 14:30 北京 周末低谷");
  // 工作日不受影响：8/24 (周一) 10:00 北京 → 高峰；20:00 → 低谷。
  assert.equal(isPeak(Date.UTC(2026, 7, 24, 2, 0, 0)), true, "8/24 周一 10:00 北京 高峰");
  assert.equal(isPeak(Date.UTC(2026, 7, 24, 12, 0, 0)), false, "8/24 周一 20:00 北京 低谷");
});

test("peak windows follow Beijing time: 09–12 and 14–18 are peak, else off-peak", () => {
  // 2026-08-17 UTC hours → Beijing = UTC + 8
  assert.equal(isPeak(Date.UTC(2026, 7, 17, 0, 59, 59)), false, "08:59 北京 空闲");
  assert.equal(isPeak(Date.UTC(2026, 7, 17, 2, 0, 0)), true, "09:00 北京 高峰");
  assert.equal(isPeak(Date.UTC(2026, 7, 17, 3, 59, 59)), true, "11:59 北京 高峰");
  assert.equal(isPeak(Date.UTC(2026, 7, 17, 4, 0, 0)), false, "12:00 北京 空闲");
  assert.equal(isPeak(Date.UTC(2026, 7, 17, 5, 59, 59)), false, "13:59 北京 空闲");
  assert.equal(isPeak(Date.UTC(2026, 7, 17, 6, 0, 0)), true, "14:00 北京 高峰");
  assert.equal(isPeak(Date.UTC(2026, 7, 17, 9, 59, 59)), true, "17:59 北京 高峰");
  assert.equal(isPeak(Date.UTC(2026, 7, 17, 10, 0, 0)), false, "18:00 北京 空闲");
});

test("tier resolution maps model ids onto the official tiers", () => {
  const pricing = normalizePricing(undefined);
  assert.equal(resolveTier("deepseek-chat", pricing), "deepseek-chat");
  assert.equal(resolveTier("deepseek-v4-flash", pricing), "deepseek-chat");
  assert.equal(resolveTier("deepseek-v4-flash-vision-exp", pricing), "deepseek-chat", "vision model prices like flash");
  assert.equal(resolveTier("deepseek-reasoner", pricing), "deepseek-reasoner");
  assert.equal(resolveTier("deepseek-v4-pro", pricing), "deepseek-reasoner");
  assert.equal(resolveTier("some-other-model", pricing), "deepseek-chat", "unknown falls back");
});

// ---------------------------------------------------------------------------
// Usage fold
// ---------------------------------------------------------------------------

test("fold prices peak and off-peak samples with the official rates", () => {
  const pricing = normalizePricing(undefined);
  const events = [
    headerEvent("deepseek-chat"),
    usageMessageEvent(1, 0, 0, { inputTokens: 1000, cacheReadTokens: 2000, outputTokens: 500 }, PEAK_MS),
    usageMessageEvent(2, 1, 0, { inputTokens: 1000, outputTokens: 500 }, OFFPEAK_MS),
  ];
  const folded = foldSessionUsage(events, 0, pricing);
  // 高峰: 1000*3.0 + 2000*0.10 + 500*9.0 = 7700 → 0.0077
  // 空闲: 1000*1.5 + 500*4.5 = 3750 → 0.00375
  assert.equal(folded.currentTurn, 1);
  assert.equal(folded.totals.uncachedInput, 2000);
  assert.equal(folded.totals.cacheRead, 2000);
  assert.equal(folded.totals.output, 1000);
  assert.equal(Math.round(folded.totals.cost * 1e6), 7700 + 3750);
  assert.equal(Math.round(folded.byTurn.get(0).cost * 1e6), 7700);
  assert.equal(Math.round(folded.byTurn.get(1).cost * 1e6), 3750);
  assert.equal(folded.model, "deepseek-chat");
});

test("fold keeps only the last usage sample per (turn, step)", () => {
  const pricing = normalizePricing(undefined);
  const events = [
    headerEvent("deepseek-reasoner"),
    usageChunkEvent(1, 0, 0, { inputTokens: 900, outputTokens: 100 }, PEAK_MS),
    usageMessageEvent(2, 0, 0, { inputTokens: 1000, outputTokens: 200 }, PEAK_MS),
  ];
  const folded = foldSessionUsage(events, 0, pricing);
  assert.equal(folded.totals.uncachedInput, 1000, "early chunk sample must be replaced");
  assert.equal(folded.totals.output, 200);
  assert.equal(folded.totals.samples, 1);
});

test("fold skips the inherited seed prefix of child sessions", () => {
  const pricing = normalizePricing(undefined);
  const events = [
    headerEvent("deepseek-chat"),
    usageMessageEvent(1, 0, 0, { inputTokens: 5000, outputTokens: 1000 }, PEAK_MS), // seed (parent's usage)
    usageMessageEvent(2, 1, 0, { inputTokens: 100, outputTokens: 50 }, OFFPEAK_MS), // child's own
  ];
  const folded = foldSessionUsage(events, 2, pricing);
  assert.equal(folded.totals.uncachedInput, 100, "seed usage must not be counted");
  assert.equal(folded.totals.output, 50);
  assert.equal(folded.currentTurn, 1);
});

test("reasoner tier applies pro rates", () => {
  const pricing = normalizePricing(undefined);
  const events = [
    headerEvent("deepseek-reasoner"),
    usageMessageEvent(1, 0, 0, { inputTokens: 1000, outputTokens: 500 }, PEAK_MS),
  ];
  const folded = foldSessionUsage(events, 0, pricing);
  // 高峰 Pro: 1000*9.0 + 500*27.0 = 22500 → 0.0225
  assert.equal(Math.round(folded.totals.cost * 1e6), 22500);
});

// ---------------------------------------------------------------------------
// Context route
// ---------------------------------------------------------------------------

test("context route answers MISSING_SESSION without a sessionId", async () => {
  const { ctx, routes } = makeServiceCtx({ sessions: [] });
  apply(ctx);
  const context = routes.find((route) => route.path === "/api/deepseek-quota/context");
  const res = await invoke(context, { url: "/api/deepseek-quota/context" });
  const body = JSON.parse(res.body);
  assert.equal(body.ok, false);
  assert.equal(body.code, "MISSING_SESSION");
});

test("context route answers SESSION_NOT_FOUND for an unknown id", async () => {
  const { ctx, routes } = makeServiceCtx({ sessions: [] });
  apply(ctx);
  const context = routes.find((route) => route.path === "/api/deepseek-quota/context");
  const res = await invoke(context, { url: "/api/deepseek-quota/context?sessionId=nope" });
  const body = JSON.parse(res.body);
  assert.equal(body.ok, false);
  assert.equal(body.code, "SESSION_NOT_FOUND");
});

test("context route reports session, latest turn, and subagent spend", async () => {
  const mainEvents = [
    headerEvent("deepseek-chat"),
    usageMessageEvent(1, 0, 0, { inputTokens: 1000, cacheReadTokens: 2000, outputTokens: 500 }, PEAK_MS),
    usageMessageEvent(2, 1, 0, { inputTokens: 1000, outputTokens: 500 }, OFFPEAK_MS),
  ];
  const childAEvents = [
    headerEvent("deepseek-chat"),
    usageMessageEvent(1, 0, 0, { inputTokens: 100, outputTokens: 50 }, OFFPEAK_MS),
  ];
  // Child B inherits a parent-history seed whose usage must be skipped.
  const childBEvents = [
    headerEvent("deepseek-chat"),
    usageMessageEvent(1, 0, 0, { inputTokens: 5000, outputTokens: 1000 }, PEAK_MS),
    usageMessageEvent(2, 1, 0, { inputTokens: 200, outputTokens: 100 }, OFFPEAK_MS),
  ];
  const sessions = [
    { header: { id: "main", seedLength: 0 }, events: mainEvents },
    { header: { id: "child-a", seedLength: 0 }, events: childAEvents },
    { header: { id: "child-b", seedLength: 2 }, events: childBEvents },
  ];
  const subagents = {
    listDescendants: async () => [
      { kind: "child", id: "child-a", label: "A" },
      { kind: "child", id: "child-b" },
    ],
  };

  const { ctx, routes } = makeServiceCtx({ sessions, subagents });
  apply(ctx);
  const context = routes.find((route) => route.path === "/api/deepseek-quota/context");
  const res = await invoke(context, { url: "/api/deepseek-quota/context?sessionId=main" });
  assert.equal(res.status, 200);
  const body = JSON.parse(res.body);
  assert.equal(body.ok, true);
  assert.equal(body.currency, "CNY");
  assert.equal(body.pricingVersion, "deepseek-v4-2026-08-23");
  assert.equal(typeof body.currentPeak, "boolean", "the session panel needs the current stage");

  // Session: 高峰 0.0077 + 空闲 0.00375 = 0.01145
  assert.equal(Math.round(body.session.cost * 1e6), 11450);
  assert.equal(body.session.uncachedInputTokens, 2000);
  assert.equal(body.session.cacheReadTokens, 2000);
  assert.equal(body.session.outputTokens, 1000);
  assert.equal(body.session.model, "deepseek-chat");
  assert.equal(body.session.tier, "deepseek-chat");

  // Per-model breakdown: one tier with the whole session cost, split by bucket.
  // flash peak: 1000*3.0=3000, 2000*0.10=200, 500*9.0=4500; off-peak: 1000*1.5=1500, 500*4.5=2250
  assert.equal(body.session.models.length, 1);
  assert.equal(body.session.models[0].tier, "deepseek-chat");
  assert.equal(Math.round(body.session.models[0].cost * 1e6), 11450);
  assert.equal(body.session.models[0].steps, 2);
  assert.equal(Math.round(body.session.models[0].costUncachedInput * 1e6), 4500);
  assert.equal(Math.round(body.session.models[0].costCacheRead * 1e6), 200);
  assert.equal(Math.round(body.session.models[0].costOutput * 1e6), 6750);
  // Session-level bucket costs must match the model row.
  assert.equal(Math.round(body.session.costUncachedInput * 1e6), 4500);
  assert.equal(Math.round(body.session.costCacheRead * 1e6), 200);
  assert.equal(Math.round(body.session.costOutput * 1e6), 6750);

  // Latest turn = 1 → 0.00375, with per-request detail.
  assert.equal(body.turn.turn, 1);
  assert.equal(Math.round(body.turn.cost * 1e6), 3750);
  assert.equal(body.turn.requests.length, 1);
  assert.equal(body.turn.requests[0].step, 0);
  assert.equal(body.turn.requests[0].peak, false, "off-peak sample must be flagged");
  assert.equal(body.turn.requests[0].model, "deepseek-chat");
  assert.equal(Math.round(body.turn.requests[0].cost * 1e6), 3750);
  // Per-request bucket costs: 1000*1.5=1500, 500*4.5=2250 (off-peak).
  assert.equal(Math.round(body.turn.requests[0].costUncachedInput * 1e6), 1500);
  assert.equal(Math.round(body.turn.requests[0].costCacheRead * 1e6), 0);
  assert.equal(Math.round(body.turn.requests[0].costOutput * 1e6), 2250);
  // Turn-level bucket costs (total row) must match the request sum.
  assert.equal(Math.round(body.turn.costUncachedInput * 1e6), 1500);
  assert.equal(Math.round(body.turn.costCacheRead * 1e6), 0);
  assert.equal(Math.round(body.turn.costOutput * 1e6), 2250);
  assert.equal(body.turn.requestsTruncated, false);

  // Subagents: A = 100*1.5 + 50*4.5 = 375 → 0.000375; B = 200*1.5 + 100*4.5 = 750 → 0.00075
  assert.equal(body.subagents.count, 2);
  assert.equal(Math.round(body.subagents.cost * 1e6), 1125);
  assert.equal(body.subagents.children.length, 2);
  const childA = body.subagents.children.find((child) => child.id === "child-a");
  assert.equal(childA.label, "A");
  assert.equal(Math.round(childA.cost * 1e6), 375);
  assert.equal(childA.tier, "deepseek-chat");
  assert.equal(childA.steps, 1);
  // Child A bucket costs (off-peak): 100*1.5=150, 50*4.5=225.
  assert.equal(Math.round(childA.costUncachedInput * 1e6), 150);
  assert.equal(Math.round(childA.costCacheRead * 1e6), 0);
  assert.equal(Math.round(childA.costOutput * 1e6), 225);
  const childB = body.subagents.children.find((child) => child.id === "child-b");
  assert.equal(Math.round(childB.cost * 1e6), 750, "child seed usage must not double count");
});

test("context route splits session spend per model tier after a mid-session switch", async () => {
  const events = [
    headerEvent("deepseek-v4-flash"),
    usageMessageEvent(1, 0, 0, { inputTokens: 1000, cacheReadTokens: 2000, outputTokens: 500 }, PEAK_MS),
    headerEvent("deepseek-v4-pro"),
    usageMessageEvent(2, 1, 0, { inputTokens: 100, outputTokens: 50 }, PEAK_MS),
  ];
  const sessions = [{ header: { id: "main", seedLength: 0 }, events }];
  const { ctx, routes } = makeServiceCtx({ sessions, subagents: undefined });
  apply(ctx);
  const context = routes.find((route) => route.path === "/api/deepseek-quota/context");
  const res = await invoke(context, { url: "/api/deepseek-quota/context?sessionId=main" });
  const body = JSON.parse(res.body);
  assert.equal(body.ok, true);
  // flash: 1000*3.0 + 2000*0.10 + 500*9.0 = 7700; pro: 100*9.0 + 50*27.0 = 2250
  assert.equal(body.session.models.length, 2);
  const flash = body.session.models.find((entry) => entry.tier === "deepseek-chat");
  const pro = body.session.models.find((entry) => entry.tier === "deepseek-reasoner");
  assert.equal(Math.round(flash.cost * 1e6), 7700);
  assert.equal(flash.model, "deepseek-v4-flash");
  assert.equal(Math.round(pro.cost * 1e6), 2250);
  assert.equal(pro.model, "deepseek-v4-pro");
  assert.equal(Math.round(body.session.cost * 1e6), 9950, "models must sum to the session total");
  // Latest turn (1) is the pro request.
  assert.equal(body.turn.requests.length, 1);
  assert.equal(body.turn.requests[0].tier, "deepseek-reasoner");
});

test("context route tolerates a missing subagents service", async () => {
  const events = [
    headerEvent("deepseek-chat"),
    usageMessageEvent(1, 0, 0, { inputTokens: 100, outputTokens: 50 }, OFFPEAK_MS),
  ];
  const sessions = [{ header: { id: "main", seedLength: 0 }, events }];
  const { ctx, routes } = makeServiceCtx({ sessions, subagents: undefined });
  apply(ctx);
  const context = routes.find((route) => route.path === "/api/deepseek-quota/context");
  const res = await invoke(context, { url: "/api/deepseek-quota/context?sessionId=main" });
  const body = JSON.parse(res.body);
  assert.equal(body.ok, true);
  assert.equal(body.subagents.count, 0);
  assert.equal(Math.round(body.subagents.cost * 1e6), 0);
  assert.equal(Math.round(body.session.cost * 1e6), 375);
});

test("non-DeepSeek subagents are unpriced and excluded from the total", async () => {
  const events = [headerEvent("deepseek-chat")];
  const childDeepseekEvents = [
    headerEvent("deepseek-chat"),
    usageMessageEvent(1, 0, 0, { inputTokens: 100, outputTokens: 50 }, OFFPEAK_MS),
  ];
  const childOtherEvents = [
    headerEvent("gpt-4o", "openai"),
    usageMessageEvent(1, 0, 0, { inputTokens: 1000, outputTokens: 500 }, OFFPEAK_MS),
  ];
  const sessions = [
    { header: { id: "main", seedLength: 0 }, events },
    { header: { id: "child-ds", seedLength: 0 }, events: childDeepseekEvents },
    { header: { id: "child-other", seedLength: 0 }, events: childOtherEvents },
  ];
  const subagents = {
    listDescendants: async () => [
      { kind: "child", id: "child-ds" },
      { kind: "child", id: "child-other" },
    ],
  };
  const { ctx, routes } = makeServiceCtx({ sessions, subagents });
  apply(ctx);
  const context = routes.find((route) => route.path === "/api/deepseek-quota/context");
  const res = await invoke(context, { url: "/api/deepseek-quota/context?sessionId=main" });
  const body = JSON.parse(res.body);
  assert.equal(body.ok, true);
  assert.equal(body.subagents.count, 2);
  assert.equal(body.subagents.unpricedCount, 1);
  // Only the DeepSeek child contributes: 100*1.5 + 50*4.5 = 375.
  assert.equal(Math.round(body.subagents.cost * 1e6), 375);
  const other = body.subagents.children.find((child) => child.id === "child-other");
  assert.equal(other.unpriced, true);
  assert.equal(other.cost, null);
  assert.equal(other.uncachedInputTokens, 0, "unpriced rows must not leak tokens");
  const ds = body.subagents.children.find((child) => child.id === "child-ds");
  assert.equal(ds.unpriced, false);
  assert.equal(Math.round(ds.cost * 1e6), 375);
});

test("a freshly started turn with no usage yet reports an empty turn", async () => {
  const events = [
    headerEvent("deepseek-chat"),
    usageMessageEvent(1, 0, 0, { inputTokens: 100, outputTokens: 50 }, OFFPEAK_MS),
    { type: "turn/start", seq: 2, time: OFFPEAK_MS, data: { turn: 1 } },
  ];
  const sessions = [{ header: { id: "main", seedLength: 0 }, events }];
  const { ctx, routes } = makeServiceCtx({ sessions, subagents: undefined });
  apply(ctx);
  const context = routes.find((route) => route.path === "/api/deepseek-quota/context");
  const res = await invoke(context, { url: "/api/deepseek-quota/context?sessionId=main" });
  const body = JSON.parse(res.body);
  assert.equal(body.ok, true);
  assert.equal(body.turn, null, "a started-but-empty turn must not replay the previous turn");
  // Session totals stay untouched.
  assert.equal(Math.round(body.session.cost * 1e6), 375);
});

test("the current turn is reported once it produces usage", async () => {
  const events = [
    headerEvent("deepseek-chat"),
    usageMessageEvent(1, 0, 0, { inputTokens: 100, outputTokens: 50 }, OFFPEAK_MS),
    { type: "turn/start", seq: 2, time: OFFPEAK_MS, data: { turn: 1 } },
    usageMessageEvent(3, 1, 0, { inputTokens: 200, outputTokens: 100 }, OFFPEAK_MS),
  ];
  const sessions = [{ header: { id: "main", seedLength: 0 }, events }];
  const { ctx, routes } = makeServiceCtx({ sessions, subagents: undefined });
  apply(ctx);
  const context = routes.find((route) => route.path === "/api/deepseek-quota/context");
  const res = await invoke(context, { url: "/api/deepseek-quota/context?sessionId=main" });
  const body = JSON.parse(res.body);
  assert.equal(body.ok, true);
  assert.equal(body.turn.turn, 1);
  assert.equal(Math.round(body.turn.cost * 1e6), 750, "200*1.5 + 100*4.5 (off-peak)");
});

test("context route serves the per-session cache and refresh=1 bypasses it", async () => {
  const events = [
    headerEvent("deepseek-chat"),
    usageMessageEvent(1, 0, 0, { inputTokens: 100, outputTokens: 50 }, OFFPEAK_MS),
  ];
  const sessions = [{ header: { id: "main", seedLength: 0 }, events }];
  let listings = 0;
  const subagents = {
    listDescendants: async () => {
      listings += 1;
      return [];
    },
  };
  const { ctx, routes } = makeServiceCtx({ sessions, subagents });
  apply(ctx);
  const context = routes.find((route) => route.path === "/api/deepseek-quota/context");

  const first = await invoke(context, { url: "/api/deepseek-quota/context?sessionId=main" });
  assert.equal(JSON.parse(first.body).ok, true);
  assert.equal(listings, 1, "first call must compute");

  const cached = await invoke(context, { url: "/api/deepseek-quota/context?sessionId=main" });
  assert.equal(JSON.parse(cached.body).ok, true);
  assert.equal(listings, 1, "second call within the TTL must hit the cache");

  const fresh = await invoke(context, { url: "/api/deepseek-quota/context?sessionId=main&refresh=1" });
  assert.equal(JSON.parse(fresh.body).ok, true);
  assert.equal(listings, 2, "refresh=1 must bypass the cache");
});

// ---------------------------------------------------------------------------
// Spend route (global DeepSeek spend over time, all sessions)
// ---------------------------------------------------------------------------

test("cumulativeSpend prices window deltas at requested boundaries", () => {
  const pricing = normalizePricing(undefined);
  const events = [
    headerEvent("deepseek-chat"),
    usageMessageEvent(1, 0, 0, { inputTokens: 1000, outputTokens: 500 }, PEAK_MS), // 0.0075 peak
    usageMessageEvent(2, 1, 0, { inputTokens: 1000, outputTokens: 500 }, OFFPEAK_MS), // 0.00375 off-peak
  ];
  const folded = foldSessionUsage(events, 0, pricing);
  const rows = cumulativeSpend(folded.steps, pricing, [PEAK_MS - 1000, PEAK_MS + 1000, OFFPEAK_MS + 1000]);
  assert.equal(rows.length, 3);
  assert.equal(rows[0].cost, 0, "before the first sample nothing is spent");
  assert.equal(Math.round(rows[1].cost * 1e6), 7500);
  assert.equal(Math.round(rows[2].cost * 1e6), 11250);
  // Window (b0, b2] is the whole session; (b0, b1] only the peak sample.
  assert.equal(Math.round((rows[2].cost - rows[0].cost) * 1e6), 11250);
  assert.equal(Math.round((rows[1].cost - rows[0].cost) * 1e6), 7500);
  assert.equal(rows[2].steps, 2);
  assert.equal(rows[2].outputTokens, 1000);
  // Bucket cost: 500*9.0 (peak) + 500*4.5 (off-peak).
  assert.equal(Math.round(rows[2].costOutput * 1e6), 6750);
  assert.equal(Math.round(rows[2].costUncachedInput * 1e6), 4500, "1000*3.0 + 1000*1.5");
});

test("spend route returns cumulative DeepSeek spend across every session", async () => {
  const mainEvents = [
    headerEvent("deepseek-chat"),
    usageMessageEvent(1, 0, 0, { inputTokens: 1000, outputTokens: 500 }, PEAK_MS), // 0.0075
    usageMessageEvent(2, 1, 0, { inputTokens: 1000, outputTokens: 500 }, OFFPEAK_MS), // 0.00375
  ];
  // Child with an inherited seed prefix that must be skipped.
  const childEvents = [
    headerEvent("deepseek-chat"),
    usageMessageEvent(1, 0, 0, { inputTokens: 5000, outputTokens: 1000 }, PEAK_MS), // seed
    usageMessageEvent(2, 1, 0, { inputTokens: 200, outputTokens: 100 }, OFFPEAK_MS + 60_000), // 0.00075
  ];
  // Another provider's session must never be priced.
  const otherEvents = [
    headerEvent("gpt-4o", "openai"),
    usageMessageEvent(1, 0, 0, { inputTokens: 10_000, outputTokens: 5_000 }, OFFPEAK_MS),
  ];
  // A cold persisted session (pro tier, peak).
  const coldEvents = [
    headerEvent("deepseek-reasoner"),
    usageMessageEvent(1, 0, 0, { inputTokens: 100, outputTokens: 50 }, PEAK_MS), // 0.00225
  ];
  const sessions = [
    { header: { id: "main", seedLength: 0 }, events: mainEvents },
    { header: { id: "child", seedLength: 2 }, events: childEvents },
    { header: { id: "other", seedLength: 0 }, events: otherEvents },
  ];
  const persistence = {
    list: async () => [{ id: "cold", seedLength: 0 }],
    inspect: async (id) => {
      assert.equal(id, "cold");
      return { meta: { id: "cold", seedLength: 0 }, events: coldEvents };
    },
  };
  const { ctx, routes } = makeServiceCtx({ sessions, subagents: undefined, persistence });
  apply(ctx);
  const spend = routes.find((route) => route.path === "/api/deepseek-quota/spend");
  const url = "/api/deepseek-quota/spend?boundaries=" +
    [PEAK_MS - 1000, PEAK_MS + 1000, OFFPEAK_MS + 1000, OFFPEAK_MS + 120_000].join(",");
  const res = await invoke(spend, { url });
  assert.equal(res.status, 200);
  const body = JSON.parse(res.body);
  assert.equal(body.ok, true);
  assert.equal(body.currency, "CNY");
  assert.equal(body.pricingVersion, "deepseek-v4-2026-08-23");
  assert.equal(body.sessions, 4, "live main/child/other + persisted cold");
  assert.equal(body.samples, 4, "main 2 + child 1 + cold 1; the openai session is excluded");
  assert.equal(body.boundaries.length, 4);
  assert.equal(body.boundaries[0].cost, 0, "nothing spent before the first sample");
  // main peak (0.0075) + cold pro peak (0.00225)
  assert.equal(Math.round(body.boundaries[1].cost * 1e6), 9750);
  // + main off-peak (0.00375)
  assert.equal(Math.round(body.boundaries[2].cost * 1e6), 13500);
  // + child own usage (0.00075); seed skipped, openai never counted
  assert.equal(Math.round(body.boundaries[3].cost * 1e6), 14250);
  // Window (b1, b3] = off-peak + child = 0.00375 + 0.00075
  assert.equal(Math.round((body.boundaries[3].cost - body.boundaries[1].cost) * 1e6), 4500);
});

test("fold checkpoint: unchanged revision zero-read; changed revision folds only the delta", async () => {
  // First call folds the base log fully (inspect); revision r1 stays cached
  // with zero further reads; after r2 the delta (seq >= watermark) is folded
  // instead of re-inspecting the whole log.
  const base = [
    headerEvent("deepseek-chat", "deepseek", 0),
    usageMessageEvent(1, 0, 0, { inputTokens: 1000, outputTokens: 500 }, PEAK_MS),
  ];
  const tail = [
    usageMessageEvent(2, 1, 0, { inputTokens: 300, outputTokens: 150 }, OFFPEAK_MS),
    usageMessageEvent(3, 1, 1, { inputTokens: 200, outputTokens: 100 }, OFFPEAK_MS),
  ];
  let revision = "r1";
  let allEvents = [...base];
  let inspectCalls = 0;
  const readFromCalls = [];
  const persistence = {
    listSnapshots: async () => [{ header: { id: "cold" }, revision }],
    readFrom: async (id, fromSeq) => {
      readFromCalls.push(fromSeq);
      return { meta: { id, seedLength: 0 }, events: allEvents.filter((e) => e.seq >= fromSeq) };
    },
    inspect: async (id) => {
      inspectCalls += 1;
      return { meta: { id, seedLength: 0 }, events: allEvents };
    },
  };
  const { ctx, routes } = makeServiceCtx({ sessions: [], subagents: undefined, persistence });
  apply(ctx);
  const context = routes.find((route) => route.path === "/api/deepseek-quota/context");
  const url = "/api/deepseek-quota/context?sessionId=cold&refresh=1";

  const first = JSON.parse((await invoke(context, { url })).body);
  assert.equal(first.ok, true);
  assert.equal(first.session.steps, 1, "first full fold sees only the base sample");
  assert.equal(inspectCalls, 1, "first fold uses inspect (full)");
  assert.equal(readFromCalls.length, 0);

  const second = JSON.parse((await invoke(context, { url })).body);
  assert.equal(second.ok, true);
  assert.equal(second.session.steps, 1);
  assert.equal(inspectCalls, 1, "unchanged revision must not re-read");
  assert.equal(readFromCalls.length, 0, "unchanged revision: no readFrom either");

  revision = "r2";
  allEvents = base.concat(tail);
  const third = JSON.parse((await invoke(context, { url })).body);
  assert.equal(third.ok, true);
  assert.equal(third.session.steps, 3, "delta merges the two new samples");
  assert.equal(inspectCalls, 1, "changed revision must not re-inspect");
  assert.deepEqual(readFromCalls, [2], "delta read starts at the fold watermark (2)");
});

test("fold checkpoint: a recreated log identity discards the stale checkpoint", async () => {
  // id 只代表槽位：同一 id 下 createdAt 变化 = 全新日志，旧检查点（含样本与
  // fromSeq 水位线）必须整体丢弃 → 全量重算，绝不能把无关日志的样本误折叠。
  const oldEvents = [
    headerEvent("deepseek-chat", "deepseek", 0),
    usageMessageEvent(1, 0, 0, { inputTokens: 1000, outputTokens: 500 }, PEAK_MS),
  ];
  const newEvents = [
    headerEvent("deepseek-reasoner", "deepseek", 0),
    usageMessageEvent(1, 0, 0, { inputTokens: 10, outputTokens: 5 }, PEAK_MS),
  ];
  let revision = "r1";
  let identity = { createdAt: 111, cwd: "C:/old" };
  let allEvents = [...oldEvents];
  let inspectCalls = 0;
  const readFromCalls = [];
  const persistence = {
    listSnapshots: async () => [{ header: { id: "re", ...identity }, revision }],
    readFrom: async (id, fromSeq) => {
      readFromCalls.push(fromSeq);
      return { meta: { id, ...identity }, events: allEvents.filter((e) => e.seq >= fromSeq) };
    },
    inspect: async (id) => {
      inspectCalls += 1;
      return { meta: { id, ...identity, seedLength: 0 }, events: allEvents };
    },
  };
  const { ctx, routes } = makeServiceCtx({ sessions: [], subagents: undefined, persistence });
  apply(ctx);
  const context = routes.find((route) => route.path === "/api/deepseek-quota/context");
  const url = "/api/deepseek-quota/context?sessionId=re&refresh=1";

  const first = JSON.parse((await invoke(context, { url })).body);
  assert.equal(first.ok, true);
  assert.equal(first.session.steps, 1);
  assert.equal(inspectCalls, 1);

  // 同身份 + 增量 → 零读路径（2 个新样本经 delta 并入）
  revision = "r2";
  identity = { createdAt: 111, cwd: "C:/old" };
  allEvents = oldEvents.concat([
    usageMessageEvent(2, 1, 0, { inputTokens: 300, outputTokens: 150 }, OFFPEAK_MS),
  ]);
  const second = JSON.parse((await invoke(context, { url })).body);
  assert.equal(second.ok, true);
  assert.equal(second.session.steps, 2, "same identity appends via delta");
  assert.equal(inspectCalls, 1);
  assert.deepEqual(readFromCalls, [2], "delta watermark advanced to 2");

  // 重新创建：同一 id、新 createdAt → 旧检查点必须作废 → inspect 全量重算
  revision = "r3";
  identity = { createdAt: 222, cwd: "C:/new" };
  allEvents = [...newEvents];
  const third = JSON.parse((await invoke(context, { url })).body);
  assert.equal(third.ok, true);
  assert.equal(third.session.steps, 1, "recreated log folds from scratch");
  assert.equal(inspectCalls, 2, "identity mismatch must re-inspect");
  assert.deepEqual(readFromCalls, [2], "no delta read off a discarded checkpoint");
});

test("spend route tolerates an empty session set and drops invalid boundaries", async () => {
  const { ctx, routes } = makeServiceCtx({ sessions: [], subagents: undefined, persistence: undefined });
  apply(ctx);
  const spend = routes.find((route) => route.path === "/api/deepseek-quota/spend");
  const res = await invoke(spend, { url: "/api/deepseek-quota/spend?boundaries=abc,123,,123,-5,456" });
  const body = JSON.parse(res.body);
  assert.equal(body.ok, true);
  assert.equal(body.sessions, 0);
  assert.equal(body.samples, 0);
  assert.deepEqual(body.boundaries.map((row) => row.at), [123, 456], "invalid and duplicate boundaries are dropped");
  assert.equal(body.boundaries.every((row) => row.cost === 0), true);
});

test("spend route serves its fold cache and refresh=1 bypasses it", async () => {
  let listings = 0;
  const persistence = {
    list: async () => {
      listings += 1;
      return [];
    },
    inspect: async () => undefined,
  };
  const { ctx, routes } = makeServiceCtx({ sessions: [], subagents: undefined, persistence });
  apply(ctx);
  const spend = routes.find((route) => route.path === "/api/deepseek-quota/spend");
  const url = "/api/deepseek-quota/spend?boundaries=1000";

  const first = await invoke(spend, { url });
  assert.equal(JSON.parse(first.body).ok, true);
  assert.equal(listings, 1, "first call must enumerate");

  const cached = await invoke(spend, { url });
  assert.equal(JSON.parse(cached.body).ok, true);
  assert.equal(listings, 1, "second call within the TTL must hit the fold cache");

  const fresh = await invoke(spend, { url: url + "&refresh=1" });
  assert.equal(JSON.parse(fresh.body).ok, true);
  assert.equal(listings, 2, "refresh=1 must bypass the fold cache");
});

test("spend route rejects non-GET methods with 405", async () => {
  const { ctx, routes } = makeServiceCtx({ sessions: [] });
  apply(ctx);
  const spend = routes.find((route) => route.path === "/api/deepseek-quota/spend");
  const res = await invoke(spend, { method: "POST", url: "/api/deepseek-quota/spend" });
  assert.equal(res.status, 405);
  assert.equal(JSON.parse(res.body).code, "METHOD");
});
