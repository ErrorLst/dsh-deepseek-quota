/**
 * @dsh-external/dsh-deepseek-quota — host half type declarations.
 *
 * The runtime entry is plain JavaScript (`lib/index.js`); these declarations
 * only describe its public surface for editors and TypeScript consumers.
 * No external type dependency: the Cordis context is modeled structurally so
 * the package stays dependency-free.
 */

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
