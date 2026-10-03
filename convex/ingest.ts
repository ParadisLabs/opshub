import { internalMutation } from "./_generated/server";
import { v } from "convex/values";

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
    if (existing) return; // already stored — engine retries are safe
    await ctx.db.insert("events", {
      eventId,
      source,
      type,
      payload,
      receivedAt: Date.now(),
    });
  },
});
