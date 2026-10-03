import { httpRouter } from "convex/server";
import { httpAction } from "./_generated/server";
import { internal } from "./_generated/api";

const http = httpRouter();

const NOTIFY_TYPES = new Set([
  "trade.opened",
  "trade.closed",
  "content.episode_ready",
]);

function summarize(event: any): string {
  const p = event.payload ?? {};
  const sym = p.symbol ? ` ${p.symbol}` : "";
  const side = p.side ? ` ${p.side}` : "";
  if (event.type === "trade.opened") {
    const entry = p.entry != null ? ` @ ${p.entry}` : "";
    return `📈${sym}${side} trade opened${entry} — hub is tracking it`;
  }
  if (event.type === "trade.closed") {
    const r = typeof p.realized_r === "number" ? p.realized_r : null;
    return `🏁${sym}${side} closed: ${
      r === null ? "logged" : `${r >= 0 ? "+" : ""}${r}R`
    }`;
  }
  if (event.type === "content.episode_ready") {
    return `📺 "${p.title ?? "Episode"}" (ep ${p.episode_number ?? "?"})${
      p.channel_name ? ` — ${p.channel_name}` : ""
    } is ready to post`;
  }
  return `Event received: ${event.type}`;
}

http.route({
  path: "/telegram",
  method: "POST",
  handler: httpAction(async (ctx, req) => {
    const expected = process.env.TELEGRAM_WEBHOOK_SECRET;
    if (
      !expected ||
      req.headers.get("x-telegram-bot-api-secret-token") !== expected
    ) {
      return new Response("forbidden", { status: 403 });
    }
    const update = await req.json();
    await ctx.scheduler.runAfter(0, internal.bot.handleUpdate, { update });
    return new Response("ok");
  }),
});

http.route({
  path: "/ingest",
  method: "POST",
  handler: httpAction(async (ctx, req) => {
    const secret = process.env.HUB_WEBHOOK_SECRET;
    if (!secret) return new Response("not configured", { status: 500 });
    const sig = req.headers.get("x-hub-signature-256") || "";
    const body = await req.text();
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"]
    );
    const mac = await crypto.subtle.sign(
      "HMAC",
      key,
      new TextEncoder().encode(body)
    );
    const hex = [...new Uint8Array(mac)]
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    if (sig !== `sha256=${hex}`) {
      return new Response("bad signature", { status: 401 });
    }
    let event: any;
    try {
      event = JSON.parse(body);
    } catch {
      return new Response("bad json", { status: 400 });
    }
    if (!event?.event_id || !event?.type) {
      return new Response("bad event", { status: 400 });
    }
    await ctx.runMutation(internal.ingest.storeEvent, {
      eventId: event.event_id,
      source: event.source ?? "unknown",
      type: event.type,
      payload: event,
    });
    if (NOTIFY_TYPES.has(event.type)) {
      await ctx.scheduler.runAfter(0, internal.broadcast.notifyEvent, {
        type: event.type as string,
        summary: summarize(event),
      });
    }
    return new Response("ok");
  }),
});

http.route({
  path: "/digest",
  method: "POST",
  handler: httpAction(async (ctx, req) => {
    const expected = process.env.TELEGRAM_WEBHOOK_SECRET;
    if (!expected || req.headers.get("x-ops-hub-token") !== expected) {
      return new Response("forbidden", { status: 403 });
    }
    await ctx.scheduler.runAfter(0, internal.digest.weeklyDigest, {});
    return new Response("digest scheduled");
  }),
});

export default http;
