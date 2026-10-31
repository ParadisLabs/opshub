/**
 * OpsHub v3 — Telegram-first control hub.
 *
 * v3 (why):
 *  - TIME is local: default Europe/Nicosia (Cyprus). The user can say
 *    "I'm in <place>" (or /where) and every time display, report window,
 *    reminder time and news alert shifts with them. /tz sets the zone directly.
 *  - WEATHER follows the location (open-meteo, free, keyless) and the daily
 *    report says whether it's a good day for the plans they schedule on here.
 *  - NEWS for trading: Forex Factory weekly calendar (nfs.faireconomy.media,
 *    free) — alerts 45m before High-impact releases, a news block in the
 *    report, and the AI is told to keep the user out of trades right before
 *    news and to reason from actual-vs-forecast after releases.
 *  - HEADLINES from free RSS (BBC, ForexLive, Al Jazeera, DW, CNN) cached in
 *    D1 so the AI can answer "what's going on with X" without inventing.
 *  - NAVIGATION: /directions (Nominatim geocode + OSRM route) and /area
 *    (geocode + Overpass amenity profile around a place).
 *  - The AI answers free text with PROTOCOL lines (DELETE:, REMIND:,
 *    REMINDAT:, WHERE:, TZ:, WEATHER:, NEWS:, HEADLINES:, DIRECTIONS:,
 *    AREA:) which the worker executes — so "delete it" or "I'm in Turkey
 *    now" actually does something. Short chat history is kept per chat.
 *  - Scheduler: Convex cron pings /sweep + /report-tick every 5 minutes
 *    (the GitHub workflow route was blocked by token scope).
 *
 * Uses Web Crypto API (globalThis.crypto) — no Node crypto import.
 */

import { Hono } from "hono";

const app = new Hono();
const VERSION = "3.3.0";
const HTTP_UNAVAILABLE = { error: "hub misconfigured" };
const REPOS = [
  { name: "faceless-studio", event: "opshub.produce" },
  { name: "faceless-turkce-studio", event: "opshub.produce" },
  { name: "deep-history-studio", event: "opshub.produce" },
  { name: "business-flip-", event: "opshub.produce" },
  { name: "icc-engine", event: "icc.run" },
];
const REPO_NAMES = REPOS.map((r) => r.name);
const REPORT_TTL_S = 900;
const WEATHER_TTL_S = 21600;
const FF_TTL_S = 21600;
const HEADLINES_TTL_S = 1800;
const DEFAULT_SETTINGS = {
  tz: "Europe/Nicosia",
  place: "Cyprus",
  lat: 35.17,
  lon: 33.36,
};
const CURRENCIES = {
  "United States": "USD", "Euro Zone": "EUR", "European Union": "EUR",
  Germany: "EUR", France: "EUR", Italy: "EUR", Spain: "EUR", Netherlands: "EUR",
  Belgium: "EUR", Austria: "EUR", Portugal: "EUR", Ireland: "EUR", Greece: "EUR",
  Finland: "EUR", "United Kingdom": "GBP", Japan: "JPY", Canada: "CAD",
  Australia: "AUD", "New Zealand": "NZD", Switzerland: "CHF", China: "CNY",
  Turkey: "TRY", "Türkiye": "TRY", Russia: "RUB", Brazil: "BRL", Mexico: "MXN",
  India: "INR", "South Korea": "KRW", "South Africa": "ZAR", Sweden: "SEK",
  Norway: "NOK", Denmark: "DKK", Poland: "PLN", "Saudi Arabia": "SAR",
  "United Arab Emirates": "AED", Qatar: "QAR", Israel: "ILS", Singapore: "SGD",
  "Hong Kong": "HKD", Indonesia: "IDR", Thailand: "THB", Malaysia: "MYR",
  Philippines: "PHP", Egypt: "EGP", Nigeria: "NGN", Ukraine: "UAH",
  "Czech Republic": "CZK", Hungary: "HUF", Romania: "RON", Iceland: "ISK",
  Pakistan: "PKR", Taiwan: "TWD", Colombia: "COP", Chile: "CLP", Peru: "PEN",
  Argentina: "ARS", Kenya: "KES",
};
const FEEDS = [
  { name: "BBC World", url: "https://feeds.bbci.co.uk/news/world/rss.xml" },
  { name: "BBC Business", url: "https://feeds.bbci.co.uk/news/business/rss.xml" },
  { name: "ForexLive", url: "https://www.forexlive.com/feed/news" },
  { name: "Al Jazeera", url: "https://www.aljazeera.com/xml/rss/all.xml" },
  { name: "CNN", url: "https://rss.cnn.com/rss/edition.rss" },
  { name: "DW", url: "https://rss.dw.com/rdf/rss-en" },
];

// --- health ---
app.get("/", async (ctx) => {
  return ctx.json({ status: "ok", version: VERSION, mode: "Telegram-first" });
});

// ---------------- helpers ----------------
async function sendTelegram(botToken, chatId, text) {
  try {
    await fetch("https://api.telegram.org/bot" + botToken + "/sendMessage", {
      method: "POST",
      headers: { "Content-Type": "application/json", "User-Agent": "OpsHub" },
      body: JSON.stringify({ chat_id: chatId, text: String(text).slice(0, 4000) }),
    });
    return true;
  } catch (e) {
    console.error("Failed to send Telegram reply:", e);
    return false;
  }
}

async function ghGet(path, token) {
  const r = await fetch("https://api.github.com" + path, {
    headers: {
      Authorization: "token " + token,
      Accept: "application/vnd.github+json",
      "User-Agent": "OpsHub",
    },
  });
  if (!r.ok) throw new Error("github " + r.status + " " + path);
  return r.json();
}

async function dispatchGitHub(token, repo, eventType, payload) {
  const resp = await fetch(
    "https://api.github.com/repos/landryparadis012-git/" + repo + "/dispatches",
    {
      method: "POST",
      headers: {
        Authorization: "token " + token,
        Accept: "application/vnd.github+json",
        "User-Agent": "OpsHub",
      },
      body: JSON.stringify({ event_type: eventType, client_payload: payload || {} }),
    }
  );
  return resp.ok;
}

async function callGroq(groqKey, messages) {
  const groqResp = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer " + groqKey,
      "User-Agent": "OpsHub",
    },
    body: JSON.stringify({
      model: "openai/gpt-oss-120b",
      messages,
      max_tokens: 500,
    }),
  });
  const data = await groqResp.json();
  if (data.choices && data.choices[0] && data.choices[0].message) {
    return data.choices[0].message.content;
  }
  console.error("Groq error:", JSON.stringify(data).slice(0, 400));
  return null;
}

async function kvGet(db, k) {
  const row = await db.prepare("SELECT v FROM kv WHERE k = ?").bind(k).first();
  return row ? row.v : null;
}

async function kvSet(db, k, v) {
  await db
    .prepare("INSERT INTO kv(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v")
    .bind(k, typeof v === "string" ? v : JSON.stringify(v))
    .run();
}

// ---------------- D1: tables ----------------
async function ensureTables(db) {
  await db
    .prepare(
      "CREATE TABLE IF NOT EXISTS dispatched (id INTEGER PRIMARY KEY AUTOINCREMENT, dedup_key TEXT UNIQUE, repo TEXT, series TEXT, episode TEXT, dispatched_at TEXT)"
    )
    .run();
  await db
    .prepare(
      "CREATE TABLE IF NOT EXISTS events (event_id TEXT PRIMARY KEY, type TEXT, payload TEXT, received_at INTEGER)"
    )
    .run();
  await db
    .prepare(
      "CREATE TABLE IF NOT EXISTS reminders (id INTEGER PRIMARY KEY AUTOINCREMENT, chat_id TEXT NOT NULL, text TEXT NOT NULL, due_at INTEGER NOT NULL, repeat_h INTEGER DEFAULT 0, active INTEGER DEFAULT 1, created_at TEXT)"
    )
    .run();
  await db.prepare("CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT)").run();
  await db
    .prepare(
      "CREATE TABLE IF NOT EXISTS tgacks (id INTEGER PRIMARY KEY AUTOINCREMENT, target TEXT NOT NULL, data TEXT NOT NULL, chat_id TEXT, message_id TEXT, created_at INTEGER, UNIQUE(target, message_id, data))"
    )
    .run();
  await db
    .prepare(
      "CREATE TABLE IF NOT EXISTS jobs (job_id TEXT PRIMARY KEY, service TEXT, kind TEXT, status TEXT, detail TEXT, url TEXT, created_at INTEGER, updated_at INTEGER)"
    )
    .run();
}

// ---------------- settings: location + timezone ----------------
async function getSettings(db) {
  try {
    const raw = await kvGet(db, "settings");
    if (raw) return { ...DEFAULT_SETTINGS, ...JSON.parse(raw) };
  } catch (e) { /* fall through to defaults */ }
  return { ...DEFAULT_SETTINGS };
}

async function saveSettings(db, patch) {
  const cur = await getSettings(db);
  const next = { ...cur, ...patch };
  await kvSet(db, "settings", next);
  return next;
}

function tzValid(tz) {
  try {
    new Intl.DateTimeFormat("en-GB", { timeZone: tz });
    return true;
  } catch (e) {
    return false;
  }
}

// ---------------- time (all local, per settings) ----------------
function pad2(n) {
  return String(n).padStart(2, "0");
}

function localEpochParts(d, tz) {
  const p = new Intl.DateTimeFormat("en-GB", {
    timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(d).reduce((a, x) => ((a[x.type] = x.value), a), {});
  return {
    y: parseInt(p.year, 10), mo: parseInt(p.month, 10), d: parseInt(p.day, 10),
    h: parseInt(p.hour, 10) % 24, mi: parseInt(p.minute, 10),
  };
}

function localParts(d, tz) {
  const p = localEpochParts(d, tz);
  return {
    date: `${p.y}-${pad2(p.mo)}-${pad2(p.d)}`,
    hour: p.h,
    hhmm: `${pad2(p.h)}:${pad2(p.mi)}`,
    weekday: new Intl.DateTimeFormat("en-GB", { timeZone: tz, weekday: "short" }).format(d),
  };
}

// wall-clock "YYYY-MM-DD HH:MM" in tz → epoch seconds
function zonedTimeToEpoch(str, tz) {
  const m = String(str).match(/^(\d{4})-(\d{1,2})-(\d{1,2})[ T](\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const want = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], 0);
  let guess = want;
  for (let i = 0; i < 3; i++) {
    const p = localEpochParts(new Date(guess), tz);
    const got = Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi, 0);
    const diff = want - got;
    if (diff === 0) break;
    guess += diff;
  }
  return Math.floor(guess / 1000);
}

function zonedDayStart(nowMs, tz) {
  const p = localEpochParts(new Date(nowMs), tz);
  return zonedTimeToEpoch(`${p.y}-${pad2(p.mo)}-${pad2(p.d)} 00:00`, tz);
}

function fmtClock(epoch, tz) {
  const p = localEpochParts(new Date(epoch * 1000), tz);
  return `${pad2(p.h)}:${pad2(p.mi)}`;
}

function fmtDayClock(epoch, tz) {
  const p = localEpochParts(new Date(epoch * 1000), tz);
  return `${pad2(p.d)}.${pad2(p.mo)} ${pad2(p.h)}:${pad2(p.mi)}`;
}

// ---------------- HMAC (events from studios / icc-engine) ----------------
async function verifySignature(rawBody, header, secret) {
  if (!secret) return false;
  if (!header) return false;
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(rawBody));
  const hex = [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
  const expected = "sha256=" + hex;
  if (header.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < header.length; i++) diff |= header.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}

async function storeEvent(db, body) {
  const eventId = body.event_id ||
    (body.type ? body.type + ":" + Math.random().toString(36).slice(2, 12) : null);
  if (!eventId || !body.type) return { stored: false, reason: "no event_id/type" };
  const res = await db
    .prepare(
      "INSERT OR IGNORE INTO events (event_id, type, payload, received_at) VALUES (?, ?, ?, ?)"
    )
    .bind(eventId, body.type, JSON.stringify(body), Math.floor(Date.now() / 1000))
    .run();
  const changed = res.meta && (res.meta.changes ?? 0);
  return { stored: changed > 0 };
}

// ---------------- D1: reminders ----------------
function normChat(v) {
  const n = Number(v);
  return Number.isFinite(n) ? String(Math.trunc(n)) : String(v);
}

async function addReminder(db, chatId, text, hours, repeatH, dueOverride) {
  const due = dueOverride != null
    ? Math.floor(dueOverride)
    : Math.floor(Date.now() / 1000) + Math.floor(hours * 3600);
  const repeat = repeatH > 0 ? Math.floor(repeatH) : 0;
  const res = await db
    .prepare(
      "INSERT INTO reminders (chat_id, text, due_at, repeat_h, active, created_at) VALUES (?, ?, ?, ?, 1, ?)"
    )
    .bind(normChat(chatId), text, due, repeat, new Date().toISOString())
    .run();
  return { id: res.meta && res.meta.last_row_id, due };
}

async function listReminders(db, chatId) {
  const rs = await db
    .prepare(
      "SELECT id, text, due_at, repeat_h FROM reminders WHERE active = 1 AND CAST(chat_id AS REAL) = CAST(? AS REAL) ORDER BY due_at ASC LIMIT 30"
    )
    .bind(chatId)
    .all();
  return rs.results || [];
}

async function deleteReminder(db, chatId, id) {
  const row = await db
    .prepare(
      "SELECT id, text FROM reminders WHERE id = ? AND CAST(chat_id AS REAL) = CAST(? AS REAL) AND active = 1"
    )
    .bind(id, chatId)
    .first();
  if (!row) return null;
  await db
    .prepare(
      "UPDATE reminders SET active = 0 WHERE id = ? AND CAST(chat_id AS REAL) = CAST(? AS REAL)"
    )
    .bind(id, chatId)
    .run();
  return row;
}

function repeatLabel(repeatH) {
  if (!repeatH) return "";
  if (repeatH % 168 === 0 && repeatH >= 168) return ` every ${repeatH / 168}w`;
  if (repeatH % 24 === 0) return ` daily${repeatH > 24 ? ` every ${repeatH / 24}d` : ""}`;
  return ` every ${repeatH}h`;
}

function fmtDue(dueAt, settings) {
  const delta = dueAt - Math.floor(Date.now() / 1000);
  const clock = `${fmtClock(dueAt, settings.tz)} ${settings.place} time`;
  if (delta <= 0) return `due now · was ${clock}`;
  const h = Math.floor(delta / 3600);
  const m = Math.floor((delta % 3600) / 60);
  if (h >= 48) return `in ${Math.floor(h / 24)}d · ${fmtDayClock(dueAt, settings.tz)}`;
  if (h > 0) return `in ${h}h ${m}m · ${clock}`;
  return `in ${m}m · ${clock}`;
}

function remindersText(rows, settings) {
  if (!rows.length) {
    return "Active reminders:\n(none)\n\nSet one with:\n/remind 48 <text> — one-shot in 48h\n/remind 24 every <text> — repeats every 24h\nor just say e.g. \"remind me every day at 08:00 to check the studios\"";
  }
  const lines = rows.map(
    (r) => `#${r.id} ${fmtDue(r.due_at, settings)}${repeatLabel(r.repeat_h)} — ${r.text}`
  );
  return "Active reminders:\n" + lines.join("\n") + "\n\nCancel: /delete <id>";
}

// ---------------- chat memory ----------------
async function getChatLog(db, chatId) {
  try {
    const raw = await kvGet(db, "chatlog:" + normChat(chatId));
    const arr = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) ? arr : [];
  } catch (e) {
    return [];
  }
}

