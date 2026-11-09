/**
 * Production job-contract tests (offline, hermetic network).
 * Covers: signed writes, idempotency, status transitions, approval/cancel/retry
 * guards, dispatch honesty, and that readiness never leaks secret values.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { createHmac } from "node:crypto";

const networkCalls = [];
globalThis.fetch = async (url) => {
  networkCalls.push(String(url));
  throw new Error("network blocked in tests: " + url);
};

const app = (await import("../worker/index.js")).default;

const SECRET = "jobs-test-secret";

function d1(sqlite) {
  return {
    prepare(sql) {
      const stmt = sqlite.prepare(sql);
      const make = (params) => ({
        bind: (...more) => make([...params, ...more]),
        run: async () => {
          const r = stmt.run(...params);
          return { meta: { changes: Number(r.changes) } };
        },
        first: async () => {
          const row = stmt.get(...params);
          return row === undefined ? null : row;
        },
        all: async () => ({ results: stmt.all(...params) }),
      });
      return make([]);
    },
  };
}

function makeEnv(extra = {}) {
  const sqlite = new DatabaseSync(":memory:");
  return { sqlite, env: { DB: d1(sqlite), HUB_WEBHOOK_SECRET: SECRET, ...extra } };
}

const sign = (raw, secret = SECRET) =>
  "sha256=" + createHmac("sha256", secret).update(raw).digest("hex");

async function signedPost(path, payload, env, opts = {}) {
  const raw = JSON.stringify(payload);
  return app.request(path, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-hub-signature-256": opts.sig || sign(raw, opts.secret || SECRET),
    },
    body: raw,
  }, env);
}

async function createJob(env, over = {}) {
  const body = {
    schema_version: "1.0", job_id: "job-1", studio: "trendscope",
    topic: "ai", status: "running", ...over,
  };
  return signedPost("/jobs", body, env);
}

describe("job contract: auth + idempotency", () => {
  test("rejects unsigned job creation", async () => {
    const { env } = makeEnv();
    const res = await app.request("/jobs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ job_id: "x", studio: "trendscope" }),
    }, env);
    assert.equal(res.status, 401);
  });

  test("rejects creation when no hub secret is configured", async () => {
    const { env } = makeEnv({ HUB_WEBHOOK_SECRET: "" });
    const res = await signedPost("/jobs", { job_id: "x", studio: "trendscope" }, env);
    assert.equal(res.status, 503);
    assert.deepEqual(await res.json(), { error: "hub misconfigured" });
  });

  test("creates once, then reports duplicate", async () => {
    const { env } = makeEnv();
    const first = await createJob(env);
    assert.equal(first.status, 200);
    const a = await first.json();
    assert.equal(a.status, "accepted");
    assert.equal(a.created, true);
    assert.equal(a.job.studio, "trendscope");
    assert.equal(a.job.progress, 0);

    const second = await createJob(env);
    const b = await second.json();
    assert.equal(b.status, "duplicate");
    assert.equal(b.created, false);
  });

  test("rejects an unknown studio and a bad schema version", async () => {
    const { env } = makeEnv();
    assert.equal((await createJob(env, { studio: "bogus" })).status, 400);
    assert.equal((await createJob(env, { schema_version: "9.9" })).status, 400);
  });

  test("canonicalises aliases", async () => {
    const { env } = makeEnv();
    const res = await createJob(env, { job_id: "alias-1", studio: "history" });
    const body = await res.json();
    assert.equal(body.job.studio, "deep-history");
  });
});

describe("job contract: status + transitions", () => {
  test("studio status update advances stage and progress", async () => {
    const { env } = makeEnv();
    await createJob(env);
    const res = await signedPost("/jobs/job-1/status", {
      status: "running", stage: "assets", progress: 55,
      detail: "rendering images", output: "episodes/ep1",
    }, env);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.job.stage, "assets");
    assert.equal(body.job.progress, 55);

    const read = await app.request("/jobs/job-1", {}, env);
    assert.equal((await read.json()).job.progress, 55);
  });

  test("unknown job returns 404", async () => {
    const { env } = makeEnv();
    const res = await signedPost("/jobs/nope/status", { status: "running" }, env);
    assert.equal(res.status, 404);
  });

  test("rejects an unknown status or stage", async () => {
    const { env } = makeEnv();
    await createJob(env);
    assert.equal((await signedPost("/jobs/job-1/status", { status: "vibing" }, env)).status, 400);
    assert.equal((await signedPost("/jobs/job-1/status", { stage: "moon" }, env)).status, 400);
  });

  test("approve only from review states, never enables publishing", async () => {
    const { env } = makeEnv();
    await createJob(env); // running
    assert.equal((await signedPost("/jobs/job-1/approve", {}, env)).status, 409);

    await signedPost("/jobs/job-1/status", { status: "awaiting_approval", stage: "approval", progress: 100 }, env);
    const res = await signedPost("/jobs/job-1/approve", {}, env);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.status, "approved");
    assert.equal(body.publishing_enabled, false);
  });

  test("cancel is final", async () => {
    const { env } = makeEnv();
    await createJob(env);
    assert.equal((await signedPost("/jobs/job-1/cancel", {}, env)).status, 200);
    assert.equal((await signedPost("/jobs/job-1/status", { status: "running" }, env)).status, 409);
    assert.equal((await signedPost("/jobs/job-1/retry", {}, env)).status, 409);
  });

  test("retry resets a failed job", async () => {
    const { env } = makeEnv();
    await createJob(env);
    await signedPost("/jobs/job-1/status", { status: "failed", stage: "rendering", progress: 70 }, env);
    const res = await signedPost("/jobs/job-1/retry", {}, env);
    const body = await res.json();
    assert.equal(body.status, "retry_requested");
    assert.equal(body.job.stage, "research");
    assert.equal(body.job.progress, 0);
  });
});

describe("dispatch honesty + readiness", () => {
  test("dispatch without a GitHub token fails cleanly and creates no production", async () => {
    const { env } = makeEnv();
    const res = await signedPost("/dispatch", { job_id: "d-1", studio: "trendscope" }, env);
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.match(body.error, /HUB_GITHUB_TOKEN/);
    const jobs = await app.request("/jobs", {}, env);
    assert.deepEqual((await jobs.json()).jobs, []);
  });

  test("readiness lists env names but never values", async () => {
    const { env } = makeEnv({ GROQ_API_KEY: "sk-should-not-leak" });
    const res = await app.request("/api-readiness", {}, env);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.publishing_enabled, false);
    assert.ok(body.providers.some((p) => p.name === "groq" && p.state === "configured"));
    assert.ok(body.providers.some((p) => p.name === "youtube" && p.state === "not_configured"));
    assert.ok(!JSON.stringify(body).includes("sk-should-not-leak"));
  });

  test("no test touched the network", () => {
    assert.deepEqual(networkCalls, []);
  });
});

// ==========================================================================
describe("telegram /run all: independent jobs and failure isolation", () => {
  const telegram = (text, env) =>
    app.request("/_telegram?echo=1", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: { chat: { id: 1 }, text } }),
    }, env).then((r) => r.json());

  test("creates three distinct jobs and isolates one dispatch failure", async () => {
    const { env, sqlite } = makeEnv({ HUB_GITHUB_TOKEN: "test-token" });
    await app.request("/jobs", {}, env); // ensureTables

    const original = globalThis.fetch;
    const calls = [];
    globalThis.fetch = async (url) => {
      calls.push(String(url));
      if (String(url).includes("faceless-turkce-studio")) {
        throw new Error("simulated github outage");
      }
      return { ok: true, status: 204, json: async () => ({}) };
    };
    let reply;
    try {
      reply = (await telegram("/run all", env)).reply;
    } finally {
      globalThis.fetch = original;
    }

    assert.match(reply, /trendscope/);
    assert.match(reply, /true-crime/);
    assert.match(reply, /deep-history/);
    assert.match(reply, /dispatch (FAILED|error)/);
    assert.match(reply, /Tracking: \/jobs/);

    const rows = sqlite
      .prepare("SELECT job_id, studio, status FROM productions ORDER BY studio")
      .all();
    assert.equal(rows.length, 3, "three independent jobs must exist");
    assert.equal(new Set(rows.map((r) => r.job_id)).size, 3, "job ids must be unique");
    assert.deepEqual(rows.map((r) => r.studio), ["deep-history", "trendscope", "true-crime"]);
    assert.ok(rows.every((r) => r.status === "dispatched"));
    assert.equal(calls.filter((u) => u.includes("faceless-turkce-studio")).length, 1);
  });

  test("an unknown studio is refused without creating a job", async () => {
    const { env, sqlite } = makeEnv({ HUB_GITHUB_TOKEN: "test-token" });
    await app.request("/jobs", {}, env);
    const reply = (await telegram("/run nonsense", env)).reply;
    assert.match(reply, /Usage: \/run/);
    const count = sqlite.prepare("SELECT COUNT(*) AS n FROM productions").get().n;
    assert.equal(count, 0);
  });

  test("rejects a chat that is not the configured operator", async () => {
    const { env, sqlite } = makeEnv({
      TELEGRAM_CHAT_ID: "42", HUB_GITHUB_TOKEN: "test-token",
    });
    await app.request("/jobs", {}, env);
    const res = await app.request("/_telegram?echo=1", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: { chat: { id: 1 }, text: "/run all" } }),
    }, env);
    assert.equal(res.status, 403);
    const count = sqlite.prepare("SELECT COUNT(*) AS n FROM productions").get().n;
    assert.equal(count, 0, "an unauthorized chat must not create jobs");
  });

  test("duplicate /run all is deduplicated while jobs are active", async () => {
    const { env, sqlite } = makeEnv({ HUB_GITHUB_TOKEN: "test-token" });
    await app.request("/jobs", {}, env);
    const original = globalThis.fetch;
    let dispatches = 0;
    globalThis.fetch = async () => {
      dispatches += 1;
      return { ok: true, status: 204, json: async () => ({}) };
    };
    let first, second;
    try {
      first = (await telegram("/run all", env)).reply;
      second = (await telegram("/run all", env)).reply;
    } finally {
      globalThis.fetch = original;
    }
    assert.match(first, /dispatched/);
    assert.match(second, /deduplicated/);
    const count = sqlite.prepare("SELECT COUNT(*) AS n FROM productions").get().n;
    assert.equal(count, 3, "a repeated command must not create six jobs");
    assert.equal(dispatches, 3, "a repeated command must not redispatch");
  });
});
