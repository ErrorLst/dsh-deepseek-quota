// @dsh-external/dsh-deepseek-quota — host half.
//
// Three read-only HTTP routes on the web profile's webServer:
//
//   GET /api/deepseek-quota           — DeepSeek account balance (existing).
//   GET /api/deepseek-quota/context   — per-session DeepSeek spend.
//   GET /api/deepseek-quota/spend     — global DeepSeek spend over time
//                                       (all sessions, cumulative at each
//                                       requested boundary timestamp).
//
// The context route answers "how much quota did this conversation burn" from
// the durable session log alone (no API call, no API key): it replays each
// session's events, folds the provider-reported usage samples (the same
// buckets the token-meter projection uses — uncached input, cache read,
// cache write, output), and prices them with the official DeepSeek
// peak/off-peak rate table (元 / 百万 tokens, Beijing time). It reports:
//
//   session    — the whole durable log of the requested session,
//   turn       — the latest turn (in progress while streaming),
//   subagents  — every durable descendant subagent session (live or cold),
//                enumerated through the subagents service and priced the
//                same way. Child usage starts at the seed boundary, so the
//                inherited parent-history prefix is never double counted.
//
// Everything derives from the persisted log, so the numbers survive reloads,
// restarts, paging, and compaction: this is the "persisted with the session"
// property — the durable events are the source of truth, money is a view.
//
// Zero runtime dependencies: only Node built-ins (global `fetch`, `URL`,
// `AbortSignal`) and the Cordis context passed into `apply`.

const DEFAULT_BASE_URL = "https://api.deepseek.com";
const DEFAULT_TTL_MS = 60_000;
const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_CONTEXT_TIMEOUT_MS = 8_000;
const DEFAULT_CONTEXT_CACHE_TTL_MS = 5_000;
/********************************************************************************
 * 全局消耗统计（spend 路由）的独立时间预算：折叠所有会话（逐个持久化读取+
 * 解析）远重于单会话的 context 路由，8 秒预算常常中途 abort 导致 partial
 * （漏掉的会话用量直接表现为「余额明细-当前API」窗口为 0）。后台统计给
 * 30 秒，仍受 spendSessionCap 约束。
 *******************************************************************************/
const DEFAULT_SPEND_TIMEOUT_MS = 30_000;
/** TTL for the global-spend sample fold (all sessions), shared by every boundary query. */
const DEFAULT_SPEND_CACHE_TTL_MS = 60_000;
/** Max boundary timestamps accepted by the spend route in one request. */
const SPEND_BOUNDARIES_CAP = 64;
/** Safety cap on how many sessions the global fold walks before going partial. */
const SPEND_SESSIONS_CAP = 512;
const SUBAGENT_CONCURRENCY = 4;
/** Per-turn request detail cap: a pathological turn must not balloon the response. */
const TURN_REQUESTS_CAP = 200;

// DeepSeek official peak/off-peak time-of-use pricing, effective 2026-08-17
// (DeepSeek-V4 series, 元 / 百万 tokens). 高峰时段为每日 09:00–12:00 与
// 14:00–18:00（北京时间），其余为空闲时段（空闲 = 高峰的一半）。
// 自 2026-08-23 00:00（北京时间）起，周末（周六/周日）全天不再区分峰谷，
// 统一按空闲（低谷）时段价格计费；生效前的历史调用仍按原规则计价。
// - deepseek-chat  ↔ DeepSeek-V4-Flash（含 deepseek-v4-flash-vision-exp）
// - deepseek-reasoner ↔ DeepSeek-V4-Pro
// Rates are overridable through `config.pricing`; see README.
const DEFAULT_PRICING = {
  version: "deepseek-v4-2026-08-23",
  currency: "CNY",
  tiers: {
    "deepseek-chat": {
      peak: { cacheHit: 0.1, cacheMiss: 3.0, output: 9.0 },
      offpeak: { cacheHit: 0.05, cacheMiss: 1.5, output: 4.5 },
    },
    "deepseek-reasoner": {
      peak: { cacheHit: 0.3, cacheMiss: 9.0, output: 27.0 },
      offpeak: { cacheHit: 0.15, cacheMiss: 4.5, output: 13.5 },
    },
  },
  fallbackTier: "deepseek-chat",
};

// 高峰时段（北京时间分钟）：09:00–12:00 与 14:00–18:00。
const PEAK_WINDOWS = [
  { start: 9 * 60, end: 12 * 60 },
  { start: 14 * 60, end: 18 * 60 },
];
// 周末低谷价规则（DeepSeek 官方 2026-08-23 00:00 北京时间起生效）：周六、
// 周日全天不再区分峰谷，统一按空闲（低谷）时段价格计费。生效前已产生的
// 历史调用仍按原规则（周末也分峰谷）计价，所以这里必须按时间截断。
// 2026-08-23 00:00 北京时间 = 2026-08-22 16:00 UTC。
const WEEKEND_OFFPEAK_SINCE_MS = Date.UTC(2026, 7, 22, 16, 0, 0);
const BEIJING_OFFSET_MS = 8 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