async function pushChatLog(db, chatId, role, text) {
  try {
    const log = await getChatLog(db, chatId);
    log.push({ r: role, t: String(text).slice(0, 300) });
    while (log.length > 8) log.shift();
    await kvSet(db, "chatlog:" + normChat(chatId), log);
  } catch (e) { /* memory is best-effort */ }
}

// ---------------- weather (open-meteo, free, keyless) ----------------
function wmo(code) {
  if (code === 0) return { i: "☀️", t: "clear" };
  if (code <= 2) return { i: "🌤", t: "partly cloudy" };
  if (code === 3) return { i: "☁️", t: "overcast" };
  if (code === 45 || code === 48) return { i: "🌫", t: "fog" };
  if (code >= 51 && code <= 67) return { i: "🌧", t: "rain/showers" };
  if (code >= 71 && code <= 77) return { i: "🌨", t: "snow" };
  if (code >= 80 && code <= 82) return { i: "🌦", t: "showers" };
  if (code >= 85 && code <= 86) return { i: "🌨", t: "snow showers" };
  if (code >= 95) return { i: "⛈", t: "thunderstorm" };
  return { i: "•", t: "" };
}

function feelFor(maxC) {
  if (maxC >= 32) return "hot — plan outdoor stuff early or late";
  if (maxC >= 24) return "warm — good for outdoor plans";
  if (maxC >= 16) return "mild — fine to be outside";
  if (maxC >= 8) return "cold — dress warm, indoor-friendly day";
  return "freezing — keep plans indoors";
}

async function getWeather(ctx, settings) {
  const db = ctx.env.DB;
  try {
    const raw = await kvGet(db, "weather");
    if (raw) {
      const w = JSON.parse(raw);
      if (Date.now() / 1000 - w.t < WEATHER_TTL_S && w.lat === settings.lat && w.tz === settings.tz) {
        return w;
      }
    }
  } catch (e) { /* refetch below */ }
  try {
    const url =
      `https://api.open-meteo.com/v1/forecast?latitude=${settings.lat}&longitude=${settings.lon}` +
      `&current=temperature_2m,weather_code,wind_speed_10m` +
      `&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max` +
      `&timezone=${encodeURIComponent(settings.tz)}&forecast_days=3`;
    const r = await fetch(url, { signal: AbortSignal.timeout(8000) });
    const j = await r.json();
    const w = {
      t: Date.now() / 1000, lat: settings.lat, tz: settings.tz,
      cur: j.current || null,
      today: {
        max: j.daily.temperature_2m_max[0], min: j.daily.temperature_2m_min[0],
        rain: j.daily.precipitation_probability_max?.[0] ?? 0, code: j.daily.weather_code[0],
      },
      tom: {
        max: j.daily.temperature_2m_max[1], min: j.daily.temperature_2m_min[1],
        rain: j.daily.precipitation_probability_max?.[1] ?? 0, code: j.daily.weather_code[1],
      },
    };
    try { await kvSet(db, "weather", w); } catch (e) { /* cache best-effort */ }
    return w;
  } catch (e) {
    return null;
  }
}

function weatherLine(w, settings) {
  if (!w || !w.today) return null;
  const now = w.cur ? `${Math.round(w.cur.temperature_2m)}°C ${wmo(w.cur.weather_code).t}` : null;
  return (
    `🌡 ${now ? now + " · " : ""}today ${Math.round(w.today.max)}°/${Math.round(w.today.min)}° ` +
    `${wmo(w.today.code).i} ${feelFor(w.today.max)} · rain ${w.today.rain}%` +
    ` (tomorrow ${Math.round(w.tom.max)}°/${Math.round(w.tom.min)}°, rain ${w.tom.rain}%)`
  );
}

async function weatherTextCmd(ctx, settings) {
  const w = await getWeather(ctx, settings);
  if (!w) return `Weather unavailable right now (checked ${settings.lat}, ${settings.lon} — ${settings.place}).`;
  const now = w.cur
    ? `Now: ${Math.round(w.cur.temperature_2m)}°C, ${wmo(w.cur.weather_code).t}, wind ${Math.round(w.cur.wind_speed_10m)} km/h`
    : "";
  const day = (lbl, d) =>
    `${lbl}: ${Math.round(d.max)}°/${Math.round(d.min)}° ${wmo(d.code).i} ${wmo(d.code).t}, rain ${d.rain}% — ${feelFor(d.max)}`;
  return `Weather for ${settings.place}:\n${now}\n${day("Today", w.today)}\n${day("Tomorrow", w.tom)}`;
}

// ---------------- Forex Factory calendar ----------------
function parseFF(xml) {
  const events = [];
  const blocks = xml.split("<event>").slice(1);
  for (const braw of blocks) {
    const b = braw.split("</event>")[0];
    const tag = (n) => {
      const m = b.match(new RegExp(`<${n}>(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?</${n}>`));
      return m ? m[1].trim() : "";
    };
    const title = tag("title");
    const country = tag("country");
    const date = tag("date");
    const impact = tag("impact");
    if (!title || !date) continue;
    const ts = Date.parse(date);
    if (!Number.isFinite(ts)) continue;
    events.push({
      title, country, impact,
      ts: Math.floor(ts / 1000),
      forecast: tag("forecast"), previous: tag("previous"), actual: tag("actual"),
    });
  }
  return events.sort((a, b) => a.ts - b.ts);
}

async function getFF(ctx, force) {
  const db = ctx.env.DB;
  if (!force) {
    try {
      const raw = await kvGet(db, "ffcal");
      if (raw) {
        const c = JSON.parse(raw);
        if (Date.now() / 1000 - c.t < FF_TTL_S && c.events?.length) return c.events;
      }
    } catch (e) { /* refetch */ }
  }
  try {
    const r = await fetch(
      "https://nfs.faireconomy.media/ff_calendar_thisweek.xml",
      { signal: AbortSignal.timeout(10000), headers: { "User-Agent": "OpsHub/3.0" } }
    );
    const xml = await r.text();
    const events = parseFF(xml);
    if (events.length) {
      try { await kvSet(db, "ffcal", { t: Date.now() / 1000, events }); } catch (e) {}
      return events;
    }
  } catch (e) { /* fall back to stale cache */ }
  try {
    const raw = await kvGet(db, "ffcal");
    if (raw) return JSON.parse(raw).events || [];
  } catch (e) {}
  return [];
}

function ffEventLine(e, settings) {
  const cur = CURRENCIES[e.country] || "";
  const time = fmtClock(e.ts, settings.tz);
  const bits = [];
  if (e.actual) bits.push(`actual ${e.actual}`);
  if (e.forecast) bits.push(`f ${e.forecast}`);
  if (e.previous) bits.push(`p ${e.previous}`);
  const suffix = bits.length ? ` (${bits.join(" · ")})` : "";
  const flag = e.impact === "High" ? "🚨" : e.impact === "Medium" ? "🟡" : "⚪️";
  return `• ${time} ${cur || e.country} — ${e.title} ${flag}${e.impact ? ` ${e.impact}` : ""}${suffix}`;
}

function sameLocalDay(epoch, tz) {
  return localParts(new Date(epoch * 1000), tz).date === localParts(new Date(), tz).date;
}

async function newsBlock(ctx, settings, opts) {
  opts = opts || {};
  const events = await getFF(ctx, opts.force);
  const now = Math.floor(Date.now() / 1000);
  const upcoming = events
    .filter((e) => e.ts >= now && (!opts.todayOnly || sameLocalDay(e.ts, settings.tz)))
    .slice(0, opts.limit || 6);
  const released = events
    .filter((e) => e.ts < now && e.actual && (!opts.todayOnly || sameLocalDay(e.ts, settings.tz)))
    .slice(-3);
  let out = "📰 Forex news (times in " + settings.place + " time):\n";
  if (upcoming.length) {
    out += "Upcoming:\n" + upcoming.map((e) => ffEventLine(e, settings)).join("\n") + "\n";
  }
  if (released.length) {
    out += "Just released:\n" + released.map((e) => ffEventLine(e, settings)).join("\n");
  }
  if (!upcoming.length && !released.length) out += "(no events found)";
  return out;
}

// 45 minutes before every High-impact event → one alert per event, ever.
async function newsAlerts(ctx) {
  const db = ctx.env.DB;
  const settings = await getSettings(db);
  const now = Math.floor(Date.now() / 1000);
  const events = await getFF(ctx);
  let sent = 0;
  for (const e of events) {
    if (e.impact !== "High") continue;
    const delta = e.ts - now;
    if (delta <= 0 || delta > 45 * 60) continue;
    const key = "ffalert:" + e.ts + ":" + e.title.slice(0, 40);
    try {
      const seen = await kvGet(db, key);
      if (seen) continue;
      const mins = Math.round(delta / 60);
      const cur = CURRENCIES[e.country] || e.country;
      const bits = [];
      if (e.forecast) bits.push(`Forecast ${e.forecast}`);
      if (e.previous) bits.push(`Prev ${e.previous}`);
      const text =
        `🚨 HIGH IMPACT in ${mins}m (${fmtClock(e.ts, settings.tz)} ${settings.place})\n` +
        `${cur} — ${e.title}\n` +
        (bits.length ? bits.join(" · ") + "\n" : "") +
        `Avoid new entries until after the release. I'll send the actual, the direction and pairs to watch right after it lands.`;
      const botToken = ctx.env.TELEGRAM_BOT_TOKEN;
      const ownerRow = await kvGet(db, "report_owner");
      const owner = ownerRow ? JSON.parse(ownerRow).chat : null;
      if (botToken && owner) {
        await sendTelegram(botToken, owner, text);
        await kvSet(db, key, now);
        sent++;
      }
    } catch (e2) { /* per-event failures are fine */ }
  }
  try {
    await db
      .prepare("DELETE FROM kv WHERE k LIKE 'ffalert:%' AND CAST(v AS INTEGER) < ?")
      .bind(now - 43200)
      .run();
  } catch (e) { /* pruning best-effort */ }
  return sent;
}

// ---------------- post-release follow-up ----------------
// One follow-up per High-impact event ~2min after it lands: the actual number,
// the surprise direction, the pairs to trade on it, and a live engine scan
// whose setup cards carry the concrete entry/SL/TP levels.
const TRADE_PAIRS = {
  USD: ["EUR/USD", "GBP/USD", "XAU/USD", "USD/JPY"],
  EUR: ["EUR/USD", "EUR/GBP", "EUR/JPY"],
  GBP: ["GBP/USD", "EUR/GBP", "GBP/JPY"],
  JPY: ["USD/JPY", "EUR/JPY", "GBP/JPY"],
  AUD: ["AUD/USD", "AUD/JPY", "EUR/AUD"],
  NZD: ["NZD/USD", "NZD/JPY", "EUR/NZD"],
  CAD: ["USD/CAD", "CAD/JPY", "EUR/CAD"],
  CHF: ["USD/CHF", "EUR/CHF", "GBP/CHF"],
  CNY: ["USD/CNH", "AUD/USD", "EUR/USD"],
  TRY: ["USD/TRY", "EUR/TRY", "GBP/TRY"],
};

function parseNum(s) {
  if (!s) return null;
  const raw = String(s).replace(/,/g, "");
  const m = raw.match(/-?\d+(\.\d+)?/);
  if (!m) return null;
  let n = parseFloat(m[0]);
  if (/[kK]\s*$/.test(raw)) n *= 1000;
  if (/[mM]\s*$/.test(raw)) n *= 1000000;
  return n;
}

