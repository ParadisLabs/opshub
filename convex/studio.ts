import { internalQuery } from "./_generated/server";
import { v } from "convex/values";
import { internal } from "./_generated/api";

// Episode stats + the studio's live position (current episode, finished flag).
export const contentOverview = internalQuery({
  args: { days: v.optional(v.number()) },
  handler: async (ctx, { days = 30 }) => {
    const stats = await ctx.runQuery(internal.insights.episodeStats, { days });
    const all = await ctx.db.query("kv").collect();
    const st = all.find((k) => k.key === "studio:state");
    return { ...stats, studioState: st ? st.value : null };
  },
});
