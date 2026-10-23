import { internalMutation, internalQuery } from "./_generated/server";
import { v } from "convex/values";

const DAY = 86_400_000;

async function kvGet(ctx: any, key: string) {
  const all = await ctx.db.query("kv").collect();
  return all.find((k: any) => k.key === key);
}

export const logSocialStat = internalMutation({
  args: {
    platform: v.string(),
    name: v.string(),
    views: v.optional(v.number()),
    likes: v.optional(v.number()),
    followers: v.optional(v.number()),
    note: v.optional(v.string()),
  },
  handler: async (ctx, a) => {
    const key = `social:${a.platform.toLowerCase()}:${a.name.toLowerCase()}`;
    const doc = await kvGet(ctx, key);
    const prev: any = doc?.value ?? null;
    const value: any = {
      platform: a.platform,
      name: a.name,
      views: a.views,
      likes: a.likes,
      followers: a.followers,
      note: a.note,
      loggedAt: Date.now(),
      delta: prev
        ? {
            views:
              a.views != null && prev.views != null
                ? a.views - prev.views
                : undefined,
            followers:
              a.followers != null && prev.followers != null
                ? a.followers - prev.followers
                : undefined,
          }
        : null,
    };
    if (doc) await ctx.db.patch(doc._id, { value });
    else await ctx.db.insert("kv", { key, value });
    return { saved: true, delta: value.delta };
  },
});

export const listSocialStats = internalQuery({
  handler: async (ctx) => {
    const all = await ctx.db.query("kv").collect();
    return all
      .filter((k) => k.key.startsWith("social:"))
      .map((k) => k.value as any);
  },
});

export const markEpisodePosted = internalMutation({
  args: {
    seriesId: v.string(),
    episodeNumber: v.number(),
    channelName: v.optional(v.string()),
  },
  handler: async (ctx, { seriesId, episodeNumber, channelName }) => {
    const ep = await ctx.db
      .query("episodes")
      .withIndex("by_series_episode", (q) =>
        q.eq("seriesId", seriesId).eq("episodeNumber", episodeNumber)
      )
      .first();
    if (ep) {
      if (!ep.publishedAt) await ctx.db.patch(ep._id, { publishedAt: Date.now() });
      return { found: true, seriesId, episodeNumber };
    }
    await ctx.db.insert("episodes", {
      seriesId,
      episodeNumber,
      channelName,
      producedAt: Date.now() - DAY,
      publishedAt: Date.now(),
    });
    return { found: false, created: true, seriesId, episodeNumber };
  },
});

export const addEpisodeRecord = internalMutation({
  args: {
    seriesId: v.string(),
    episodeNumber: v.number(),
    channelName: v.optional(v.string()),
    title: v.optional(v.string()),
    published: v.optional(v.boolean()),
  },
  handler: async (ctx, a) => {
    const existing = await ctx.db
      .query("episodes")
      .withIndex("by_series_episode", (q) =>
        q.eq("seriesId", a.seriesId).eq("episodeNumber", a.episodeNumber)
      )
      .first();
    if (existing) return { created: false, note: "already tracked" };
    await ctx.db.insert("episodes", {
      seriesId: a.seriesId,
      episodeNumber: a.episodeNumber,
      channelName: a.channelName,
      title: a.title,
      producedAt: Date.now() - DAY,
      publishedAt: a.published ? Date.now() : undefined,
    });
    return { created: true };
  },
});
