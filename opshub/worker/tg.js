/**
 * OpsHub Telegram Bot — webhook-based, not getUpdates poller.
 * 
 * Commands:
 * /repos       - List registered repos
 * /status      - Hub status (optionally ?repo=XYZ)
 * /trigger <repo> [topic] - Trigger a production run
 * /newseries <repo> - Start a new series for a repo
 * /reminders   - List active reminders
 * /remind 48 <text>   - Set one-shot 48h reminder
 * /remind 24 every 24 <text> - Set repeating reminder
 * /delete <id> - Cancel a reminder (final, with [⏹ Stop] button)
 * /forget flip:XYZ - Forget a flip broker reminder chain
 */

import { Hono } from "hono";
import { configureStorage } from "@hono/d1";
import * as joi from "joi";
import { detect } from "@detect/crypto";

const bot = new Hono();
bot.use(configureStorage((ctx) => ({
  DB: ctx.env.DB,
  TELEGRAM_BOT_TOKEN: ctx.env.TELEGRAM_BOT_TOKEN,
  GITHUB_OWNER: ctx.env.GITHUB_OWNER,
})));

// /repos - List registered repos
bot.get("/reps", async (ctx) => {
  const rows = await ctx.env.DB.prepare(
    "SELECT * FROM repo_registry ORDER BY repo"
  ).all();
  return ctx.json({ repos: rows.results || [] });
});

// /status - Hub status
bot.get("/status", async (ctx) => {
  const repo = ctx.req.query("repo");
  let row;
  if (repo) {
    row = await ctx.env.DB.prepare(
      "SELECT * FROM repo_registry WHERE repo = ?"
    ).bind(repo).first();
  } else {
    row = await ctx.env.DB.prepare(
      "SELECT * FROM repo_registry LIMIT 1"
    ).first();
  }
  if (!row) return ctx.json({ status: "no data" });
  return ctx.json({ status: "ok", repo: row.repo, trigger_type: row.trigger_type, last_triggered: row.last_triggered });
});

// /trigger <repo> [topic]
bot.post("/trigger/:repo", async (ctx) => {
  const repo = ctx.param("repo");
  const topic = ctx.req.query("topic") || "default";
  
  // Record the trigger
  await ctx.env.DB.prepare(
    "INSERT OR IGNORE INTO repo_registry (repo, trigger_type, last_triggered, active) VALUES (?, 'opshub.produce', ?, 1)"
  ).bind(repo, new Date().toISOString()).run();
  
  // Fire GitHub dispatch
  const response = await fetch(`https://api.github.com/repos/${ctx.env.GITHUB_OWNER}/${repo}/dispatches`, {
    method: "POST",
    headers: {
      "Authorization": `token ${ctx.env.HUB_GITHUB_TOKEN}`,
      "Accept": "application/vnd.github+json",
    },
    body: JSON.stringify({
      event_type: "opshub.produce",
      client_payload: { topic, hub: "opshub" },
    }),
  });
  
  return ctx.json({ 
    triggered: repo, 
    github_response: await response.json(),
    topic 
  });
});

// /newseries <repo>
bot.post("/newseries/:repo", async (ctx) => {
  const repo = ctx.param("repo");
  await ctx.env.DB.prepare(
    "INSERT OR IGNORE INTO repo_registry (repo, trigger_type, last_triggered, active) VALUES (?, 'studio.produce', ?, 1)"
  ).bind(repo, new Date().toISOString()).run();
  return ctx.json({ newseries: repo });
});

// /reminders - List active reminders
bot.get("/reminders", async (ctx) => {
  const rows = await ctx.env.DB.prepare(
    "SELECT * FROM reminders WHERE status != 'cancelled' AND status != 'sent'"
  ).all();
  return ctx.json({ reminders: rows.results || [] });
});

// /remind 48 <text> - One-shot 48h reminder
bot.post("/remind/48", async (ctx) => {
  const { text } = await ctx.req.json();
  const triggerTime = new Date(Date.now() + 48 * 3600 * 1000).toISOString();
  const id = crypto.randomUUID();
  
  await ctx.env.DB.prepare(
    "INSERT INTO reminders (id, chat_id, text, mode, interval_hours, trigger_time, status) VALUES (?, ?, ?, 'one-shot', 48, ?, 'pending')"
  ).bind(id, ctx.from.id, text, triggerTime).run();
  
  // Schedule via hub sweep (the /sweep cron will deliver it)
  return ctx.json({ reminder_id: id, trigger_time: triggerTime, mode: "one-shot" });
});

// /remind 24 every 24 <text> - Repeating reminder
bot.post("/remind/24/every", async (ctx) => {
  const { text } = await ctx.req.json();
  const triggerTime = new Date(Date.now() + 24 * 3600 * 1000).toISOString();
  const id = crypto.randomUUID();
  
  await ctx.env.DB.prepare(
    "INSERT INTO reminders (id, chat_id, text, mode, interval_hours, trigger_time, status) VALUES (?, ?, ?, 'repeating', 24, ?, 'pending')"
  ).bind(id, ctx.from.id, text, triggerTime).run();
  
  return ctx.json({ reminder_id: id, trigger_time: triggerTime, mode: "repeating" });
});

