/**
 * Two daily messages, both gated by the operator's local clock instead of a
 * fixed UTC hour:
 *   - morning brief: what is due today, what is ready to post, what to do first
 *   - evening report: what actually happened today, and what tomorrow looks like
 *
 * `tick` is cheap and runs often; it decides whether either message is due, so
 * a missed window is picked up within the catch-up hours instead of silently
 * disappearing. Delivery is deduped per local day in kv.
 */
import { internalAction, internalMutation, internalQuery } from "./_generated/server";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import * as T from "./time";
import { readSettings } from "./settings";

type Mode = "morning" | "evening";

const DAY = 86_400_000;

async function wasSent(ctx: any, kind: Mode, key: string) {
  const rows = await ctx.db.query("kv").collect();
  return rows.some((r: any) => r.key === `report:${kind}:${key}`);
}

export const sentAlready = internalQuery({
  args: { kind: v.union(v.literal("morning"), v.literal("evening")), key: v.string() },
  handler: async (ctx, { kind, key }) => wasSent(ctx, kind, key),
});

export const markSent = internalMutation({
  args: { kind: v.union(v.literal("morning"), v.literal("evening")), key: v.string() },
  handler: async (ctx, { kind, key }) => {
    await ctx.db.insert("kv", { key: `report:${kind}:${key}`, value: { sentAt: Date.now() } });
    return { ok: true };
  },
});

export const snapshot = internalQuery({
  args: { mode: v.union(v.literal("morning"), v.literal("evening")) },
  handler: async (ctx, { mode }) => {
    const settings = await readSettings(ctx);
    const tz = settings.timezone;
    const now = Date.now();
    const today = T.dayRange(now, tz);
    const yesterday = T.dayRange(today.start - 1, tz);

    const inRange = async (from: number, to: number) => {
      const rows = await ctx.db
        .query("entries")
        .withIndex("by_occurred", (q) => q.gte("occurredAt", from).lt("occurredAt", to))
        .collect();
      return {
        income: rows.filter((e) => e.kind === "income").reduce((s, e) => s + (e.amount ?? 0), 0),
        expense: rows.filter((e) => e.kind === "expense").reduce((s, e) => s + (e.amount ?? 0), 0),
        count: rows.filter((e) => e.kind === "income" || e.kind === "expense").length,
      };
    };

    const trades = await ctx.db.query("trades").collect();
    const closed = (from: number, to: number) =>
      trades.filter((t) => t.status === "closed" && (t.closedAt ?? 0) >= from && (t.closedAt ?? 0) < to);
    const closedToday = closed(today.start, today.end);
    const closedYesterday = closed(yesterday.start, yesterday.end);
    const openTrades = trades.filter((t) => t.status === "open");

    const episodes = await ctx.db.query("episodes").collect();
    const producedToday = episodes.filter((e) => e.producedAt >= today.start && e.producedAt < today.end);
    const publishedToday = episodes.filter(
      (e) => (e.publishedAt ?? 0) >= today.start && (e.publishedAt ?? 0) < today.end
    );
    const waiting = episodes
      .filter((e) => e.publishedAt == null)
      .sort((a, b) => a.producedAt - b.producedAt);

    const reminders = await ctx.runQuery(internal.reminders.openForRange, {
      start: today.start,
      end: today.end,
    });
    const studios = await ctx.runQuery(internal.dispatch.listStudios, {});
    const dispatches = await ctx.runQuery(internal.dispatch.recentDispatches, { since: today.start });

    // a small honesty metric: consecutive local days with at least one post
    const postDays = new Set(
      episodes
        .filter((e) => e.publishedAt != null)
        .map((e) => T.dayKey(e.publishedAt as number, tz))
    );
    let streak = 0;
    for (let i = 0; i < 60; i++) {
      const key = T.dayKey(now - i * DAY, tz);
      if (postDays.has(key)) streak++;
      else if (i > 0) break;
    }

    return {
      mode,
      now,
      nowLocal: T.nowLine(now, tz),
      timezone: tz,
      todayLabel: T.fmtLocal(now, tz),
      morningHour: settings.morningHour,
      eveningHour: settings.eveningHour,
      moneyToday: await inRange(today.start, today.end),
      moneyYesterday: await inRange(yesterday.start, yesterday.end),
      closedToday: closedToday.map((t) => ({
        symbol: t.symbol,
        r: t.realizedR ?? 0,
        tier: t.tier ?? null,
      })),
      closedYesterday: closedYesterday.map((t) => ({ symbol: t.symbol, r: t.realizedR ?? 0 })),
      openTrades: openTrades.map((t) => ({
        symbol: t.symbol,
        side: t.side ?? "",
        ageHours: t.openedAt ? Math.round((now - t.openedAt) / 3_600_000) : null,
      })),
      producedToday: producedToday.map((e) => ({
        series: e.seriesId,
        episode: e.episodeNumber,
        title: e.title ?? null,
        at: T.clock(e.producedAt, tz),
      })),
      publishedToday: publishedToday.map((e) => ({
        series: e.seriesId,
        episode: e.episodeNumber,
        at: T.clock(e.publishedAt as number, tz),
      })),
      waiting: waiting.slice(0, 8).map((e) => ({
        series: e.seriesId,
        episode: e.episodeNumber,
        title: e.title ?? null,
        hours: Math.round(((now - e.producedAt) / 3_600_000) * 10) / 10,
      })),
      waitingCount: waiting.length,
      reminders,
      studios,
      dispatches,
      postStreak: streak,
    };
  },
});

