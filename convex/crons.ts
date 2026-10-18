import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

const crons = cronJobs();

// Reminders: the engine claims before sending and only advances on a confirmed
// delivery, so this stays cheap even though it runs every minute.
crons.interval("check reminders", { minutes: 1 }, internal.reminders.fireDue);

// Studio schedules: fires when the local clock hits a studio's configured time.
// A 5-minute cadence against a 15-minute window gives at most one run per day.
crons.interval("studio schedules", { minutes: 5 }, internal.dispatch.runDueSchedules);

// Morning brief + evening report. Gated by the operator's local hour, with a
// two-hour catch-up window, so this can run often without double-sending.
crons.interval("daily reports", { minutes: 30 }, internal.report.tick);

crons.weekly(
  "weekly ops digest",
  { dayOfWeek: "sunday", hourUTC: 16, minuteUTC: 0 }, // 19:00 in Istanbul
  internal.digest.weeklyDigest
);

crons.daily(
  "youtube stats pull",
  { hourUTC: 5, minuteUTC: 17 },
  internal.youtube.pullChannelStats
);

export default crons;