export const name = "deepseek-quota";
export const inject = ["webServer"];

export function apply(ctx, config = {}) {
  // Hard dependency on webServer: this bundle only mounts in the web profile,
  // so `inject` both guarantees the service is present before apply runs and
  // parks loudly (instead of silently no-op'ing) if it ever disappears.
  const webServer = ctx.webServer;

  const baseURL = config.baseURL ?? process.env.DEEPSEEK_BASE_URL ?? DEFAULT_BASE_URL;
  const ttlMs = Number(config.ttlMs ?? DEFAULT_TTL_MS);
  const timeoutMs = Number(config.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const contextTimeoutMs = Number(config.contextTimeoutMs ?? DEFAULT_CONTEXT_TIMEOUT_MS);
  const contextCacheTtlMs = Number(config.contextCacheTtlMs ?? DEFAULT_CONTEXT_CACHE_TTL_MS);
  const spendTimeoutMs = Number(config.spendTimeoutMs ?? DEFAULT_SPEND_TIMEOUT_MS);
  const spendCacheTtlMs = Number(config.spendCacheTtlMs ?? DEFAULT_SPEND_CACHE_TTL_MS);
  const pricing = normalizePricing(config.pricing);

  let cache = { at: 0, value: undefined };
  // Short-lived per-session cache for the context route: session switches (and
  // repeated polls) render instantly instead of waiting for a full recompute
  // (cold subagent reads included).
  const contextCache = new Map();
  // Global-spend fold cache: the sorted, priced DeepSeek sample list across
  // ALL sessions. Boundary queries against it are O(samples + boundaries), so
  // a short TTL makes the whole panel render cheaply between refreshes.
  let spendCache = { at: 0, samples: undefined, sessions: 0, partial: false };

  async function resolveApiKey() {
    const credentials = ctx.get("credentials");
    if (credentials !== undefined) {
      try {
        const hit = await credentials.resolve("DEEPSEEK_API_KEY");
        if (hit !== undefined && hit.value !== "") return hit.value;
      } catch {
        // fall through to the environment
      }
    }
    const ambient = process.env.DEEPSEEK_API_KEY;
    return ambient !== undefined && ambient !== "" ? ambient : undefined;
  }

  async function loadBalance(force = false) {
    const now = Date.now();
    if (!force && cache.value !== undefined && now - cache.at < ttlMs) {
      return cache.value;
    }

    const apiKey = await resolveApiKey();
    if (apiKey === undefined) {
      return {
        ok: false,
        code: "MISSING_KEY",
        message:
          "DEEPSEEK_API_KEY 未配置：请在「设置 > 模型」页填写，或写入 ~/.dsh/.credentials.yaml",
      };
    }

    try {
      const response = await fetch(`${baseURL}/user/balance`, {
        headers: { authorization: `Bearer ${apiKey}`, accept: "application/json" },
        signal: AbortSignal.timeout(timeoutMs),
      });

      let body;
      try {
        body = await response.json();
      } catch {
        body = undefined;
      }

      if (!response.ok) {
        const value = {
          ok: false,
          code: response.status === 401 ? "AUTH" : `HTTP_${response.status}`,
          status: response.status,
          message: body?.error?.message ?? `DeepSeek API HTTP ${response.status}`,
        };
        cache = { at: now, value };
        return value;
      }

      const value = {
        ok: true,
        isAvailable: body?.is_available === true,
        balances: (body?.balance_infos ?? []).map((entry) => ({
          currency: entry.currency,
          total: entry.total_balance,
          granted: entry.granted_balance,
          toppedUp: entry.topped_up_balance,
        })),
        fetchedAt: now,
      };
      cache = { at: now, value };
      return value;
    } catch (error) {
      const value = {
        ok: false,
        code: "TRANSPORT",
        message: error instanceof Error ? error.message : String(error),
      };
      cache = { at: now, value };
      return value;
    }
  }

  /**
   * Global DeepSeek spend fold across EVERY durable session (live sessions
   * first, then persisted sessions not already covered), each folded from its
   * own seed boundary so an inherited parent-history prefix is never double
   * counted. Only DeepSeek-model samples are kept — another provider's usage
   * is never billed at DeepSeek rates. Bounded by a timeout budget and a
   * session cap: when either trips, the result is marked partial (the
   * cumulative numbers are still useful — they just undercount).
   */
  async function loadGlobalSpend(force = false) {
    const now = Date.now();
    if (!force && spendCache.samples !== undefined && now - spendCache.at < spendCacheTtlMs) {
      return spendCache;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), spendTimeoutMs);
    try {
      const collected = await collectGlobalSamples(ctx, pricing, controller.signal);
      spendCache = {
        at: Date.now(),
        samples: collected.samples,
        sessions: collected.sessions,
        partial: collected.partial,
      };
    } finally {
      clearTimeout(timer);
    }
    return spendCache;
  }

  ctx.effect(
    () =>
      webServer.register({
        kind: "exact",
        path: "/api/deepseek-quota",
        handler: async (req, res) => {
          if (req.method !== "GET" && req.method !== "HEAD") {
            res.writeHead(405, { "content-type": "application/json; charset=utf-8" });
            res.end(JSON.stringify({ ok: false, code: "METHOD", message: "GET only" }));
            return;
          }
          const value = await loadBalance(req.url?.includes("refresh=1"));
          res.writeHead(200, {
            "content-type": "application/json; charset=utf-8",
            "cache-control": "no-store",
          });
          res.end(JSON.stringify(value));
        },
      }),
    "deepseek-quota: route",
  );

  ctx.effect(
    () =>
      webServer.register({
        kind: "exact",
        path: "/api/deepseek-quota/context",
        handler: async (req, res) => {
          if (req.method !== "GET" && req.method !== "HEAD") {
            res.writeHead(405, { "content-type": "application/json; charset=utf-8" });
            res.end(JSON.stringify({ ok: false, code: "METHOD", message: "GET only" }));
            return;
          }
          let sessionId = "";
          let refresh = false;
          try {
            const url = new URL(req.url ?? "/", "http://dsh.local");
            sessionId = url.searchParams.get("sessionId") ?? "";
            refresh = url.searchParams.get("refresh") === "1";
          } catch {
            // leave sessionId empty → MISSING_SESSION below
          }
          let value;
          const cachedContext = refresh ? void 0 : contextCache.get(sessionId);
          if (cachedContext !== void 0 && Date.now() - cachedContext.at < contextCacheTtlMs) {
            value = cachedContext.value;
          } else {
            try {
              value = await loadContext(ctx, sessionId, { pricing, contextTimeoutMs });
              if (value.ok) contextCache.set(sessionId, { at: Date.now(), value });
            } catch (error) {
              value = {
                ok: false,
                code: "INTERNAL",
                message: error instanceof Error ? error.message : String(error),
              };
            }
          }
          res.writeHead(200, {
            "content-type": "application/json; charset=utf-8",
            "cache-control": "no-store",
          });
          res.end(JSON.stringify(value));
        },
      }),
    "deepseek-quota: context route",
  );

  ctx.effect(
    () =>
      webServer.register({
        kind: "exact",
        path: "/api/deepseek-quota/spend",
        handler: async (req, res) => {
          if (req.method !== "GET" && req.method !== "HEAD") {
            res.writeHead(405, { "content-type": "application/json; charset=utf-8" });
            res.end(JSON.stringify({ ok: false, code: "METHOD", message: "GET only" }));
            return;
          }
          // boundaries=ms1,ms2,… — cumulative DeepSeek spend since the
          // beginning of all logs is answered at each boundary, so the client
          // can derive any window's consumption by subtracting two rows.
          let boundaries = [];
          let refresh = false;
          try {
            const url = new URL(req.url ?? "/", "http://dsh.local");
            refresh = url.searchParams.get("refresh") === "1";
            const raw = url.searchParams.get("boundaries") ?? "";
            if (raw !== "") {
              for (const part of raw.split(",")) {
                const trimmed = part.trim();
                if (trimmed === "") continue;
                const value = Number(trimmed);
                if (Number.isFinite(value) && value >= 0) boundaries.push(Math.floor(value));
              }
            }
          } catch {
            // leave boundaries empty
          }
          boundaries = [...new Set(boundaries)].sort((a, b) => a - b);
          if (boundaries.length > SPEND_BOUNDARIES_CAP) {
            boundaries = boundaries.slice(boundaries.length - SPEND_BOUNDARIES_CAP);
          }
          let value;
          try {
            const state = await loadGlobalSpend(refresh);
            value = {
              ok: true,
              currency: pricing.currency,
              pricingVersion: pricing.version,
              sessions: state.sessions,
              samples: state.samples.length,
              ...(state.partial ? { partial: true } : {}),
              boundaries: cumulativeSpend(state.samples, pricing, boundaries),
              computedAt: state.at,
            };
          } catch (error) {
            value = {
              ok: false,
              code: "INTERNAL",
              message: error instanceof Error ? error.message : String(error),
            };
          }
          res.writeHead(200, {
            "content-type": "application/json; charset=utf-8",
            "cache-control": "no-store",
          });
          res.end(JSON.stringify(value));
        },
      }),
    "deepseek-quota: spend route",
  );
}

