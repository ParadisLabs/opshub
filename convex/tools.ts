import { internalMutation, internalQuery } from "./_generated/server";
import { v } from "convex/values";

const DAY = 86_400_000;

async function kvGet(ctx: any, key: string) {
  const all = await ctx.db.query("kv").collect();
  return all.find((k: any) => k.key === key);
}

async function kvSet(ctx: any, key: string, value: any) {
  const doc = await kvGet(ctx, key);
  if (doc) await ctx.db.patch(doc._id, { value });
  else await ctx.db.insert("kv", { key, value });
}

// ---------- businesses ----------

export const listBusinesses = internalQuery({
  handler: async (ctx) => ctx.db.query("businesses").collect(),
});

export const addBusiness = internalMutation({
  args: {
    name: v.string(),
    kind: v.string(),
    platform: v.optional(v.string()),
  },
  handler: async (ctx, { name, kind, platform }) => {
    const id = await ctx.db.insert("businesses", {
      name,
      kind,
      platform,
      createdAt: Date.now(),
    });
    return { created: true, name, kind, id };
  },
});

// ---------- entries ----------

export const addEntry = internalMutation({
  args: {
    kind: v.string(),
    text: v.string(),
    amount: v.optional(v.number()),
    businessName: v.optional(v.string()),
    occurredAt: v.optional(v.number()),
  },
  handler: async (ctx, a) => {
    let businessId: any = undefined;
    if (a.businessName) {
      const all = await ctx.db.query("businesses").collect();
      const match = all.find(
        (b) => b.name.toLowerCase() === a.businessName!.toLowerCase()
      );
      businessId = match
        ? match._id
        : await ctx.db.insert("businesses", {
            name: a.businessName!,
            kind: "other",
            createdAt: Date.now(),
          });
    }
    const id = await ctx.db.insert("entries", {
      businessId,
      kind: a.kind,
      text: a.text,
      amount: a.amount,
      occurredAt: a.occurredAt ?? Date.now(),
      source: "telegram",
    });
    return { saved: true, id };
  },
});

export const getRecentEntries = internalQuery({
  handler: async (ctx) => {
    const entries = await ctx.db
      .query("entries")
      .withIndex("by_occurred")
      .order("desc")
      .take(10);
    const businesses = await ctx.db.query("businesses").collect();
    const nameOf = (id?: any) =>
      businesses.find((b: any) => b._id === id)?.name ?? "";
    return entries
      .map((e) =>
        [
          new Date(e.occurredAt).toISOString().slice(0, 10),
          e.kind,
          nameOf(e.businessId),
          e.amount ?? "",
          e.text,
        ]
          .filter((x) => x !== "")
          .join(" | ")
      )
      .join("\n");
  },
});

// ---------- pending record (confirm flow) ----------

export const proposePending = internalMutation({
  args: { chatId: v.number(), record: v.any() },
  handler: async (ctx, { chatId, record }) => {
    const rec = {
      kind: String(record.kind ?? "journal"),
      text: String(record.text ?? ""),
      amount: typeof record.amount === "number" ? record.amount : undefined,
      businessName: record.businessName
        ? String(record.businessName)
        : undefined,
      occurredAt:
        typeof record.occurredAt === "number" ? record.occurredAt : Date.now(),
    };
    const label =
      rec.kind === "income"
        ? "Income"
        : rec.kind === "expense"
        ? "Expense"
        : "Record";
    const card =
      `📌 ${label}${rec.businessName ? ` · ${rec.businessName}` : ""}` +
      `${rec.amount != null ? ` · ${rec.amount}` : ""}\n` +
      `"${rec.text}"\n\nSave? (yes / no)`;
    await kvSet(ctx, `pending:${chatId}`, rec);
    return { staged: true, card };
  },
});

export const getPending = internalQuery({
  args: { chatId: v.number() },
  handler: async (ctx, { chatId }) => {
    const doc = await kvGet(ctx, `pending:${chatId}`);
    return doc ? doc.value : null;
  },
});

