import { internalMutation } from "./_generated/server";
import { v } from "convex/values";

function toMs(x: any): number | undefined {
  if (typeof x === "number" && isFinite(x)) return x < 1e12 ? x * 1000 : x;
  if (typeof x === "string") {
    const t = Date.parse(x);
    if (isFinite(t)) return t;
  }
  return undefined;
}

function num(x: any): number | undefined {
  if (typeof x === "number" && isFinite(x)) return x;
  if (typeof x === "string" && x.trim() !== "" && isFinite(Number(x))) {
    return Number(x);
  }
  return undefined;
}

export const storeEvent = internalMutation({
  args: {
    eventId: v.string(),
    source: v.string(),
    type: v.string(),
    payload: v.any(),
  },
  handler: async (ctx, { eventId, source, type, payload }) => {
    const existing = await ctx.db
      .query("events")
      .withIndex("by_event_id", (q) => q.eq("eventId", eventId))
      .first();
    if (existing) return; // dedupe retries

    await ctx.db.insert("events", {
      eventId,
      source,
      type,
      payload,
      receivedAt: Date.now(),
    });

    // ---- derive: trade.opened ----
    if (type === "trade.opened") {
      const tradeId = String(payload.trade_id ?? eventId);
      const existingTrade = await ctx.db
        .query("trades")
        .withIndex("by_trade_id", (q) => q.eq("tradeId", tradeId))
        .first();
      const fields = {
        symbol: String(payload.symbol ?? "UNKNOWN"),
        side: payload.side ? String(payload.side) : undefined,
        strategy: payload.strategy ? String(payload.strategy) : undefined,
        tier: payload.tier ? String(payload.tier) : undefined,
        entry: num(payload.entry),
        sl: num(payload.sl),
        tp: num(payload.tp),
        engineVersion: payload.engine_version
          ? String(payload.engine_version)
          : undefined,
      };
      if (existingTrade) {
        await ctx.db.patch(existingTrade._id, {
          ...fields,
          status: "open",
          openedAt: toMs(payload.occurred_at) ?? existingTrade.openedAt,
        });
      } else {
        await ctx.db.insert("trades", {
          tradeId,
          ...fields,
          status: "open",
          openedAt: toMs(payload.occurred_at) ?? Date.now(),
        });
      }
    }

    // ---- derive: trade.closed ----
    if (type === "trade.closed") {
      const tradeId = String(payload.trade_id ?? eventId);
      const existingTrade = await ctx.db
        .query("trades")
        .withIndex("by_trade_id", (q) => q.eq("tradeId", tradeId))
        .first();
      const closeFields = {
        exit: num(payload.exit),
        realizedR: num(payload.realized_r),
        mfeR: num(payload.mfe_r),
        maeR: num(payload.mae_r),
        peakR: num(payload.peak_r),
        status: "closed" as const,
        closedAt: toMs(payload.occurred_at) ?? Date.now(),
      };
      if (existingTrade) {
        await ctx.db.patch(existingTrade._id, closeFields);
      } else {
        await ctx.db.insert("trades", {
          tradeId,
          symbol: String(payload.symbol ?? "UNKNOWN"),
          side: payload.side ? String(payload.side) : undefined,
          strategy: payload.strategy ? String(payload.strategy) : undefined,
          tier: payload.tier ? String(payload.tier) : undefined,
          ...closeFields,
        });
      }
    }

    // ---- derive: content.episode_ready ----
    if (type === "content.episode_ready") {
      const seriesId = String(payload.series_id ?? "unknown");
      const episodeNumber = num(payload.episode_number) ?? 0;
      const existing = await ctx.db
        .query("episodes")
        .withIndex("by_series_episode", (q) =>
          q.eq("seriesId", seriesId).eq("episodeNumber", episodeNumber)
        )
        .first();
      const fields = {
        title: payload.title ? String(payload.title) : undefined,
        channelName: payload.channel_name
          ? String(payload.channel_name)
          : undefined,
        hookType: payload.hook_type ? String(payload.hook_type) : undefined,
        durationSec: num(payload.duration_sec),
        producedAt: toMs(payload.occurred_at) ?? Date.now(),
      };
      if (existing) {
        await ctx.db.patch(existing._id, fields);
      } else {
        await ctx.db.insert("episodes", {
          seriesId,
          episodeNumber,
          ...fields,
        });
      }
    }
  },
});
