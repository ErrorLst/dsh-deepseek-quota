/**
 * @dsh-external/dsh-deepseek-quota — host half type declarations.
 *
 * The runtime entry is plain JavaScript (`lib/index.js`); these declarations
 * only describe its public surface for editors and TypeScript consumers.
 * No external type dependency: the Cordis context is modeled structurally so
 * the package stays dependency-free.
 */

/** One pricing band (元 / 百万 tokens). */
export interface PricingBand {
  /** Input tokens served from DeepSeek's disk cache (`prompt_cache_hit_tokens`). */
  cacheHit: number;
  /** Uncached input tokens (`prompt_cache_miss_tokens`). */
  cacheMiss: number;
  /** Output (completion) tokens, reasoning included. */
  output: number;
}

/** Peak/off-peak rates for one model tier. */
export interface PricingTier {
  /** 高峰时段 09:00–12:00 与 14:00–18:00（北京时间）。 */
  peak: PricingBand;
  /** 其余空闲时段（官方定价 = 高峰的一半）。 */
  offpeak: PricingBand;
}

/** Rate table override accepted under `config.pricing`. */
export interface PricingConfig {
  /** Free-form version tag surfaced in API responses. */
  version?: string;
  /** Currency code. Defaults to `CNY`. */
  currency?: string;
  /** Per-tier rates; entries deep-merge over the official defaults. */
  tiers?: Record<string, PricingTier>;
  /** Tier used for unrecognized model ids. Defaults to `deepseek-chat`. */
  fallbackTier?: string;
}

/** Configuration accepted by the `deepseek-quota` row (set via a patch layer). */
export interface QuotaConfig {
  /**
   * DeepSeek API base URL. Defaults to `process.env.DEEPSEEK_BASE_URL`,
   * then to `https://api.deepseek.com`.
   */
  baseURL?: string;
  /** Positive cache TTL in milliseconds. Defaults to `60000`. */
  ttlMs?: number;
  /** Positive outbound request timeout in milliseconds. Defaults to `15000`. */
  timeoutMs?: number;
  /**
   * Budget for one `/api/deepseek-quota/context` computation (cold subagent
   * reads included). Defaults to `8000`.
   */
  contextTimeoutMs?: number;
  /**
   * Short TTL for the per-session context-route cache (ms), so session
   * switches render instantly. `refresh=1` bypasses it. Defaults to `5000`.
   */
  contextCacheTtlMs?: number;
  /**
   * TTL for the global-spend sample fold (ms): the priced DeepSeek sample
   * list across ALL sessions, shared by every spend-route boundary query.
   * `refresh=1` bypasses it. Defaults to `60000`.
   */
  spendCacheTtlMs?: number;
  /** Rate table override (official DeepSeek-V4 peak/off-peak rates by default). */
  pricing?: PricingConfig;
}

/** One currency entry of the DeepSeek balance response. */
export interface BalanceEntry {
  currency: string;
  total: number;
  granted: number;
  toppedUp: number;
}

/** Normalized JSON body served at `GET /api/deepseek-quota`. */
export type QuotaResponse =
  | {
      ok: true;
      isAvailable: boolean;
      balances: BalanceEntry[];
      fetchedAt: number;
    }
  | {
      ok: false;
      /** `MISSING_KEY` | `AUTH` | `HTTP_<status>` | `TRANSPORT`. */
      code: string;
      message: string;
      status?: number;
    };

/** Usage buckets of one session or turn (provider-reported tokens). */
export interface UsageTotals {
  cost: number;
  uncachedInputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
  steps: number;
  model?: string | null;
  provider?: string | null;
}

/** One descendant subagent's spend. */
export interface SubagentSpend {
  id: string;
  label?: string;
  cost: number | null;
  /** 输入（缓存未命中）的折算金额；非 DeepSeek 子代理为 null。 */
  costUncachedInput: number | null;
  costCacheRead: number | null;
  costCacheWrite: number | null;
  costOutput: number | null;
  /** True when the subagent ran a non-DeepSeek model and is not priced. */
  unpriced: boolean;
  steps: number;
  tier: string | null;
  uncachedInputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
  model: string | null;
  provider: string | null;
}