async function newsPost(ctx) {
  const db = ctx.env.DB;
  const settings = await getSettings(db);
  const now = Math.floor(Date.now() / 1000);
  const inWindow = (e) => e.impact === "High" && now >= e.ts + 90 && now <= e.ts + 2700;

  let events = await getFF(ctx);
  let due = events.filter(inWindow);
  if (!due.length) return 0;

  // Actuals appear in the calendar only after the release — refetch once.
  if (due.some((e) => !e.actual)) {
    events = await getFF(ctx, true).catch(() => events);
    due = events.filter(inWindow);
  }

  const botToken = ctx.env.TELEGRAM_BOT_TOKEN;
  const ownerRow = await kvGet(db, "report_owner");
  const owner = ownerRow ? JSON.parse(ownerRow).chat : null;
  if (!botToken || !owner) return 0;

  let sent = 0;
  for (const e of due) {
    const key = "ffpost:" + e.ts + ":" + e.title.slice(0, 40);
    try {
      if (await kvGet(db, key)) continue;
      if (!e.actual) continue; // still no actual — retry next sweep

      const cur = CURRENCIES[e.country] || e.country;
      const pairs = TRADE_PAIRS[cur] || [];
      const a = parseNum(e.actual);
      const f = parseNum(e.forecast);
      const p = parseNum(e.previous);

      let surprise = "";
      if (a !== null && f !== null) {
        const d = a - f;
        const mag = Math.abs(d).toPrecision(2);
        if (Math.abs(d) < 1e-9) surprise = `➡️ In line with forecast — usually a muted, range-bound reaction.`;
        else if (d > 0) surprise = `➡️ ${mag} ABOVE forecast — hotter than expected, reads supportive for ${cur}.`;
        else surprise = `➡️ ${mag} BELOW forecast — cooler than expected, reads bearish for ${cur}.`;
      }

      const bits = [];
      if (e.actual) bits.push(`Actual ${e.actual}`);
      if (e.forecast) bits.push(`Forecast ${e.forecast}`);
      if (e.previous) bits.push(`Prev ${e.previous}`);

      let text =
        `🔔 RELEASED — ${cur} · ${e.title} (${fmtClock(e.ts, settings.tz)} ${settings.place})\n` +
        (bits.length ? bits.join(" · ") + "\n" : "") +
        (surprise ? surprise + "\n" : "") +
        (pairs.length ? `Pairs to watch: ${pairs.join(" · ")}\n` : "");

      // Short analyst read: direction, what to trade, levels to watch.
      const groqKey = ctx.env.GROQ_API_KEY;
      if (groqKey) {
        try {
          const analysis = await callGroq(groqKey, [
            { role: "system", content: "You are a concise forex news analyst. Reply in plain text, max 110 words, no markdown, no preamble. Give exactly: (1) the market read (hawkish/dovish, beat/miss), (2) the trade bias for the listed pairs with BUY/SELL direction, (3) two concrete levels or behaviors to watch right after the release (pre-news range high/low, round numbers, sweep-and-reverse). Never promise outcomes; hedge where needed." },
            { role: "user", content: `Event: ${cur} ${e.title}\nActual: ${e.actual} | Forecast: ${e.forecast || "n/a"} | Previous: ${e.previous || "n/a"}\nPairs: ${pairs.join(", ") || cur + " crosses"}` },
          ]);
          if (analysis) text += "\n" + analysis.trim() + "\n";
        } catch (e2) { /* analysis is best-effort */ }
      }

      await sendTelegram(botToken, owner, text);
      await kvSet(db, key, now);
      sent++;

      // Kick a fresh engine scan so concrete setup cards (entry/SL/TP) follow.
      try {
        const token = ctx.env.HUB_GITHUB_TOKEN;
        if (token) {
          const ok = await dispatchGitHub(token, "icc-engine", "icc.run", {
            reason: "post-news scan",
            event: cur + " " + e.title,
            actual: e.actual,
            forecast: e.forecast,
          });
          if (ok) await kvSet(db, "icc_dispatch", { t: Math.floor(Date.now() / 1000) });
        }
      } catch (e2) { /* dispatch best-effort */ }
    } catch (e2) { /* per-event failures are fine */ }
  }
  return sent;
}

// ---------------- headlines (free RSS) ----------------
function stripXml(s) {
  const A = "&";
  let out = String(s).replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1");
  out = out.replace(/&#x([0-9a-fA-F]+);/g, (_, n) => String.fromCharCode(parseInt(n, 16)));
  out = out.replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)));
  out = out.replace(/&([a-zA-Z]+);/g, (m, n) => (
    { lt: "<", gt: ">", quot: "\"", apos: "'", amp: A }[n] || m
  ));
  return out.replace(/\s+/g, " ").trim();
}

async function getHeadlines(ctx, force) {
  const db = ctx.env.DB;
  if (!force) {
    try {
      const raw = await kvGet(db, "headlines");
      if (raw) {
        const h = JSON.parse(raw);
        if (Date.now() / 1000 - h.t < HEADLINES_TTL_S && h.items?.length) return h;
      }
    } catch (e) { /* refetch */ }
  }
  const results = await Promise.allSettled(
    FEEDS.map(async (f) => {
      const r = await fetch(f.url, {
        signal: AbortSignal.timeout(7000),
        headers: { "User-Agent": "OpsHub/3.0 (personal news reader)" },
      });
      const xml = await r.text();
      const items = [];
      const chunks = xml.split(/<item[\s>]/).slice(1);
      for (const c of chunks.slice(0, 4)) {
        const title = (c.match(/<title[^>]*>([\s\S]*?)<\/title>/) || [])[1];
        const link = (c.match(/<link[^>]*>([\s\S]*?)<\/link>/) || [])[1];
        const pub = (c.match(/<pubDate[^>]*>([\s\S]*?)<\/pubDate>/) || [])[1];
        if (!title) continue;
        const parsed = pub ? Date.parse(stripXml(pub)) : NaN;
        items.push({
          feed: f.name,
          title: stripXml(title),
          link: stripXml(link || ""),
          at: Number.isFinite(parsed) ? parsed : 0,
        });
      }
      if (!items.length) throw new Error("empty feed " + f.name);
      return items;
    })
  );
  const items = [];
  const okFeeds = [];
  results.forEach((r, i) => {
    if (r.status === "fulfilled") {
      okFeeds.push(FEEDS[i].name);
      items.push(...r.value);
    }
  });
  const h = { t: Date.now() / 1000, feeds: okFeeds, items: items.slice(0, 14) };
  try { await kvSet(db, "headlines", h); } catch (e) {}
  return h;
}

function headlinesText(h, limit) {
  if (!h || !h.items || !h.items.length) return "Headlines unavailable right now.";
  const seen = new Set();
  const lines = [];
  for (const it of h.items) {
    if (seen.has(it.title)) continue;
    seen.add(it.title);
    lines.push(`• [${it.feed}] ${it.title}`);
    if (lines.length >= (limit || 10)) break;
  }
  return "Headlines (" + h.feeds.join(", ") + "):\n" + lines.join("\n");
}

// ---------------- navigation ----------------
const COUNTRY_TZ = {
  Cyprus: "Europe/Nicosia", Turkey: "Europe/Istanbul", "Türkiye": "Europe/Istanbul",
  Greece: "Europe/Athens", "United Kingdom": "Europe/London", Germany: "Europe/Berlin",
  France: "Europe/Paris", Spain: "Europe/Madrid", Italy: "Europe/Rome",
  Portugal: "Europe/Lisbon", Netherlands: "Europe/Amsterdam", Belgium: "Europe/Brussels",
  Austria: "Europe/Vienna", Switzerland: "Europe/Zurich", Sweden: "Europe/Stockholm",
  Norway: "Europe/Oslo", Denmark: "Europe/Copenhagen", Finland: "Europe/Helsinki",
  Poland: "Europe/Warsaw", Czechia: "Europe/Prague", "Czech Republic": "Europe/Prague",
  Hungary: "Europe/Budapest", Romania: "Europe/Bucharest", Bulgaria: "Europe/Sofia",
  Ireland: "Europe/Dublin", Russia: "Europe/Moscow", Ukraine: "Europe/Kyiv",
  Israel: "Asia/Jerusalem", Lebanon: "Asia/Beirut", Jordan: "Asia/Amman",
  "Saudi Arabia": "Asia/Riyadh", Qatar: "Asia/Qatar", "United Arab Emirates": "Asia/Dubai",
  Egypt: "Africa/Cairo", Nigeria: "Africa/Lagos", Kenya: "Africa/Nairobi",
  "South Africa": "Africa/Johannesburg", "United States": "America/New_York",
  Canada: "America/Toronto", Mexico: "America/Mexico_City", Brazil: "America/Sao_Paulo",
  Argentina: "America/Argentina/Buenos_Aires", India: "Asia/Kolkata",
  Pakistan: "Asia/Karachi", China: "Asia/Shanghai", Japan: "Asia/Tokyo",
  "South Korea": "Asia/Seoul", Singapore: "Asia/Singapore", Thailand: "Asia/Bangkok",
  Malaysia: "Asia/Kuala_Lumpur", Indonesia: "Asia/Jakarta", Vietnam: "Asia/Ho_Chi_Minh",
  Philippines: "Asia/Manila", Australia: "Australia/Sydney", "New Zealand": "Pacific/Auckland",
  Iran: "Asia/Tehran", Iraq: "Asia/Baghdad", Kazakhstan: "Asia/Almaty",
};

// Resolve a timezone for a place: Open-Meteo geocoding first (city-level),
// then a country-name fallback (islands/regions often have no city match).
async function lookupTz(q, countryEn) {
  let omCountry = null;
  try {
    const r = await fetch(
      "https://geocoding-api.open-meteo.com/v1/search?count=1&language=en&name=" + encodeURIComponent(q),
      { signal: AbortSignal.timeout(6000) }
    );
    const j = await r.json();
    const first = j.results && j.results[0];
    if (first) {
      omCountry = first.country || null;
      if (first.timezone && tzValid(first.timezone)) return first.timezone;
    }
  } catch (e) { /* fall through */ }
  const mapped = COUNTRY_TZ[String(countryEn || "").trim()] || COUNTRY_TZ[String(omCountry || "").trim()];
  return mapped && tzValid(mapped) ? mapped : null;
}

async function geocode(q) {
  try {
    const r = await fetch(
      "https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&accept-language=en&q=" + encodeURIComponent(q),
      {
        headers: { "User-Agent": "OpsHub/3.0 personal Telegram assistant", "Accept": "application/json" },
        signal: AbortSignal.timeout(8000),
      }
    );
    const ct = (r.headers.get("content-type") || "");
    if (!r.ok || ct.indexOf("json") === -1) return null;
    const j = await r.json().catch(() => null);
    if (!j || !Array.isArray(j) || !j.length) return null;
    const g = j[0];
    return {
      label: g.display_name, lat: parseFloat(g.lat), lon: parseFloat(g.lon),
      type: (g.addresstype || g.type || "").toString(),
      country: (g.address && (g.address.country || "")) || "",
    };
  } catch (e) {
    return null;
  }
}

function fmtMeters(m) {
  return m < 1000 ? `${Math.round(m)} m` : `${(m / 1000).toFixed(1)} km`;
}

function fmtSeconds(s) {
  if (s < 90) return `${Math.round(s / 60) * 60 === 0 ? 1 : Math.round(s / 60)} min`;
  if (s < 3600) return `${Math.round(s / 60)} min`;
  const h = Math.floor(s / 3600);
  const m = Math.round((s % 3600) / 60);
  return `${h}h ${m}m`;
}

async function osrmRoute(a, b, walk) {
  const providers = walk
    ? ["https://routing.openstreetmap.de/routed-foot/route/v1/driving"]
    : [
        "https://router.project-osrm.org/route/v1/driving",
        "https://routing.openstreetmap.de/routed-car/route/v1/driving",
      ];
  for (const base of providers) {
    try {
      const url =
        `${base}/${a.lon},${a.lat};${b.lon},${b.lat}?overview=false&steps=true&alternatives=false`;
      const r = await fetch(url, {
        headers: { "Accept": "application/json", "User-Agent": "OpsHub/3.0" },
        signal: AbortSignal.timeout(9000),
      });
      const ct = (r.headers.get("content-type") || "");
      if (!r.ok || ct.indexOf("json") === -1) continue;
      const j = await r.json().catch(() => null);
      if (!j || j.code !== "Ok" || !j.routes || !j.routes.length) continue;
      const rt = j.routes[0];
      const steps = [];
      for (const leg of rt.legs) {
        for (const s of leg.steps || []) {
          const mv = s.maneuver || {};
          const road = s.name ? ` onto ${s.name}` : "";
          let t = "";
          if (mv.type === "depart") t = `Head ${mv.modifier || "out"}${road}`;
          else if (mv.type === "arrive") t = "Arrive at destination";
          else if (mv.type === "roundabout" || mv.type === "rotary") t = `Take the roundabout${road}`;
          else if (mv.type === "merge") t = `Merge${road}`;
          else if (mv.type === "on ramp") t = `Take the ramp${road}`;
          else if (mv.type === "off ramp") t = `Take the exit${road}`;
          else if (mv.type === "fork") t = `Keep ${mv.modifier || "left"} at the fork${road}`;
          else if (mv.type === "new name") t = `Continue${road}`;
          else if (mv.type === "turn") t = `Turn ${mv.modifier || ""}${road}`.trim();
          else if (mv.type === "continue" || mv.type === "end of road") t = `Continue${road}`;
          else t = `${mv.type || "Go"}${road}`;
          if (t && steps.length < 12) steps.push(t.replace(/\s+/g, " "));
        }
      }
      return { dist: rt.distance, dur: rt.duration, steps };
    } catch (e) { /* try next provider */ }
  }
  return null;
}

async function directionsText(fromQ, toQ, walk, settings) {
  const a = await geocode(fromQ);
  if (!a) return `Couldn't find "${fromQ}". Try /directions <place> to <place>.`;
  const b = await geocode(toQ);
  if (!b) return `Couldn't find "${toQ}". Try /directions <place> to <place>.`;
  const rt = await osrmRoute(a, b, walk);
  if (!rt) return `No route found between ${a.label} and ${b.label} right now.`;
  const mode = walk ? "🚶 walking" : "🚗 driving";
  return (
    `${mode}: ${a.label.split(",")[0]} → ${b.label.split(",")[0]}\n` +
    `${fmtMeters(rt.dist)} · about ${fmtSeconds(rt.dur)}\n\n` +
    rt.steps.map((s, i) => `${i + 1}. ${s}`).join("\n")
  );
}