function r(n: number): string {
  return `${n >= 0 ? "+" : ""}${Math.round(n * 100) / 100}R`;
}

function studioLines(studios: any[]): string[] {
  if (!studios.length) return [];
  return studios.map((s) => {
    if (!s.series) return `• ${s.label}: no series yet — create one with "new series on ${s.key}"`;
    const pos = s.maxEpisodes ? `${s.episodeNumber}/${s.maxEpisodes}` : `${s.episodeNumber}`;
    const stale = s.stateAgeHours != null && s.stateAgeHours > 48 ? ` (silent ${Math.round(s.stateAgeHours / 24)}d)` : "";
    return `• ${s.label}: "${s.series}" ep ${pos}${s.finished ? " — arc finished" : ""}${stale}`;
  });
}

function renderMorning(d: any): string {
  const lines: string[] = [];
  lines.push(`☀️ MORNING — ${d.todayLabel}`);
  const st = studioLines(d.studios);
  if (st.length) lines.push("", "🎬 Studios", ...st);

  if (d.reminders.today.length) {
    lines.push("", "⏰ Today's reminders");
    for (const x of d.reminders.today) lines.push(`• ${x.at} — ${x.text}${x.repeat !== "once" ? ` (${x.repeat})` : ""}`);
  } else {
    lines.push("", "⏰ No reminders scheduled today.");
  }
  if (d.reminders.overdue.length) {
    lines.push("", "⚠️ Overdue");
    for (const x of d.reminders.overdue.slice(0, 5)) lines.push(`• ${x.text} — due ${x.at} (${x.delta})`);
  }

  if (d.waitingCount) {
    lines.push("", "📺 Ready but not posted");
    for (const w of d.waiting.slice(0, 5)) {
      lines.push(`• ${w.series} ep ${w.episode}${w.title ? ` "${w.title}"` : ""} — waiting ${w.hours}h`);
    }
  }

  const netToday = d.moneyYesterday.income - d.moneyYesterday.expense;
  lines.push(
    "",
    "💰 Yesterday",
    `• in ${d.moneyYesterday.income} · out ${d.moneyYesterday.expense} · net ${netToday >= 0 ? "+" : ""}${netToday} (${d.moneyYesterday.count} entries)`
  );

  const rY = d.closedYesterday.reduce((s: number, t: any) => s + t.r, 0);
  lines.push(
    "",
    "📈 Trading",
    `• open now: ${d.openTrades.length}${d.openTrades.length ? ` (${d.openTrades.map((t: any) => t.symbol).join(", ")})` : ""}` +
      ` · closed yesterday: ${d.closedYesterday.length}${d.closedYesterday.length ? `, ${r(rY)}` : ""}`
  );

  const scheduled = d.studios.filter((s: any) => s.schedule?.enabled);
  if (scheduled.length) {
    lines.push("", "🕒 Scheduled today");
    for (const s of scheduled) lines.push(`• ${s.label} at ${s.schedule.localTime} (${s.schedule.timezone})`);
  }

  const todo: string[] = [];
  if (d.reminders.overdue.length) todo.push(`Clear the overdue reminder: ${d.reminders.overdue[0].text}`);
  if (d.waitingCount) todo.push(`Post ${d.waiting[0].series} ep ${d.waiting[0].episode} (waiting ${d.waiting[0].hours}h)`);
  if (d.reminders.today.length) todo.push(`First reminder at ${d.reminders.today[0].at}: ${d.reminders.today[0].text}`);
  for (const s of d.studios) {
    if (!s.series) todo.push(`${s.label} has no series — say "new series on ${s.key}"`);
    else if (s.finished) todo.push(`${s.label} finished its arc — say "new series on ${s.key}" to start the next one`);
    else if (s.stateAgeHours != null && s.stateAgeHours > 48) todo.push(`${s.label} has been silent for ${Math.round(s.stateAgeHours / 24)}d — run it`);
  }
  if (!todo.length) todo.push("Nothing is on fire. Pick the biggest lever and work on it for one hour.");
  lines.push("", "✅ Do first", ...todo.slice(0, 4).map((t, i) => `${i + 1}. ${t}`));

  return lines.join("\n").slice(0, 4000);
}

