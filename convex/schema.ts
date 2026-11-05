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
    repeat: v.optional(v.string()), // daily | weekdays | weekly | monthly | (absent = once)
    done: v.boolean(),
    // Local-time bookkeeping: a repeating reminder re-anchors to localTime, so
    // a late delivery can never shift the whole series.
    tz: v.optional(v.string()),
    localTime: v.optional(v.string()), // "20:00"
    lastFiredAt: v.optional(v.number()),
    firedCount: v.optional(v.number()),
    channel: v.optional(v.string()),
    sourceRef: v.optional(v.string()),
  }).index("by_due", ["dueAt"]),

  studioSchedules: defineTable({
    studioKey: v.string(),
    localTime: v.string(), // "20:00" in tz
    days: v.optional(v.array(v.number())), // 0=Sun..6=Sat, absent/empty = daily
    enabled: v.boolean(),
    tz: v.optional(v.string()),
    topic: v.optional(v.string()),
    maxEpisodes: v.optional(v.number()),
    lastRunAt: v.optional(v.number()),
    lastRunKey: v.optional(v.string()),
  }).index("by_studio", ["studioKey"]),

  dispatches: defineTable({
    studioKey: v.string(),
    repo: v.string(),
    kind: v.string(), // run | create_series | schedule
    topic: v.optional(v.string()),
    newSeries: v.boolean(),
    ok: v.boolean(),
    status: v.optional(v.number()),
    detail: v.optional(v.string()),
    at: v.number(),
  }).index("by_at", ["at"]),

  events: defineTable({
    eventId: v.string(),
    source: v.string(), // engine | studio | flip
    type: v.string(),
    payload: v.any(),
    receivedAt: v.number(),
  }).index("by_event_id", ["eventId"]),

  kv: defineTable({
    key: v.string(),
    value: v.any(),
  }),

  // Shared daily image-call reservations across the three studio repositories.
  aiUsageDaily: defineTable({
    day: v.string(), // UTC YYYY-MM-DD
    calls: v.number(),
    studioCounts: v.any(),
    requestIds: v.array(v.string()),
    updatedAt: v.number(),
  }).index("by_day", ["day"]),

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

  flipWatches: defineTable({
    watchId: v.string(), // slug, e.g. iphone-miami
    query: v.string(),
    city: v.string(),
    maxPrice: v.number(),
    category: v.string(), // electronics | furniture | instruments | other
    active: v.boolean(),
    source: v.optional(v.string()), // chat | file
    createdAt: v.number(),
  }).index("by_watch_id", ["watchId"]),

  flipDeals: defineTable({
    dealId: v.string(), // marketplace listing id
    watchId: v.optional(v.string()),
    title: v.optional(v.string()),
    asking: v.optional(v.number()),
    lowComp: v.optional(v.number()),
    maxOffer: v.optional(v.number()),
    estList: v.optional(v.number()),
    estSpread: v.optional(v.number()),
    url: v.optional(v.string()),
    city: v.optional(v.string()),
    status: v.string(), // found | taken | contacted | posted | won | lost
    wonPrice: v.optional(v.number()),
    foundAt: v.number(),
    updatedAt: v.number(),
  }).index("by_deal_id", ["dealId"]),
  aiUsageDaily: defineTable({
    day: v.string(),
    calls: v.number(),
    studioCounts: v.any(),
    requestIds: v.array(v.string()),
    updatedAt: v.number(),
  }).index("by_day", ["day"]),
});