async function areaText(q) {
  const g = await geocode(q);
  if (!g) return `Couldn't find "${q}".`;
  let extra = "";
  try {
    const r = await fetch(
      "https://geocoding-api.open-meteo.com/v1/search?count=1&language=en&name=" + encodeURIComponent(q),
      { signal: AbortSignal.timeout(6000) }
    );
    const j = await r.json();
    const f = j.results && j.results[0];
    if (f) {
      if (f.population) extra += ` · pop ~${Number(f.population).toLocaleString("en")}`;
      const tz = (f.timezone && tzValid(f.timezone)) ? f.timezone : COUNTRY_TZ[String(f.country || "").trim()];
      if (tz) {
        const pp = localParts(new Date(), tz);
        extra += `\nlocal time there: ${pp.hhmm} ${pp.weekday} (${tz})`;
      }
    }
  } catch (e) { /* enrichment optional */ }
  let profile = "";
  const mirrors = ["https://overpass-api.de/api/interpreter"];
  for (const mirror of mirrors) {
    try {
      const cats = [
        ["schools", 'nwr(around:900,LAT,LON)["amenity"="school"]'],
        ["hospitals/clinics", 'nwr(around:1500,LAT,LON)["amenity"~"hospital|clinic"]'],
        ["cafes/restaurants", 'nwr(around:700,LAT,LON)["amenity"~"cafe|restaurant|bar|fast_food"]'],
        ["supermarkets", 'nwr(around:900,LAT,LON)["shop"~"supermarket|convenience"]'],
        ["parks", 'nwr(around:1500,LAT,LON)["leisure"="park"]'],
        ["pharmacies", 'nwr(around:700,LAT,LON)["amenity"="pharmacy"]'],
      ];
      const body =
        "[out:json][timeout:12];" +
        cats.map(([_, q2]) => q2.replace("LAT", g.lat).replace("LON", g.lon) + ";out count;").join("");
      const r = await fetch(mirror, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "Accept": "application/json",
          "User-Agent": "OpsHub/3.0 personal Telegram assistant",
        },
        body: "data=" + encodeURIComponent(body),
        signal: AbortSignal.timeout(8000),
      });
      const ct = (r.headers.get("content-type") || "");
      if (!r.ok || ct.indexOf("json") === -1) continue;
      const j2 = await r.json().catch(() => null);
      if (!j2 || !Array.isArray(j2.elements)) continue;
      const counts = j2.elements.map((e) => {
        const n = (e.tags && (e.tags.total ?? e.tags.total_count)) ?? e.total ?? 0;
        return Number(n) || 0;
      });
      const icons = ["🏫", "🏥", "☕️", "🛒", "🌳", "💊"];
      profile = cats.map(([name], i2) => `${icons[i2]} ${counts[i2] ?? 0} ${name}`).join(" · ");
      break;
    } catch (e) { /* try next mirror */ }
  }
  if (!profile) profile = "(nearby-places lookup unavailable)";
  return `📍 ${g.label}\ntype: ${g.type}${g.country ? ` · ${g.country}` : ""}${extra}\ncoords: ${g.lat.toFixed(4)}, ${g.lon.toFixed(4)}\nnearby: ${profile}`;
}

// ---------------- report data (REAL, cached) ----------------
async function repoStatuses(ctx) {
  const db = ctx.env.DB;
  const token = ctx.env.HUB_GITHUB_TOKEN;
  const owner = ctx.env.GITHUB_OWNER || "landryparadis012-git";
  if (!token) return null;
  try {
    const hit = await kvGet(db, "repostatus");
    if (hit) {
      const parsed = JSON.parse(hit);
      if (Date.now() / 1000 - parsed.t < REPORT_TTL_S) return parsed.data;
    }
  } catch (e) { /* cache miss is fine */ }
  const out = [];
  for (const name of REPO_NAMES) {
    try {
      const j = await ghGet(`/repos/${owner}/${name}/actions/runs?per_page=1`, token);
      const run = j.workflow_runs && j.workflow_runs[0];
      out.push(
        run
          ? {
              repo: name, wf: run.name || "?", state: run.status,
              result: run.conclusion || (run.status === "in_progress" ? "running" : "-"),
              at: run.updated_at, url: run.html_url,
            }
          : { repo: name, wf: "-", state: "none", result: "no runs", at: "", url: "" }
      );
    } catch (e) {
      out.push({ repo: name, wf: "-", state: "error", result: String(e).slice(0, 60), at: "", url: "" });
    }
  }
  try {
    await kvSet(db, "repostatus", { t: Date.now() / 1000, data: out });
  } catch (e) { /* cache write is best-effort */ }
  return out;
}

function ago(iso) {
  if (!iso) return "";
  const d = (Date.now() - new Date(iso).getTime()) / 1000;
  if (d < 90) return "just now";
  if (d < 3600) return `${Math.round(d / 60)}m ago`;
  if (d < 86400) return `${Math.round(d / 3600)}h ago`;
  return `${Math.round(d / 86400)}d ago`;
}

function iconFor(result, state) {
  if (state === "in_progress" || state === "queued") return "🔄";
  if (result === "success") return "✅";
  if (result === "failure" || result === "timed_out" || result === "cancelled") return "❌";
  return "•";
}

// ---------------- job ledger + failure triage ----------------
// Every service event lands in `jobs`, keyed by an idempotency key so a
// replayed webhook or a re-run never duplicates history. /jobs reads it.
const nowSec = () => Math.floor(Date.now() / 1000);

async function recordJob(db, j) {
  if (!db || !j || !j.job_id) return;
  try {
    await db
      .prepare(
        "INSERT INTO jobs (job_id, service, kind, status, detail, url, created_at, updated_at) " +
          "VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(job_id) DO UPDATE SET " +
          "status=excluded.status, detail=excluded.detail, url=excluded.url, updated_at=excluded.updated_at"
      )
      .bind(
        String(j.job_id),
        String(j.service || "hub"),
        String(j.kind || "?"),
        String(j.status || "?"),
        String(j.detail || "").slice(0, 4000),
        String(j.url || ""),
        Number(j.created_at) || nowSec(),
        nowSec()
      )
      .run();
  } catch (e) {
    console.error("recordJob failed:", e);
  }
}

async function listJobs(db, limit) {
  try {
    const r = await db
      .prepare("SELECT job_id, service, kind, status, detail, url, created_at, updated_at FROM jobs ORDER BY updated_at DESC LIMIT ?")
      .bind(Math.min(Number(limit) || 15, 50))
      .all();
    return r.results || [];
  } catch (e) {
    return [];
  }
}

// Heuristic diagnosis: service failure evidence -> cause + concrete fix.
// Rules are ordered from most specific to most general.
const FAILURE_RULES = [
  { re: /no queued topics|topics\.json has no queued topics/i,
    cause: "topic queue is empty",
    fix: "refill memory/topics.json (git owns it; a stale actions/cache copy used to clobber it — fixed 2026-10-30)" },
  { re: /daily (free )?limit|DAILY LIMIT|daily free allocation|quota exceeded|insufficient quota| neurons used up/i,
    cause: "free-tier AI quota exhausted",
    fix: "rerun after the provider's UTC reset — cached progress resumes, nothing is lost" },
  { re: /ModuleNotFoundError|No module named|Cannot find module|ERR_MODULE_NOT_FOUND/i,
    cause: "missing dependency",
    fix: "add it to requirements.txt / package.json and pin a version" },
  { re: /401 Unauthorized|403 Forbidden|Bad credentials|unauthorized|invalid .*key|invalid .*token|secret.*not set|Webhook response code: 40[13]/i,
    cause: "missing or invalid credential/secret",
    fix: "check the secret NAME in Actions secrets or Sites → Secrets, then redeploy" },
  { re: /timed out|timeout|ETIMEDOUT|ECONNRESET|Temporary failure in name resolution|getaddrinfo|fetch failed/i,
    cause: "network timeout / upstream unreachable",
    fix: "safe to retry; the pipeline resumes from cached work" },
  { re: /MemoryError|out of memory|Killed process|signal 9/i,
    cause: "runner ran out of memory",
    fix: "reduce images/chapters per run or split write and produce" },
  { re: /Traceback \(most recent call last\)|^\w*Error:/m,
    cause: "unhandled code error",
    fix: "reproduce locally with the same command; log tail below shows the frame" },
];

function classifyFailure(step, logTail) {
  const hay = `${step || ""}\n${logTail || ""}`;
  for (const r of FAILURE_RULES) if (r.re.test(hay)) return r;
  return { cause: "unclassified failure", fix: "open the run log (link below)" };
}

async function ghText(path, token) {
  const r = await fetch("https://api.github.com" + path, {
    headers: { Authorization: "token " + token, Accept: "application/vnd.github+json", "User-Agent": "OpsHub" },
  });
  if (!r.ok) throw new Error("github " + r.status + " " + path);
  return r.text();
}

// Pull the part of a job log that actually explains the failure. GitHub logs
// end in job-cleanup noise (git config, node deprecation warnings), so a plain
// tail hides the error — search for real failure markers first, window around
// the first hit, and fall back to the tail only when nothing matches.
const LOG_MARKERS = /##\[error\]|Traceback \(most recent call last\)|PIPELINE FAILED|RuntimeError|ModuleNotFoundError|ImportError|No module named|DAILY LIMIT|daily (free )?limit|daily free allocation|Uncaught |Command failed with exit code|returned non-zero exit status|FATAL|MemoryError/;
// Marks that indicate the error itself (not a script echo of the command).
const STRONG_MARKERS = /##\[error\]Process completed|Traceback \(most recent call last\)|RuntimeError|ModuleNotFoundError|ImportError|No module named|DAILY LIMIT|daily (free )?limit|daily free allocation|MemoryError|Uncaught /;

function extractEvidence(rawText) {
  // Strip GitHub's timestamp prefix FIRST so the marker/cut patterns below can
  // match at the start of a line, and so the evidence reads cleanly.
  const lines = rawText
    .split("\n")
    .filter((l) => l.trim().length)
    .map((l) => l.replace(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z\s*/, "").slice(0, 400));
  const hits = [];
  const strong = [];
  for (let i = 0; i < lines.length; i++) {
    if (LOG_MARKERS.test(lines[i])) {
      hits.push(i);
      if (STRONG_MARKERS.test(lines[i])) strong.push(i);
    }
  }
  // Prefer the LAST strong error marker: earlier hits are often the workflow
  // echoing its own shell script, and cleanup noise follows the real error.
  const anchor = strong.length ? strong[strong.length - 1] : hits.length ? hits[hits.length - 1] : -1;
  let window;
  if (anchor >= 0) {
    window = lines.slice(Math.max(0, anchor - 6), anchor + 34);
    // Stop at the next workflow step or cleanup boilerplate — everything after
    // the error is unrelated (artifact upload config, git config, job cleanup).
    const cut = window.findIndex(
      (l, i) => i > 0 && (/^##\[group\]/.test(l) || /^\[command\]/.test(l) ||
        /^Post job cleanup\./.test(l) || /^Cleaning up orphan processes/.test(l))
    );
    if (cut > 0) window = window.slice(0, cut);
  } else {
    window = lines.slice(-45);
  }
  return window.join("\n").slice(-2500);
}

// Watch every registered repo for NEW failed runs: one Telegram report per run
// with the failing step, log evidence, a diagnosed cause, a proposed fix and
// the run link. Deduped by run id in D1 so a re-run never re-spams.
async function failureWatch(ctx, opts) {
  opts = opts || {};
  const db = ctx.env.DB;
  const token = ctx.env.HUB_GITHUB_TOKEN;
  const owner = ctx.env.GITHUB_OWNER || "landryparadis012-git";
  const dryRun = opts.dryRun === true || opts.dry_run === "1" || opts.dry_run === "true";
  const sinceHours = Number(opts.sinceHours || 26);
  if (!db) return { found: 0, reports: [], skipped: "no_db" };
  if (!token) return { found: 0, reports: [], skipped: "no_token" };
  const cutoff = Date.now() - sinceHours * 3600000;
  const reports = [];

  for (const name of REPO_NAMES) {
    let runs = [];
    try {
      const j = await ghGet(`/repos/${owner}/${name}/actions/runs?per_page=10`, token);
      runs = j.workflow_runs || [];
    } catch (e) {
      continue;
    }
    for (const run of runs) {
      // cancelled/superseded runs are not real failures — only report true failures
      if (!["failure", "timed_out"].includes(run.conclusion || "")) continue;
      if (Date.parse(run.created_at) < cutoff) continue;
      const key = `fail:${name}:${run.id}`;
      try {
        if (await kvGet(db, key)) continue;
      } catch (e) { /* treat as unseen */ }

      let step = "unknown step";
      let jobId = 0;
      try {
        const jj = await ghGet(`/repos/${owner}/${name}/actions/runs/${run.id}/jobs?per_page=20`, token);
        const bad = (jj.jobs || []).find((x) => x.conclusion === "failure");
        if (bad) {
          jobId = bad.id || 0;
          // Prefer the failing STEP over the job name — that's what broke.
          const badStep = (bad.steps || []).find((s) => s.conclusion === "failure");
          step = (badStep && badStep.name) || bad.name || step;
        }
      } catch (e) { /* jobs list optional */ }

      let logTail = "";
      let logNote = "";
      if (jobId) {
        try {
          const txt = await ghText(`/repos/${owner}/${name}/actions/jobs/${jobId}/logs`, token);
          logTail = extractEvidence(txt.replace(/\r/g, ""));
        } catch (e) {
          logNote = `logs unavailable (${String(e).slice(0, 60)}) — token may lack actions:read`;
        }
      }

      const d = classifyFailure(step, logTail || logNote);
      const text =
        `🚨 SERVICE FAILURE — ${name}\n` +
        `${run.name || "workflow"} · ${ago(run.created_at)} · ${run.conclusion}\n` +
        `step: ${step}\n` +
        `cause: ${d.cause}\n` +
        `fix: ${d.fix}\n\n` +
        (logTail ? `evidence:\n\`\`\`\n${logTail.slice(-1400)}\n\`\`\`\n` : `${logNote || "no log captured"}\n`) +
        `status: diagnosed automatically · 1 alert per run\n` +
        (run.html_url || "");

      reports.push({ repo: name, run_id: run.id, step, cause: d.cause, fix: d.fix, text });
      await recordJob(db, {
        job_id: `run:${name}:${run.id}`,
        service: name,
        kind: "workflow_run",
        status: "failed",
        detail: `${step} — ${d.cause}`,
        url: run.html_url || "",
        created_at: Math.floor(Date.parse(run.created_at) / 1000),
      });

      if (dryRun) continue;
      try {
        const botToken = ctx.env.TELEGRAM_BOT_TOKEN;
        const ownerRow = await kvGet(db, "report_owner");
        const chat = ownerRow ? JSON.parse(ownerRow).chat : null;
        if (botToken && chat) await sendTelegram(botToken, chat, text);
        await kvSet(db, key, nowSec());
      } catch (e) { /* send/dedupe best-effort */ }
    }
  }
  return { found: reports.length, reports, sent: dryRun ? 0 : reports.length };
}

async function webhookHealth(ctx) {
  const tok = (ctx.env.TELEGRAM_BOT_TOKEN || "").trim();
  if (!tok) return null;
  try {
    const r = await fetch("https://api.telegram.org/bot" + tok + "/getWebhookInfo", {
      signal: AbortSignal.timeout(8000),
      headers: { "User-Agent": "OpsHub" },
    });
    const j = await r.json();
    return (j && j.result) || null;
  } catch (e) {
    return null;
  }
}