function renderEvening(d: any): string {
  const lines: string[] = [];
  const net = d.moneyToday.income - d.moneyToday.expense;
  const rDay = d.closedToday.reduce((s: number, t: any) => s + t.r, 0);

  lines.push(`🌙 DAY REPORT — ${d.todayLabel}`);
  lines.push(
    "",
    "📺 Content",
    `• produced ${d.producedToday.length} · posted ${d.publishedToday.length} · waiting ${d.waitingCount}` +
      (d.postStreak > 0 ? ` · posting streak ${d.postStreak}d` : "")
  );
  for (const e of d.producedToday.slice(0, 5)) {
    lines.push(`• ${e.series} ep ${e.episode}${e.title ? ` "${e.title}"` : ""} produced ${e.at}`);
  }
  for (const e of d.publishedToday.slice(0, 5)) lines.push(`• posted ${e.series} ep ${e.episode} at ${e.at}`);
  if (d.waitingCount) {
    lines.push(`• oldest waiting: ${d.waiting[0].series} ep ${d.waiting[0].episode} (${d.waiting[0].hours}h)`);
  }

  lines.push(
    "",
    "💰 Money",
    `• in ${d.moneyToday.income} · out ${d.moneyToday.expense} · net ${net >= 0 ? "+" : ""}${net} (${d.moneyToday.count} entries)`
  );

  lines.push(
    "",
    "📈 Trading",
    `• closed today: ${d.closedToday.length}${d.closedToday.length ? `, ${r(rDay)}` : ""}` +
      ` · still open: ${d.openTrades.length}`
  );

  lines.push(
    "",
    "⏰ Reminders",
    `• due today: ${d.reminders.today.length} · overdue: ${d.reminders.overdue.length}` +
      (d.reminders.overdue.length ? ` · oldest: ${d.reminders.overdue[0].text}` : "")
  );

  if (d.dispatches.length) {
    lines.push("", "🎬 Studio runs today");
    for (const x of d.dispatches.slice(0, 5)) {
      lines.push(`• ${x.studioKey} ${x.kind} ${x.ok ? "ok" : "FAILED"}${x.detail ? ` — ${x.detail}` : ""}`);
    }
  }

  const scheduled = d.studios.filter((s: any) => s.schedule?.enabled);
  if (scheduled.length) {
    lines.push("", "🌅 Tomorrow's runs");
    for (const s of scheduled) lines.push(`• ${s.label} at ${s.schedule.localTime}`);
  }

  const tomorrow: string[] = [];
  if (d.waitingCount) tomorrow.push(`Post ${d.waiting[0].series} ep ${d.waiting[0].episode} first thing`);
  for (const s of d.studios) {
    if (s.finished) tomorrow.push(`${s.label} needs a new series — say "new series on ${s.key}"`);
  }
  if (d.reminders.overdue.length) tomorrow.push(`Deal with: ${d.reminders.overdue[0].text}`);
  if (!tomorrow.length) tomorrow.push("Nothing queued — pick tomorrow's one priority before you sleep.");
  lines.push("", "📌 First thing tomorrow", ...tomorrow.slice(0, 3).map((t, i) => `${i + 1}. ${t}`));

  return lines.join("\n").slice(0, 4000);
}

