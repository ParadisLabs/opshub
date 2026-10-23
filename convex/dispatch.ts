/**
 * OpsHub -> studios. This is the half that was missing: the hub could receive
 * events from the studios but had no way to start one, and no schedule of its
 * own. Everything here goes through GitHub's repository_dispatch, which the
 * studios' workflows now accept as `opshub.produce`.
 *
 * Token: OPSHUB_GITHUB_TOKEN (fine-grained PAT, Contents: write on the studio
 * repos). Without it every dispatch records a clear failure instead of throwing.
 */
import { internalAction, internalMutation, internalQuery } from "./_generated/server";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import * as T from "./time";
import { readSettings } from "./settings";

const EVENT_TYPES = ["opshub.produce", "opshub.run"];
const WINDOW_MS = 15 * 60_000; // how late a schedule may fire and still count

export const STUDIOS = [
  {
    key: "turkce",
    repo: "landryparadis012-git/faceless-turkce-studio",
    label: "Faceless Türkçe",
    language: "tr",
    maxEpisodes: 8,
  },
  {
    key: "english",
    repo: "landryparadis012-git/faceless-studio",
    label: "Faceless English",
    language: "en",
    maxEpisodes: 8,
  },
  {
    key: "history",
    repo: "landryparadis012-git/deep-history-studio",
    label: "Deep History",
    language: "tr",
    maxEpisodes: 0,
  },
] as const;

function studioByKey(key?: string | null) {
  const k = (key ?? "").trim().toLowerCase();
  return STUDIOS.find((s) => s.key === k || s.repo.toLowerCase() === k) ?? null;
}

async function stateFor(ctx: any, repo: string) {
  const rows = await ctx.db.query("kv").collect();
  const doc = rows.find((r: any) => r.key === `studio:state:${repo}`);
  return doc?.value ?? null;
}

export const listStudios = internalQuery({
  handler: async (ctx) => {
    const { timezone } = await readSettings(ctx);
    const rows = await ctx.db.query("kv").collect();
    const schedules = await ctx.db.query("studioSchedules").collect();
    const dispatches = await ctx.db.query("dispatches").withIndex("by_at").order("desc").take(30);

    return STUDIOS.map((s) => {
      const stateDoc = rows.find((r: any) => r.key === `studio:state:${s.repo}`);
      const legacy = rows.find((r: any) => r.key === "studio:state");
      const state = stateDoc?.value ?? (legacy?.value?.channelName === s.repo ? legacy.value : null);
      const schedule = schedules.find((x) => x.studioKey === s.key) ?? null;
      const last = dispatches.find((d) => d.studioKey === s.key) ?? null;
      return {
        key: s.key,
        label: s.label,
        repo: s.repo,
        language: s.language,
        maxEpisodes: s.maxEpisodes || null,
        series: state?.title ?? state?.seriesId ?? null,
        seriesId: state?.seriesId ?? null,
        episodeNumber: state?.episodeNumber ?? 0,
        finished: state?.finished ?? false,
        stateAgeHours: state?.updatedAt
          ? Math.round(((Date.now() - state.updatedAt) / 3_600_000) * 10) / 10
          : null,
        schedule: schedule
          ? {
              localTime: schedule.localTime,
              days: schedule.days ?? [],
              enabled: schedule.enabled,
              timezone: schedule.tz ?? timezone,
              lastRunKey: schedule.lastRunKey ?? null,
            }
          : null,
        lastDispatch: last
          ? { kind: last.kind, ok: last.ok, at: T.fmtLocal(last.at, timezone), detail: last.detail ?? null }
          : null,
      };
    });
  },
});

export const enabledSchedules = internalQuery({
  handler: async (ctx) => ctx.db.query("studioSchedules").collect().then((rows) => rows.filter((r) => r.enabled)),
});

export const recentDispatches = internalQuery({
  args: { since: v.number() },
  handler: async (ctx, { since }) => {
    const { timezone } = await readSettings(ctx);
    const rows = await ctx.db.query("dispatches").withIndex("by_at").order("desc").take(50);
    return rows
      .filter((r) => r.at >= since)
      .map((r) => ({
        studioKey: r.studioKey,
        kind: r.kind,
        ok: r.ok,
        at: T.fmtLocal(r.at, timezone),
        topic: r.topic ?? null,
        detail: r.detail ?? null,
      }));
  },
});