async function healthText(ctx, settings) {
  const db = ctx.env.DB;
  const statuses = (await repoStatuses(ctx)) || [];
  const out = [`🩺 OpsHub ${VERSION} · ${localParts(new Date(), settings.tz).hhmm} ${settings.place}`];
  out.push("Services:");
  for (const s of statuses) {
    out.push(`${iconFor(s.result, s.state)} ${s.repo} — ${s.result}${s.at ? " " + ago(s.at) : ""}`);
  }
  try {
    const fails = await db
      .prepare("SELECT service, detail, url, updated_at FROM jobs WHERE status = 'failed' ORDER BY updated_at DESC LIMIT 5")
      .all();
    const rows = fails.results || [];
    if (rows.length) {
      out.push("Recent failures:");
      for (const f of rows) out.push(`  ❌ ${f.service} ${ago(new Date(f.updated_at * 1000).toISOString())} — ${f.detail}`);
    }
  } catch (e) { /* ledger unreadable is a health signal, not a crash */ }
  const wh = await webhookHealth(ctx);
  if (wh) {
    out.push(`Telegram webhook: ${wh.url ? "ok" : "unset"} · pending ${wh.pending_update_count ?? 0}${wh.last_error_message ? ` · ⚠️ ${wh.last_error_message}` : ""}`);
  } else {
    out.push("Telegram webhook: unavailable (no bot token?)");
  }
  try {
    const ack = await db.prepare("SELECT COUNT(*) AS n FROM tgacks").first();
    const job = await db.prepare("SELECT COUNT(*) AS n FROM jobs").first();
    out.push(`Ledger: ${job ? job.n : 0} job records · ${ack ? ack.n : 0} pending button acks`);
  } catch (e) { out.push("Ledger: unavailable"); }
  out.push("Commands: /health · /jobs · /status · /report");
  return out.join("\n");
}

async function buildReport(ctx, chatId, mode, settings) {
  mode = mode || "daily";
  const db = ctx.env.DB;
  const statuses = (await repoStatuses(ctx)) || [];
  const now = localParts(new Date(), settings.tz);
  const head =
    mode === "morning" ? `☀️ MORNING BRIEF — ${now.date}`
    : mode === "evening" ? `🌙 DAY REPORT — ${now.date}`
    : `📊 OpsHub Daily Report — ${now.date}`;

  let out = `${head}\n(${settings.place} time ${now.hhmm} · ${settings.tz})\n\n🔨 Studio runs:\n`;
  const todos = [];
  for (const s of statuses) {
    out += `${iconFor(s.result, s.state)} ${s.repo} — ${s.result}${s.at ? ` (${ago(s.at)})` : ""}\n`;
    if (s.result === "failure" || s.result === "timed_out" || s.result === "cancelled") {
      todos.push(`Check ${s.repo} — last run ${s.result}`);
    }
    if (s.state === "none" || s.result === "no runs") {
      todos.push(`Trigger ${s.repo} — it has never run`);
    }
  }

  // trading lifecycle from stored events (real, from icc-engine hub_sync)
  try {
    const dayStart = zonedDayStart(Date.now(), settings.tz);
    const evRows = await db.prepare(
      "SELECT type, payload FROM events WHERE type LIKE 'trade.%' ORDER BY received_at DESC LIMIT 300"
    ).all();
    const openMap = {};
    let closedR = 0, closedN = 0;
    for (const row of evRows.results || []) {
      let p = {};
      try { p = JSON.parse(row.payload); } catch (_) {}
      const tid = p.trade_id || "";
      if (!tid) continue;
      if (row.type === "trade.opened") {
        if (!(tid in openMap)) openMap[tid] = p;
      } else if (row.type === "trade.closed") {
        delete openMap[tid];
        const rr = Number(p.realized_r);
        if (Number.isFinite(rr) && (p.occurred_at || 0) >= dayStart) { closedN++; closedR += rr; }
      }
    }
    const openList = Object.values(openMap);
    out += `\n📈 Trading\n• open: ${openList.length}` +
      (openList.length ? " (" + openList.map((t) => `${t.symbol || "?"} ${t.side || ""}`).join(", ") + ")" : "") +
      ` · closed today: ${closedN}${closedN ? `, ${closedR >= 0 ? "+" : ""}${closedR.toFixed(2)}R` : ""}\n`;
  } catch (e) { /* events table optional */ }

  // weather for planning the day
  try {
    const w = await getWeather(ctx, settings);
    const wl = weatherLine(w, settings);
    if (wl) out += `\n🌤 Weather\n• ${wl}\n`;
  } catch (e) { /* weather optional */ }

  // forex news — the trading-critical part
  try {
    const events = await getFF(ctx);
    const nowS = Math.floor(Date.now() / 1000);
    const up = events
      .filter((e) => e.ts >= nowS && sameLocalDay(e.ts, settings.tz) && e.impact === "High")
      .slice(0, 3);
    const rel = events
      .filter((e) => e.ts < nowS && e.actual && sameLocalDay(e.ts, settings.tz))
      .slice(-2);
    if (up.length || rel.length) {
      out += `\n⚠️ News (high impact, ${settings.place} time):\n`;
      for (const e of up) {
        out += `• ${fmtClock(e.ts, settings.tz)} ${CURRENCIES[e.country] || e.country} — ${e.title}` +
          `${e.forecast ? ` (f ${e.forecast} · p ${e.previous})` : ""}\n`;
        const delta = e.ts - nowS;
        if (delta < 5400) todos.push(`${e.title} in ${Math.round(delta / 60)}m — no new entries before it`);
      }
      for (const e of rel) {
        out += `• released ${fmtClock(e.ts, settings.tz)} ${CURRENCIES[e.country] || e.country} — ${e.title}: actual ${e.actual}${e.forecast ? ` vs f ${e.forecast}` : ""}\n`;
      }
    }
  } catch (e) { /* calendar optional */ }

  // reminders due in next 24h
  let rows = [];
  try {
    rows = await listReminders(db, chatId);
  } catch (e) { /* table may not exist yet */ }
  const soon = Math.floor(Date.now() / 1000) + 86400;
  const dueSoon = rows.filter((r) => r.due_at <= soon);
  out += `\n⏰ Reminders (next 24h):\n`;
  out += dueSoon.length
    ? dueSoon.map((r) => `• #${r.id} ${fmtDue(r.due_at, settings)} — ${r.text}`).join("\n")
    : "• none";

  // recent dispatches from D1
  try {
    const rec = await db
      .prepare("SELECT repo, series, episode, dispatched_at FROM dispatched ORDER BY id DESC LIMIT 5")
      .all();
    const recs = rec.results || [];
    if (recs.length) {
      out += `\n\n📤 Recent dispatches:\n`;
      out += recs
        .map(
          (r) =>
            `• ${r.repo}${r.series ? ` : ${r.series}` : ""}${r.episode ? ` ep${r.episode}` : ""} (${ago(r.dispatched_at)})`
        )
        .join("\n");
    }
  } catch (e) { /* dispatched table optional */ }

  const todoHead = mode === "evening" ? "📌 First thing tomorrow" : "✅ Do first";
  if (todos.length) {
    out += `\n\n${todoHead}:\n` + todos.map((t, i) => `${i + 1}. ${t}`).join("\n");
  } else {
    out += `\n\n${todoHead}:\n• All green — nothing needs you today.`;
  }
  return out.slice(0, 4000);
}

// ---------------- AI context + protocol ----------------
async function aiContext(db, chatId, settings, statuses, reminders) {
  const now = localParts(new Date(), settings.tz);
  const [w, headlines, cal, log] = await Promise.all([
    getWeather({ env: { DB: db } }, settings).catch(() => null),
    getHeadlines({ env: { DB: db } }).catch(() => ({ items: [], feeds: [] })),
    getFF({ env: { DB: db } }).catch(() => []),
    getChatLog(db, chatId),
  ]);
  const runLine = (statuses || [])
    .map((s) => `${s.repo}: ${s.result}${s.at ? ` (${ago(s.at)})` : ""}`)
    .join("; ");
  const remLine = reminders.length
    ? reminders
        .map(
          (r) =>
            `#${r.id} ${fmtDue(r.due_at, settings)}${repeatLabel(r.repeat_h)}: "${r.text}"`
        )
        .join("; ")
    : "none";
  const nowS = Math.floor(Date.now() / 1000);
  const upcoming = cal
    .filter((e) => e.ts >= nowS && e.ts < nowS + 86400 && e.impact === "High")
    .slice(0, 6)
    .map((e) => ffEventLine(e, settings))
    .join("\n  ");
  const released = cal
    .filter((e) => e.ts < nowS && e.ts > nowS - 86400 && e.actual)
    .slice(-3)
    .map((e) => ffEventLine(e, settings))
    .join("\n  ");
  const heads = (headlines.items || [])
    .slice(0, 8)
    .map((h) => `[${h.feed}] ${h.title}`)
    .join("\n  ");
  const history = log
    .map((m) => `${m.r === "user" ? "User" : "OpsHub"}: ${m.t}`)
    .join("\n  ");
  return `LIVE CONTEXT (real — never invent beyond this):
- Now: ${now.weekday} ${now.date} ${now.hhmm} in ${settings.place} (${settings.tz})
- Weather: ${weatherLine(w, settings) || "unavailable"}
- Forex news — upcoming 24h (High impact, ${settings.place} time):
  ${upcoming || "none listed"}
- Released last 24h:
  ${released || "none"}
- Headlines (${(headlines.feeds || []).join(", ") || "none"}):
  ${heads || "none"}
- Active reminders: ${remLine}
- Latest GitHub run per repo: ${runLine || "unavailable"}
- Recent chat:
  ${history || "(empty)"}`;
}

function aiRules(settings) {
  return `RULES:
- All times you mention are in ${settings.tz} — ${settings.place} local — matching LIVE CONTEXT.
- Reports and to-do lists: answer ONLY from LIVE CONTEXT. Never invent tasks, metrics, news, prices or headlines; if something isn't in context, say you don't have it.
- Trading: factor the news calendar in. Warn against opening positions within 30 minutes before a High-impact release; after releases, reason from actual vs forecast values shown. Keep it factual.
- The user lives in / travels to different places: if they say they are now in / moved to / landed in <place>, or ask you to remember where they are, reply with ONLY this line: WHERE:<place>
- If they ask to set/confirm the timezone, reply ONLY: TZ:<IANA name>
- If they ask about the weather, reply ONLY: WEATHER:
- If they ask for directions or how to get somewhere, reply ONLY: DIRECTIONS:<from> to <to> (use their saved place as <from> when they don't say it; mention walking only if they asked to walk)
- If they ask about an area / neighborhood / what's around somewhere, reply ONLY: AREA:<place>
- If they ask what news is coming out / forex calendar / any economic events, reply ONLY: NEWS:
- If they ask for news headlines / articles / "what's in the news", reply ONLY: HEADLINES:
- ONLY when the user explicitly asks to delete/cancel/remove an EXISTING reminder, reply ONLY: DELETE:<id> (pick the id from Active reminders; "it"/"that" with one obvious candidate → that id; if none exist, reply normally that there are no reminders).
- ONLY when the user asks for a reminder within hours/days ("in 2 hours", "tomorrow in 3h"), reply ONLY: REMIND:<hours>:<repeat_h or 0>:<text>
- ONLY when the user asks for a reminder at a clock time ("at 15:30", "every day at 08:00", "every Monday 09:00" → next occurrence), reply ONLY: REMINDAT:<YYYY-MM-DD HH:MM>:<repeat_h or 0>:<text> — compute the date/time in ${settings.tz}; use repeat 1440 for daily, 0 for once.
- If you emit a protocol line, emit NOTHING else (one line only).
- Otherwise: concise, friendly, plain text. Max 150 words. No markdown tables.`;
}

