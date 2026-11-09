import { internalMutation } from "./_generated/server";
import { v } from "convex/values";

export const reserve = internalMutation({
  args: { day: v.string(), studio: v.string(), requestId: v.string(), globalCap: v.number(), studioCap: v.number(), now: v.number() },
  handler: async (ctx, args) => {
    const row = await ctx.db.query("aiUsageDaily").withIndex("by_day", q => q.eq("day", args.day)).unique();
    const ids = row?.requestIds ?? [];
    const counts = { ...(row?.studioCounts ?? {}) } as Record<string, number>;
    if (ids.includes(args.requestId)) return { allowed: true, calls: row?.calls ?? 0, studioCalls: counts[args.studio] ?? 0, reason: "already_reserved" };
    const calls = row?.calls ?? 0;
    const studioCalls = counts[args.studio] ?? 0;
    if (calls >= args.globalCap) return { allowed: false, calls, studioCalls, reason: "global_daily_call_cap" };
    if (studioCalls >= args.studioCap) return { allowed: false, calls, studioCalls, reason: "studio_daily_call_cap" };
    counts[args.studio] = studioCalls + 1;
    const requestIds = [...ids, args.requestId];
    if (row) await ctx.db.patch(row._id, { calls: calls + 1, studioCounts: counts, requestIds, updatedAt: args.now });
    else await ctx.db.insert("aiUsageDaily", { day: args.day, calls: 1, studioCounts: counts, requestIds, updatedAt: args.now });
    return { allowed: true, calls: calls + 1, studioCalls: studioCalls + 1, reason: "reserved" };
  },
});
