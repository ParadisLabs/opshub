#!/usr/bin/env node
/**
 * Register and verify the Telegram webhook without ever printing credentials.
 *
 * Required names (values are read from the environment only):
 *   HUB_URL, TELEGRAM_BOT_TOKEN, TELEGRAM_WEBHOOK_SECRET, TELEGRAM_CHAT_ID
 *
 * Fails on: missing config, non-HTTPS origin, DNS failure, unreachable hub,
 * non-2xx setWebhook, Telegram ok=false, or getWebhookInfo not matching the
 * requested URL / allowed updates. Exit code 1 on any failure.
 */
import { lookup as dnsLookup } from "node:dns/promises";

const REQUIRED = ["HUB_URL", "TELEGRAM_BOT_TOKEN", "TELEGRAM_WEBHOOK_SECRET", "TELEGRAM_CHAT_ID"];
const ALLOWED_UPDATES = ["message", "callback_query"];

export function validateConfig(env = process.env) {
  const missing = REQUIRED.filter((k) => !String(env[k] || "").trim());
  if (missing.length) throw new Error(`missing required secrets: ${missing.join(", ")}`);

  let hub;
  try {
    hub = new URL(String(env.HUB_URL).trim());
  } catch {
    throw new Error("HUB_URL is not a valid absolute URL");
  }
  const local = ["localhost", "127.0.0.1", "::1"].includes(hub.hostname);
  if (hub.protocol !== "https:" && !local) {
    throw new Error("HUB_URL must use https (only localhost may use http)");
  }
  if (hub.pathname !== "/" || hub.search || hub.hash) {
    throw new Error("HUB_URL must be an origin without a path, query or fragment");
  }
  const base = hub.origin;
  return {
    hubUrl: base,
    webhookUrl: base + "/telegram",
    botToken: String(env.TELEGRAM_BOT_TOKEN).trim(),
    secret: String(env.TELEGRAM_WEBHOOK_SECRET).trim(),
    chatId: String(env.TELEGRAM_CHAT_ID).trim(),
  };
}

export async function checkDns(hostname, lookupImpl = dnsLookup) {
  if (["localhost", "127.0.0.1", "::1"].includes(hostname)) return { skipped: true };
  let rows;
  try {
    rows = await lookupImpl(hostname, { all: true });
  } catch (e) {
    throw new Error(`DNS lookup failed for ${hostname}: ${e.code || "ENOTFOUND"}`);
  }
  if (!Array.isArray(rows) || rows.length === 0) {
    throw new Error(`DNS lookup returned no addresses for ${hostname}`);
  }
  return { addresses: rows.length };
}

export function validateWebhookInfo(info, expectedUrl) {
  if (!info || typeof info !== "object") throw new Error("getWebhookInfo returned no object");
  if (info.url !== expectedUrl) {
    throw new Error(`webhook URL mismatch: expected ${expectedUrl}, got ${info.url || "(empty)"}`);
  }
  const allowed = Array.isArray(info.allowed_updates) ? info.allowed_updates : [];
  const missing = ALLOWED_UPDATES.filter((u) => !allowed.includes(u));
  if (missing.length) throw new Error(`webhook allowed_updates missing: ${missing.join(", ")}`);
  return {
    url: info.url,
    allowed_updates: allowed,
    pending_update_count: Number(info.pending_update_count || 0),
    last_error_message: info.last_error_message || null,
  };
}

export async function registerWebhook(env = process.env, opts = {}) {
  const fetchImpl = opts.fetchImpl || fetch;
  const lookupImpl = opts.lookupImpl || dnsLookup;
  const log = opts.log || console.log;
  const cfg = validateConfig(env);

  await checkDns(new URL(cfg.hubUrl).hostname, lookupImpl);

  const healthResp = await fetchImpl(cfg.hubUrl + "/health", {
    method: "GET",
    headers: { accept: "application/json", "user-agent": "opshub-webhook-register" },
    signal: AbortSignal.timeout(opts.timeoutMs || 15000),
  });
  if (!healthResp.ok) throw new Error(`hub health check failed: HTTP ${healthResp.status}`);
  const health = await healthResp.json().catch(() => null);
  if (!health || health.ok !== true) throw new Error("hub health check did not return ok=true");

  const telegram = "https://api.telegram.org/bot" + cfg.botToken;
  const setResp = await fetchImpl(telegram + "/setWebhook", {
    method: "POST",
    headers: { "content-type": "application/json", "user-agent": "opshub-webhook-register" },
    body: JSON.stringify({
      url: cfg.webhookUrl,
      secret_token: cfg.secret,
      allowed_updates: ALLOWED_UPDATES,
    }),
    signal: AbortSignal.timeout(opts.timeoutMs || 15000),
  });
  const setBody = await setResp.json().catch(() => null);
  if (!setResp.ok || !setBody || setBody.ok !== true) {
    throw new Error(`setWebhook rejected: ${(setBody && setBody.description) || "HTTP " + setResp.status}`);
  }

  const infoResp = await fetchImpl(telegram + "/getWebhookInfo", {
    method: "GET",
    headers: { accept: "application/json", "user-agent": "opshub-webhook-register" },
    signal: AbortSignal.timeout(opts.timeoutMs || 15000),
  });
  const infoBody = await infoResp.json().catch(() => null);
  if (!infoResp.ok || !infoBody || infoBody.ok !== true) {
    throw new Error(`getWebhookInfo rejected: ${(infoBody && infoBody.description) || "HTTP " + infoResp.status}`);
  }
  const verified = validateWebhookInfo(infoBody.result, cfg.webhookUrl);
  log(`webhook verified: ${verified.url}`);
  log(`allowed_updates: ${verified.allowed_updates.join(",")}`);
  log(`pending_updates: ${verified.pending_update_count}`);
  if (verified.last_error_message) log(`last_error: ${verified.last_error_message}`);
  return { ok: true, ...verified };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  registerWebhook().catch((e) => {
    console.error("webhook registration failed:", String(e.message || e).slice(0, 300));
    process.exit(1);
  });
}