// ---------------------------------------------------------------------------
// Pricing
// ---------------------------------------------------------------------------

/** Merge optional user pricing overrides over the official defaults. */
function normalizePricing(custom) {
  if (custom === undefined) return DEFAULT_PRICING;
  return {
    version: custom.version ?? DEFAULT_PRICING.version,
    currency: custom.currency ?? DEFAULT_PRICING.currency,
    tiers: { ...DEFAULT_PRICING.tiers, ...(custom.tiers ?? {}) },
    fallbackTier: custom.fallbackTier ?? DEFAULT_PRICING.fallbackTier,
  };
}

/**
 * Map a provider model id onto a pricing tier.
 * deepseek-chat / *-flash → Flash tier; deepseek-reasoner / *-pro → Pro tier;
 * anything unknown falls back to the configured fallback tier.
 */
function resolveTier(model, pricing) {
  const id = String(model ?? "").toLowerCase();
  if (id.includes("reasoner") || id.includes("pro")) return "deepseek-reasoner";
  if (id.includes("chat") || id.includes("flash")) return "deepseek-chat";
  return pricing.fallbackTier;
}

/**
 * Whether an epoch-ms timestamp falls in a Beijing-time peak window.
 * Since 2026-08-23 00:00 (Beijing), weekends (Sat/Sun) are all-day
 * off-peak; before that, the original peak windows applied every day.
 */
