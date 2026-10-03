import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

const crons = cronJobs();

crons.interval(
  "check reminders",
  { minutes: 1 },
  internal.bot.checkReminders
);

export default crons;
