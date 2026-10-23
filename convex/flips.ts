import { internalMutation, internalQuery } from "./_generated/server";
import { v } from "convex/values";

function slug(s: string): string {
  return (
    (s || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") ||
    "watch"
  );
}

// Serves the active hunt list to the Flip Broker engine (via /flipwatches).
export const serveWatches = internalQuery({
  handler: async (ctx) => {
    const all = await ctx.db.query("flipWatches").collect();
    return all
      .filter((w) => w.active)
      .map((w) => ({
        watchId: w.watchId,
        query: w.query,
        city: w.city,
        maxPrice: w.maxPrice,
        category: w.category,
        active: true,
      }));
  },
});

export const listWatches = internalQuery({
  handler: async (ctx) => {
    const all = await ctx.db.query("flipWatches").collect();
    return all.filter((w) => w.active);
  },
});

export const createWatch = internalMutation({
  args: {
    query: v.string(),
    city: v.string(),
    maxPrice: v.number(),
    category: v.optional(v.string()),
  },
  handler: async (ctx, { query, city, maxPrice, category }) => {
    const watchId = `${slug(query)}-${slug(city)}`;
    const existing = await ctx.db
      .query("flipWatches")
      .withIndex("by_watch_id", (q) => q.eq("watchId", watchId))
      .first();
    if (existing) {
      await ctx.db.patch(existing._id, {
        query,
        city,
        maxPrice,
        category: category ?? "other",
        active: true,
        source: "chat",
      });
      return { watchId, updated: true };
    }
    await ctx.db.insert("flipWatches", {
      watchId,
      query,
      city,
      maxPrice,
      category: category ?? "other",
      active: true,
      source: "chat",
      createdAt: Date.now(),
    });
    return { watchId, created: true };
  },
});

export const dealStats = internalQuery({
  args: { days: v.optional(v.number()) },
  handler: async (ctx, { days = 30 }) => {
    const cutoff = Date.now() - days * 86_400_000;
    const all = await ctx.db.query("flipDeals").collect();
    const recent = all.filter((d) => d.updatedAt >= cutoff);
    const active = recent.filter((d) => !["won", "lost"].includes(d.status));
    const won = recent.filter((d) => d.status === "won");
    const lost = recent.filter((d) => d.status === "lost");
    const estProfit = won.reduce(
      (s, d) => s + (d.wonPrice ?? 0) - (d.asking ?? 0),
      0
    );
    return {
      days,
      activeDeals: active.map(
        (d) => `${d.title ?? d.dealId} — ${d.status} (ask $${d.asking ?? "?"})`
      ),
      found: recent.length,
      won: won.length,
      lost: lost.length,
      estProfitUsd: Math.round(estProfit * 100) / 100,
      wonDetail: won.map(
        (d) => `${d.title ?? d.dealId}: ask $${d.asking ?? "?"} → $${d.wonPrice ?? "?"}`
      ),
    };
  },
});