function isPeak(timeMs) {
  const beijingMs = timeMs + BEIJING_OFFSET_MS;
  if (beijingMs >= WEEKEND_OFFPEAK_SINCE_MS) {
    const day = new Date(beijingMs).getUTCDay();
    if (day === 0 || day === 6) return false;
  }
  const minutes = Math.floor((beijingMs % DAY_MS) / 60_000);
  return PEAK_WINDOWS.some((window) => minutes >= window.start && minutes < window.end);
}

/**
 * Whether a usage sample came from a DeepSeek route (model id or provider
 * names DeepSeek). Only such samples are priced; anything else is shown as
 * unpriced ("-") so another provider's usage is never billed at DeepSeek
 * rates.
 */
function isDeepseekSample(sample) {
  const model = String(sample.model ?? "").toLowerCase();
  const provider = String(sample.provider ?? "").toLowerCase();
  return model.startsWith("deepseek") || provider.startsWith("deepseek");
}

/**
 * Price one usage sample split by bucket (元). DeepSeek never reports
 * cache-write tokens (the first uncached pass IS the write, billed at the
 * miss rate), but the bucket is priced at the miss rate when another
 * provider reports it.
 */
function costBucketsOfSample(sample, pricing) {
  const tierId = resolveTier(sample.model, pricing);
  const tier = pricing.tiers[tierId] ?? pricing.tiers[pricing.fallbackTier];
  const rate = isPeak(sample.time) ? tier.peak : tier.offpeak;
  const b = sample.buckets;
  return {
    uncachedInput: (b.uncachedInput * rate.cacheMiss) / 1_000_000,
    cacheRead: (b.cacheRead * rate.cacheHit) / 1_000_000,
    cacheWrite: (b.cacheWrite * rate.cacheMiss) / 1_000_000,
    output: (b.output * rate.output) / 1_000_000,
  };
}

/** Total price of one usage sample (元). */
function costOfSample(sample, pricing) {
  const buckets = costBucketsOfSample(sample, pricing);
  return buckets.uncachedInput + buckets.cacheRead + buckets.cacheWrite + buckets.output;
}

// ---------------------------------------------------------------------------
// Usage fold
// ---------------------------------------------------------------------------

function zeroBuckets() {
  return { uncachedInput: 0, cacheRead: 0, cacheWrite: 0, output: 0 };
}

/** Normalize one provider usage record into disjoint billing buckets. */
function bucketsFromUsage(usage) {
  return {
    uncachedInput: finiteNonNegative(usage.inputTokens),
    cacheRead: finiteNonNegative(usage.cacheReadTokens),
    cacheWrite: finiteNonNegative(usage.cacheWriteTokens),
    output: finiteNonNegative(usage.outputTokens),
  };
}

