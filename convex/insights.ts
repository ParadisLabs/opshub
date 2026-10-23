import { internalQuery, internalMutation } from "./_generated/server";
import { v } from "convex/values";

const DAY = 86_400_000;

function bump(
  rec: Record<string, { n: number; wins: number; r: number }>,
  key: string | null | undefined,
  r: number
) {
  const k = key ?? "?";
  const b = rec[k] ?? { n: 0, wins: 0, r: 0 };
  b.n += 1;
  b.wins += r > 0 ? 1 : 0;
  b.r = Math.round((b.r + r) * 100) / 100;
  rec[k] = b;
}

function fmt(rec: Record<string, { n: number; wins: number; r: number }>) {
  return (
    Object.entries(rec)
      .map(
        ([k, v]) =>
          `${k}: ${v.n} trades, WR ${Math.round((v.wins / v.n) * 100)}%, ${
            v.r >= 0 ? "+" : ""
          }${v.r}R`
      )
      .join("; ") || "none"
  );
}

export const tradeStats = internalQuery({
  args: { days: v.optional(v.number()) },
  handler: async (ctx, { days = 30 }) => {
    const cutoff = Date.now() - days * DAY;
    const all = await ctx.db.query("trades").collect();
    const closed = all.filter(
      (t) => t.status === "closed" && (t.closedAt ?? 0) >= cutoff
    );
    const open = all.filter((t) => t.status === "open");
    const wins = closed.filter((t) => (t.realizedR ?? 0) > 0);
    const totalR = closed.reduce((s, t) => s + (t.realizedR ?? 0), 0);
    const bySym: Record<string, { n: number; wins: number; r: number }> = {};
    const byTier: Record<string, { n: number; wins: number; r: number }> = {};
    const byStrat: Record<string, { n: number; wins: number; r: number }> = {};
    for (const t of closed) {
      const r = t.realizedR ?? 0;
      bump(bySym, t.symbol, r);
      bump(byTier, t.tier, r);
      bump(byStrat, t.strategy, r);
    }
    return {
      days,
      openCount: open.length,
      closedCount: closed.length,
      winRate: closed.length ? Math.round((wins.length / closed.length) * 100) : null,
      totalR: Math.round(totalR * 100) / 100,
      avgR: closed.length ? Math.round((totalR / closed.length) * 100) / 100 : null,
      best: closed.length ? Math.max(...closed.map((t) => t.realizedR ?? 0)) : null,
      worst: closed.length ? Math.min(...closed.map((t) => t.realizedR ?? 0)) : null,
      bySymbol: fmt(bySym),
      byTier: fmt(byTier),
      byStrategy: fmt(byStrat),
      recent: closed
        .sort((a, b) => (b.closedAt ?? 0) - (a.closedAt ?? 0))
        .slice(0, 5)
        .map((t) => `${t.symbol} ${t.side ?? ""} ${t.realizedR}R (${t.tier ?? "?"}/${t.strategy ?? "?"})`),
      open: open.map(
        (t) =>
          `${t.symbol} ${t.side ?? ""} opened ${
            t.openedAt ? new Date(t.openedAt).toISOString().slice(0, 10) : "?"
          }`
      ),
    };
  },
});

export const episodeStats = internalQuery({
  args: { days: v.optional(v.number()) },
  handler: async (ctx, { days = 30 }) => {
    const cutoff = Date.now() - days * DAY;
    const eps = await ctx.db.query("episodes").collect();
    const recent = eps.filter((e) => e.producedAt >= cutoff);
    const unpublished = recent.filter((e) => e.publishedAt == null);
    const published = recent.filter((e) => e.publishedAt != null);
    const lags = published.map((e) =>
      Math.round(((e.publishedAt! - e.producedAt) / 3_600_000) * 10) / 10
    );
    const byChannel: Record<string, number> = {};
    for (const e of recent) {
      const k = e.channelName ?? e.seriesId;
      byChannel[k] = (byChannel[k] ?? 0) + 1;
    }
    return {
      days,
      produced: recent.length,
      published: published.length,
      unpublishedCount: unpublished.length,
      unpublished: unpublished.slice(0, 10).map((e) => ({
        label: `${e.channelName ?? e.seriesId} ep ${e.episodeNumber}`,
        title: e.title ?? "",
        hoursWaiting: Math.round(((Date.now() - e.producedAt) / 3_600_000) * 10) / 10,
      })),
      avgPublishLagHours: lags.length
        ? Math.round((lags.reduce((a, b) => a + b, 0) / lags.length) * 10) / 10
        : null,
      byChannel,
    };
  },
});

export const moneySummary = internalQuery({
  args: { days: v.optional(v.number()) },
  handler: async (ctx, { days = 7 }) => {
    const cutoff = Date.now() - days * DAY;
    const rows = await ctx.db
      .query("entries")
      .withIndex("by_occurred", (q) => q.gte("occurredAt", cutoff))
      .collect();
    const businesses = await ctx.db.query("businesses").collect();
    const nameOf = (id?: any) =>
      businesses.find((b: any) => b._id === id)?.name ?? "General";
    const agg: Record<string, { income: number; expense: number }> = {};
    for (const e of rows) {
      const k = nameOf(e.businessId);
      const b = agg[k] ?? { income: 0, expense: 0 };
      if (e.kind === "income") b.income += e.amount ?? 0;
      if (e.kind === "expense") b.expense += e.amount ?? 0;
      agg[k] = b;
    }
    return {
      days,
      totalIncome: rows.filter((e) => e.kind === "income").reduce((s, e) => s + (e.amount ?? 0), 0),
      totalExpense: rows.filter((e) => e.kind === "expense").reduce((s, e) => s + (e.amount ?? 0), 0),
      byBusiness:
        Object.entries(agg).map(([k, v]) => `${k}: +${v.income} / -${v.expense}`) || [],
      recent: rows
        .sort((a, b) => b.occurredAt - a.occurredAt)
        .slice(0, 8)
        .map((e) => `${e.kind} ${nameOf(e.businessId)} ${e.amount ?? ""} ${e.text}`.trim()),
    };
  },
});

export const markPublished = internalMutation({
  args: { seriesId: v.string(), episodeNumber: v.number() },
  handler: async (ctx, { seriesId, episodeNumber }) => {
    const ep = await ctx.db
      .query("episodes")
      .withIndex("by_series_episode", (q) =>
        q.eq("seriesId", seriesId).eq("episodeNumber", episodeNumber)
      )
      .first();
    if (!ep) return { found: false };
    if (ep.publishedAt) return { found: true, alreadyPublished: true };
    await ctx.db.patch(ep._id, { publishedAt: Date.now() });
    return { found: true, published: true };
  },
});
