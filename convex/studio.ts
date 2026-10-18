import { internalQuery } from "./_generated/server";
import { v } from "convex/values";
import { internal } from "./_generated/api";

// Episode stats + every studio's live position (series, episode, finished).
// `studioState` is kept for old callers and points at the most recent studio;
// `studios` is the honest list, one entry per channel.
export const contentOverview = internalQuery({
  args: { days: v.optional(v.number()) },
  handler: async (ctx, { days = 30 }) => {
    const stats = await ctx.runQuery(internal.insights.episodeStats, { days });
    const all = await ctx.db.query("kv").collect();
    const states = all
      .filter((k) => k.key.startsWith("studio:state:"))
      .map((k) => k.value as any)
      .sort((a, b) => (b?.updatedAt ?? 0) - (a?.updatedAt ?? 0));
    const legacy = all.find((k) => k.key === "studio:state");
    const schedules = await ctx.db.query("studioSchedules").collect();

    return {
      ...stats,
      studios: states,
      schedules,
      studioState: states[0] ?? (legacy ? legacy.value : null),
    };
  },
});