export const record = internalMutation({
  args: {
    studioKey: v.string(),
    repo: v.string(),
    kind: v.string(),
    newSeries: v.boolean(),
    ok: v.boolean(),
    status: v.optional(v.number()),
    topic: v.optional(v.string()),
    detail: v.optional(v.string()),
  },
  handler: async (ctx, a) => {
    await ctx.db.insert("dispatches", {
      studioKey: a.studioKey,
      repo: a.repo,
      kind: a.kind,
      newSeries: a.newSeries,
      ok: a.ok,
      status: a.status,
      topic: a.topic,
      detail: a.detail,
      at: Date.now(),
    });
    return { ok: true };
  },
});

export const markScheduled = internalMutation({
  args: { id: v.id("studioSchedules"), runKey: v.string() },
  handler: async (ctx, { id, runKey }) => {
    await ctx.db.patch(id, { lastRunAt: Date.now(), lastRunKey: runKey });
    return { ok: true };
  },
});

export const setSchedule = internalMutation({
  args: {
    studioKey: v.string(),
    localTime: v.string(),
    days: v.optional(v.array(v.number())),
    enabled: v.optional(v.boolean()),
    topic: v.optional(v.string()),
    maxEpisodes: v.optional(v.number()),
    tz: v.optional(v.string()),
  },
  handler: async (ctx, a) => {
    const studio = studioByKey(a.studioKey);
    if (!studio) {
      return {
        ok: false,
        error: `Unknown studio "${a.studioKey}". Known: ${STUDIOS.map((s) => s.key).join(", ")}.`,
      };
    }
    const match = a.localTime.match(/^(\d{1,2}):(\d{2})$/);
    if (!match || Number(match[1]) > 23 || Number(match[2]) > 59) {
      return { ok: false, error: `localTime must look like "20:00" (got "${a.localTime}").` };
    }
    const localTime = `${String(Number(match[1])).padStart(2, "0")}:${match[2]}`;
    const { timezone } = await readSettings(ctx);
    const tz = T.tzOrDefault(a.tz ?? timezone);
    const days = a.days && a.days.length ? a.days.filter((d) => d >= 0 && d <= 6) : undefined;
    const existing = await ctx.db
      .query("studioSchedules")
      .withIndex("by_studio", (q) => q.eq("studioKey", studio.key))
      .first();
    const fields = {
      localTime,
      days,
      enabled: a.enabled ?? true,
      topic: a.topic,
      maxEpisodes: a.maxEpisodes,
      tz,
      lastRunKey: undefined,
    };
    if (existing) await ctx.db.patch(existing._id, fields);
    else await ctx.db.insert("studioSchedules", { studioKey: studio.key, ...fields });
    return {
      ok: true,
      studioKey: studio.key,
      localTime,
      timezone: tz,
      days: days ?? "every day",
      enabled: fields.enabled,
      nextRun: T.fmtLocal(
        T.nextClock(
          Number(localTime.split(":")[0]),
          Number(localTime.split(":")[1]),
          tz
        ),
        tz
      ),
    };
  },
});

export const clearSchedule = internalMutation({
  args: { studioKey: v.string() },
  handler: async (ctx, { studioKey }) => {
    const studio = studioByKey(studioKey);
    const key = studio?.key ?? studioKey.toLowerCase();
    const existing = await ctx.db
      .query("studioSchedules")
      .withIndex("by_studio", (q) => q.eq("studioKey", key))
      .first();
    if (!existing) return { ok: false, error: "no schedule for that studio" };
    await ctx.db.delete(existing._id);
    return { ok: true, cleared: key };
  },
});

