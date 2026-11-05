import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

const crons = cronJobs();

// Reminders moved to the OpsHub worker (D1-backed /remind + GitHub /sweep).
// Keep this OFF: after the HUB_URL migration Convex no longer receives bot
// commands, so a Convex reminder would fire with no way to list or delete it —
// exactly the "it didn't know what I meant" bug.
// crons.interval("check reminders", { minutes: 1 }, internal.reminders.fireDue);

// Studio schedules: fires when the local clock hits a studio's configured time.
// A 5-minute cadence against a 15-minute window gives at most one run per day.
crons.interval("studio schedules", { minutes: 5 }, internal.dispatch.runDueSchedules);

// Morning/evening report moved to the worker (/report-tick, local-time windows,
// live GitHub + D1 data). Convex's copy reads tables that stopped updating.
// crons.interval("daily reports", { minutes: 30 }, internal.report.tick);

// Worker sweep + report tick: fires reminders, pre-news alerts and the
// morning/evening report windows (all timed in the user's local timezone).
crons.interval("hub sweep + report", { minutes: 5 }, internal.report.sweepPing);

crons.weekly(
  "weekly ops digest",
  { dayOfWeek: "sunday", hourUTC: 17, minuteUTC: 0 }, // 19:00 Nicosia in winter; 20:00 in summer (fixed UTC cron)
  internal.digest.weeklyDigest
);

crons.daily(
  "youtube stats pull",
  { hourUTC: 5, minuteUTC: 17 },
  internal.youtube.pullChannelStats
);

export default crons;
