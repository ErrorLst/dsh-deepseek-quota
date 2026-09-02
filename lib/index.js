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
// `AbortSignal`, `node:os/path/fs`) and the Cordis context passed into
// `apply`.
//
// v0.5.8 增量折叠：持久化服务的 `listSnapshots`（廉价 per-log revision）
// + `readFrom(id, fromSeq)`（水位线增量读——官方为「persisted projection
// cache folding only the tail past its checkpoint」设计的原语）。每个会话维护
// { revision, fromSeq, samples, lastProvider, lastModel, startedTurn } 检查点，
// 折叠从「每次全量重放」变为「revision 未变 → 零读；已变 → 只读增量」。
// 检查点落盘 ~/.dsh/deepseek-quota/checkpoints.json（防抖批量写，
// 失败静默回退全量，不影响正确性）；首建仍可能超预算 → partial + 后台回填。

import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

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
/** 折叠检查点存储目录（测试可用 DSH_QUOTA_DATA_DIR 指到临时目录）。 */
function quotaDataDir() {
  const override = typeof process !== "undefined" ? process.env?.DSH_QUOTA_DATA_DIR : undefined;
  return override !== undefined && override !== "" ? override : join(homedir(), ".dsh", "deepseek-quota");
}
const DB_FILE_NAME = "quota.db";
/** 会话级折叠检查点（模块级：collectGlobalSamples / foldSessionCached / loadContext 共用）。 */
const foldCheckpoints = new Map();
/*
 * 存储后端：SQLite（node:sqlite，零原生依赖；WAL + 按会话行 upsert）。
 * 冷启动 SELECT 全量加载 → 内存 foldCheckpoints；热对话每个会话折叠后
 * 立即逐行写入。仅内存模式（node:sqlite 不可用）下持久化静默跳过——
 * 数据仍正确，只是重启后需重新首建折叠。
 */
let quotaDb = null;           // DatabaseSync | null（null = 仅内存模式）
let quotaStoreReady = false;
let quotaStoreFailed = false;
function quotaDbFile() { return join(quotaDataDir(), DB_FILE_NAME); }
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
  // 会话级折叠检查点在模块级；启动恢复后后台预折叠最近会话
  // （DSH_QUOTA_DISABLE_WARMUP=1 可关闭——测试/低配场景）
  void loadCheckpoints(foldCheckpoints).then(() => {
    if (process.env.DSH_QUOTA_DISABLE_WARMUP !== "1") void warmUpCheckpoints(ctx, pricing);
  });

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
// 会话级折叠检查点（增量折叠）
// ---------------------------------------------------------------------------

/** 打开 sqlite 存储（动态 import：老 Node 无 node:sqlite 时安全回退）。 */
async function openQuotaStore() {
  if (quotaStoreReady || quotaStoreFailed) return quotaStoreReady;
  try {
    const { DatabaseSync } = await import("node:sqlite");
    await mkdir(quotaDataDir(), { recursive: true });
    const db = new DatabaseSync(quotaDbFile());
    db.exec("PRAGMA journal_mode=WAL");
    db.exec(`CREATE TABLE IF NOT EXISTS session_folds (
      session_id  TEXT PRIMARY KEY NOT NULL,
      revision    TEXT NOT NULL,
      created_at  INTEGER,
      cwd         TEXT,
      from_seq    INTEGER NOT NULL,
      last_provider TEXT,
      last_model  TEXT,
      started_turn INTEGER NOT NULL,
      samples     TEXT NOT NULL,
      updated_at  INTEGER NOT NULL
    )`);
    quotaDb = db;
    quotaStoreReady = true;
  } catch {
    quotaDb = null;
    quotaStoreReady = false;
    quotaStoreFailed = true;
  }
  return quotaStoreReady;
}