function finiteNonNegative(value) {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

/**
 * Replay a session log and fold provider-reported usage into per-step final
 * samples — the same "last sample wins per (turn, step)" rule the token-meter
 * projection uses — then aggregate totals, per-turn totals, and cost.
 *
 * @param events - session events (durable log or persistence inspection).
 * @param fromSeq - first seq to count; child sessions skip their inherited
 *   parent-history seed (`header.seedLength`) so usage is never double counted.
 * @param pricing - rate table.
 * @returns session aggregates plus the latest turn's numbers.
 */
function foldSessionUsage(events, fromSeq = 0, pricing) {
  const samples = new Map(); // "turn:step" → final sample
  let provider;
  let model;
  for (const event of events) {
    // Header events are route metadata, not usage: track them even inside the
    // seed prefix so samples after the boundary keep their model attribution.
    if (event.type === "request/header") {
      const header = event.data?.header;
      provider = header?.config?.provider;
      model = header?.config?.model;
      continue;
    }
    if (event.seq < fromSeq) continue;
    let turn;
    let step;
    let usage;
    if (event.type === "assistant/chunk" && event.data?.chunk?.type === "usage" && event.data.chunk.usage !== void 0) {
      turn = event.data.turn;
      step = event.data.step;
      usage = event.data.chunk.usage;
    } else if (event.type === "assistant/message" && event.data?.usage !== void 0) {
      turn = event.data.turn;
      step = event.data.step;
      usage = event.data.usage;
    } else {
      continue;
    }
    if (typeof turn !== "number" || typeof step !== "number") continue;
    samples.set(`${turn}:${step}`, {
      turn,
      step,
      buckets: bucketsFromUsage(usage),
      time: typeof event.time === "number" ? event.time : Date.now(),
      provider,
      model,
    });
  }

  const totals = { ...zeroBuckets(), cost: 0, samples: samples.size };
  const byTurn = new Map();
  let currentTurn = -1;
  for (const sample of samples.values()) {
    const cost = costOfSample(sample, pricing);
    sample.cost = cost;
    totals.uncachedInput += sample.buckets.uncachedInput;
    totals.cacheRead += sample.buckets.cacheRead;
    totals.cacheWrite += sample.buckets.cacheWrite;
    totals.output += sample.buckets.output;
    totals.cost += cost;
    if (sample.turn > currentTurn) currentTurn = sample.turn;
    let entry = byTurn.get(sample.turn);
    if (entry === void 0) {
      entry = { ...zeroBuckets(), cost: 0, samples: 0 };
      byTurn.set(sample.turn, entry);
    }
    entry.uncachedInput += sample.buckets.uncachedInput;
    entry.cacheRead += sample.buckets.cacheRead;
    entry.cacheWrite += sample.buckets.cacheWrite;
    entry.output += sample.buckets.output;
    entry.cost += cost;
    entry.samples += 1;
  }

  return {
    totals,
    byTurn,
    currentTurn,
    provider,
    model,
    // Final samples (last usage per turn/step), each carrying its own cost.
    steps: [...samples.values()],
  };
}

// ---------------------------------------------------------------------------
// Global spend (all sessions)
// ---------------------------------------------------------------------------

/**
 * Enumerate EVERY durable session and fold its usage into one sorted list of
 * DeepSeek-priced samples. Live sessions win over persisted ones with the
 * same id (a live log is fresher than its durable snapshot). Each session is
 * folded from its own seedLength, so the inherited parent-history prefix of a
 * subagent log is skipped and no usage is ever double counted.
 *
 * Honors signal (the caller's timeout budget) and a session cap: when either
 * trips, the result is marked partial and only the sessions seen so far
 * contribute. Persisted logs are inspected in small concurrent batches.
 *
 * @returns { samples, sessions, partial } with samples sorted by time.
 */
async function collectGlobalSamples(ctx, pricing, signal) {
  const samples = [];
  const seen = new Set();
  let sessions = 0;
  let partial = false;

  const liveService = ctx.get("sessions");
  if (liveService !== undefined) {
    let list = [];
    try {
      list = liveService.list() ?? [];
    } catch {
      list = [];
    }
    for (const session of list) {
      if (partial || sessions >= SPEND_SESSIONS_CAP) {
        partial = true;
        break;
      }
      const id = session?.header?.id;
      if (id === undefined || seen.has(id)) continue;
      seen.add(id);
      sessions += 1;
      try {
        const folded = foldSessionUsage(session.events ?? [], session.header?.seedLength ?? 0, pricing);
        for (const sample of folded.steps) {
          if (isDeepseekSample(sample)) samples.push(sample);
        }
      } catch {
        // a broken session must never poison the global fold
      }
    }
  }

  const persistence = ctx.get("sessionPersistence");
  if (persistence !== undefined && !partial) {
    let headers = [];
    try {
      headers = await persistence.list(signal);
    } catch {
      headers = [];
    }
    for (let index = 0; index < headers.length && !partial; index += SUBAGENT_CONCURRENCY) {
      if (sessions >= SPEND_SESSIONS_CAP) {
        partial = true;
        break;
      }
      const batch = headers.slice(index, index + SUBAGENT_CONCURRENCY);
      const settled = await Promise.all(batch.map(async (header) => {
        if (signal?.aborted) return undefined;
        if (seen.has(header?.id)) return undefined;
        seen.add(header?.id);
        try {
          const inspection = await persistence.inspect(header.id, signal);
          const folded = foldSessionUsage(inspection?.events ?? [], inspection?.meta?.seedLength ?? 0, pricing);
          const rows = [];
          for (const sample of folded.steps) {
            if (isDeepseekSample(sample)) rows.push(sample);
          }
          return rows;
        } catch {
          return undefined;
        }
      }));
      for (const rows of settled) {
        if (rows !== undefined) {
          sessions += 1;
          samples.push(...rows);
        }
      }
    }
    if (signal?.aborted) partial = true;
  }

  samples.sort((a, b) => a.time - b.time);
  return { samples, sessions, partial };
}

/**
 * Cumulative DeepSeek spend at each boundary timestamp, over the given sample
 * list (already sorted by time; DeepSeek-only). Boundary at includes every
 * sample with time <= at, so a window (start, end] is exactly
 * row(end) - row(start). Each row also carries the per-bucket cost and token
 * splits for completeness.
 */
function cumulativeSpend(samples, pricing, boundaries) {
  const rows = [];
  let cost = 0;
  let costUncachedInput = 0;
  let costCacheRead = 0;
  let costCacheWrite = 0;
  let costOutput = 0;
  let uncachedInputTokens = 0;
  let cacheReadTokens = 0;
  let cacheWriteTokens = 0;
  let outputTokens = 0;
  let steps = 0;
  let index = 0;
  for (const at of boundaries) {
    while (index < samples.length && samples[index].time <= at) {
      const sample = samples[index];
      const buckets = costBucketsOfSample(sample, pricing);
      cost += sample.cost;
      costUncachedInput += buckets.uncachedInput;
      costCacheRead += buckets.cacheRead;
      costCacheWrite += buckets.cacheWrite;
      costOutput += buckets.output;
      uncachedInputTokens += sample.buckets.uncachedInput;
      cacheReadTokens += sample.buckets.cacheRead;
      cacheWriteTokens += sample.buckets.cacheWrite;
      outputTokens += sample.buckets.output;
      steps += 1;
      index += 1;
    }
    rows.push({
      at,
      cost: roundCost(cost),
      costUncachedInput: roundCost(costUncachedInput),
      costCacheRead: roundCost(costCacheRead),
      costCacheWrite: roundCost(costCacheWrite),
      costOutput: roundCost(costOutput),
      uncachedInputTokens,
      cacheReadTokens,
      cacheWriteTokens,
      outputTokens,
      steps,
    });
  }
  return rows;
}

// ---------------------------------------------------------------------------
// Session resolution
// ---------------------------------------------------------------------------

/**
 * Resolve one session's durable log: live session store → live agent →
 * persistence inspection. Returns `{ events, seedLength }` or undefined.
 */
async function resolveSessionEvents(ctx, sessionId, signal) {
  const sessions = ctx.get("sessions");
  const live = sessions?.list().find((session) => session.header.id === sessionId);
  if (live !== undefined) {
    return { events: live.events, seedLength: live.header.seedLength ?? 0 };
  }
  const agent = ctx.get("agents")?.get(sessionId);
  if (agent !== undefined && agent.session !== undefined) {
    return { events: agent.session.events, seedLength: agent.session.header.seedLength ?? 0 };
  }
  const persistence = ctx.get("sessionPersistence");
  if (persistence !== undefined) {
    const inspection = await persistence.inspect(sessionId, signal);
    if (inspection !== undefined) {
      return { events: inspection.events ?? [], seedLength: inspection.meta?.seedLength ?? 0 };
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Context computation
// ---------------------------------------------------------------------------

async function loadContext(ctx, sessionId, options) {
  const { pricing, contextTimeoutMs } = options;
  if (sessionId === "") {
    return { ok: false, code: "MISSING_SESSION", message: "缺少 sessionId 查询参数" };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), contextTimeoutMs);
  try {
    const resolved = await resolveSessionEvents(ctx, sessionId, controller.signal);
    if (resolved === undefined) {
      return {
        ok: false,
        code: "SESSION_NOT_FOUND",
        message: `会话 ${sessionId} 不可用（既不在线也不在持久化存储中）`,
      };
    }

    const folded = foldSessionUsage(resolved.events, 0, pricing);
    const turn = folded.currentTurn >= 0 ? folded.byTurn.get(folded.currentTurn) : undefined;

    // Per-model-tier breakdown of the whole session (flash / pro / …),
    // with costs split by billing bucket so the panel shows quota, not tokens.
    const byTier = new Map();
    for (const sample of folded.steps) {
      const tier = resolveTier(sample.model, pricing);
      let entry = byTier.get(tier);
      if (entry === void 0) {
        entry = {
          tier,
          model: sample.model ?? null,
          cost: 0,
          costUncachedInput: 0,
          costCacheRead: 0,
          costCacheWrite: 0,
          costOutput: 0,
          uncachedInputTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          outputTokens: 0,
          steps: 0,
        };
        byTier.set(tier, entry);
      }
      const buckets = costBucketsOfSample(sample, pricing);
      entry.cost += sample.cost;
      entry.costUncachedInput += buckets.uncachedInput;
      entry.costCacheRead += buckets.cacheRead;
      entry.costCacheWrite += buckets.cacheWrite;
      entry.costOutput += buckets.output;
      entry.uncachedInputTokens += sample.buckets.uncachedInput;
      entry.cacheReadTokens += sample.buckets.cacheRead;
      entry.cacheWriteTokens += sample.buckets.cacheWrite;
      entry.outputTokens += sample.buckets.output;
      entry.steps += 1;
    }
    const sessionModels = [...byTier.values()].map((entry) => ({
      ...entry,
      cost: roundCost(entry.cost),
      costUncachedInput: roundCost(entry.costUncachedInput),
      costCacheRead: roundCost(entry.costCacheRead),
      costCacheWrite: roundCost(entry.costCacheWrite),
      costOutput: roundCost(entry.costOutput),
    }));

    // Whole-session cost split by billing bucket (for the panel total row).
    let costUncachedInput = 0;
    let costCacheRead = 0;
    let costCacheWrite = 0;
    let costOutput = 0;
    for (const sample of folded.steps) {
      const buckets = costBucketsOfSample(sample, pricing);
      costUncachedInput += buckets.uncachedInput;
      costCacheRead += buckets.cacheRead;
      costCacheWrite += buckets.cacheWrite;
      costOutput += buckets.output;
    }

    const session = {
      cost: roundCost(folded.totals.cost),
      costUncachedInput: roundCost(costUncachedInput),
      costCacheRead: roundCost(costCacheRead),
      costCacheWrite: roundCost(costCacheWrite),
      costOutput: roundCost(costOutput),
      uncachedInputTokens: folded.totals.uncachedInput,
      cacheReadTokens: folded.totals.cacheRead,
      cacheWriteTokens: folded.totals.cacheWrite,
      outputTokens: folded.totals.output,
      model: folded.model ?? null,
      provider: folded.provider ?? null,
      tier: folded.model === undefined ? null : resolveTier(folded.model, pricing),
      steps: folded.totals.samples,
      models: sessionModels,
    };

    // Per-request (per-step) detail of the latest turn, newest turn first by
    // step order; capped so a pathological turn cannot balloon the response.
    // Each request carries its cost split by billing bucket.
    const turnSamples = turn === undefined
      ? []
      : folded.steps
          .filter((sample) => sample.turn === folded.currentTurn)
          .sort((a, b) => a.step - b.step);
    const requests = turnSamples.slice(0, TURN_REQUESTS_CAP).map((sample) => {
      const buckets = costBucketsOfSample(sample, pricing);
      return {
        step: sample.step,
        time: sample.time,
        model: sample.model ?? null,
        tier: resolveTier(sample.model, pricing),
        peak: isPeak(sample.time),
        uncachedInputTokens: sample.buckets.uncachedInput,
        cacheReadTokens: sample.buckets.cacheRead,
        cacheWriteTokens: sample.buckets.cacheWrite,
        outputTokens: sample.buckets.output,
        cost: roundCost(sample.cost),
        costUncachedInput: roundCost(buckets.uncachedInput),
        costCacheRead: roundCost(buckets.cacheRead),
        costCacheWrite: roundCost(buckets.cacheWrite),
        costOutput: roundCost(buckets.output),
      };
    });

    // Turn-level cost split by bucket (the total row of the turn panel; sums
    // the FULL turn — correct even when the per-request list is truncated).
    let turnCostUncachedInput = 0;
    let turnCostCacheRead = 0;
    let turnCostCacheWrite = 0;
    let turnCostOutput = 0;
    for (const sample of turnSamples) {
      const buckets = costBucketsOfSample(sample, pricing);
      turnCostUncachedInput += buckets.uncachedInput;
      turnCostCacheRead += buckets.cacheRead;
      turnCostCacheWrite += buckets.cacheWrite;
      turnCostOutput += buckets.output;
    }

    // A freshly started turn has no usage samples yet: `turn/start` opens it
    // before any request runs. Once the log's latest started turn exceeds the
    // latest turn with usage, 本轮 must read empty instead of replaying the
    // previous turn's final cost. Falls back to the old behavior when the log
    // carries no `turn/start` events (pre-turn logs).
    let startedTurn = -1;
    for (const event of resolved.events) {
      if (event.type === "turn/start" && typeof event.data?.turn === "number" && event.data.turn > startedTurn) {
        startedTurn = event.data.turn;
      }
    }
    const emptyTurn = startedTurn > folded.currentTurn;

    const turnResponse = turn === undefined || emptyTurn
      ? null
      : {
          turn: folded.currentTurn,
          cost: roundCost(turn.cost),
          costUncachedInput: roundCost(turnCostUncachedInput),
          costCacheRead: roundCost(turnCostCacheRead),
          costCacheWrite: roundCost(turnCostCacheWrite),
          costOutput: roundCost(turnCostOutput),
          uncachedInputTokens: turn.uncachedInput,
          cacheReadTokens: turn.cacheRead,
          cacheWriteTokens: turn.cacheWrite,
          outputTokens: turn.output,
          steps: turn.samples,
          requests,
          requestsTruncated: turnSamples.length > TURN_REQUESTS_CAP,
        };

    // Subagent spend: every durable descendant of this session, live or cold.
    const subagentRows = [];
    let subagentError;
    const subagentsService = ctx.get("subagents");
    if (subagentsService !== undefined) {
      try {
        const rows = await subagentsService.listDescendants(sessionId, controller.signal);
        const results = [];
        for (let i = 0; i < rows.length; i += SUBAGENT_CONCURRENCY) {
          const batch = rows.slice(i, i + SUBAGENT_CONCURRENCY);
          const settled = await Promise.all(batch.map(async (row) => {
            try {
              const child = await resolveSessionEvents(ctx, row.id, controller.signal);
              if (child === undefined) return { row, folded: undefined };
              return { row, folded: foldSessionUsage(child.events, child.seedLength, pricing) };
            } catch {
              return { row, folded: undefined };
            }
          }));
          results.push(...settled);
        }
        for (const { row, folded } of results) {
          if (folded === void 0) {
            subagentRows.push({
              id: row.id,
              ...row.label === void 0 ? {} : { label: row.label },
              cost: null,
              costUncachedInput: null,
              costCacheRead: null,
              costCacheWrite: null,
              costOutput: null,
              unpriced: false,
              steps: 0,
              tier: null,
              uncachedInputTokens: 0,
              cacheReadTokens: 0,
              cacheWriteTokens: 0,
              outputTokens: 0,
              model: null,
              provider: null,
            });
            continue;
          }
          // Only DeepSeek-model usage is priced. A subagent that ran another
          // provider/model shows as unpriced ("-" in the UI) and contributes
          // nothing to the DeepSeek total.
          let cost = 0;
          let costUncachedInput = 0;
          let costCacheRead = 0;
          let costCacheWrite = 0;
          let costOutput = 0;
          let pricedSteps = 0;
          let uncachedInput = 0;
          let cacheRead = 0;
          let cacheWrite = 0;
          let output = 0;
          for (const sample of folded.steps) {
            if (!isDeepseekSample(sample)) continue;
            const buckets = costBucketsOfSample(sample, pricing);
            cost += sample.cost;
            costUncachedInput += buckets.uncachedInput;
            costCacheRead += buckets.cacheRead;
            costCacheWrite += buckets.cacheWrite;
            costOutput += buckets.output;
            pricedSteps += 1;
            uncachedInput += sample.buckets.uncachedInput;
            cacheRead += sample.buckets.cacheRead;
            cacheWrite += sample.buckets.cacheWrite;
            output += sample.buckets.output;
          }
          const unpriced = pricedSteps === 0;
          subagentRows.push({
            id: row.id,
            ...row.label === void 0 ? {} : { label: row.label },
            cost: unpriced ? null : roundCost(cost),
            costUncachedInput: unpriced ? null : roundCost(costUncachedInput),
            costCacheRead: unpriced ? null : roundCost(costCacheRead),
            costCacheWrite: unpriced ? null : roundCost(costCacheWrite),
            costOutput: unpriced ? null : roundCost(costOutput),
            unpriced,
            steps: folded.totals.samples,
            tier: folded.model === undefined ? null : resolveTier(folded.model, pricing),
            uncachedInputTokens: unpriced ? 0 : uncachedInput,
            cacheReadTokens: unpriced ? 0 : cacheRead,
            cacheWriteTokens: unpriced ? 0 : cacheWrite,
            outputTokens: unpriced ? 0 : output,
            model: folded.model ?? null,
            provider: folded.provider ?? null,
          });
        }
      } catch (error) {
        subagentError = error instanceof Error ? error.message : String(error);
      }
    }

    const unpricedCount = subagentRows.filter((row) => row.unpriced).length;
    const subagents = {
      cost: roundCost(subagentRows.reduce((total, row) => total + (row.cost ?? 0), 0)),
      count: subagentRows.length,
      ...unpricedCount === 0 ? {} : { unpricedCount },
      ...subagentError === void 0 ? {} : { error: subagentError },
      children: subagentRows,
    };

    const computedAt = Date.now();

    return {
      ok: true,
      currency: pricing.currency,
      pricingVersion: pricing.version,
      // Peak/off-peak stage AT the computation moment (Beijing time, weekend
      // rule included) — the session panel shows it in its leading column.
      currentPeak: isPeak(computedAt),
      session,
      turn: turnResponse,
      subagents,
      computedAt,
    };
  } finally {
    clearTimeout(timer);
  }
}

/** Keep money values compact on the wire: 6 decimals is plenty for ¥/token scale. */
function roundCost(value) {
  return Math.round(value * 1_000_000) / 1_000_000;
}

// Pure helpers exported for unit tests; not part of the plugin runtime surface.
export { cumulativeSpend, foldSessionUsage, isPeak, normalizePricing, resolveTier };
