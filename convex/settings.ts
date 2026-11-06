/**
 * Operator settings that used to be hardcoded: timezone and the two report
 * hours. Everything falls back to sane defaults, so the hub works with no
 * configuration at all — it starts in the configured default timezone (Europe/Nicosia).
 */
import { internalMutation, internalQuery } from "./_generated/server";
import { v } from "convex/values";
import * as T from "./time";

export type OpsSettings = {
  timezone: string;
  morningHour: number;
  eveningHour: number;
};

function env(key: string): string | undefined {
  try {
    return process.env[key];
  } catch {
    return undefined;
  }
}

function clampHour(value: unknown, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 && n <= 23 ? Math.floor(n) : fallback;
}

/** Plain helper: usable from queries, mutations and actions alike. */
export async function readSettings(ctx: any): Promise<OpsSettings> {
  const rows = await ctx.db.query("kv").collect();
  const get = (key: string) => rows.find((r: any) => r.key === key)?.value;
  return {
    timezone: T.tzOrDefault(get("ops:timezone") ?? env("OPS_TIMEZONE")),
    morningHour: clampHour(get("ops:morningHour") ?? env("OPS_MORNING_HOUR"), T.DEFAULT_MORNING_HOUR),
    eveningHour: clampHour(get("ops:eveningHour") ?? env("OPS_EVENING_HOUR"), T.DEFAULT_EVENING_HOUR),
  };
}

export async function kvGet(ctx: any, key: string) {
  const all = await ctx.db.query("kv").collect();
  return all.find((k: any) => k.key === key);
}

export async function kvSet(ctx: any, key: string, value: any) {
  const doc = await kvGet(ctx, key);
  if (doc) await ctx.db.patch(doc._id, { value });
  else await ctx.db.insert("kv", { key, value });
}

export const get = internalQuery({
  handler: async (ctx) => {
    const settings = await readSettings(ctx);
    const now = Date.now();
    return { ...settings, now, nowLocal: T.nowLine(now, settings.timezone) };
  },
});

export const setTimezone = internalMutation({
  args: { timezone: v.string() },
  handler: async (ctx, { timezone }) => {
    if (!T.isValidTz(timezone)) {
      return { ok: false, error: `Unknown timezone "${timezone}". Use an IANA name like Europe/Nicosia.` };
    }
    await kvSet(ctx, "ops:timezone", timezone);
    const now = Date.now();
    return { ok: true, timezone, nowLocal: T.nowLine(now, timezone) };
  },
});

export const setReportHours = internalMutation({
  args: { morningHour: v.optional(v.number()), eveningHour: v.optional(v.number()) },
  handler: async (ctx, { morningHour, eveningHour }) => {
    if (morningHour != null) {
      if (morningHour < 0 || morningHour > 23) return { ok: false, error: "morningHour must be 0-23" };
      await kvSet(ctx, "ops:morningHour", Math.floor(morningHour));
    }
    if (eveningHour != null) {
      if (eveningHour < 0 || eveningHour > 23) return { ok: false, error: "eveningHour must be 0-23" };
      await kvSet(ctx, "ops:eveningHour", Math.floor(eveningHour));
    }
    const settings = await readSettings(ctx);
    return { ok: true, ...settings };
  },
});