/** 单会话行 upsert（热对话逐行即时写，WAL 下亚毫秒；失败静默=仅内存模式）。 */
function saveCheckpointRow(id, cp) {
  if (quotaDb === null) return false;
  try {
    quotaDb.prepare(`INSERT INTO session_folds
        (session_id, revision, created_at, cwd, from_seq, last_provider, last_model, started_turn, samples, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(session_id) DO UPDATE SET
        revision=excluded.revision, created_at=excluded.created_at, cwd=excluded.cwd,
        from_seq=excluded.from_seq, last_provider=excluded.last_provider, last_model=excluded.last_model,
        started_turn=excluded.started_turn, samples=excluded.samples, updated_at=excluded.updated_at`)
      .run(id, cp.revision, cp.createdAt ?? null, cp.cwd ?? null, cp.fromSeq,
        cp.lastProvider ?? null, cp.lastModel ?? null, cp.startedTurn ?? -1,
        JSON.stringify(cp.samples), Date.now());
    return true;
  } catch {
    return false;
  }
}

/** 删除已删除会话的行。 */
function removeCheckpointRow(id) {
  if (quotaDb === null) return false;
  try {
    quotaDb.prepare("DELETE FROM session_folds WHERE session_id = ?").run(id);
    return true;
  } catch {
    return false;
  }
}

/** 写入出口：确保存储已打开后逐行 upsert（失败静默：仅内存继续，数据仍正确）。 */
async function saveCheckpoint(id, cp) {
  await openQuotaStore();
  saveCheckpointRow(id, cp);
}

/** 删除出口。 */
async function removeCheckpoint(id) {
  await openQuotaStore();
  removeCheckpointRow(id);
}

/** 冷启动恢复：sqlite SELECT 全量装载到内存表。 */
async function loadCheckpoints(map) {
  if (!await openQuotaStore()) return;
  try {
    const rows = quotaDb.prepare("SELECT * FROM session_folds").all();
    for (const row of rows) {
      let samples = [];
      try { samples = JSON.parse(row.samples); } catch { samples = []; }
      if (typeof row.session_id !== "string" || typeof row.revision !== "string" || !Array.isArray(samples)) continue;
      map.set(row.session_id, {
        revision: row.revision,
        createdAt: typeof row.created_at === "number" ? row.created_at : undefined,
        cwd: typeof row.cwd === "string" ? row.cwd : undefined,
        fromSeq: typeof row.from_seq === "number" && Number.isFinite(row.from_seq) ? row.from_seq : 0,
        lastProvider: typeof row.last_provider === "string" ? row.last_provider : undefined,
        lastModel: typeof row.last_model === "string" ? row.last_model : undefined,
        startedTurn: typeof row.started_turn === "number" ? row.started_turn : -1,
        samples,
      });
    }
  } catch {
    // 读取失败：保持空内存表（后续逐步重建）
  }
}

/** 后台预折叠：按 lastActiveAt 排序取最近更新的会话建立检查点（4 并发、
 * 会话间让出事件循环），使用户打开任意"最近用过的会话"时 context 零等待。
 * 只处理尚无检查点的会话；失败静默（下次访问时再全量）。 */
