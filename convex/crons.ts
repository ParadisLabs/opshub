import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

const crons = cronJobs();

crons.interval("check reminders", { minutes: 1 }, internal.bot.checkReminders);

crons.weekly(
  "weekly ops digest",
  { dayOfWeek: "sunday", hourUTC: 19, minuteUTC: 0 },
  internal.digest.weeklyDigest
);

crons.daily(
  "youtube stats pull",
  { hourUTC: 5, minuteUTC: 17 },
  internal.youtube.pullChannelStats
);

export default crons;
