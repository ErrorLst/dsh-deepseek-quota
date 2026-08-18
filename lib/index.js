// @dsh-external/dsh-deepseek-quota — host half.
//
// Registers a read-only HTTP route `GET /api/deepseek-quota` that resolves the
// DeepSeek API key through the same credential seam the llm-deepseek provider
// uses (`ctx.credentials.resolve('DEEPSEEK_API_KEY')`, falling back to the
// process environment), calls the official balance endpoint, and returns a
// normalized JSON body. A short TTL cache coalesces concurrent browser tabs.
//
// Zero runtime dependencies: this file only uses Node built-ins (via the
// global `fetch`) and the Cordis context passed into `apply`.

const DEFAULT_BASE_URL = "https://api.deepseek.com";
const DEFAULT_TTL_MS = 60_000;
const DEFAULT_TIMEOUT_MS = 15_000;

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

  let cache = { at: 0, value: undefined };

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
}
