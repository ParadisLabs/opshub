/**
 * Timezone math for OpsHub. No dependencies: Intl ships with the Convex V8
 * runtime, so every "local time" rule lives here instead of being scattered
 * around as hardcoded UTC offsets.
 *
 * App-wide rule: store UTC milliseconds, speak local time.
 */

export const DEFAULT_TZ = "Europe/Nicosia";
export const DEFAULT_MORNING_HOUR = 7; // local
export const DEFAULT_EVENING_HOUR = 21; // local

export type Parts = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  weekday: string;
};

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

const cache = new Map<string, Intl.DateTimeFormat>();

function formatter(tz: string): Intl.DateTimeFormat {
  let f = cache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hour12: false,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      weekday: "short",
    });
    cache.set(tz, f);
  }
  return f;
}

export function isValidTz(tz: string): boolean {
  try {
    formatter(tz).format(new Date());
    return true;
  } catch {
    return false;
  }
}

export function tzOrDefault(tz?: string | null): string {
  const candidate = (tz ?? "").trim();
  return candidate && isValidTz(candidate) ? candidate : DEFAULT_TZ;
}

/** Wall clock in `tz` for a UTC instant. */
export function parts(ts: number, tz: string = DEFAULT_TZ): Parts {
  const raw: Record<string, string> = {};
  for (const p of formatter(tz).formatToParts(new Date(ts))) {
    if (p.type !== "literal") raw[p.type] = p.value;
  }
  return {
    year: Number(raw.year),
    month: Number(raw.month),
    day: Number(raw.day),
    // some engines render midnight as "24"
    hour: Number(raw.hour) % 24,
    minute: Number(raw.minute),
    second: Number(raw.second),
    weekday: raw.weekday ?? WEEKDAYS[new Date(ts).getUTCDay()],
  };
}

/** Offset of `tz` at instant `ts`, in ms (positive east of Greenwich). */
export function offsetMs(ts: number, tz: string = DEFAULT_TZ): number {
  const p = parts(ts, tz);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(ts / 1000) * 1000;
}

/**
 * Turn a wall-clock reading in `tz` into a UTC instant.
 * Two passes: the first guess can land on the wrong side of a DST switch,
 * the second corrects it.
 */
export function zonedToUtc(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  tz: string = DEFAULT_TZ
): number {
  const naive = Date.UTC(year, month - 1, day, hour, minute, 0);
  let ts = naive - offsetMs(naive, tz);
  ts = naive - offsetMs(ts, tz);
  return ts;
}

const HAS_ZONE = /(Z|[+-]\d{2}:?\d{2})$/i;

/**
 * Parse whatever the model/user produced into a UTC instant.
 * - with an explicit zone ("...Z", "+03:00") it is taken literally
 * - "YYYY-MM-DDTHH:MM" / "YYYY-MM-DD HH:MM" are read as LOCAL wall clock
 * - "20:00" alone means the next time that clock reads 20:00 locally
 * - "YYYY-MM-DD" alone means 09:00 local that day
 * Returns null when nothing sensible can be parsed.
 */
export function parseLocal(
  input: string,
  tz: string = DEFAULT_TZ,
  now: number = Date.now()
): number | null {
  const s = String(input ?? "").trim();
  if (!s) return null;

  if (HAS_ZONE.test(s)) {
    const t = Date.parse(s);
    return Number.isFinite(t) ? t : null;
  }

  const clock = s.match(/^(\d{1,2})[:.](\d{2})$/);
  if (clock) {
    const h = Number(clock[1]);
    const m = Number(clock[2]);
    if (h > 23 || m > 59) return null;
    return nextClock(h, m, tz, now);
  }

  const dt = s.match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{1,2}):(\d{2})/);
  if (dt) {
    return zonedToUtc(+dt[1], +dt[2], +dt[3], +dt[4], +dt[5], tz);
  }

  const d = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (d) return zonedToUtc(+d[1], +d[2], +d[3], 9, 0, tz);

  const t = Date.parse(s);
  return Number.isFinite(t) ? t : null;
}