async function warmUpCheckpoints(ctx, pricing) {
  const persistence = ctx.get("sessionPersistence");
  if (persistence === undefined) return;
  try {
    const list = typeof persistence.listSnapshots === "function"
      ? await persistence.listSnapshots()
      : (await persistence.list()).map((h) => ({ header: h, revision: void 0 }));
    const withTime = list
      .map((s) => ({ id: s.header?.id, revision: s.revision, identity: identityOf(s.header), at: Number(s.header?.updatedAt) || 0 }))
      .filter((s) => s.id !== void 0)
      .sort((a, b) => b.at - a.at)
      .slice(0, 32);
    let p = Promise.resolve();
    for (const entry of withTime) {
      if (foldCheckpoints.has(entry.id)) continue;
      const run = p.then(async () => {
        if (foldCheckpoints.has(entry.id)) return;
        try {
          await foldSessionCached(ctx, entry.id, { pricing, signal: undefined, persistence, revision: entry.revision, identity: entry.identity });
        } catch { /* ignore */ }
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      p = run;
    }
    await p;
  } catch { /* ignore */ }
}

/** The highest started turn observed in one event list. */
function startedTurnOfEvents(events) {
  let startedTurn = -1;
  for (const event of events) {
    if (event.type === "turn/start" && typeof event.data?.turn === "number" && event.data.turn > startedTurn) {
      startedTurn = event.data.turn;
    }
  }
  return startedTurn;
}

/** Next unread seq after a whole event list. */
function nextSeqOf(events) {
  let maxSeq = -1;
  for (const event of events) {
    if (typeof event.seq === "number" && event.seq > maxSeq) maxSeq = event.seq;
  }
  return maxSeq + 1;
}

/** Keep cache entries cost-free: pricing is a config view, not stored state. */
function stripCosts(steps) {
  return steps.map((sample) => ({
    turn: sample.turn,
    step: sample.step,
    buckets: sample.buckets,
    time: sample.time,
    provider: sample.provider ?? null,
    model: sample.model ?? null,
  }));
}

/** Price cached samples back into the fold shape (same "last wins" list). */
function pricedSteps(samples, pricing) {
  return samples.map((sample) => ({
    ...sample,
    buckets: sample.buckets,
    cost: costOfSample(sample, pricing),
  }));
}

/** Aggregate priced steps into totals / byTurn / currentTurn (as in foldSessionUsage). */
function aggregateSteps(steps, provider, model, pricing) {
  const totals = { ...zeroBuckets(), cost: 0, samples: steps.length };
  const byTurn = new Map();
  let currentTurn = -1;
  for (const sample of steps) {
    totals.uncachedInput += sample.buckets.uncachedInput;
    totals.cacheRead += sample.buckets.cacheRead;
    totals.cacheWrite += sample.buckets.cacheWrite;
    totals.output += sample.buckets.output;
    totals.cost += sample.cost;
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
    entry.cost += sample.cost;
    entry.samples += 1;
  }
  return { totals, byTurn, currentTurn };
}

/** Turn one checkpoint entry into the foldSessionUsage-shaped result. */
function finalizeCheckpoint(cp, pricing) {
  const steps = pricedSteps(cp.samples, pricing);
  const { totals, byTurn, currentTurn } = aggregateSteps(steps, cp.lastProvider, cp.lastModel, pricing);
  return {
    totals,
    byTurn,
    currentTurn,
    provider: cp.lastProvider,
    model: cp.lastModel,
    steps,
    startedTurn: cp.startedTurn,
  };
}

/** 增量馈入：合并事件到检查点状态；同 (turn,step) 后到者覆盖（追加日志语义天然保证）。 */
function foldEventsInto(state, events) {
  for (const event of events) {
    if (event.type === "request/header") {
      const header = event.data?.header;
      const provider = header?.config?.provider;
      const model = header?.config?.model;
      if (typeof provider === "string") state.lastProvider = provider;
      if (typeof model === "string") state.lastModel = model;
      continue;
    }
    if (typeof event.seq === "number" && event.seq > state.maxSeq) state.maxSeq = event.seq;
    if (event.type === "turn/start" && typeof event.data?.turn === "number" && event.data.turn > state.startedTurn) {
      state.startedTurn = event.data.turn;
    }
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
    state.samplesMap.set(`${turn}:${step}`, {
      turn,
      step,
      buckets: bucketsFromUsage(usage),
      time: typeof event.time === "number" ? event.time : Date.now(),
      provider: state.lastProvider,
      model: state.lastModel,
    });
  }
}

/** 活会话的内存增量折叠状态（每个 live session 一份；事件数组只增不减）。 */
const liveFoldStates = new Map();

/** 由活会话增量状态产出 fold 结果（样本计价 + 聚合）。 */
function finalizeLiveState(state, pricing) {
  const steps = [];
  for (const sample of state.samplesMap.values()) {
    steps.push({ ...sample, cost: costOfSample(sample, pricing) });
  }
  const { totals, byTurn, currentTurn } = aggregateSteps(steps, state.lastProvider, state.lastModel, pricing);
  return {
    totals, byTurn, currentTurn,
    provider: state.lastProvider, model: state.lastModel,
    steps, startedTurn: state.startedTurn,
  };
}

/**
 * 适配会话对象的事件读取（dsh alpha.4 兼容层）：
 * - alpha.4 的 Session 不再有 `.events` getter，改为 `snapshotEvents()`——
 *   返回冻结缓存数组，同一快照在下次 append 前**引用稳定**，正好适配
 *   liveFoldStates 的事件数组引用判定；继承前缀长度从
 *   `session.inheritedEventCount` 取（逻辑头里只有 isSeeded）。
 * - alpha.3 回退：`.events` + `header.seedLength`。
 * - 返回 undefined 表示该对象读不出事件（不应当发生），调用方回退冷路径。
 */
function liveEventsOfSession(session) {
  if (session === null || typeof session !== "object") return undefined;
  const events = typeof session.snapshotEvents === "function" ? session.snapshotEvents() : session.events;
  if (!Array.isArray(events)) return undefined;
  const seedLength = typeof session.inheritedEventCount === "number"
    ? session.inheritedEventCount
    : (session.header?.seedLength ?? 0);
  return { events, seedLength };
}

/** Live (in-memory) events for one session: session store → live agent. */
function liveEventsOf(ctx, sessionId) {
  const sessions = ctx.get("sessions");
  const live = sessions?.list().find((session) => session.header.id === sessionId);
  if (live !== undefined) {
    const src = liveEventsOfSession(live);
    if (src !== undefined) return src;
  }
  const agent = ctx.get("agents")?.get(sessionId);
  if (agent !== undefined && agent.session !== undefined) {
    const src = liveEventsOfSession(agent.session);
    if (src !== undefined) return src;
  }
  return undefined;
}

/**
 * 检查点归属校验：会话 id 只是槽位，不是生命周期——删除后重建/存储根被换
 * 都会产生新日志（新 createdAt/cwd 组合），旧检查点必须整体丢弃（回退全量，
 * 只慢不错），防止来自无关日志的样本被水位线增量误用。
 * 对齐 session-projection-cache 的 checkpointIdentity（createdAt+cwd）。
 */
function sameLogIdentity(cp, identity) {
  if (cp === undefined) return false;
  if (identity === undefined) return cp.createdAt === undefined && cp.cwd === undefined;
  return cp.createdAt !== undefined
    ? cp.createdAt === identity.createdAt && (cp.cwd ?? undefined) === (identity.cwd ?? undefined)
    : (identity.createdAt === undefined || identity.createdAt === cp.createdAt)
      && (cp.cwd ?? undefined) === (identity.cwd ?? undefined);
}

/** 从 SessionHeader 提取身份；fallback 返回 undefined（视为不校验，保守全量）。 */
function identityOf(header) {
  if (header === null || header === void 0 || typeof header !== "object") return undefined;
  const createdAt = header.createdAt;
  const cwd = header.cwd;
  if (typeof createdAt !== "number" && typeof cwd !== "string") return undefined;
  return { createdAt: typeof createdAt === "number" ? createdAt : undefined, cwd: typeof cwd === "string" ? cwd : undefined };
}

/**
 * 折叠一个会话（带检查点增量）：live 内存路径 → 未变零读 →
 * readFrom 增量 → 全量（inspect）。返回 foldSessionUsage 形状 + startedTurn，
 * 或 undefined（会话不存在）。identity 为 listSnapshots/inspect 报来的
 * {createdAt, cwd}；与检查点归属不一致时丢弃检查点回退全量。
 */
async function foldSessionCached(ctx, id, { pricing, signal, persistence, revision, identity }) {
  const live = liveEventsOf(ctx, id);
  if (live !== undefined) {
    const events = live.events ?? [];
    let state = liveFoldStates.get(id);
    // 首次 / 事件数组被替换（reref 不一致）→ 全量折叠一次，建立增量状态。
    // 判定必须按数组引用：同一 id 在不同生命周期/测试间可能复用不同数组。
    if (state === undefined || state.eventsRef !== events || state.seedLength !== live.seedLength) {
      const folded = foldSessionUsage(events, live.seedLength, pricing);
      const samplesMap = new Map();
      for (const sample of folded.steps) samplesMap.set(`${sample.turn}:${sample.step}`, sample);
      state = {
        eventsRef: events,
        count: events.length,
        maxSeq: nextSeqOf(events),
        lastProvider: folded.provider,
        lastModel: folded.model,
        startedTurn: startedTurnOfEvents(events),
        samplesMap,
        seedLength: live.seedLength,
      };
      liveFoldStates.set(id, state);
      if (liveFoldStates.size > 32) {
        // 兜底容量：只保留最近访问的活会话状态
        const firstKey = liveFoldStates.keys().next().value;
        if (firstKey !== undefined && firstKey !== id) liveFoldStates.delete(firstKey);
      }
      return { ...folded, startedTurn: state.startedTurn };
    }
    // 增量：只折叠新增事件区间（事件数组尾追加；seq 与数组长度单调一致）
    const delta = events.slice(state.count);
    if (delta.length > 0) {
      foldEventsInto(state, delta);
      state.count = events.length;
    }
    return finalizeLiveState(state, pricing);
  }
  if (persistence === undefined) return undefined;
  const cp = foldCheckpoints.get(id);
  const sameLog = sameLogIdentity(cp, identity);
  if (typeof persistence.readFrom === "function" && typeof revision === "string") {
    if (sameLog && cp.revision === revision) {
      return finalizeCheckpoint(cp, pricing);
    }
    if (sameLog) {
      signal?.throwIfAborted();
      const delta = await persistence.readFrom(id, cp.fromSeq, signal);
      signal?.throwIfAborted();
      if (delta?.events && delta.events.length > 0) {
        const state = {
          samplesMap: new Map(cp.samples.map((s) => [`${s.turn}:${s.step}`, s])),
          maxSeq: cp.fromSeq - 1,
          lastProvider: cp.lastProvider,
          lastModel: cp.lastModel,
          startedTurn: cp.startedTurn,
        };
        foldEventsInto(state, delta.events);
        const next = {
          revision,
          createdAt: cp.createdAt,
          cwd: cp.cwd,
          fromSeq: state.maxSeq + 1,
          lastProvider: state.lastProvider,
          lastModel: state.lastModel,
          startedTurn: state.startedTurn,
          samples: [...state.samplesMap.values()],
        };
        foldCheckpoints.set(id, next);
        await saveCheckpoint(id, next);
        return finalizeCheckpoint(next, pricing);
      }
      // revision 变化但无增量事件（torn/repair）：仅推进 revision
      const next = {
        ...(cp ?? { samples: [], lastProvider: undefined, lastModel: undefined, startedTurn: -1 }),
        revision,
        fromSeq: cp.fromSeq,
      };
      foldCheckpoints.set(id, next);
      await saveCheckpoint(id, next);
      return finalizeCheckpoint(next, pricing);
    }
  }
  // 全量（首次 / 旧版 harness 无 readFrom）：inspect 一次并建立检查点
  signal?.throwIfAborted();
  const inspection = await persistence.inspect(id, signal);
  if (inspection === undefined) return undefined;
  const folded = foldSessionUsage(inspection?.events ?? [], inspection?.inheritedEventCount ?? inspection?.meta?.seedLength ?? 0, pricing);
  const startedTurn = startedTurnOfEvents(inspection?.events ?? []);
  if (typeof revision === "string") {
    const nextIdentity = identity ?? identityOf(inspection?.meta);
    const next = {
      revision,
      createdAt: nextIdentity?.createdAt,
      cwd: nextIdentity?.cwd,
      fromSeq: nextSeqOf(inspection?.events ?? []),
      lastProvider: folded.provider,
      lastModel: folded.model,
      startedTurn,
      samples: stripCosts(folded.steps),
    };
    foldCheckpoints.set(id, next);
    await saveCheckpoint(id, next);
  }
  return { ...folded, startedTurn };
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
        const src = liveEventsOfSession(session);
        const folded = foldSessionUsage(src?.events ?? [], src?.seedLength ?? 0, pricing);
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
    // 轻量列出全部会话的修订号（不读日志）；revision 不变的会话在
    // foldSessionCached 中零读跳过——只有变化的日志才做增量/全量解析。
    let snapshots = [];
    try {
      if (typeof persistence.listSnapshots === "function") {
        const list = await persistence.listSnapshots(signal);
        snapshots = list.map((s) => ({ id: s.header?.id, revision: s.revision, header: s.header }));
      } else {
        const headers = await persistence.list(signal);
        snapshots = headers.map((h) => ({ id: h.id, revision: void 0, header: h }));
      }
    } catch {
      snapshots = [];
    }
    // 已删除会话的检查点即刻清出（含磁盘冗余）——删除后不得再被任何路径引用
    {
      const alive = new Set(snapshots.map((s) => s.id).filter((id) => id !== void 0));
      for (const id of foldCheckpoints.keys()) {
        if (!alive.has(id)) {
          foldCheckpoints.delete(id);
          await removeCheckpoint(id);
        }
      }
    }
    for (let index = 0; index < snapshots.length && !partial; index += SUBAGENT_CONCURRENCY) {
      if (sessions >= SPEND_SESSIONS_CAP) {
        partial = true;
        break;
      }
      const batch = snapshots.slice(index, index + SUBAGENT_CONCURRENCY);
      const settled = await Promise.all(batch.map(async (snap) => {
        if (signal?.aborted) return undefined;
        if (snap?.id === void 0 || seen.has(snap.id)) return undefined;
        seen.add(snap.id);
        try {
          const folded = await foldSessionCached(ctx, snap.id, {
            pricing, signal, persistence, revision: snap.revision, identity: identityOf(snap.header),
          });
          const rows = [];
          for (const sample of folded?.steps ?? []) {
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
    const persistence = ctx.get("sessionPersistence");
    // 一次轻量快照拿全部修订号；父会话与每个子代理共用（revision 一致 → 零读）
    let snapshotsMap = new Map();
    if (persistence !== undefined && typeof persistence.listSnapshots === "function") {
      try {
        const snapshots = await persistence.listSnapshots(controller.signal);
        snapshotsMap = new Map(snapshots.map((s) => [s.header?.id, { revision: s.revision, identity: identityOf(s.header) }]));
      } catch {
        // revision 未知 → 全量路径
      }
    }
    {
      const hit = snapshotsMap.get(sessionId);
      if (hit === void 0 && liveEventsOf(ctx, sessionId) === void 0) {
        // 已被删除：清理残留检查点（内存 + sqlite 行）
        if (foldCheckpoints.delete(sessionId)) await removeCheckpoint(sessionId);
      }
    }
    const parentSnapshot = snapshotsMap.get(sessionId);
    const folded = await foldSessionCached(ctx, sessionId, {
      pricing, signal: controller.signal, persistence,
      revision: parentSnapshot?.revision, identity: parentSnapshot?.identity,
    });
    if (folded === undefined) {
      return {
        ok: false,
        code: "SESSION_NOT_FOUND",
        message: `会话 ${sessionId} 不可用（既不在线也不在持久化存储中）`,
      };
    }
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
    // previous turn's final cost. startedTurn 随折叠检查点增量维护（首次全量扫描）。
    const emptyTurn = (folded.startedTurn ?? -1) > folded.currentTurn;

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
              const childSnapshot = snapshotsMap.get(row.id);
              const child = await foldSessionCached(ctx, row.id, {
                pricing, signal: controller.signal, persistence,
                revision: childSnapshot?.revision, identity: childSnapshot?.identity,
              });
              return { row, folded: child };
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
