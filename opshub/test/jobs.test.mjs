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

const EMPTY_SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
const signedGet = (path, env) =>
  app.request(path, {
    headers: { "x-hub-signature-256": sign(`GET\n${path}\n${EMPTY_SHA256}`) },
  }, env);

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

    const read = await signedGet("/jobs/job-1", env);
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

    await signedPost("/jobs/job-1/status", {
      status: "awaiting_approval", stage: "approval", progress: 100,
      qa: { verdict: "pass", blocking_failures: [], synthetic: false },
    }, env);
    const res = await signedPost("/jobs/job-1/approve", {}, env);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.status, "approved");
    assert.equal(body.publishing_enabled, false);
  });

  test("empty QA and synthetic fixtures cannot be approved", async () => {
    const { env } = makeEnv();
    await createJob(env);
    await signedPost("/jobs/job-1/status", { status: "awaiting_approval", stage: "approval" }, env);
    assert.equal((await signedPost("/jobs/job-1/approve", {}, env)).status, 409);

    await signedPost("/jobs/job-1/status", {
      status: "awaiting_approval", stage: "approval",
      qa: { verdict: "pass", blocking_failures: [], synthetic: true },
    }, env);
    assert.equal((await signedPost("/jobs/job-1/approve", {}, env)).status, 409);
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
    const jobs = await signedGet("/jobs", env);
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

  test("creates six targets and isolates one dispatch failure", async () => {
    const { env, sqlite } = makeEnv({ HUB_GITHUB_TOKEN: "test-token" });
    await signedGet("/jobs", env); // ensureTables

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
    assert.match(reply, /icc/);
    assert.match(reply, /flip/);
    assert.match(reply, /benji: unavailable/);
    assert.match(reply, /dispatch (FAILED|error)/);
    assert.match(reply, /Queued 4\/6/);
    assert.match(reply, /Tracking: \/jobs/);

    const rows = sqlite
      .prepare("SELECT job_id, studio, status FROM productions ORDER BY studio")
      .all();
    assert.equal(rows.length, 3, "three studio jobs must exist");
    assert.equal(new Set(rows.map((r) => r.job_id)).size, 3, "job ids must be unique");
    assert.deepEqual(rows.map((r) => r.studio), ["deep-history", "trendscope", "true-crime"]);
    assert.deepEqual(rows.map((r) => r.status), ["dispatched", "dispatched", "failed"]);
    assert.equal(calls.filter((u) => u.includes("faceless-turkce-studio")).length, 3, "transient failures retry exactly three times");
    assert.ok(calls.some((u) => u.includes("icc-engine")));
    assert.ok(calls.some((u) => u.includes("business-flip-")));
  });

  test("an unknown studio is refused without creating a job", async () => {
    const { env, sqlite } = makeEnv({ HUB_GITHUB_TOKEN: "test-token" });
    await signedGet("/jobs", env);
    const reply = (await telegram("/run nonsense", env)).reply;
    assert.match(reply, /Usage: \/run/);
    const count = sqlite.prepare("SELECT COUNT(*) AS n FROM productions").get().n;
    assert.equal(count, 0);
  });

  test("rejects a chat that is not the configured operator", async () => {
    const { env, sqlite } = makeEnv({
      TELEGRAM_CHAT_ID: "42", HUB_GITHUB_TOKEN: "test-token",
    });
    await signedGet("/jobs", env);
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
    await signedGet("/jobs", env);
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
    assert.equal(count, 3, "a repeated command must not create studio jobs");
    assert.equal(dispatches, 5, "five connected targets dispatch once each");
  });

  test("engine targets dispatch independently and Benji is visibly unavailable", async () => {
    const { env, sqlite } = makeEnv({ HUB_GITHUB_TOKEN: "test-token" });
    await signedGet("/jobs", env);
    const original = globalThis.fetch;
    const calls = [];
    globalThis.fetch = async (url) => {
      calls.push(String(url));
      return { ok: true, status: 204, json: async () => ({}) };
    };
    let icc, flip, benji;
    try {
      icc = (await telegram("/run icc", env)).reply;
      flip = (await telegram("/run flip", env)).reply;
      benji = (await telegram("/run benji", env)).reply;
    } finally {
      globalThis.fetch = original;
    }
    assert.match(icc, /icc: dispatched/);
    assert.match(flip, /flip: dispatched/);
    assert.match(benji, /benji: unavailable/);
    assert.equal(calls.filter((u) => u.includes("icc-engine")).length, 1);
    assert.equal(calls.filter((u) => u.includes("business-flip-")).length, 1);
    const engineJobs = sqlite.prepare("SELECT COUNT(*) AS n FROM jobs WHERE kind = 'repository_dispatch'").get().n;
    assert.equal(engineJobs, 2);
  });

  test("production refuses the webhook when auth names are missing", async () => {
    const { env } = makeEnv({ ENVIRONMENT: "production", TELEGRAM_CHAT_ID: "42" });
    const res = await app.request("/_telegram?echo=1", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: { chat: { id: 42 }, text: "/status" } }),
    }, env);
    assert.equal(res.status, 503);
    const body = await res.json();
    assert.match(body.error, /not configured/);
    assert.ok(body.missing.includes("TELEGRAM_BOT_TOKEN"));
  });

  test("job reads are signed and the public dashboard feed is sanitized", async () => {
    const { env } = makeEnv();
    await createJob(env);
    assert.equal((await app.request("/jobs", {}, env)).status, 401);
    assert.equal((await signedGet("/jobs", env)).status, 200);
    const dashboard = await app.request("/dashboard/data", {}, env);
    assert.equal(dashboard.status, 200);
    const body = await dashboard.json();
    assert.equal(body.jobs[0].studio, "trendscope");
    assert.ok(!("output" in body.jobs[0]));
    assert.ok(!("detail" in body.jobs[0]));
  });
});

describe("retention: dry-run default and approved preservation", () => {
  test("deletes only expired unapproved objects and never in dry-run", async () => {
    const files = {
      deleted: [],
      objects: [
        { key: "jobs/approved/old.mp4", uploaded: new Date(Date.now() - 90 * 86400000).toISOString() },
        { key: "jobs/old/old.mp4", uploaded: new Date(Date.now() - 90 * 86400000).toISOString() },
        { key: "jobs/new/new.mp4", uploaded: new Date().toISOString() },
      ],
      async list() { return { objects: this.objects, truncated: false }; },
      async delete(key) { this.deleted.push(key); },
    };
    const { env, sqlite } = makeEnv({ FILES: files });
    await signedGet("/jobs", env); // ensureTables
    sqlite.prepare("INSERT INTO productions (job_id, studio, status, created_at, updated_at) VALUES (?,?,?,?,?)")
      .run("approved", "trendscope", "approved", 1, 1);

    const dry = await app.request("/retention/run?secret=" + SECRET, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ days: 30, dry_run: true }),
    }, env);
    assert.equal(dry.status, 200);
    const dryBody = await dry.json();
    assert.equal(dryBody.deleted, 1);
    assert.equal(dryBody.kept, 2);
    assert.deepEqual(files.deleted, []);

    const real = await app.request("/retention/run?secret=" + SECRET, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ days: 30, dry_run: false }),
    }, env);
    assert.equal(real.status, 200);
    assert.deepEqual(files.deleted, ["jobs/old/old.mp4"]);
    assert.equal((await real.json()).approved_preserved, 1);
  });
});
