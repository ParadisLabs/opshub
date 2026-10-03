import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  businesses: defineTable({
    name: v.string(),
    kind: v.string(), // restaurant | poultry | trading | freelance | channel
    platform: v.optional(v.string()),
    createdAt: v.number(),
  }),

  entries: defineTable({
    businessId: v.optional(v.id("businesses")),
    kind: v.string(), // journal | income | expense | note
    text: v.string(),
    amount: v.optional(v.number()),
    occurredAt: v.number(),
    source: v.string(), // telegram | engine | studio | dashboard
    meta: v.optional(v.any()),
  }).index("by_occurred", ["occurredAt"]),

  reminders: defineTable({
    text: v.string(),
    dueAt: v.number(),
    repeat: v.optional(v.string()),
    done: v.boolean(),
  }).index("by_due", ["dueAt"]),

  events: defineTable({
    eventId: v.string(),
    source: v.string(), // engine | studio
    type: v.string(),
    payload: v.any(),
    receivedAt: v.number(),
  }).index("by_event_id", ["eventId"]),

  kv: defineTable({
    key: v.string(),
    value: v.any(),
  }),

  trades: defineTable({
    tradeId: v.string(),
    symbol: v.string(),
    side: v.optional(v.string()),
    strategy: v.optional(v.string()), // core | pressure
    tier: v.optional(v.string()), // take | risky
    entry: v.optional(v.number()),
    sl: v.optional(v.number()),
    tp: v.optional(v.number()),
    exit: v.optional(v.number()),
    realizedR: v.optional(v.number()),
    mfeR: v.optional(v.number()),
    maeR: v.optional(v.number()),
    peakR: v.optional(v.number()),
    status: v.string(), // open | closed
    openedAt: v.optional(v.number()),
    closedAt: v.optional(v.number()),
    engineVersion: v.optional(v.string()),
  }).index("by_trade_id", ["tradeId"]),

  episodes: defineTable({
    seriesId: v.string(),
    channelName: v.optional(v.string()),
    episodeNumber: v.number(),
    title: v.optional(v.string()),
    hookType: v.optional(v.string()),
    durationSec: v.optional(v.number()),
    producedAt: v.number(),
    publishedAt: v.optional(v.number()),
  }).index("by_series_episode", ["seriesId", "episodeNumber"]),
});
