import { httpRouter } from "convex/server";
import { httpAction } from "./_generated/server";
import { internal } from "./_generated/api";

const http = httpRouter();

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
    return new Response("ok");
  }),
});

export default http;
