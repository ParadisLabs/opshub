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
});