// /delete <id> - Cancel a reminder (final)
bot.post("/delete/:id", async (ctx) => {
  const id = ctx.param("id");
  await ctx.env.DB.prepare(
    "UPDATE reminders SET status = 'cancelled' WHERE id = ?"
  ).bind(id).run();
  return ctx.json({ deleted: id, final: true });
});

// /forget flip:XYZ - Forget a flip broker reminder chain
bot.post("/forget/:chain", async (ctx) => {
  const chain = ctx.param("chain");
  await ctx.env.DB.prepare(
    "UPDATE reminders SET status = 'cancelled' WHERE chat_id = ? AND mode = 'repeating' AND text LIKE ?"
  ).bind(ctx.from.id, `%${chain}%`).run();
  return ctx.json({ forgotten: chain });
});

// Webhook update handler from Telegram
bot.post("/", async (ctx) => {
  const update = await ctx.req.json();
  
  if (update.message && update.message.text) {
    const text = update.message.text;
    const chatId = update.message.chat.id;
    
    // Handle /start
    if (text === "/start") {
      return ctx.json({
        text: "Welcome to OpsHub! Use /repos to see registered repos, /trigger to fire a production, /reminders to see active reminders, /remind to set reminders, /delete to cancel one.",
      });
    }
    
    // Handle /repos
    if (text === "/repos") {
      const rows = await ctx.env.DB.prepare(
        "SELECT * FROM repo_registry ORDER BY repo"
      ).all();
      const repoList = (rows.results || []).map(r => r.repo).join("\n");
      return ctx.json({ text: `Registered repos:\n${repoList || "None"}` });
    }
    
    // Handle /status
    if (text === "/status") {
      const status = await ctx.env.DB.prepare(
        "SELECT * FROM repo_registry LIMIT 1"
      ).first();
      if (!status) return ctx.json({ text: "Hub has no registered repos yet." });
      return ctx.json({ text: `Hub status: OK. Last triggered: ${status.last_triggered || "never"}` });
    }
    
    // Handle /reminders
    if (text === "/reminders") {
      const rows = await ctx.env.DB.prepare(
        "SELECT * FROM reminders WHERE status != 'cancelled' AND status != 'sent'"
      ).all();
      const remList = (rows.results || []).map(r => `${r.id}: ${r.text} (${r.mode}, repeats every ${r.interval_hours}h`).trim()).join("\n") || "No active reminders";
      return ctx.json({ text: `Active reminders:\n${remList}` });
    }
    
    // Handle /remind (simple syntax)
    if (text.startsWith("/remind ")) {
      const parts = text.substring(8).split(" ");
      const duration = parts[0]; // e.g., "48" or "24"
      const rest = parts.slice(1).join(" ");
      
      if (duration === "48") {
        await ctx.env.DB.prepare(
          "INSERT INTO reminders (id, chat_id, text, mode, interval_hours, trigger_time, status) VALUES (?, ?, ?, 'one-shot', 48, DATE_ADD(NOW(), INTERVAL 48 HOUR), 'pending')"
        ).bind(crypto.randomUUID(), chatId, rest).run();
        return ctx.json({ text: `✅ 48-hour reminder set: "${rest}"` });
      }
      
      if (duration === "24" && parts[1] === "every") {
        const repeatText = parts.slice(2).join(" ");
        await ctx.env.DB.prepare(
          "INSERT INTO reminders (id, chat_id, text, mode, interval_hours, trigger_time, status) VALUES (?, ?, ?, 'repeating', 24, DATE_ADD(NOW(), INTERVAL 24 HOUR), 'pending')"
        ).bind(crypto.randomUUID(), chatId, repeatText).run();
        return ctx.json({ text: `✅ 24h repeating reminder set: "${repeatText}"` });
      }
      
      return ctx.json({ text: "Usage: /remind 48 <text> or /remind 24 every <text>" });
    }
    
    // Handle /delete (simulated - in real use, comes via callback query from button)
    if (text.startsWith("/delete ")) {
      const id = text.substring(8);
      await ctx.env.DB.prepare(
        "UPDATE reminders SET status = 'cancelled' WHERE id = ?"
      ).bind(id).run();
      return ctx.json({ text: `✅ Reminder #${id} cancelled. It will never fire again.` });
    }
    
    // Handle /forget
    if (text.startsWith("/forget ")) {
      const chain = text.substring(8);
      await ctx.env.DB.prepare(
        "UPDATE reminders SET status = 'cancelled' WHERE chat_id = ? AND mode = 'repeating' AND text LIKE ?"
      ).bind(chatId, `%${chain}%`).run();
      return ctx.json({ text: `✅ Forget chain "${chain}" — all repeating reminders cancelled.` });
    }
  }
  
  return ctx.json({ text: "Unknown command. Use /help for available commands." });
});

// Export the bot handler for the Worker
export { bot as handler };