// Executes at most 2 protocol actions from an AI reply.
// Returns { text, acted } — text is what to send the user.
async function runProtocol(aiReply, chatId, ctx, settings) {
  const db = ctx.env.DB;
  const actions = [];
  const send = (s) => actions.push(s);
  let remaining = String(aiReply || "");

  const del = remaining.match(/^\s*DELETE:\s*(\d+)\s*$/m);
  const rem = remaining.match(/^\s*REMIND:\s*([\d.]+):(\d*):(.+)$/m);
  const remAt = remaining.match(/^\s*REMINDAT:\s*([^\s:]+(?:\s+\d{1,2}:\d{2})):(\d*):(.+)$/m);
  const where = remaining.match(/^\s*WHERE:\s*(.+)$/m);
  const tz = remaining.match(/^\s*TZ:\s*(\S+)$/m);
  const wantsWeather = /^\s*WEATHER:\s*$/m.test(remaining);
  const wantsNews = /^\s*NEWS:\s*$/m.test(remaining);
  const wantsHeads = /^\s*HEADLINES:\s*$/m.test(remaining);
  const dir = remaining.match(/^\s*DIRECTIONS:\s*(.+?)\s+to\s+(.+)$/m);
  const area = remaining.match(/^\s*AREA:\s*(.+)$/m);

  let acted = false;

  if (del && actions.length < 2) {
    acted = true;
    try {
      const row = await deleteReminder(db, chatId, parseInt(del[1], 10));
      send(row
        ? `✅ Reminder #${row.id} cancelled: "${row.text}"`
        : `No active reminder #${del[1]}. /reminders shows what's active.`);
    } catch (e) { send("Could not delete: " + String(e).slice(0, 100)); }
  } else if (rem && actions.length < 2) {
    acted = true;
    try {
      const hours = parseFloat(rem[1]);
      const repeatH = parseInt(rem[2] || "0", 10) || 0;
      const body = rem[3].trim();
      const r = await addReminder(db, chatId, body, hours, repeatH);
      send(`✅ Reminder #${r.id} set for ${fmtClock(r.due, settings.tz)} ${settings.place} time${repeatLabel(repeatH)}:\n"${body}"`);
    } catch (e) { send("Could not store reminder: " + String(e).slice(0, 100)); }
  } else if (remAt && actions.length < 2) {
    acted = true;
    try {
      const when = remAt[1].trim();
      const repeatH = parseInt(remAt[2] || "0", 10) || 0;
      const body = remAt[3].trim();
      let epoch = zonedTimeToEpoch(when, settings.tz);
      if (epoch == null) {
        send(`Couldn't read the time "${when}". Say e.g. "at 15:30" or "every day at 08:00".`);
      } else {
        const nowS = Math.floor(Date.now() / 1000);
        if (epoch <= nowS) {
          if (repeatH > 0) {
            while (epoch <= nowS) epoch += repeatH * 3600;
          } else {
            send(`That time (${when}) already passed in ${settings.place}. Give a future time.`);
            epoch = null;
          }
        }
        if (epoch) {
          const r = await addReminder(db, chatId, body, (epoch - nowS) / 3600, repeatH, epoch);
          send(`✅ Reminder #${r.id} set for ${fmtClock(r.due, settings.tz)} ${settings.place} time${repeatLabel(repeatH)}:\n"${body}"`);
        }
      }
    } catch (e) { send("Could not store reminder: " + String(e).slice(0, 100)); }
  }

  if (where && actions.length < 2) {
    acted = true;
    const placeQ = where[1].trim().replace(/[.!?]+$/, "");
    try {
      const geo = await geocode(placeQ);
      if (geo) {
        const tzOf = await lookupTz(placeQ, geo.country);
        const s2 = await saveSettings(db, {
          place: geo.label.split(",")[0].trim(),
          lat: geo.lat, lon: geo.lon,
          ...(tzOf && tzValid(tzOf) ? { tz: tzOf } : {}),
        });
        const p = localParts(new Date(), s2.tz);
        send(`📍 Location updated: ${s2.place} (${s2.lat.toFixed(2)}, ${s2.lon.toFixed(2)})\nTimezone: ${s2.tz} — local time now ${p.hhmm}.\nWeather, report windows and news alerts all shifted with you.`);
      } else {
        send(`Couldn't find "${placeQ}" — give me a clearer place name (city + country).`);
      }
    } catch (e) { send("Location update failed: " + String(e).slice(0, 100)); }
  }

  if (tz && actions.length < 2) {
    acted = true;
    const z = tz[1].trim();
    if (tzValid(z)) {
      const s2 = await saveSettings(db, { tz: z });
      const p = localParts(new Date(), s2.tz);
      send(`✅ Timezone set to ${z} — local time now ${p.hhmm} (${p.weekday} ${p.date}).`);
    } else {
      send(`"${z}" isn't a valid timezone. Example: Europe/Nicosia, Europe/Istanbul, Asia/Dubai.`);
    }
  }

  if (wantsWeather && actions.length < 2) {
    acted = true;
    send(await weatherTextCmd(ctx, settings));
  }
  if (wantsNews && actions.length < 2) {
    acted = true;
    send(await newsBlock(ctx, settings, { limit: 8 }));
  }
  if (wantsHeads && actions.length < 2) {
    acted = true;
    const h = await getHeadlines(ctx, true).catch(() => null);
    send(headlinesText(h, 10));
  }
  if (dir && actions.length < 2) {
    acted = true;
    const from = dir[1].trim() || settings.place;
    send(await directionsText(from, dir[2].trim(), /walk/i.test(from + " " + dir[2]), settings));
  }
  if (area && actions.length < 2) {
    acted = true;
    send(await areaText(area[1].trim()));
  }

  if (!acted) return { text: aiReply, acted: false };
  // strip protocol lines from whatever the model also said
  const stripped = remaining
    .split("\n")
    .filter((l) => !/^\s*(DELETE|REMIND|REMINDAT|WHERE|TZ|WEATHER|NEWS|HEADLINES|DIRECTIONS|AREA)\s*:/i.test(l))
    .join("\n")
    .trim();
  const parts = actions.slice(0, 2);
  if (stripped.length > 3) parts.push(stripped);
  return { text: parts.join("\n\n"), acted: true };
}

// ---------------- slash command handling ----------------
async function handleCommand(text, chatId, ctx, settings) {
  const db = ctx.env.DB;

  if (text === "/repos") {
    return "Registered repos:\n" + REPOS.map((r) => `• ${r.name} (${r.event})`).join("\n");
  }
  if (text === "/status") {
    const statuses = (await repoStatuses(ctx)) || [];
    const lines = [`Hub status: OK`, `Version: ${VERSION}`, `Mode: Telegram-first`, `Location: ${settings.place} (${settings.tz})`, `Local time: ${localParts(new Date(), settings.tz).hhmm}`, `Reminders: D1-backed (swept every 5m by Convex cron)`, `News alerts: 45m before High impact`, ``, `Services (last run per repo):`];
    for (const s of statuses) {
      const icon = iconFor(s.result, s.state);
      const when = s.at ? ago(s.at) : "";
      lines.push(`${icon} ${s.repo} — ${s.result}${when ? ` (${when})` : ""}${s.state === "in_progress" || s.state === "queued" ? ` (${s.state})` : ""}`);
    }
    return lines.join("\n");
  }
  if (text === "/health") {
    try { return await healthText(ctx, settings); }
    catch (e) { return "Health check failed: " + String(e).slice(0, 120); }
  }
  if (/^\/jobs\b/.test(text)) {
    const limit = parseInt((text.match(/\d+/) || [15])[0], 10);
    try {
      const rows = await listJobs(db, limit);
      if (!rows.length) return "No job records yet — the ledger fills as studios and ICC report in.";
      const head = `📒 Last ${rows.length} job records (newest first):\n`;
      return head + rows.map((r) => {
        const when = ago(new Date(r.updated_at * 1000).toISOString());
        const icon = r.status === "failed" ? "❌" : r.status === "duplicate" || r.status === "recorded" ? "✅" : "•";
        return `${icon} ${r.service} · ${r.kind} · ${r.status} · ${when}\n   ${(r.detail || "").replace(/\s+/g, " ").slice(0, 140)}`;
      }).join("\n");
    } catch (e) {
      return "Could not read the job ledger: " + String(e).slice(0, 120);
    }
  }
  if (text === "/close") {
    if (!db) return "No database — can't close trades here.";
    try {
      await ensureTables(db);
      const chat = String(chatId);
      const data = "C|close";
      const existing = await db
        .prepare("SELECT id FROM tgacks WHERE target = 'icc' AND data = ? AND chat_id = ? ORDER BY id DESC LIMIT 1")
        .bind(data, chat)
        .first();
      if (existing) {
        return "Close already queued for this chat — the engine applies it on its next scan. Use /status for service health.";
      }
      await db
        .prepare("INSERT INTO tgacks(target,data,chat_id,message_id,created_at) VALUES(?,?,?,?,?)")
        .bind("icc", data, chat, "cmd-close-" + Math.floor(Date.now() / 1000), Math.floor(Date.now() / 1000))
        .run();
      await recordJob(db, {
        job_id: `ack:close:${chat}:${Math.floor(Date.now() / 1000)}`,
        service: "icc-engine",
        kind: "telegram_command",
        status: "C|close",
        detail: `typed /close by chat ${chat} → relayed to /acks for the next engine scan`,
      });
      return "✅ Close queued — icc-engine applies C|close on its next scan (closes the most recent open trade).";
    } catch (e) {
      return "Could not queue close: " + String(e).slice(0, 120);
    }
  }
  if (text === "/report" || text === "/daily") {
    try {
      const cur = await kvGet(db, "report_owner");
      if (!cur) await kvSet(db, "report_owner", { chat: String(chatId), setAt: Date.now() });
    } catch (e) { /* registration best-effort */ }
    return buildReport(ctx, chatId, "daily", settings);
  }
  if (text === "/reminders") {
    try {
      return remindersText(await listReminders(db, chatId), settings);
    } catch (e) {
      return "Reminders unavailable: " + String(e).slice(0, 120);
    }
  }
  if (/^\/remind\s+\d+/.test(text)) {
    const m = text.match(/^\/remind\s+(\d+(?:\.\d+)?)\s+(?:every\s+)?(.+)$/);
    if (!m) return "Usage:\n/remind 48 <text>\n/remind 24 every <text>";
    const hours = parseFloat(m[1]);
    const body = m[2].trim();
    const repeat = /\bevery\b/.test(text);
    try {
      const r = await addReminder(db, chatId, body, hours, repeat ? Math.max(1, Math.round(hours)) : 0);
      return `✅ Reminder #${r.id} set${repeat ? ` (repeats every ${Math.round(hours)}h)` : ""} for ${fmtClock(r.due, settings.tz)} ${settings.place} time:\n"${body}"`;
    } catch (e) {
      return "Could not store reminder: " + String(e).slice(0, 120);
    }
  }
  if (/^\/delete\s+\d+/.test(text)) {
    const id = parseInt(text.match(/^\/delete\s+(\d+)/)[1], 10);
    try {
      const row = await deleteReminder(db, chatId, id);
      return row
        ? `✅ Reminder #${id} cancelled: "${row.text}"`
        : `No active reminder #${id}. Use /reminders to see active ones.`;
    } catch (e) {
      return "Could not delete: " + String(e).slice(0, 120);
    }
  }
  if (text.startsWith("/forget ")) {
    const chain = text.substring(8).trim();
    try {
      const res = await db
        .prepare("DELETE FROM dispatched WHERE series = ? OR repo = ?")
        .bind(chain, chain)
        .run();
      const n = (res.meta && res.meta.changes) || 0;
      return n
        ? `✅ Chain "${chain}" forgotten — ${n} dispatch record(s) cleared; it can fire again.`
        : `Nothing found for chain "${chain}".`;
    } catch (e) {
      return "Could not forget: " + String(e).slice(0, 120);
    }
  }
  if (text === "/weather") return weatherTextCmd(ctx, settings);
  if (text === "/news") return newsBlock(ctx, settings, { limit: 8 });
  if (text === "/headlines") {
    const h = await getHeadlines(ctx, false).catch(() => null);
    return headlinesText(h, 10);
  }
  if (text.startsWith("/push")) {
    const parts = text.trim().split(/\s+/);
    const platform = parts[1]?.toLowerCase();
    const epId = parts[2];
    if (!platform || !epId) {
      return "Usage: /push yt <episode-id> /push tiktok <episode-id>";
    }
    try {
      await kvSet(db, "pending_upload:" + chatId, JSON.stringify({ platform, episodeId: epId, setAt: Date.now() }));
      return `✅ Pending upload set: ${platform === 'yt' ? 'YouTube' : platform === 'tiktok' ? 'TikTok' : platform} for episode ${epId}\n\nUpload the video to the corresponding drafts from your device when ready.`;
    } catch (e) {
      return "Failed to set pending upload: " + String(e).slice(0, 80);
    }
  }
  if (/^\/time\b/.test(text)) {
    const arg = text.replace(/^\/time\s*/, "").trim();
    if (!arg) {
      const p = localParts(new Date(), settings.tz);
      return `🕐 ${p.hhmm} ${p.weekday} ${p.date} — ${settings.place} (${settings.tz})`;
    }
    const g = await (async () => {
      try {
        const r = await fetch(
          "https://geocoding-api.open-meteo.com/v1/search?count=1&language=en&name=" + encodeURIComponent(arg),
          { signal: abort2(6000) }
        );
        const j = await r.json();
        return j.results && j.results[0] ? j.results[0] : null;
      } catch (e) { return null; }
    })();
    if (!g) return `Couldn't find "${arg}".`;
    const tzOf = (g.timezone && tzValid(g.timezone)) ? g.timezone : COUNTRY_TZ[String(g.country || "").trim()];
    if (!tzOf) return `Found ${g.name}${g.country ? `, ${g.country}` : ""} but couldn't detect its timezone. Coordinates: ${g.latitude}, ${g.longitude}`;
    const p = localParts(new Date(), tzOf);
    return `🕐 ${p.hhmm} ${p.weekday} ${p.date} in ${g.name}${g.country ? `, ${g.country}` : ""} (${tzOf})`;
  }
  if (/^\/tz\b/.test(text)) {
    const z = text.replace(/^\/tz\s*/, "").trim();
    if (!z) return `Current timezone: ${settings.tz}. Set with /tz Europe/Istanbul`;
    if (!tzValid(z)) return `"${z}" isn't a valid timezone. Example: /tz Europe/Istanbul`;
    await saveSettings(db, { tz: z });
    const p = localParts(new Date(), z);
    return `✅ Timezone: ${z} — local time now ${p.hhmm} (${p.weekday} ${p.date}).`;
  }
  if (/^\/where\b/.test(text)) {
    const q = text.replace(/^\/where\s*/, "").trim();
    if (!q) {
      return `Current location: ${settings.place} (${settings.lat}, ${settings.lon}) · ${settings.tz}\nSet a new one with /where <city or place>`;
    }
    const geo = await geocode(q);
    if (!geo) return `Couldn't find "${q}". Try /where Limassol or /where "Berlin, Germany".`;
    const tzOf = await lookupTz(q, geo.country);
    const s2 = await saveSettings(db, {
      place: geo.label.split(",")[0].trim(), lat: geo.lat, lon: geo.lon,
      ...(tzOf ? { tz: tzOf } : {}),
    });
    const p = localParts(new Date(), s2.tz);
    const warn = tzOf ? "" : "\n⚠️ Could not auto-detect the timezone — set it with /tz <IANA> (e.g. /tz Europe/Nicosia).";
    return `📍 Location: ${geo.label}\nTimezone ${s2.tz} — local time ${p.hhmm}. Weather, times and news alerts now follow this place.${warn}`;
  }
  if (/^\/(directions|nav)\b/.test(text)) {
    const arg = text.replace(/^\/(directions|nav)\s*/, "").trim();
    if (!arg) return "Usage: /directions <from> to <to>\nExample: /directions Nicosia to Limassol";
    const m = arg.match(/^(.+?)\s+(?:to|->|→)\s+(.+)$/);
    const from = m ? m[1] : settings.place;
    const to = m ? m[2] : arg;
    return directionsText(from, to, false, settings);
  }
  if (/^\/walk\b/.test(text)) {
    const arg = text.replace(/^\/walk\s*/, "").trim();
    const m = arg.match(/^(.+?)\s+(?:to|->|→)\s+(.+)$/);
    const from = m ? m[1] : settings.place;
    const to = m ? m[2] : arg;
    if (!to) return "Usage: /walk <from> to <to>";
    return directionsText(from, to, true, settings);
  }
  if (/^\/area\b/.test(text)) {
    const q = text.replace(/^\/area\s*/, "").trim();
    if (!q) return "Usage: /area <place> — what's around there";
    return areaText(q);
  }
  if (text === "/start" || text === "/help") {
    return `👋 OpsHub v${VERSION}

Commands:
/report — daily report (runs, trading, weather, news, reminders, to-dos)
/reminders · /remind 48 <text> · /remind 24 every <text> · /delete <id>
/weather — now + today/tomorrow where you are
/news — forex calendar (Forex Factory), times in YOUR time
/headlines — free news articles (BBC, ForexLive, Al Jazeera, DW, CNN)
/push yt <ep> · /push tiktok <ep> — mark episode for manual draft upload
/directions <from> to <to> · /walk <from> to <to> · /area <place>
/where <place> — move OpsHub with you (time, weather, alerts shift)
/tz <IANA> — set timezone · /time [place] — what time is it there
/health · /jobs · /repos · /status · /forget <chain>

Or just talk to me: "I'm in Turkey now", "remind me every day at 08:00",
"delete it", "any news before I trade?", "how do I get to Limassol?"`;
  }
  if (text.startsWith("/")) {
    return "Unknown command. Use /start for the list, or just ask me in plain words.";
  }
  return null;
}

