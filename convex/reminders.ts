/**
 * Reminder engine. Replaces the old one-minute cron that:
 *   - parsed dueAt as UTC while the operator lives in UTC+3,
 *   - sent the reminder and then marked it done even if Telegram failed,
 *   - advanced a daily reminder by exactly one day, so a late fire (or an
 *     overdue reminder) re-fired every single minute until it caught up.
 *
 * The new flow claims a reminder before sending (no double send when the cron
 * overlaps), only advances after a confirmed delivery, and always re-anchors a
 * repeating reminder to its local wall-clock time, never to "dueAt + 24h".
 */
import { internalAction, internalMutation, internalQuery } from "./_generated/server";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import * as T from "./time";
import { readSettings } from "./settings";

const MINUTE = 60_000;
const DAY = 86_400_000;

function normalizeRepeat(repeat?: string | null): string | undefined {
  const r = (repeat ?? "").trim().toLowerCase();
  if (!r || r === "once" || r === "no" || r === "none") return undefined;
  if (["daily", "weekdays", "weekly", "monthly", "every day"].includes(r)) {
    return r === "every day" ? "daily" : r;
  }
  return r; // unknown cadence: treated as one-shot
}

/** Next occurrence of `hour:minute` on an allowed weekday (weekly/weekdays). */
function nextWeekdayClock(
  hour: number,
  minute: number,
  tz: string,
  from: number,
  allowed: (dow: number) => boolean
): number {
  const start = T.zonedToUtc(
    T.parts(from, tz).year,
    T.parts(from, tz).month,
    T.parts(from, tz).day,
    hour,
    minute,
    tz
  );
  let candidate = start > from ? start : T.addLocalDays(start, 1, tz);
  for (let i = 0; i < 8; i++) {
    if (allowed(T.weekdayIndex(candidate, tz))) return candidate;
    candidate = T.addLocalDays(candidate, 1, tz);
  }
  return candidate;
}

export const addReminder = internalMutation({
  args: {
    text: v.string(),
    dueAt: v.string(),
    repeat: v.optional(v.string()),
    channel: v.optional(v.string()),
    sourceRef: v.optional(v.string()),
  },
  handler: async (ctx, a) => {
    const { timezone } = await readSettings(ctx);
    const now = Date.now();
    const parsed = T.parseLocal(a.dueAt, timezone, now);
    const assumed = parsed === null;
    const ts = parsed ?? now + 60 * MINUTE;
    const repeat = normalizeRepeat(a.repeat);
    const id = await ctx.db.insert("reminders", {
      text: a.text.trim() || "reminder",
      dueAt: ts,
      repeat,
      done: false,
      tz: timezone,
      localTime: T.clock(ts, timezone),
      firedCount: 0,
      channel: a.channel,
      sourceRef: a.sourceRef,
    });
    return {
      created: true,
      id,
      localTime: T.fmtLocal(ts, timezone),
      dueAt: ts,
      repeat: repeat ?? "once",
      timezone,
      assumedDefault: assumed,
    };
  },
});

export const listUpcoming = internalQuery({
  args: { horizonDays: v.optional(v.number()) },
  handler: async (ctx, { horizonDays = 7 }) => {
    const { timezone } = await readSettings(ctx);
    const now = Date.now();
    const rows = await ctx.db
      .query("reminders")
      .withIndex("by_due", (q) => q.lte("dueAt", now + horizonDays * DAY))
      .collect();
    return rows
      .filter((r) => !r.done)
      .sort((a, b) => a.dueAt - b.dueAt)
      .slice(0, 25)
      .map((r) => ({
        id: r._id,
        text: r.text,
        localTime: T.fmtLocal(r.dueAt, r.tz ?? timezone),
        overdue: r.dueAt <= now,
        repeat: r.repeat ?? "once",
        delta: T.humanDelta(r.dueAt - now),
      }));
  },
});

/** Reminders that are due and not yet fired for this occurrence. */
export const dueIds = internalQuery({
  handler: async (ctx) => {
    const now = Date.now();
    const rows = await ctx.db
      .query("reminders")
      .withIndex("by_due", (q) => q.lte("dueAt", now))
      .collect();
    return rows
      .filter((r) => !r.done)
      .filter((r) => !(r.lastFiredAt != null && r.lastFiredAt >= r.dueAt))
      .map((r) => r._id);
  },
});

/** Take ownership of one reminder so a slow send cannot be doubled. */
export const claim = internalMutation({
  args: { id: v.id("reminders"), now: v.number() },
  handler: async (ctx, { id, now }) => {
    const r = await ctx.db.get(id);
    if (!r || r.done) return null;
    if (r.lastFiredAt != null && r.lastFiredAt >= r.dueAt) return null;
    await ctx.db.patch(id, { lastFiredAt: now });
    return {
      id: r._id,
      text: r.text,
      repeat: r.repeat ?? null,
      dueAt: r.dueAt,
      localTime: r.localTime ?? null,
      tz: r.tz ?? null,
      firedCount: r.firedCount ?? 0,
    };
  },
});

