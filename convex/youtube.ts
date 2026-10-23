import { internalAction, internalQuery, internalMutation } from "./_generated/server";
import { v } from "convex/values";
import { internal } from "./_generated/api";

export const saveSnapshot = internalMutation({
  args: { handle: v.string(), stats: v.any() },
  handler: async (ctx, { handle, stats }) => {
    const key = `yt:${handle}`;
    const all = await ctx.db.query("kv").collect();
    const doc = all.find((k) => k.key === key);
    const prev: any = doc?.value ?? null;
    const delta = prev
      ? {
          subs: (stats.subscribers ?? 0) - (prev.subscribers ?? 0),
          views: (stats.views ?? 0) - (prev.views ?? 0),
          since: prev.fetchedAt,
        }
      : null;
    const value = { ...stats, delta };
    if (doc) await ctx.db.patch(doc._id, { value });
    else await ctx.db.insert("kv", { key, value });
    return value;
  },
});

export const snapshotForDigest = internalQuery({
  handler: async (ctx) => {
    const all = await ctx.db.query("kv").collect();
    return all
      .filter((k) => k.key.startsWith("yt:"))
      .map((k) => ({ handle: k.key.slice(3), ...(k.value as any) }));
  },
});

export const pullChannelStats = internalAction({
  handler: async (ctx) => {
    const key = process.env.YOUTUBE_API_KEY;
    const handles = (process.env.YOUTUBE_CHANNELS ?? "")
      .split(",")
      .map((h) => h.trim())
      .filter(Boolean);
    if (!key || handles.length === 0) {
      console.log("youtube: YOUTUBE_API_KEY / YOUTUBE_CHANNELS not set, skipping");
      return;
    }
    for (const handle of handles) {
      try {
        const chUrl = `https://www.googleapis.com/youtube/v3/channels?part=statistics,contentDetails&forHandle=${encodeURIComponent(handle)}&key=${key}`;
        const ch = await (await fetch(chUrl)).json();
        const item = ch?.items?.[0];
        if (!item) {
          console.log(`youtube: ${handle} not found`);
          continue;
        }
        const st = item.statistics ?? {};
        const stats: any = {
          subscribers: Number(st.subscriberCount ?? 0),
          views: Number(st.viewCount ?? 0),
          videos: Number(st.videoCount ?? 0),
          fetchedAt: Date.now(),
        };
        try {
          const up = item.contentDetails?.relatedPlaylists?.uploads;
          const pl = await (
            await fetch(`https://www.googleapis.com/youtube/v3/playlistItems?part=contentDetails&maxResults=5&playlistId=${up}&key=${key}`)
          ).json();
          const ids = (pl.items ?? [])
            .map((i: any) => i.contentDetails?.videoId)
            .filter(Boolean);
          if (ids.length) {
            const vs = await (
              await fetch(`https://www.googleapis.com/youtube/v3/videos?part=statistics,snippet&id=${ids.join(",")}&key=${key}`)
            ).json();
            stats.recentVideos = (vs.items ?? []).map((v: any) => ({
              title: v.snippet?.title ?? "",
              views: Number(v.statistics?.viewCount ?? 0),
              likes: Number(v.statistics?.likeCount ?? 0),
            }));
          }
        } catch {}
        await ctx.runMutation(internal.youtube.saveSnapshot, { handle, stats });
        console.log(`youtube: ${handle} → subs ${stats.subscribers}, views ${stats.views}, videos ${stats.videos}`);
      } catch (e: any) {
        console.log(`youtube: ${handle} failed: ${e?.message ?? e}`);
      }
    }
  },
});