/** Next instant at which the local clock reads hour:minute (strictly future). */
export function nextClock(
  hour: number,
  minute: number,
  tz: string = DEFAULT_TZ,
  now: number = Date.now()
): number {
  const p = parts(now, tz);
  let ts = zonedToUtc(p.year, p.month, p.day, hour, minute, tz);
  if (ts <= now) ts = zonedToUtc(p.year, p.month, p.day + 1, hour, minute, tz);
  return ts;
}

/** Same local wall-clock time, `days` later. */
export function addLocalDays(ts: number, days: number, tz: string = DEFAULT_TZ): number {
  const p = parts(ts, tz);
  return zonedToUtc(p.year, p.month, p.day + days, p.hour, p.minute, tz);
}

export function startOfLocalDay(ts: number, tz: string = DEFAULT_TZ): number {
  const p = parts(ts, tz);
  return zonedToUtc(p.year, p.month, p.day, 0, 0, tz);
}

export function dayRange(ts: number, tz: string = DEFAULT_TZ): { start: number; end: number } {
  const start = startOfLocalDay(ts, tz);
  return { start, end: addLocalDays(start, 1, tz) };
}

/** 0 = Sunday … 6 = Saturday, in local time. */
export function weekdayIndex(ts: number = Date.now(), tz: string = DEFAULT_TZ): number {
  return WEEKDAYS.indexOf(parts(ts, tz).weekday);
}

/** "2026-10-18" in local time — the key used to dedupe daily reports. */
export function dayKey(ts: number = Date.now(), tz: string = DEFAULT_TZ): string {
  const p = parts(ts, tz);
  const mm = String(p.month).padStart(2, "0");
  const dd = String(p.day).padStart(2, "0");
  return `${p.year}-${mm}-${dd}`;
}

/** "20:05" in local time. */
export function clock(ts: number, tz: string = DEFAULT_TZ): string {
  const p = parts(ts, tz);
  return `${String(p.hour).padStart(2, "0")}:${String(p.minute).padStart(2, "0")}`;
}

/** "Sun 18 Oct, 20:05" in local time. */
export function fmtLocal(ts: number, tz: string = DEFAULT_TZ): string {
  const p = parts(ts, tz);
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${p.weekday} ${p.day} ${months[p.month - 1]}, ${clock(ts, tz)}`;
}

/** "in 2h 15m", "3d ago" — for report lines. */
export function humanDelta(ms: number): string {
  const future = ms > 0;
  const abs = Math.abs(ms);
  const mins = Math.round(abs / 60_000);
  if (mins < 1) return future ? "now" : "just now";
  if (mins < 60) return future ? `in ${mins}m` : `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return future ? `in ${hours}h` : `${hours}h ago`;
  const days = Math.round(hours / 24);
  return future ? `in ${days}d` : `${days}d ago`;
}

/** Local hour right now (0-23). */
export function localHour(now: number = Date.now(), tz: string = DEFAULT_TZ): number {
  return parts(now, tz).hour;
}

/** "Europe/Istanbul (UTC+03:00)" — what the bot shows when asked the time. */
export function tzLabel(ts: number = Date.now(), tz: string = DEFAULT_TZ): string {
  const mins = Math.round(offsetMs(ts, tz) / 60_000);
  const sign = mins >= 0 ? "+" : "-";
  const abs = Math.abs(mins);
  const hh = String(Math.floor(abs / 60)).padStart(2, "0");
  const mm = String(abs % 60).padStart(2, "0");
  return `${tz} (UTC${sign}${hh}:${mm})`;
}

/** Human line for the bot: "Sun 18 Oct, 20:05 · Europe/Istanbul (UTC+03:00)" */
export function nowLine(now: number = Date.now(), tz: string = DEFAULT_TZ): string {
  return `${fmtLocal(now, tz)} · ${tzLabel(now, tz)}`;
}