export const savePending = internalMutation({
  args: { chatId: v.number() },
  handler: async (ctx, { chatId }) => {
    const doc = await kvGet(ctx, `pending:${chatId}`);
    if (!doc) return { saved: false };
    const rec = doc.value;
    await ctx.db.delete(doc._id);
    let businessId: any = undefined;
    if (rec.businessName) {
      const all = await ctx.db.query("businesses").collect();
      const match = all.find(
        (b: any) =>
          b.name.toLowerCase() === String(rec.businessName).toLowerCase()
      );
      businessId = match
        ? match._id
        : await ctx.db.insert("businesses", {
            name: rec.businessName,
            kind: "other",
            createdAt: Date.now(),
          });
    }
    await ctx.db.insert("entries", {
      businessId,
      kind: rec.kind,
      text: rec.text,
      amount: rec.amount,
      occurredAt: rec.occurredAt,
      source: "telegram",
    });
    return {
      saved: true,
      kind: rec.kind,
      text: rec.text,
      amount: rec.amount,
      businessName: rec.businessName,
    };
  },
});

export const clearPending = internalMutation({
  args: { chatId: v.number() },
  handler: async (ctx, { chatId }) => {
    const doc = await kvGet(ctx, `pending:${chatId}`);
    if (doc) await ctx.db.delete(doc._id);
    return { cleared: true };
  },
});

// ---------- money queries ----------

export const checkIncome = internalQuery({
  args: { days: v.optional(v.number()), businessName: v.optional(v.string()) },
  handler: async (ctx, { days = 7, businessName }) => {
    const cutoff = Date.now() - days * DAY;
    let rows = (
      await ctx.db
        .query("entries")
        .withIndex("by_occurred", (q) => q.gte("occurredAt", cutoff))
        .collect()
    ).filter((e) => e.kind === "income");
    if (businessName) {
      const all = await ctx.db.query("businesses").collect();
      const b = all.find(
        (x: any) => x.name.toLowerCase() === businessName!.toLowerCase()
      );
      rows = b ? rows.filter((e) => e.businessId === b._id) : [];
    }
    const total = rows.reduce((s, e) => s + (e.amount ?? 0), 0);
    return {
      days,
      count: rows.length,
      total,
      recent: rows.slice(-5).map((e) => ({ text: e.text, amount: e.amount })),
    };
  },
});

export const checkExpenses = internalQuery({
  args: { days: v.optional(v.number()), businessName: v.optional(v.string()) },
  handler: async (ctx, { days = 7, businessName }) => {
    const cutoff = Date.now() - days * DAY;
    let rows = (
      await ctx.db
        .query("entries")
        .withIndex("by_occurred", (q) => q.gte("occurredAt", cutoff))
        .collect()
    ).filter((e) => e.kind === "expense");
    if (businessName) {
      const all = await ctx.db.query("businesses").collect();
      const b = all.find(
        (x: any) => x.name.toLowerCase() === businessName!.toLowerCase()
      );
      rows = b ? rows.filter((e) => e.businessId === b._id) : [];
    }
    const total = rows.reduce((s, e) => s + (e.amount ?? 0), 0);
    return {
      days,
      count: rows.length,
      total,
      recent: rows.slice(-5).map((e) => ({ text: e.text, amount: e.amount })),
    };
  },
});

// ---------- chat memory ----------

export const getChat = internalQuery({
  args: { chatId: v.number() },
  handler: async (ctx, { chatId }) => {
    const doc = await kvGet(ctx, `chat:${chatId}`);
    return doc ? doc.value : [];
  },
});

export const appendChat = internalMutation({
  args: { chatId: v.number(), userText: v.string(), botText: v.string() },
  handler: async (ctx, { chatId, userText, botText }) => {
    const doc = await kvGet(ctx, `chat:${chatId}`);
    const history: any[] = doc ? doc.value : [];
    history.push({ role: "user", text: userText });
    history.push({ role: "bot", text: botText });
    await kvSet(ctx, `chat:${chatId}`, history.slice(-12));
    return { ok: true };
  },
});
