// @dsh-external/dsh-deepseek-quota — host half smoke tests (node:test, zero dependencies).
//
// Covers the plugin surface (name/inject), the route registration, and the
// handler's main behaviors with a stubbed global fetch: missing key, success
// normalization, auth failure, method rejection, and the TTL cache with the
// `refresh=1` bypass.

import { test } from "node:test";
import assert from "node:assert/strict";

import { name, inject, apply } from "../lib/index.js";

/** Minimal Cordis-like context: captures the registered route, no credentials service. */
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

test("plugin surface declares the expected identity", () => {
  assert.equal(name, "deepseek-quota");
  assert.deepEqual(inject, ["webServer"]);
});

test("apply registers the exact route /api/deepseek-quota", () => {
  const { ctx, routes } = makeCtx();
  apply(ctx);
  assert.equal(routes.length, 1);
  assert.deepEqual(
    { kind: routes[0].kind, path: routes[0].path },
    { kind: "exact", path: "/api/deepseek-quota" },
  );
});

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
