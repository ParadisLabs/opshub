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

    // ---- series state (where the studio IS right now) ----
    if (type === "content.series_state") {
      const key = "studio:state";
      const all = await ctx.db.query("kv").collect();
      const doc = all.find((k) => k.key === key);
      const value = {
        seriesId: String(payload.series_id ?? "unknown"),
        channelName: payload.channel_name
          ? String(payload.channel_name)
          : undefined,
        title: payload.title ? String(payload.title) : undefined,
        episodeNumber: num(payload.episode_number) ?? 0,
        maxEpisodes: num(payload.max_episodes),
        finished: payload.finished === true,
        lastHook: payload.last_hook ? String(payload.last_hook) : undefined,
        updatedAt: Date.now(),
      };
      if (doc) await ctx.db.patch(doc._id, { value });
      else await ctx.db.insert("kv", { key, value });
    }

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

    // ---- derive: flip.deal_found ----
    if (type === "flip.deal_found") {
      const dealId = String(payload.deal_id ?? eventId);
      const existingDeal = await ctx.db
        .query("flipDeals")
        .withIndex("by_deal_id", (q) => q.eq("dealId", dealId))
        .first();
      const fields = {
        watchId: payload.watch_id ? String(payload.watch_id) : undefined,
        title: payload.title ? String(payload.title) : undefined,
        asking: num(payload.asking),
        lowComp: num(payload.low_comp),
        maxOffer: num(payload.max_offer),
        estList: num(payload.est_list),
        estSpread: num(payload.est_spread),
        url: payload.url ? String(payload.url) : undefined,
        city: payload.city ? String(payload.city) : undefined,
      };
      if (existingDeal) {
        await ctx.db.patch(existingDeal._id, { ...fields, updatedAt: Date.now() });
      } else {
        await ctx.db.insert("flipDeals", {
          dealId,
          ...fields,
          status: "found",
          foundAt: toMs(payload.occurred_at) ?? Date.now(),
          updatedAt: Date.now(),
        });
      }
    }

    // ---- derive: flip.status_changed / flip.deal_closed ----
    if (type === "flip.status_changed" || type === "flip.deal_closed") {
      const dealId = String(payload.deal_id ?? eventId);
      const status = String(payload.status ?? "");
      const existingDeal = await ctx.db
        .query("flipDeals")
        .withIndex("by_deal_id", (q) => q.eq("dealId", dealId))
        .first();
      if (!existingDeal) {
        await ctx.db.insert("flipDeals", {
          dealId,
          title: payload.title ? String(payload.title) : undefined,
          watchId: payload.watch_id ? String(payload.watch_id) : undefined,
          asking: num(payload.asking),
          status: status || "found",
          wonPrice: num(payload.price),
          foundAt: toMs(payload.occurred_at) ?? Date.now(),
          updatedAt: Date.now(),
        });
      } else {
        const patch: any = {
          status: status || existingDeal.status,
          updatedAt: Date.now(),
        };
        if (num(payload.price) !== undefined) patch.wonPrice = num(payload.price);
        await ctx.db.patch(existingDeal._id, patch);
        // auto follow-up reminders (48h) — engine never re-sends same status,
        // so no duplicate reminders
        if (status === "contacted" || status === "posted") {
          const label = (existingDeal.title ?? "deal").slice(0, 40);
          await ctx.db.insert("reminders", {
            text:
              status === "contacted"
                ? `Flip follow-up: seller replied? "${label}"`
                : `Flip follow-up: buyer leads on "${label}"?`,
            dueAt: Date.now() + 48 * 3600 * 1000,
            done: false,
          });
        }
      }
    }
  },
});
