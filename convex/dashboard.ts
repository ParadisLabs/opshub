import { internalQuery } from "./_generated/server";

const DAY = 86_400_000;

export const snapshot = internalQuery({
  handler: async (ctx) => {
    const now = Date.now();
    const since = now - 30 * DAY;
    const [trades, deals, episodes, dispatches, events, schedules, reminders, entries] =
      await Promise.all([
        ctx.db.query("trades").collect(),
        ctx.db.query("flipDeals").collect(),
        ctx.db.query("episodes").collect(),
        ctx.db.query("dispatches").collect(),
        ctx.db.query("events").collect(),
        ctx.db.query("studioSchedules").collect(),
        ctx.db.query("reminders").collect(),
        ctx.db.query("entries").collect(),
      ]);
    const closed = trades.filter((t) => t.status === "closed" && (t.closedAt ?? 0) >= since);
    const wins = closed.filter((t) => (t.realizedR ?? 0) > 0).length;
    const recentTrades = [...trades].sort((a, b) =>
      (b.openedAt ?? b.closedAt ?? 0) - (a.openedAt ?? a.closedAt ?? 0)
    ).slice(0, 10).map((t) => ({
      symbol: t.symbol, side: t.side ?? null, status: t.status,
      tier: t.tier ?? null, realizedR: t.realizedR ?? null,
      openedAt: t.openedAt ?? null, closedAt: t.closedAt ?? null,
    }));
    const recentDeals = [...deals].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 10);
    const recentEpisodes = [...episodes].sort((a, b) => b.producedAt - a.producedAt).slice(0, 10);
    const recentDispatches = [...dispatches].sort((a, b) => b.at - a.at).slice(0, 15);
    const recentEvents = [...events].sort((a, b) => b.receivedAt - a.receivedAt).slice(0, 15);
    const nowEntries = entries.filter((e) => e.occurredAt >= since);
    const openReminders = reminders.filter((r) => !r.done).sort((a, b) => a.dueAt - b.dueAt).slice(0, 20);
    return {
      generatedAt: now,
      trading: {
        open: trades.filter((t) => t.status === "open").length,
        closed30d: closed.length,
        winRatePct: closed.length ? Math.round(wins / closed.length * 100) : null,
        netR30d: Math.round(closed.reduce((s, t) => s + (t.realizedR ?? 0), 0) * 100) / 100,
        recent: recentTrades,
      },
      flip: {
        activeWatches: (await ctx.db.query("flipWatches").collect()).filter((w) => w.active).length,
        activeDeals: deals.filter((d) => !["won", "lost"].includes(d.status)).length,
        found30d: deals.filter((d) => d.foundAt >= since).length,
        won30d: deals.filter((d) => d.status === "won" && d.updatedAt >= since).length,
        lost30d: deals.filter((d) => d.status === "lost" && d.updatedAt >= since).length,
        recent: recentDeals.map((d) => ({
          title: d.title ?? d.dealId, status: d.status, asking: d.asking ?? null,
          estSpread: d.estSpread ?? null, city: d.city ?? null, url: d.url ?? null,
          updatedAt: d.updatedAt,
        })),
      },
      studios: {
        schedules: schedules.map((s) => ({
          studioKey: s.studioKey, enabled: s.enabled, localTime: s.localTime,
          timezone: s.tz ?? null, topic: s.topic ?? null, lastRunAt: s.lastRunAt ?? null,
        })),
        produced30d: episodes.filter((e) => e.producedAt >= since).length,
        published30d: episodes.filter((e) => (e.publishedAt ?? 0) >= since).length,
        recent: recentEpisodes.map((e) => ({
          seriesId: e.seriesId, title: e.title ?? null, episodeNumber: e.episodeNumber,
          producedAt: e.producedAt, publishedAt: e.publishedAt ?? null,
        })),
      },
      operations: {
        dispatches24h: recentDispatches.filter((d) => d.at >= now - DAY).length,
        dispatchFailures24h: recentDispatches.filter((d) => d.at >= now - DAY && !d.ok).length,
        events24h: recentEvents.filter((e) => e.receivedAt >= now - DAY).length,
        recentDispatches: recentDispatches.map((d) => ({
          studioKey: d.studioKey, repo: d.repo, kind: d.kind, ok: d.ok,
          status: d.status ?? null, detail: d.detail ?? null, at: d.at,
        })),
        recentEvents: recentEvents.map((e) => ({
          source: e.source, type: e.type, receivedAt: e.receivedAt,
        })),
      },
      reminders: openReminders.map((r) => ({
        text: r.text, dueAt: r.dueAt, repeat: r.repeat ?? "once",
      })),
      activity: {
        entries30d: nowEntries.length,
        income30d: nowEntries.filter((e) => e.kind === "income").reduce((s, e) => s + (e.amount ?? 0), 0),
        expense30d: nowEntries.filter((e) => e.kind === "expense").reduce((s, e) => s + (e.amount ?? 0), 0),
      },
    };
  },
});
