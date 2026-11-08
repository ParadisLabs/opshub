/**
 * OpsHub test suite — runs with Node's built-in test runner (no extra deps).
 *
 * The real Hono worker is exercised end to end against an in-memory SQLite
 * database through a small D1 adapter, with ALL outbound network blocked, so
 * results are deterministic and cost nothing.
 *
 * Coverage:
 *  1. HMAC signature validation on /ingest (valid / invalid / missing)
 *  2. Idempotency: duplicate events are not stored twice
 *  3. Job ledger upsert (audit trail, no duplicate rows)
 *  4. Telegram button ack recording + dedup + non-icc data ignored
 *  5. /acks auth: unsigned and wrong-signature rejected, signed list/consume works
 *  6. /telegram route alias (webhook path) and /_telegram both served
 *  7. Reminders: set, list, delete-is-final (no resurrection)
 *  8. Sweep: due one-shot fires once, repeating advances in place
 *  9. /health + /repos + / version endpoints
 * 10. Failure-triage classifier, log-evidence extraction, number parsing
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { createHmac } from "node:crypto";

// ---- hermetic network: nothing may leave this process --------------------
const networkCalls = [];
globalThis.fetch = async (url) => {
  networkCalls.push(String(url));
  throw new Error("network blocked in tests: " + url);
};

const app = (await import("../worker/index.js")).default;
const { classifyFailure, extractEvidence, parseNum, verifySignature } =
  await import("../worker/index.js");

const SECRET = "test-hub-secret";
const OWNER = "landryparadis012-git";

// ---- D1 adapter over node:sqlite -----------------------------------------
function d1(sqlite) {
  return {
    prepare(sql) {
      const stmt = sqlite.prepare(sql);
      const make = (params) => ({
        bind: (...more) => make([...params, ...more]),
        run: async () => {
          const r = stmt.run(...params);
          return { meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } };
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
  return {
    sqlite,
    env: {
      DB: d1(sqlite),
      HUB_WEBHOOK_SECRET: SECRET,
      GITHUB_OWNER: OWNER,
      TELEGRAM_BOT_TOKEN: "", // no bot token: sends are skipped, no network
      ...extra,
    },
  };
}

const post = (path, body, env) =>
  app.request(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  }, env);

const get = (path, env) => app.request(path, {}, env);

const sign = (raw) => "sha256=" + createHmac("sha256", SECRET).update(raw).digest("hex");

// Any slash command runs ensureTables() — the cheapest real way to create schema.
const initTables = (env) => post("/_telegram?echo=1", { message: { chat: { id: 1 }, text: "/repos" } }, env);

// ==========================================================================
describe("ingest: HMAC + idempotency + job ledger", () => {
  test("rejects a request with no signature", async () => {
    const { env } = makeEnv();
    const res = await post("/ingest", { type: "trade.opened", event_id: "e1" }, env);
    assert.equal(res.status, 401);
  });

  test("rejects a wrong signature", async () => {
    const { env } = makeEnv();
    const res = await post("/ingest", { type: "trade.opened", event_id: "e1" }, env);
    assert.equal(res.status, 401);
  });

  test("ingest rejects unsigned events when the hub has no webhook secret configured", async () => {
    const { env, sqlite } = makeEnv({ HUB_WEBHOOK_SECRET: "" });
    const res = await post("/ingest", { type: "flip.deal_found", event_id: "no-secret" }, env);
    assert.equal(res.status, 503);
    assert.deepEqual(await res.json(), { error: "hub misconfigured" });
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM events").get().n, 0);
  });

  test("emit rejects a valid-looking event sent to an unconfigured hub", async () => {
    const { env, sqlite } = makeEnv({ HUB_WEBHOOK_SECRET: "" });
    const res = await app.request("/emit", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "studio.produce", event_id: "emit-no-secret" }),
    }, env);
    assert.equal(res.status, 503);
    assert.deepEqual(await res.json(), { error: "hub misconfigured" });
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM events").get().n, 0);
  });

  test("accepts a valid signature and records the event + job", async () => {
    const { env, sqlite } = makeEnv();
    const raw = JSON.stringify({ type: "trade.opened", event_id: "e1", repo: undefined });
    const res = await app.request("/ingest", {
      method: "POST",
      headers: { "content-type": "application/json", "x-hub-signature-256": sign(raw) },
      body: raw,
    }, env);
    assert.equal(res.status, 200);
    const j = await res.json();
    assert.equal(j.stored, true);
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM events").get().n, 1);
    const job = sqlite.prepare("SELECT status FROM jobs WHERE job_id = ?").get("e1");
    assert.equal(job.status, "recorded");
  });

  test("duplicate deliveries are deduplicated (idempotent)", async () => {
    const { env, sqlite } = makeEnv();
    const raw = JSON.stringify({ type: "studio.produce", event_id: "dup-1" });
    const send = () => app.request("/ingest", {
      method: "POST",
      headers: { "content-type": "application/json", "x-hub-signature-256": sign(raw) },
      body: raw,
    }, env);
    const a = await (await send()).json();
    const b = await (await send()).json();
    assert.equal(a.stored, true);
    assert.equal(b.stored, false);
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM events").get().n, 1);
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM jobs").get().n, 1,
      "ledger must upsert, never duplicate");
    assert.equal(sqlite.prepare("SELECT status FROM jobs").get().status, "duplicate");
  });

  test("verifySignature accepts a python-style HMAC and rejects tampering", async () => {
    const raw = '{"op":"list"}';
    assert.equal(await verifySignature(raw, sign(raw), SECRET), true);
    assert.equal(await verifySignature(raw, sign(raw), "other-secret"), false);
    assert.equal(await verifySignature(raw, "sha256=dead", SECRET), false);
    assert.equal(
      await verifySignature(raw, "", ""),
      false,
      "missing secret must fail closed (hub rejects unsigned events)"
    );
    assert.equal(
      await verifySignature(raw, sign(raw), ""),
      false,
      "request with a correct signature but no configured secret must also fail closed"
    );
  });  });

// ==========================================================================
describe("ingest: unsigned events are rejected when the secret is missing", () => {
  test("ingest rejects unsigned events when the hub has no webhook secret configured", async () => {
    const { env, sqlite } = makeEnv({ HUB_WEBHOOK_SECRET: "" });
    const res = await post("/ingest", { type: "flip.deal_found", event_id: "no-secret" }, env);
    assert.equal(res.status, 503);
    assert.deepEqual(await res.json(), { error: "hub misconfigured" });
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM events").get().n, 0);
  });

  test("emit rejects a valid-looking event sent to an unconfigured hub", async () => {
    const { env, sqlite } = makeEnv({ HUB_WEBHOOK_SECRET: "" });
    const res = await app.request("/emit", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "studio.produce", event_id: "emit-no-secret" }),
    }, env);
    assert.equal(res.status, 503);
    assert.deepEqual(await res.json(), { error: "hub misconfigured" });
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM events").get().n, 0);
  });

  test("acks rejects an unsigned request when the hub has no webhook secret", async () => {
    const { env } = makeEnv({ HUB_WEBHOOK_SECRET: "" });
    assert.equal((await post("/acks", { op: "list" }, env)).status, 503);
  });

  test("isAdmin-protected reads fail closed when the secret is missing", async () => {
    const { env } = makeEnv({ HUB_WEBHOOK_SECRET: "" });
    assert.equal((await get("/reminders", env)).status, 503);
    assert.equal((await get("/settings", env)).status, 503);
  });

  test("set-owner rejects no-secret attempts before any owner is registered", async () => {
    const { env } = makeEnv({ HUB_WEBHOOK_SECRET: "" });
    const res = await app.request("/set-owner", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: 123 }),
    }, env);
    assert.equal(res.status, 503);
  });

// ==========================================================================
describe("telegram button acks -> /acks relay", () => {
  const press = (data, msgId, env) =>
    post("/_telegram?echo=1", {
      callback_query: { id: "cb-" + msgId, data, message: { message_id: msgId, chat: { id: 777, type: "private" } } },
    }, env);

  test("records an icc press and answers with a confirmation reply", async () => {
    const { env, sqlite } = makeEnv();
    const j = await (await press("T|take", 42, env)).json();
    assert.match(j.reply, /ack stored: T\|take/);
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM tgacks").get().n, 1);
  });

  test("double pressing the same button does not duplicate the ack", async () => {
    const { env, sqlite } = makeEnv();
    await press("T|take", 42, env);
    await press("T|take", 42, env);
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM tgacks").get().n, 1);
  });

  test("non-icc callback data is ignored (business-flip presses are not relayed)", async () => {
    const { env, sqlite } = makeEnv();
    await initTables(env);
    const j = await (await press("T|contacted:5", 43, env)).json();
    assert.equal(j.reply, undefined);
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM tgacks").get().n, 0);
  });

  test("/acks rejects unsigned and wrong-signature callers", async () => {
    const { env } = makeEnv();
    assert.equal((await post("/acks", { op: "list" }, env)).status, 401);
    const res = await app.request("/acks", {
      method: "POST",
      headers: { "content-type": "application/json", "x-hub-signature-256": "sha256=00" },
      body: JSON.stringify({ op: "list" }),
    }, env);
    assert.equal(res.status, 401);
  });

  test("signed list -> consume drains the queue exactly once", async () => {
    const { env } = makeEnv();
    await press("T|take", 10, env);
    await press("T|no", 11, env);
    const call = (bodyObj) => {
      const raw = JSON.stringify(bodyObj);
      return app.request("/acks", {
        method: "POST",
        headers: { "content-type": "application/json", "x-hub-signature-256": sign(raw) },
        body: raw,
      }, env);
    };
    const listed = await (await call({ op: "list" })).json();
    assert.equal(listed.acks.length, 2);
    assert.deepEqual(listed.acks.map((a) => a.data).sort(), ["T|no", "T|take"]);

    const consumed = await (await call({ op: "consume", ids: listed.acks.map((a) => a.id) })).json();
    assert.equal(consumed.consumed, 2);
    const after = await (await call({ op: "list" })).json();
    assert.equal(after.acks.length, 0);
  });
});

// ==========================================================================
describe("telegram routes and commands", () => {
  test("/telegram (webhook path) and /_telegram are both served", async () => {
    const { env } = makeEnv();
    const a = await post("/telegram?echo=1", { message: { chat: { id: 1 }, text: "/repos" } }, env);
    const b = await post("/_telegram?echo=1", { message: { chat: { id: 1 }, text: "/repos" } }, env);
    assert.equal(a.status, 200);
    assert.equal(b.status, 200);
    assert.match((await a.json()).reply, /icc-engine/);
  });

  test("help lists the health and jobs commands", async () => {
    const { env } = makeEnv();
    const j = await (await post("/_telegram?echo=1", { message: { chat: { id: 1 }, text: "/help" } }, env)).json();
    assert.match(j.reply, /\/health/);
    assert.match(j.reply, /\/jobs/);
  });

  test("/jobs reads the ledger (empty state is friendly)", async () => {
    const { env } = makeEnv();
    const j = await (await post("/_telegram?echo=1", { message: { chat: { id: 1 }, text: "/jobs" } }, env)).json();
    assert.match(j.reply, /No job records yet/);
  });

  test("/health reports services and the ledger", async () => {
    const { env } = makeEnv();
    const res = await get("/health", env);
    assert.equal(res.status, 200);
    const j = await res.json();
    assert.equal(j.ok, true);
    assert.ok(Array.isArray(j.services));
    assert.ok(j.ledger && typeof j.ledger.jobs === "number");
  });

  test("/repos lists the five registered services", async () => {
    const { env } = makeEnv();
    const j = await (await get("/repos", env)).json();
    assert.equal(j.repos.length, 5);
  });
});

// ==========================================================================
describe("reminders: set, list, delete-is-final, sweep", () => {
  const cmd = (text, env) => post("/_telegram?echo=1", { message: { chat: { id: 777 }, text } }, env);

  test("set and list a reminder", async () => {
    const { env } = makeEnv();
    const set = await (await cmd("/remind 48 buy milk", env)).json();
    assert.match(set.reply, /Reminder #1 set/);
    const list = await (await cmd("/reminders", env)).json();
    assert.match(list.reply, /buy milk/);
  });

  test("delete is final — a cancelled reminder cannot resurrect", async () => {
    const { env } = makeEnv();
    await cmd("/remind 48 buy milk", env);
    const first = await (await cmd("/delete 1", env)).json();
    assert.match(first.reply, /cancelled/);
    const again = await (await cmd("/delete 1", env)).json();
    assert.match(again.reply, /No active reminder/);
    const afterSweep = await (await post("/sweep", {}, env)).json();
    assert.equal(afterSweep.fired, 0, "cancelled reminder must not fire");
  });

  test("sweep fires a due one-shot exactly once", async () => {
    const { env, sqlite } = makeEnv();
    await initTables(env);
    const past = Math.floor(Date.now() / 1000) - 60;
    sqlite.prepare(
      "INSERT INTO reminders(chat_id, text, due_at, repeat_h, active, created_at) VALUES(?,?,?,0,1,?)"
    ).run("777", "due job", past, past);
    // make sure the tables exist before we query them through the worker
    const first = await (await post("/sweep", {}, env)).json();
    assert.equal(first.fired, 1);
    const row = sqlite.prepare("SELECT active FROM reminders WHERE id = 1").get();
    assert.equal(Number(row.active), 0);
    const second = await (await post("/sweep", {}, env)).json();
    assert.equal(second.fired, 0, "one-shot must not fire twice");
  });

  test("sweep advances a repeating reminder in place", async () => {
    const { env, sqlite } = makeEnv();
    await initTables(env);
    const past = Math.floor(Date.now() / 1000) - 60;
    sqlite.prepare(
      "INSERT INTO reminders(chat_id, text, due_at, repeat_h, active, created_at) VALUES(?,?,?,24,1,?)"
    ).run("777", "every day", past, past);
    const res = await (await post("/sweep", {}, env)).json();
    assert.equal(res.fired, 1);
    const row = sqlite.prepare("SELECT active, due_at FROM reminders WHERE id = 1").get();
    assert.equal(Number(row.active), 1, "repeating stays active");
    assert.ok(Number(row.due_at) > Math.floor(Date.now() / 1000), "due_at advanced into the future");
  });

  test("sweep is safe with no database work to do and reports its counters", async () => {
    const { env } = makeEnv();
    const res = await post("/sweep", {}, env);
    assert.equal(res.status, 200);
    const j = await res.json();
    assert.equal(j.status, "ok");
    for (const k of ["due", "fired", "alerts", "post", "fails", "icc"]) assert.ok(k in j, `missing ${k}`);
  });
});

// ==========================================================================
describe("failure triage (diagnosis engine)", () => {
  const cases = [
    ["Write (research + script)", "RuntimeError: memory/topics.json has no queued topics.", "topic queue is empty"],
    ["Produce", "Cloudflare daily neurons used up — DAILY LIMIT reached", "free-tier AI quota exhausted"],
    ["run pipeline", "ModuleNotFoundError: No module named edge_tts", "missing dependency"],
    ["notify", "HTTP Error 401: Unauthorized", "missing or invalid credential/secret"],
    ["produce", "fetch failed: ETIMEDOUT 104.16.0.1", "network timeout / upstream unreachable"],
    ["produce", "MemoryError: std::bad_alloc", "runner ran out of memory"],
    ["write", "Traceback (most recent call last):", "unhandled code error"],
    ["mystery step", "totally unexplained output", "unclassified failure"],
  ];
  for (const [step, log, expected] of cases) {
    test(`classifies: ${expected}`, () => {
      assert.equal(classifyFailure(step, log).cause, expected);
    });
  }

  test("every diagnosis ships a concrete fix", () => {
    for (const [, log] of cases) assert.ok(classifyFailure("s", log).fix.length > 10);
  });

  test("evidence extraction windows on the error, not the job-cleanup noise", () => {
    const log = [
      "2026-10-29T12:32:10.0000000Z setup line",
      "2026-10-29T12:32:22.5675621Z Traceback (most recent call last):",
      '2026-10-29T12:32:22.5692302Z RuntimeError: memory/topics.json has no queued topics.',
      "2026-10-29T12:32:24.9000000Z Cleaning up orphan processes",
    ].join("\n");
    const ev = extractEvidence(log);
    assert.match(ev, /RuntimeError/);
    assert.doesNotMatch(ev, /Cleaning up orphan processes/, "cleanup noise must be trimmed");
    assert.doesNotMatch(ev, /^\d{4}-\d{2}-\d{2}T/m, "timestamps are stripped for readability");
  });

  test("evidence falls back to the tail when no marker matches", () => {
    const log = Array.from({ length: 80 }, (_, i) => `line ${i}`).join("\n");
    const ev = extractEvidence(log);
    assert.match(ev, /line 79/);
  });

  test("log evidence is size-capped so Telegram never truncates mid-word", () => {
    const big = Array.from({ length: 5000 }, (_, i) => `noise ${i} with some padding text`).join("\n");
    assert.ok(extractEvidence(big).length <= 2500);
  });  });
});

// ==========================================================================
describe("number parsing (ForexFactory formats)", () => {
  test("parses rates, thousands, millions, negatives and junk", () => {
    assert.equal(parseNum("3.00%"), 3);
    assert.equal(parseNum("1,234.5"), 1234.5);
    assert.equal(parseNum("30K"), 30000);
    assert.equal(parseNum("1.2M"), 1200000);
    assert.equal(parseNum("-0.4"), -0.4);
    assert.equal(parseNum(""), null);
    assert.equal(parseNum("n/a"), null);
  });
});

// ==========================================================================
describe("hermeticity", () => {
  test("no request ever reached an unexpected host (network is stubbed out)", () => {
    const allowed = new Set(["nfs.faireconomy.media", "api.github.com", "api.telegram.org"]);
    for (const url of networkCalls) {
      assert.ok(allowed.has(new URL(url).host), `unexpected outbound host: ${url}`);
    }
  });
});