function abort2(ms) {
  return AbortSignal.timeout(ms);
}

// ---------------- Telegram webhook ----------------
// The Telegram webhook handler. Registered under BOTH spellings: the
// register-webhook workflow posts to /telegram (with an optional
// x-telegram-bot-api-secret-token), older setups used /_telegram.
const telegramHandler = async (ctx) => {
  try {
    const ws = ctx.env.TELEGRAM_WEBHOOK_SECRET;
    if (ws && ctx.req.header("x-telegram-bot-api-secret-token") !== ws) {
      return ctx.json({ error: "forbidden" }, 403);
    }
    const update = await ctx.req.json();
    const botToken = ctx.env.TELEGRAM_BOT_TOKEN;
    const db = ctx.env.DB;
    const settings = db ? await getSettings(db) : { ...DEFAULT_SETTINGS };
    const echo = ctx.req.query("echo") === "1"; // test mode: no Telegram delivery

    let reply = null;
    let chatId = null;
    let needsAI = false;
    let userText = "";

    if (update.message && update.message.text) {
      const text = update.message.text.trim();
      chatId = update.message.chat.id;
      userText = text;

      if (db && text.startsWith("/")) {
        try { await ensureTables(db); } catch (e) { /* surfaced below if critical */ }
        reply = await handleCommand(text, chatId, ctx, settings);
      } else {
        needsAI = true;
      }
    }

    if (update.callback_query) {
      chatId = update.callback_query.message.chat.id;
      const data = update.callback_query.data || "";
      const cbId = update.callback_query.id || "";
      const msgId = String(update.callback_query.message.message_id || "");
      // Telegram keeps a pressed button spinning until it is answered — always ack.
      const answerCb = async (toast) => {
        if (!botToken || !cbId) return;
        try {
          await fetch("https://api.telegram.org/bot" + botToken + "/answerCallbackQuery", {
            method: "POST",
            headers: { "Content-Type": "application/json", "User-Agent": "OpsHub" },
            body: JSON.stringify({
              callback_query_id: cbId,
              ...(toast ? { text: toast } : {}),
            }),
          });
        } catch (e) { /* best-effort */ }
      };

      if (data.startsWith("delete:") && db) {
        const id = parseInt(data.substring(7), 10);
        try {
          await ensureTables(db);
          const row = await deleteReminder(db, chatId, id);
          reply = row
            ? `✅ Reminder #${id} cancelled: "${row.text}"`
            : `No active reminder #${id}.`;
        } catch (e) {
          reply = "Could not delete: " + String(e).slice(0, 120);
        }
        await answerCb();
      } else if (/^T\|(take|risky|no|both|swap|cswap|tpup)$|^C\|close/.test(data) && db) {
        // icc-engine setup-card buttons: store the choice; the engine's next
        // scan pulls it from POST /acks and applies it via handle_ack().
        try {
          await ensureTables(db);
          await db
            .prepare(
              "INSERT OR IGNORE INTO tgacks(target,data,chat_id,message_id,created_at) VALUES(?,?,?,?,?)"
            )
            .bind("icc", data, String(chatId), msgId, Math.floor(Date.now() / 1000))
            .run();
          await recordJob(db, {
            job_id: `ack:${msgId}:${data}`,
            service: "icc-engine",
            kind: "telegram_button",
            status: data,
            detail: `pressed by chat ${chatId} → relayed to /acks for the next engine scan`,
          });
          if (echo) {
            const c = await db
              .prepare("SELECT COUNT(*) AS n FROM tgacks WHERE target = 'icc'")
              .first();
            reply = `ack stored: ${data} | msg ${msgId} | icc acks in db: ${c ? c.n : "?"}`;
          }
          await answerCb("✅ Recorded — icc-engine applies it on its next scan.");
        } catch (e) {
          await answerCb("Could not record: " + String(e).slice(0, 60));
        }
      } else {
        await answerCb();
      }
    }

    // AI path: ack fast, resolve in background with live context + protocol.
    // ?echo=1 runs it synchronously and returns the text instead of sending
    // (test hook — verifies context/protocol without spamming a chat).
    if (needsAI) {
      const work = (async () => {
        const groqKey = ctx.env.GROQ_API_KEY;
        if (!groqKey) return "AI is not configured.";
        try {
          await ensureTables(db);
          await pushChatLog(db, chatId, "user", userText);
          const [statuses, reminders] = await Promise.all([
            repoStatuses(ctx).catch(() => null),
            listReminders(db, chatId).catch(() => []),
          ]);
          const context = await aiContext(db, chatId, settings, statuses, reminders);
          const messages = [
            { role: "system", content: `You are OpsHub, a personal Telegram operations assistant (AI studio fleet + trading + daily planning).\n\n${context}\n\n${aiRules(settings)}` },
            { role: "user", content: userText },
          ];
          const aiReply = await callGroq(groqKey, messages);
          if (!aiReply) return "AI had an issue. Try /start for commands.";
          const out = await runProtocol(aiReply, chatId, ctx, settings);
          const finalText = out.text || aiReply;
          await pushChatLog(db, chatId, "bot", finalText);
          return finalText;
        } catch (e) {
          console.error("Groq AI error:", e);
          return "AI is having issues. Try /start for commands.";
        }
      })();

      if (echo) {
        const text = await work;
        return ctx.json({ status: "ok", reply: text }, 200);
      }

      if (botToken && chatId) {
        try {
          await fetch("https://api.telegram.org/bot" + botToken + "/sendChatAction", {
            method: "POST",
            headers: { "Content-Type": "application/json", "User-Agent": "OpsHub" },
            body: JSON.stringify({ chat_id: chatId, action: "typing" }),
          });
        } catch (e) { /* best-effort */ }
      }
      ctx.executionCtx.waitUntil(
        work.then((t) => (botToken && chatId ? sendTelegram(botToken, chatId, t) : null))
      );
      return ctx.json({ status: "ok" }, 200);
    }

    if (reply && chatId && botToken && !echo) {
      await sendTelegram(botToken, chatId, reply);
    }

    return ctx.json({ status: "ok", reply: reply || undefined }, 200);
  } catch (e) {
    console.error("Telegram webhook error:", e);
    return ctx.json({ status: "ok", error: String((e && e.message) || e) }, 200);
  }
};
app.all("/_telegram", telegramHandler);
app.all("/telegram", telegramHandler);

// ---------------- button-ack relay (icc-engine pulls these each scan) --------
// Telegram delivers callback queries to this webhook, but icc-engine can only
// read them via getUpdates while its workflow run is alive — so presses are
// stored here and the engine claims them with an HMAC-signed POST /acks.
//   {"op":"list"}                     -> {acks:[{id,data,created_at}]}
//   {"op":"consume","ids":[1,2,3]}    -> {ok:true, consumed:n}
app.post("/acks", async (ctx) => {
  try {
    const raw = await ctx.req.text();
    const secret = ctx.env.HUB_WEBHOOK_SECRET;
    if (!secret) {
      if (ctx.env.DB) await ensureTables(ctx.env.DB);
      return ctx.json(HTTP_UNAVAILABLE, 503);
    }
    const ok = await verifySignature(
      raw, ctx.req.header("x-hub-signature-256") || "", secret
    );
    if (!ok) return ctx.json({ error: "invalid signature" }, 401);
    if (!ctx.env.DB) return ctx.json({ error: "No DB" }, 500);
    let body;
    try { body = JSON.parse(raw); } catch (_) { return ctx.json({ error: "bad json" }, 400); }
    await ensureTables(ctx.env.DB);

    if (body.op === "consume") {
      const ids = (Array.isArray(body.ids) ? body.ids : [])
        .map(Number)
        .filter((n) => Number.isFinite(n));
      if (!ids.length) return ctx.json({ ok: true, consumed: 0 });
      const ph = ids.map(() => "?").join(",");
      const res = await ctx.env.DB
        .prepare(`DELETE FROM tgacks WHERE target = 'icc' AND id IN (${ph})`)
        .bind(...ids)
        .run();
      return ctx.json({ ok: true, consumed: (res.meta && res.meta.changes) || 0 });
    }

    const rows = await ctx.env.DB
      .prepare("SELECT id, data, created_at FROM tgacks WHERE target = 'icc' ORDER BY id ASC LIMIT 50")
      .all();
    return ctx.json({ acks: rows.results || [] });
  } catch (e) {
    return ctx.json({ error: String(e).slice(0, 200) }, 500);
  }
});

// ---------------- sweep: Convex cron pings this every 5 minutes ----------------
app.post("/sweep", async (ctx) => {
  if (!ctx.env.DB) return ctx.json({ error: "No DB" }, 500);
  try {
    await ensureTables(ctx.env.DB);
    const now = Math.floor(Date.now() / 1000);
    const due = await ctx.env.DB
      .prepare(
        "SELECT id, chat_id, text, due_at, repeat_h FROM reminders WHERE active = 1 AND due_at <= ? LIMIT 20"
      )
      .bind(now)
      .all();
    const rows = due.results || [];
    const botToken = ctx.env.TELEGRAM_BOT_TOKEN;
    let fired = 0;
    for (const r of rows) {
      if (botToken) {
        const ok = await sendTelegram(botToken, r.chat_id, `⏰ Reminder #${r.id}: ${r.text}`);
        if (!ok) continue;
      }
      if (r.repeat_h > 0) {
        let next = r.due_at;
        while (next <= now) next += r.repeat_h * 3600;
        await ctx.env.DB
          .prepare("UPDATE reminders SET due_at = ? WHERE id = ?")
          .bind(next, r.id)
          .run();
      } else {
        await ctx.env.DB
          .prepare("UPDATE reminders SET active = 0 WHERE id = ?")
          .bind(r.id)
          .run();
      }
      fired++;
    }
    let alerts = 0;
    try { alerts = await newsAlerts(ctx); } catch (e) { /* alerts best-effort */ }
    let post = 0;
    try { post = await newsPost(ctx); } catch (e) { /* post-release best-effort */ }    let fails = { found: 0, sent: 0 };
    try { fails = await failureWatch(ctx); } catch (e) { console.error("failureWatch:", e); }

    // Self-heal icc-engine: GitHub's scheduled cron misses slots (it went
    // 90+ minutes without a run today), so if the last scan is >20min old
    // and nothing is queued/running, re-dispatch it ourselves.
    let icc = "skipped";
    try {
      const token = ctx.env.HUB_GITHUB_TOKEN;

      if (token) {

        const j = await ghGet("/repos/landryparadis012-git/icc-engine/actions/runs?per_page=3", token);
        const runs = j.workflow_runs || [];
        const active = runs.some((r) => r.status === "queued" || r.status === "in_progress");
        const last = runs[0] ? Date.parse(runs[0].created_at) : 0;
        const staleMin = last ? (Date.now() - last) / 60000 : 1e9;
        const dispRaw = await kvGet(ctx.env.DB, "icc_dispatch");
        const dispT = dispRaw ? (JSON.parse(dispRaw).t || 0) : 0;
        const dispAgeMin = Date.now() / 1000 / 60 - dispT / 60;
        if (!active && staleMin > 20 && dispAgeMin > 20) {
          const ok = await dispatchGitHub(token, "icc-engine", "icc.run", {
            reason: "sweep self-heal", staleMin: Math.round(staleMin),
          });
          if (ok) {
            await kvSet(ctx.env.DB, "icc_dispatch", { t: Math.floor(Date.now() / 1000) });
            icc = "dispatched";
          } else icc = "dispatch_failed";
        } else icc = active ? "running" : "fresh";
      } else icc = "no_token";
    } catch (e) { icc = "error:" + String(e).slice(0, 40); }

    return ctx.json({ status: "ok", due: rows.length, fired, alerts, post, fails: fails.found, icc });
  } catch (e) {
    console.error("Sweep error:", e);
    return ctx.json({ error: String(e).slice(0, 200) }, 500);
  }
});