/** One model tier's aggregate spend inside the session. */
export interface SessionModelSpend {
  tier: string;
  model: string | null;
  cost: number;
  /** 输入（缓存未命中）的折算金额。 */
  costUncachedInput: number;
  /** 缓存输入（命中）的折算金额。 */
  costCacheRead: number;
  costCacheWrite: number;
  /** 输出的折算金额。 */
  costOutput: number;
  uncachedInputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
  steps: number;
}

/** One request (step) of the latest turn, with its own price. */
export interface TurnRequestSpend {
  step: number;
  time: number;
  model: string | null;
  tier: string;
  /** Whether the request fell in a Beijing-time peak window. */
  peak: boolean;
  uncachedInputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
  cost: number;
  /** 输入（缓存未命中）的折算金额。 */
  costUncachedInput: number;
  costCacheRead: number;
  costCacheWrite: number;
  costOutput: number;
}

/** Normalized JSON body served at `GET /api/deepseek-quota/context?sessionId=…`. */
export type ContextQuotaResponse =
  | {
      ok: true;
      currency: string;
      pricingVersion: string;
      session: {
        cost: number;
        costUncachedInput: number;
        costCacheRead: number;
        costCacheWrite: number;
        costOutput: number;
        uncachedInputTokens: number;
        cacheReadTokens: number;
        cacheWriteTokens: number;
        outputTokens: number;
        model: string | null;
        provider: string | null;
        tier: string | null;
        steps: number;
        models: SessionModelSpend[];
      };
      turn: {
        turn: number;
        cost: number;
        costUncachedInput: number;
        costCacheRead: number;
        costCacheWrite: number;
        costOutput: number;
        uncachedInputTokens: number;
        cacheReadTokens: number;
        cacheWriteTokens: number;
        outputTokens: number;
        steps: number;
        requests: TurnRequestSpend[];
        requestsTruncated?: boolean;
      } | null;
      subagents: {
        cost: number;
        count: number;
        /** How many children ran a non-DeepSeek model (shown as "-"). */
        unpricedCount?: number;
        error?: string;
        children: SubagentSpend[];
      };
      computedAt: number;
    }
  | {
      ok: false;
      /** `MISSING_SESSION` | `SESSION_NOT_FOUND` | `INTERNAL`. */
      code: string;
      message: string;
    };

/** Cumulative global DeepSeek spend at one boundary timestamp. */
export interface SpendBoundaryRow {
  at: number;
  cost: number;
  costUncachedInput: number;
  costCacheRead: number;
  costCacheWrite: number;
  costOutput: number;
  uncachedInputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
  steps: number;
}

/** Normalized JSON body served at `GET /api/deepseek-quota/spend?boundaries=…`. */
export type SpendQuotaResponse =
  | {
      ok: true;
      currency: string;
      pricingVersion: string;
      /** How many sessions the global fold walked (live + persisted). */
      sessions: number;
      /** How many priced DeepSeek usage samples the fold produced. */
      samples: number;
      /**
       * True when the fold was interrupted by the timeout budget or the
       * session cap; the numbers then undercount.
       */
      partial?: boolean;
      /** Cumulative spend at each requested boundary, in sorted order. */
      boundaries: SpendBoundaryRow[];
      computedAt: number;
    }
  | {
      ok: false;
      /** `INTERNAL`. */
      code: string;
      message: string;
    };

/** Minimal structural view of the parts of the Cordis context this plugin uses. */
export interface QuotaContext {
  /** Read an optional service by name; `undefined` when absent. */
  get(name: string): unknown;
  /** Required service (declared via `inject`): the web profile's HTTP server. */
  webServer: {
    register(desc: {
      kind: "exact";
      path: string;
      handler(req: unknown, res: unknown): unknown;
    }): unknown;
  };
  /** Register a disposer-backed side effect. */
  effect(callback: () => unknown, label?: string): unknown;
}

export const name: "deepseek-quota";
export const inject: ["webServer"];
export function apply(ctx: QuotaContext, config?: QuotaConfig): void;