/** Advance after delivery, or release the claim when the send failed. */
export const settle = internalMutation({
  args: { id: v.id("reminders"), delivered: v.boolean(), sentAt: v.number() },
  handler: async (ctx, { id, delivered, sentAt }) => {
    const r = await ctx.db.get(id);
    if (!r) return { ok: false };
    if (!delivered) {
      await ctx.db.patch(id, { lastFiredAt: undefined, done: false });
      return { ok: true, retry: true };
    }

    const { timezone } = await readSettings(ctx);
    const tz = r.tz ?? timezone;
    const localTime = r.localTime ?? T.clock(r.dueAt, tz);
    const [hour, minute] = localTime.split(":").map((x) => Number(x) || 0);
    const repeat = normalizeRepeat(r.repeat);
    const firedCount = (r.firedCount ?? 0) + 1;

    if (!repeat) {
      await ctx.db.patch(id, { done: true, lastFiredAt: sentAt, firedCount });
      return { ok: true, done: true, nextLocal: null };
    }

    let next: number;
    if (repeat === "daily") {
      next = T.nextClock(hour, minute, tz, sentAt);
    } else if (repeat === "weekdays") {
      next = nextWeekdayClock(hour, minute, tz, sentAt, (dow) => dow >= 1 && dow <= 5);
    } else if (repeat === "weekly") {
      const anchorDow = T.weekdayIndex(r.dueAt, tz);
      next = nextWeekdayClock(hour, minute, tz, sentAt, (dow) => dow === anchorDow);
    } else if (repeat === "monthly") {
      const p = T.parts(r.dueAt, tz);
      next = T.zonedToUtc(p.year, p.month + 1, p.day, hour, minute, tz);
      if (next <= sentAt) next = T.zonedToUtc(p.year + 1, p.month + 1, p.day, hour, minute, tz);
    } else {
      await ctx.db.patch(id, { done: true, lastFiredAt: sentAt, firedCount });
      return { ok: true, done: true, nextLocal: null };
    }

    await ctx.db.patch(id, {
      dueAt: next,
      lastFiredAt: sentAt,
      firedCount,
      done: false,
    });
    return { ok: true, done: false, nextLocal: T.fmtLocal(next, tz) };
  },
});

export const snooze = internalMutation({
  args: { minutes: v.number(), id: v.optional(v.id("reminders")) },
  handler: async (ctx, { minutes, id }) => {
    const now = Date.now();
    let target = id ? await ctx.db.get(id) : null;
    if (!target) {
      // no id: snooze the next thing that is due within the next day
      const rows = await ctx.db
        .query("reminders")
        .withIndex("by_due", (q) => q.lte("dueAt", now + DAY))
        .collect();
      target = rows.filter((r) => !r.done).sort((a, b) => a.dueAt - b.dueAt)[0] ?? null;
    }
    if (!target) return { ok: false, error: "nothing to snooze" };
    const dueAt = now + Math.max(1, minutes) * MINUTE;
    const { timezone } = await readSettings(ctx);
    await ctx.db.patch(target._id, {
      dueAt,
      lastFiredAt: undefined,
      done: false,
      localTime: T.clock(dueAt, target.tz ?? timezone),
    });
    return { ok: true, text: target.text, localTime: T.fmtLocal(dueAt, target.tz ?? timezone) };
  },
});

/** Missed or still-open reminders, for the morning brief. */
export const openForRange = internalQuery({
  args: { start: v.number(), end: v.number() },
  handler: async (ctx, { start, end }) => {
    const { timezone } = await readSettings(ctx);
    const rows = await ctx.db.query("reminders").collect();
    const today = rows
      .filter((r) => !r.done && r.dueAt >= start && r.dueAt < end)
      .sort((a, b) => a.dueAt - b.dueAt);
    const overdue = rows.filter((r) => !r.done && r.dueAt < start);
    return {
      today: today.map((r) => ({
        text: r.text,
        at: T.clock(r.dueAt, r.tz ?? timezone),
        repeat: r.repeat ?? "once",
      })),
      overdue: overdue.map((r) => ({
        text: r.text,
        at: T.fmtLocal(r.dueAt, r.tz ?? timezone),
        delta: T.humanDelta(r.dueAt - Date.now()),
      })),
    };
  },
});

function message(claimed: { text: string; repeat: string | null; localTime: string | null; dueAt: number; tz: string | null }, timezone: string): string {
  const when = T.fmtLocal(claimed.dueAt, claimed.tz ?? timezone);
  const tail = claimed.repeat ? ` · repeats ${claimed.repeat}` : "";
  return `⏰ ${claimed.text}\n${when}${tail}\n\nReply "snooze 30" to push it back.`;
}

async function sendTelegram(token: string, chatId: number, text: string): Promise<boolean> {
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

export const fireDue = internalAction({
  handler: async (ctx) => {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    const allowed = process.env.ALLOWED_TELEGRAM_ID;
    if (!token || !allowed) return { fired: 0, failed: 0 };

    const settings = await ctx.runQuery(internal.settings.get, {});
    const ids: any[] = await ctx.runQuery(internal.reminders.dueIds, {});
    let fired = 0;
    let failed = 0;

    for (const id of ids) {
      const claimed = await ctx.runMutation(internal.reminders.claim, {
        id,
        now: Date.now(),
      });
      if (!claimed) continue;
      const ok = await sendTelegram(token, Number(allowed), message(claimed, settings.timezone));
      await ctx.runMutation(internal.reminders.settle, {
        id,
        delivered: ok,
        sentAt: Date.now(),
      });
      ok ? fired++ : failed++;
    }
    return { fired, failed };
  },
});