// ---------------- ingest (dedup + HMAC events) ----------------
app.post("/ingest", async (ctx) => {
  try {
    const raw = await ctx.req.text();
    let body;
    try { body = JSON.parse(raw); } catch (_) { return ctx.json({ error: "bad json" }, 400); }
    const token = ctx.env.HUB_GITHUB_TOKEN;

    const secret = ctx.env.HUB_WEBHOOK_SECRET;
    if (!secret) {
      if (ctx.env.DB) await ensureTables(ctx.env.DB);
      return ctx.json(HTTP_UNAVAILABLE, 503);
    }
    const sigOk = await verifySignature(
      raw, ctx.req.header("x-hub-signature-256") || "", secret
    );
    if (!sigOk) return ctx.json({ error: "invalid signature" }, 401);
    if (!ctx.env.DB) return ctx.json({ status: "ok", event: body.type, stored: false }, 200);
    await ensureTables(ctx.env.DB);
    const r = await storeEvent(ctx.env.DB, body);
    await recordJob(ctx.env.DB, {
      job_id: body.event_id || `${body.type}:${body.repo || "hub"}`,
      service: body.repo || "hub",
      kind: body.type,
      status: r.stored ? "recorded" : "duplicate",
      detail: JSON.stringify(body).slice(0, 500),
    });
    return ctx.json({ status: "ok", event: body.type, ...r }, 200);
  } catch (e) {
    console.error("Ingest error:", e);
    return ctx.json({ error: "internal error" }, 500);
  }
  if (!token || !body.repo) {
    return ctx.json({ error: "missing token or repo" }, 400);
  }

  const seriesName = body.client_payload?.series_name || "";
  const episode = body.client_payload?.episode || "";
  const dedupKey = body.repo + ":" + seriesName + ":" + episode;

  if (ctx.env.DB) {
    try {
      await ensureTables(ctx.env.DB);
      const existing = await ctx.env.DB
        .prepare("SELECT id FROM dispatched WHERE dedup_key = ?")
        .bind(dedupKey).first();

      if (existing) {
        return ctx.json({
          status: "duplicate",
          message: "Episode already dispatched: " + dedupKey,
        }, 200);
      }

      await ctx.env.DB
        .prepare(
          "INSERT INTO dispatched (dedup_key, repo, series, episode, dispatched_at) VALUES (?, ?, ?, ?, ?)"
        )
        .bind(dedupKey, body.repo, seriesName, episode, new Date().toISOString()).run();
    } catch (e) {
      console.error("D1 dedup error:", e);
    }
  }

  const success = await dispatchGitHub(token, body.repo, "opshub.produce", body.client_payload);
  if (ctx.env.DB) {
    await recordJob(ctx.env.DB, {
      job_id: `dispatch:${dedupKey}`,
      service: body.repo,
      kind: "repository_dispatch",
      status: success ? "dispatched" : "dispatch_failed",
      detail: `topic=${seriesName || "-"} episode=${episode || "-"}`,
      created_at: Math.floor(Date.parse(body.client_payload?.dispatched_at || "") / 1000) || nowSec(),
    });
  }
  return ctx.json({ status: success ? "accepted" : "dispatch_failed", dedup_key: dedupKey }, 200);
});

// ---------------- legacy emit ----------------
app.post("/emit", async (ctx) => {
  try {
    const raw = await ctx.req.text();
    let body;
    try { body = JSON.parse(raw); } catch (_) { return ctx.json({ error: "bad json" }, 400); }

    const secret = ctx.env.HUB_WEBHOOK_SECRET;
    if (body && body.type && !body.repo) {
      if (!secret) {
        if (ctx.env.DB) await ensureTables(ctx.env.DB);
        return ctx.json(HTTP_UNAVAILABLE, 503);
      }
      const sigOk = await verifySignature(raw, ctx.req.header("x-hub-signature-256") || "", secret);
      if (!sigOk) return ctx.json({ error: "invalid signature" }, 401);
      if (ctx.env.DB) {
        await ensureTables(ctx.env.DB);
        const r = await storeEvent(ctx.env.DB, body);
        return ctx.json({ status: "accepted", ...r }, 200);
      }
      return ctx.json({ status: "accepted", stored: false }, 200);
    }

    const token = ctx.env.HUB_GITHUB_TOKEN;
    if (token && body.repo) {
      await dispatchGitHub(token, body.repo, "legacy.produce", body.client_payload);
    }
    return ctx.json({ status: "accepted" }, 200);
  } catch (e) {
    return ctx.json({ error: "internal error" }, 500);
  }
});

// ---------------- read endpoints ----------------
// ---------------- webhook diagnostics ----------------
// Telegram's getWebhookInfo (no token echoed back) is the only way to see
// where updates are actually landing and why presses might go missing.
app.get("/tg-webhook-info", async (ctx) => {
  if (!(ctx.env.TELEGRAM_BOT_TOKEN || "").trim()) return ctx.json({ error: "no bot token configured" }, 500);
  const info = await webhookHealth(ctx);
  return info ? ctx.json({ ok: true, result: info }) : ctx.json({ error: "telegram unreachable" }, 502);
});

// JSON health snapshot for scripts/dashboards (Telegram /health is the same data).
// Register this worker's Telegram webhook (the worker calls Telegram
// directly with its own TELEGRAM_BOT_TOKEN so Telegram can resolve the
// webhook URL from the same network the worker is reachable on).
app.post("/set-webhook", async (ctx) => {
  const tok = (ctx.env.TELEGRAM_BOT_TOKEN || "").trim();
  if (!tok) return ctx.json({ error: "no bot token configured" }, 500);
  const secret = (ctx.env.TELEGRAM_WEBHOOK_SECRET || "").trim();
  const url = (ctx.env.HUB_URL || "").trim().replace(/\/?$/, "") + "/telegram";
  if (!url) return ctx.json({ error: "no HUB_URL configured" }, 500);
  try {
    const r = await fetch("https://api.telegram.org/bot" + tok + "/setWebhook", {
      method: "POST",
      headers: { "Content-Type": "application/json", "User-Agent": "OpsHub" },
      body: JSON.stringify({
        url,
        ...(secret ? { secret_token: secret } : {}),
        allowed_updates: ["message", "callback_query"],
      }),
    });
    const j = await r.json();
    return ctx.json({ ok: j && j.ok, result: j && j.result });
  } catch (e) {
    return ctx.json({ ok: false, error: String(e).slice(0, 200) }, 502);
  }
});

app.get("/health", async (ctx) => {
  if (!ctx.env.DB) return ctx.json({ error: "No DB" }, 500);
  try {
    await ensureTables(ctx.env.DB);
    const settings = await getSettings(ctx.env.DB);
    const statuses = (await repoStatuses(ctx)) || [];
    const wh = await webhookHealth(ctx);
    const fails = await ctx.env.DB
      .prepare("SELECT service, detail, url, updated_at FROM jobs WHERE status = 'failed' ORDER BY updated_at DESC LIMIT 10")
      .all();
    const acks = await ctx.env.DB.prepare("SELECT COUNT(*) AS n FROM tgacks").first();
    const jobs = await ctx.env.DB.prepare("SELECT COUNT(*) AS n FROM jobs").first();
    return ctx.json({
      ok: true,
      version: VERSION,
      time: localParts(new Date(), settings.tz),
      services: statuses,
      failures: fails.results || [],
      telegram: wh
        ? { url: wh.url || "", pending: wh.pending_update_count ?? 0, last_error: wh.last_error_message || null }
        : null,
      ledger: { jobs: jobs ? jobs.n : 0, pending_acks: acks ? acks.n : 0 },
    });
  } catch (e) {
    return ctx.json({ ok: false, error: String(e).slice(0, 200) }, 500);
  }
});

// Failure triage hook: ?dry_run=1 diagnoses and returns reports WITHOUT
// messaging Telegram — used to verify triage before enabling alerts.
app.post("/failure-watch", async (ctx) => {
  if (!ctx.env.DB) return ctx.json({ error: "No DB" }, 500);
  try {
    await ensureTables(ctx.env.DB);
    // Sending an alert is privileged: without the shared secret this endpoint
    // only diagnoses (dry run), so an unauthenticated caller cannot spam you.
    const provided = ctx.req.query("token") || ctx.req.header("x-ops-token") || "";
    const authorized = !!ctx.env.HUB_WEBHOOK_SECRET && provided === ctx.env.HUB_WEBHOOK_SECRET;
    const r = await failureWatch(ctx, {
      dryRun: ctx.req.query("dry_run") === "1" || !authorized,
      sinceHours: Number(ctx.req.query("since_hours") || 26),
    });
    return ctx.json({ ...r, authorized });
  } catch (e) {
    return ctx.json({ error: String(e).slice(0, 200) }, 500);
  }
});

app.get("/repos", async (ctx) => ctx.json({ repos: REPOS }));

app.get("/status", async (ctx) => {
  const settings = ctx.env.DB ? await getSettings(ctx.env.DB) : { ...DEFAULT_SETTINGS };
  const p = localParts(new Date(), settings.tz);
  return ctx.json({
    status: "ok", version: VERSION, mode: "Telegram-first",
    place: settings.place, tz: settings.tz, local_time: p.hhmm,
  });
});

app.get("/report", async (ctx) => {
  if (!isAdmin(ctx)) return ctx.json({ error: "bad secret" }, 403);
  const settings = ctx.env.DB ? await getSettings(ctx.env.DB) : { ...DEFAULT_SETTINGS };
  const text = await buildReport(ctx, ctx.req.query("chat_id") || "0", "daily", settings);
  return ctx.text(text);
});

// Scheduled sender: Convex cron POSTs here every 5 min (via sweepPing).
// Windows + per-day dedup bound it to at most 2 messages/day.
app.post("/report-tick", async (ctx) => {
  if (!ctx.env.DB) return ctx.json({ error: "No DB" }, 500);
  try {
    await ensureTables(ctx.env.DB);
    const ownerRow = await kvGet(ctx.env.DB, "report_owner");
    const owner = ownerRow ? JSON.parse(ownerRow).chat : null;
    if (!owner) return ctx.json({ status: "ok", skipped: "no owner registered" });
    const settings = await getSettings(ctx.env.DB);
    const local = localParts(new Date(), settings.tz);
    const force = ctx.req.query("force");
    let mode = null;
    if (local.hour >= 7 && local.hour <= 9) mode = "morning";
    else if (local.hour >= 21) mode = "evening";
    if (!mode && !force) {
      return ctx.json({ status: "ok", skipped: "outside report windows", local: local.hhmm, tz: settings.tz });
    }
    if (!mode) mode = "daily";
    const key = `report:${mode}:${local.date}`;
    if (!force) {
      const done = await kvGet(ctx.env.DB, key);
      if (done) return ctx.json({ status: "ok", skipped: "already sent", local: local.hhmm });
    }
    const text = await buildReport(ctx, owner, mode, settings);
    const sent = await sendTelegram(ctx.env.TELEGRAM_BOT_TOKEN, owner, text);
    if (sent && !force) await kvSet(ctx.env.DB, key, { sentAt: Date.now() });
    return ctx.json({ status: "ok", sent: sent ? mode : "telegram failed", local: local.hhmm });
  } catch (e) {
    return ctx.json({ error: String(e).slice(0, 200) }, 500);
  }
});

app.post("/reminders", async (ctx) => {
  if (!ctx.env.DB) return ctx.json({ error: "No DB" }, 500);
  try {
    await ensureTables(ctx.env.DB);
    const body = await ctx.req.json();
    const chatId = body.chat_id || body.chatId;
    if (!chatId) return ctx.json({ error: "chat_id required" }, 400);
    const rows = await listReminders(ctx.env.DB, chatId);
    return ctx.json({ reminders: rows });
  } catch (e) {
    return ctx.json({ error: String(e).slice(0, 200) }, 500);
  }
});

// First-set is open (registers the report owner); changing needs the secret.
app.post("/set-owner", async (ctx) => {
  if (!ctx.env.DB) return ctx.json({ error: "No DB" }, 500);
  try {
    const body = await ctx.req.json();
    if (!body.chat_id) return ctx.json({ error: "chat_id required" }, 400);
    await ensureTables(ctx.env.DB);
    const cur = await kvGet(ctx.env.DB, "report_owner");
    const curChat = cur ? JSON.parse(cur).chat : null;
    const secret = ctx.env.HUB_WEBHOOK_SECRET;
    if (!secret) {
      return ctx.json(HTTP_UNAVAILABLE, 503);
    }
    const authed = !curChat || body.secret === secret || String(body.chat_id) === String(curChat);
    if (!authed) return ctx.json({ error: "owner already set — pass secret to change" }, 403);
    await kvSet(ctx.env.DB, "report_owner", { chat: String(body.chat_id), setAt: Date.now() });
    return ctx.json({ status: "ok", owner: String(body.chat_id) });
  } catch (e) {
    return ctx.json({ error: String(e).slice(0, 200) }, 500);
  }
});

// HTTP read endpoints expose reminder texts — require the webhook secret.
function isAdmin(ctx) {
  const secret = ctx.env.HUB_WEBHOOK_SECRET;
  if (!secret) {
    return false;
  }
  return ctx.req.query("secret") === secret;
}

app.get("/reminders", async (ctx) => {
  if (!ctx.env.DB) return ctx.json({ error: "No DB" }, 500);
  if (!isAdmin(ctx)) {
    return ctx.json({ error: "hub misconfigured" }, 503);
  }
  try {
    await ensureTables(ctx.env.DB);
    const chatId = ctx.req.query("chat_id") || "0";
    return ctx.json({ reminders: await listReminders(ctx.env.DB, chatId) });
  } catch (e) {
    return ctx.json({ error: String(e).slice(0, 200) }, 500);
  }
});

app.get("/settings", async (ctx) => {
  if (!ctx.env.DB) return ctx.json({ error: "No DB" }, 500);
  const ok = isAdmin(ctx);
  if (ok === false) {
    return ctx.json({ error: "hub misconfigured" }, 503);
  }
  if (ok !== true) return ctx.json({ error: "bad secret" }, 403);
  const s = await getSettings(ctx.env.DB);
  const p = localParts(new Date(), s.tz);
  return ctx.json({ settings: s, local_time: p.hhmm });
});

// ---------------- debug/admin ----------------
app.post("/debug-dispatch", async (ctx) => {
  try {
    const body = await ctx.req.json();
    const repo = body.repo || "faceless-studio";
    const token = ctx.env.HUB_GITHUB_TOKEN;
    if (!token) return ctx.json({ error: "HUB_GITHUB_TOKEN not set" }, 500);
    const success = await dispatchGitHub(token, repo, "opshub.produce", body.client_payload);
    return ctx.json({ success });
  } catch (e) {
    return ctx.json({ error: e.message }, 500);
  }
});

app.get("/init-db", async (ctx) => {
  if (!ctx.env.DB) return ctx.json({ error: "No DB" }, 500);
  try {
    await ensureTables(ctx.env.DB);
    return ctx.json({ status: "ok" });
  } catch (e) {
    return ctx.json({ error: e.message }, 500);
  }
});

app.post("/debug-ai", async (ctx) => {
  try {
    const body = await ctx.req.json();
    const groqKey = ctx.env.GROQ_API_KEY;
    if (!groqKey) return ctx.json({ error: "GROQ_API_KEY not set" }, 500);
    const reply = await callGroq(groqKey, [
      { role: "system", content: body.system || "You are OpsHub. Reply concisely." },
      { role: "user", content: body.text || "Say hello" },
    ]);
    return ctx.json({ reply });
  } catch (e) {
    return ctx.json({ error: e.message }, 500);
  }
});

export default app;

// Pure helpers exported for the test suite (no I/O, no side effects).
export { classifyFailure, extractEvidence, parseNum, verifySignature };