export const dispatch = internalAction({
  args: {
    studioKey: v.string(),
    kind: v.optional(v.string()),
    topic: v.optional(v.string()),
    newSeries: v.optional(v.boolean()),
    maxEpisodes: v.optional(v.number()),
    reason: v.optional(v.string()),
  },
  handler: async (ctx, a) => {
    const studio = studioByKey(a.studioKey);
    if (!studio) return { ok: false, error: `Unknown studio "${a.studioKey}"` };
    const kind = a.kind ?? "run";
    const token = process.env.OPSHUB_GITHUB_TOKEN || process.env.GITHUB_DISPATCH_TOKEN;

    if (!token) {
      await ctx.runMutation(internal.dispatch.record, {
        studioKey: studio.key,
        repo: studio.repo,
        kind,
        newSeries: a.newSeries === true,
        ok: false,
        detail: "OPSHUB_GITHUB_TOKEN is not set",
        topic: a.topic,
      });
      return { ok: false, error: "OPSHUB_GITHUB_TOKEN is not set on the Convex deployment", studio: studio.key };
    }

    const payload = {
      topic: a.topic ?? "",
      new_series: a.newSeries === true,
      max_episodes: a.maxEpisodes ?? (studio.maxEpisodes || undefined),
      reason: a.reason ?? `opshub ${kind}`,
      source: "opshub",
    };

    try {
      const res = await fetch(`https://api.github.com/repos/${studio.repo}/dispatches`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github+json",
          "Content-Type": "application/json",
          "User-Agent": "opshub",
          "X-GitHub-Api-Version": "2022-11-28",
        },
        body: JSON.stringify({ event_type: EVENT_TYPES[0], client_payload: payload }),
      });
      const ok = res.status === 204 || res.ok;
      const detail = ok ? `${studio.label} queued (${kind})` : (await res.text()).slice(0, 200);
      await ctx.runMutation(internal.dispatch.record, {
        studioKey: studio.key,
        repo: studio.repo,
        kind,
        newSeries: payload.new_series,
        ok,
        status: res.status,
        topic: a.topic,
        detail,
      });
      return { ok, status: res.status, studio: studio.key, repo: studio.repo, detail };
    } catch (e: any) {
      const detail = String(e?.message ?? e).slice(0, 200);
      await ctx.runMutation(internal.dispatch.record, {
        studioKey: studio.key,
        repo: studio.repo,
        kind,
        newSeries: payload.new_series,
        ok: false,
        topic: a.topic,
        detail,
      });
      return { ok: false, error: detail, studio: studio.key };
    }
  },
});

/** Start (or continue) one studio right now. */
export const runStudio = internalAction({
  args: { studioKey: v.string(), topic: v.optional(v.string()), reason: v.optional(v.string()) },
  handler: async (ctx, a) =>
    ctx.runAction(internal.dispatch.dispatch, {
      studioKey: a.studioKey,
      kind: "run",
      topic: a.topic,
      newSeries: false,
      reason: a.reason ?? "opshub run",
    }),
});

/** Begin a brand-new arc: new seed, new character, episode 1. */
export const createSeries = internalAction({
  args: {
    studioKey: v.string(),
    topic: v.optional(v.string()),
    maxEpisodes: v.optional(v.number()),
  },
  handler: async (ctx, a) =>
    ctx.runAction(internal.dispatch.dispatch, {
      studioKey: a.studioKey,
      kind: "create_series",
      topic: a.topic,
      newSeries: true,
      maxEpisodes: a.maxEpisodes,
      reason: "opshub create series",
    }),
});

/** Same, for every studio at once. */
export const createSeriesEverywhere = internalAction({
  args: { topic: v.optional(v.string()) },
  handler: async (ctx, a) => {
    const results = [] as any[];
    for (const studio of STUDIOS) {
      results.push(
        await ctx.runAction(internal.dispatch.dispatch, {
          studioKey: studio.key,
          kind: "create_series",
          topic: a.topic,
          newSeries: true,
          reason: "opshub create series (all studios)",
        })
      );
    }
    return { results, ok: results.every((r) => r.ok) };
  },
});

/**
 * Cron entry point: fires a studio when its local schedule says so.
 * The window keeps it idempotent — a 5-minute cron and a 15-minute window
 * mean at most one dispatch per studio per day, even after a restart.
 */
export const runDueSchedules = internalAction({
  handler: async (ctx) => {
    const { timezone } = await readSettings(ctx);
    const now = Date.now();
    const schedules: any[] = await ctx.runQuery(internal.dispatch.enabledSchedules, {});
    const fired: string[] = [];

    for (const s of schedules) {
      if (s.enabled === false) continue; // defensive: the query already filters
      const tz = T.tzOrDefault(s.tz ?? timezone);
      const [hour, minute] = String(s.localTime).split(":").map((x) => Number(x) || 0);
      const p = T.parts(now, tz);
      const target = T.zonedToUtc(p.year, p.month, p.day, hour, minute, tz);
      const key = T.dayKey(now, tz);
      if (s.lastRunKey === key) continue;
      if (now < target || now - target > WINDOW_MS) continue;
      if (Array.isArray(s.days) && s.days.length && !s.days.includes(T.weekdayIndex(now, tz))) continue;

      await ctx.runMutation(internal.dispatch.markScheduled, { id: s._id, runKey: key });
      await ctx.runAction(internal.dispatch.dispatch, {
        studioKey: s.studioKey,
        kind: "schedule",
        topic: s.topic,
        newSeries: false,
        maxEpisodes: s.maxEpisodes,
        reason: `schedule ${s.localTime} ${tz}`,
      });
      fired.push(`${s.studioKey}@${s.localTime}`);
    }
    return { fired };
  },
});