async function deliver(text: string): Promise<boolean> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const allowed = process.env.ALLOWED_TELEGRAM_ID;
  if (!token || !allowed) return false;
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: Number(allowed), text, disable_web_page_preview: true }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

export const sendMorning = internalAction({
  handler: async (ctx) => {
    const data = await ctx.runQuery(internal.report.snapshot, { mode: "morning" });
    const text = renderMorning(data as any);
    const ok = await deliver(text);
    const key = T.dayKey(Date.now(), (data as any).timezone);
    if (ok) await ctx.runMutation(internal.report.markSent, { kind: "morning", key });
    return { sent: ok, key };
  },
});

export const sendEvening = internalAction({
  handler: async (ctx) => {
    const data = await ctx.runQuery(internal.report.snapshot, { mode: "evening" });
    const text = renderEvening(data as any);
    const ok = await deliver(text);
    const key = T.dayKey(Date.now(), (data as any).timezone);
    if (ok) await ctx.runMutation(internal.report.markSent, { kind: "evening", key });
    return { sent: ok, key };
  },
});

/**
 * Runs every 30 minutes. Sends the morning brief when the local hour reaches
 * the configured morning hour, and the evening report at the evening hour.
 * A two-hour catch-up window means a deployment that was asleep at 07:00
 * still delivers the brief at 08:30 instead of losing it for the day.
 */
export const tick = internalAction({
  handler: async (ctx) => {
    const settings: any = await ctx.runQuery(internal.settings.get, {});
    const now = Date.now();
    const hour = T.localHour(now, settings.timezone);
    const key = T.dayKey(now, settings.timezone);
    const actions: string[] = [];

    const morningDue =
      hour >= settings.morningHour && hour <= settings.morningHour + 2;
    const eveningDue =
      hour >= settings.eveningHour && hour <= settings.eveningHour + 2;

    if (morningDue) {
      const already = await ctx.runQuery(internal.report.sentAlready, { kind: "morning", key });
      if (!already) {
        const res = await ctx.runAction(internal.report.sendMorning, {});
        if (res.sent) actions.push("morning");
      }
    }
    if (eveningDue) {
      const already = await ctx.runQuery(internal.report.sentAlready, { kind: "evening", key });
      if (!already) {
        const res = await ctx.runAction(internal.report.sendEvening, {});
        if (res.sent) actions.push("evening");
      }
    }
    return { localHour: hour, timezone: settings.timezone, sent: actions };
  },
});

/**
 * Pings the OpsHub worker every few minutes so reminder sweeps, pre-news
 * alerts and the morning/evening report windows keep firing. The GitHub
 * sweep workflow could not be created (repo token lacks the workflow
 * scope), so Convex crons are the scheduler; the worker owns the data.
 * The URL is the public worker endpoint, not a secret.
 */
const OPS_HUB_URL = "https://site-383ef7b599e542209e6a7c00f9ab7638.freebuff.page";

export const sweepPing = internalAction({
  handler: async () => {
    const out: Record<string, number> = {};
    for (const path of ["/sweep", "/report-tick"]) {
      try {
        const r = await fetch(OPS_HUB_URL + path, { method: "POST" });
        out[path] = r.status;
      } catch (e) {
        out[path] = 0;
      }
    }
    return out;
  },
});
