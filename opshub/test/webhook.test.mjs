import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  validateConfig,
  checkDns,
  validateWebhookInfo,
  registerWebhook,
} from "../scripts/register-webhook.mjs";

const baseEnv = {
  HUB_URL: "https://hub.example.com",
  TELEGRAM_BOT_TOKEN: "123:token",
  TELEGRAM_WEBHOOK_SECRET: "webhook-secret",
  TELEGRAM_CHAT_ID: "42",
};

function fakeFetch(responses) {
  const calls = [];
  const fn = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    const next = responses.shift();
    if (!next) throw new Error("unexpected fetch " + url);
    return {
      ok: next.ok !== false,
      status: next.status || 200,
      json: async () => next.body,
    };
  };
  return { fn, calls };
}

describe("webhook registration validation", () => {
  test("rejects missing secrets without echoing values", () => {
    assert.throws(() => validateConfig({ ...baseEnv, TELEGRAM_CHAT_ID: "" }), /TELEGRAM_CHAT_ID/);
  });

  test("rejects an empty or relative HUB_URL", () => {
    assert.throws(() => validateConfig({ ...baseEnv, HUB_URL: "" }), /missing required secrets/);
    assert.throws(() => validateConfig({ ...baseEnv, HUB_URL: "hub.example.com" }), /valid absolute URL/);
  });

  test("rejects non-HTTPS production origins", () => {
    assert.throws(() => validateConfig({ ...baseEnv, HUB_URL: "http://hub.example.com" }), /https/);
  });

  test("rejects a HUB_URL with a path", () => {
    assert.throws(() => validateConfig({ ...baseEnv, HUB_URL: "https://hub.example.com/base" }), /without a path/);
  });

  test("propagates DNS failure", async () => {
    await assert.rejects(
      checkDns("missing.example.com", async () => { throw Object.assign(new Error("no"), { code: "ENOTFOUND" }); }),
      /ENOTFOUND/
    );
  });

  test("rejects an empty DNS answer", async () => {
    await assert.rejects(checkDns("empty.example.com", async () => []), /no addresses/);
  });

  test("rejects a webhook URL mismatch", () => {
    assert.throws(
      () => validateWebhookInfo({ url: "https://evil.example.com/telegram", allowed_updates: ["message", "callback_query"] }, "https://hub.example.com/telegram"),
      /mismatch/
    );
  });

  test("rejects missing allowed updates", () => {
    assert.throws(
      () => validateWebhookInfo({ url: "https://hub.example.com/telegram", allowed_updates: ["message"] }, "https://hub.example.com/telegram"),
      /callback_query/
    );
  });

  test("fails when Telegram returns ok=false", async () => {
    const { fn } = fakeFetch([
      { body: { ok: true } },
      { ok: false, status: 200, body: { ok: false, description: "bad token" } },
    ]);
    await assert.rejects(
      registerWebhook(baseEnv, { fetchImpl: fn, lookupImpl: async () => [{ address: "1.2.3.4" }], log: () => {} }),
      /bad token/
    );
  });

  test("fails on a non-2xx hub health response", async () => {
    const { fn } = fakeFetch([{ ok: false, status: 503, body: { ok: false } }]);
    await assert.rejects(
      registerWebhook(baseEnv, { fetchImpl: fn, lookupImpl: async () => [{ address: "1.2.3.4" }], log: () => {} }),
      /health check failed/
    );
  });

  test("verifies a successful registration and never returns the token", async () => {
    const url = "https://hub.example.com/telegram";
    const { fn, calls } = fakeFetch([
      { body: { ok: true } },
      { body: { ok: true, result: true } },
      { body: { ok: true, result: { url, allowed_updates: ["message", "callback_query"], pending_update_count: 2 } } },
    ]);
    const logs = [];
    const result = await registerWebhook(baseEnv, {
      fetchImpl: fn,
      lookupImpl: async () => [{ address: "1.2.3.4" }],
      log: (line) => logs.push(line),
    });
    assert.equal(result.ok, true);
    assert.equal(result.pending_update_count, 2);
    assert.equal(calls.length, 3);
    assert.ok(!JSON.stringify(result).includes("token"));
    assert.ok(!logs.join("\n").includes("token"));
    const setBody = JSON.parse(calls[1].init.body);
    assert.equal(setBody.url, url);
    assert.equal(setBody.secret_token, "webhook-secret");
    assert.deepEqual(setBody.allowed_updates, ["message", "callback_query"]);
  });
});
