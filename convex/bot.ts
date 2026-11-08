import { internalAction } from "./_generated/server";
import { v } from "convex/values";
import { internal } from "./_generated/api";

const API = "https://generativelanguage.googleapis.com/v1beta/models";

// Retry chain: cheap/fast first, stable fallbacks after.
const MODELS = [
  "gemini-3.5-flash-lite",
  "gemini-3.8-flash",
  "gemini-3.1-flash-lite",
];

const SYSTEM_PROMPT = `You are OpsHub, the personal operator AI for one busy person running several businesses (see CURRENT DATA: restaurant, poultry farm, trading, freelance, faceless content channels, flip sourcing).

HARD RULES:
1. Money records (income/expense): ALWAYS call propose_record first and show its card to the user. NEVER save money directly. The user confirms with yes/no (handled outside you).
2. add_entry is ONLY for journal and note entries — never for income/expense.
3. Store amounts as plain numbers in the user's own currency. Never convert, never assume USD.
4. Time is LOCAL, never UTC: read the NOW line in CURRENT DATA and pass create_reminder a local dueAt ("YYYY-MM-DDTHH:MM", or just "HH:MM" for the next time that clock reads it). Never convert to UTC yourself. If the exact date is unclear, ask.
5. When asked about money, trading, or channels, call check_income/check_expenses/check_trades/check_episodes and report REAL numbers. Never invent figures.
6. New business or channel to track: add_business. Use exact business names on all records.
7. When the user says they posted/published an episode, call mark_episode_published (create the record if it predates the hub). When they share TikTok/other platform numbers, call log_channel_stat. Use add_episode_record to backfill older episodes the hub never tracked.
8. Flip sourcing: when the user wants the flip engine to hunt something ("watch used cars under 5000 in Miami"), call create_flip_watch with query, city (US city slug like miami) and max_price. Tell them the watch syncs to the flip engine within ~15 min and pricing/comps live in the flip repo (flip-broker). For flip pipeline questions call list_flip_deals. All spread numbers are ESTIMATES, never promised profit.
9. Be concise, warm, direct. No markdown headers. Match the user's language.
10. If CURRENT DATA shows no businesses, guide setup first: ask what businesses to add.
11. Studios (faceless video engines): create_series starts a brand-new arc (new premise, new character, episode 1); run_studio produces the next episode of the current arc; schedule_studio sets a recurring local-time run; list_studios reports where every channel is. A dispatch reaches GitHub Actions in ~30s and the video takes 20-25 min. Say which studio you queued and what kind.
12. Finished arc or a studio that has been silent for days: offer create_series for that studio instead of waiting for it to fix itself.
13. set_timezone only when the operator says the NOW line is wrong. Everything else (reminders, schedules, reports) then follows that timezone automatically.`;

const TOOLS = [
  {
    functionDeclarations: [
      {
        name: "propose_record",
        description:
          "Stage an income/expense/journal/note record and show a confirm card. REQUIRED for all money records.",
        parameters: {
          type: "object",
          properties: {
            kind: {
              type: "string",
              description: "income | expense | journal | note",
            },
            text: { type: "string", description: "short description" },
            amount: {
              type: "number",
              description: "amount in user's currency; omit for journal/note",
            },
            businessName: {
              type: "string",
              description: "exact business name from CURRENT DATA",
            },
            occurredAt: {
              type: "number",
              description: "ms epoch timestamp; omit for now",
            },
          },
          required: ["kind", "text"],
        },
      },
      {
        name: "save_pending_record",
        description:
          "Save the staged record after the user explicitly confirmed yes.",
        parameters: { type: "object", properties: {} },
      },
      {
        name: "add_entry",
        description:
          "Directly save a journal or note entry (NOT money records).",
        parameters: {
          type: "object",
          properties: {
            kind: { type: "string", description: "journal | note" },
            text: { type: "string" },
            businessName: { type: "string" },
          },
          required: ["kind", "text"],
        },
      },
      {
        name: "add_business",
        description: "Create a new business or channel to track.",
        parameters: {
          type: "object",
          properties: {
            name: { type: "string" },
            kind: {
              type: "string",
              description:
                "restaurant | poultry | trading | freelance | channel | other",
            },
            platform: {
              type: "string",
              description: "e.g. youtube, tiktok — for channels",
            },
          },
          required: ["name"],
        },
      },
      {
        name: "create_reminder",
        description: "Create a reminder that pings the user at the due time.",
        parameters: {
          type: "object",
          properties: {
            text: { type: "string" },
            dueAt: { type: "string", description: "ISO 8601 datetime" },
            repeat: { type: "string", description: "'daily' if repeating" },
          },
          required: ["text", "dueAt"],
        },
      },
      {
        name: "check_income",
        description: "Sum of income entries over the last N days.",
        parameters: {
          type: "object",
          properties: {
            days: { type: "number", description: "default 7" },
            businessName: { type: "string" },
          },
        },
      },
      {
        name: "check_expenses",
        description: "Sum of expense entries over the last N days.",
        parameters: {
          type: "object",
          properties: {
            days: { type: "number", description: "default 7" },
            businessName: { type: "string" },
          },
        },
      },
      {
        name: "check_reminders",
        description: "List reminders due in the next 7 days.",
        parameters: { type: "object", properties: {} },
      },
      {
        name: "list_businesses",
        description: "List tracked businesses/channels.",
        parameters: { type: "object", properties: {} },
      },
      {
        name: "check_trades",
        description:
          "Trading performance: win rate, total/avg R, breakdowns by symbol/tier/strategy, open trades.",
        parameters: {
          type: "object",
          properties: {
            days: { type: "number", description: "default 30" },
          },
        },
      },
      {
        name: "check_episodes",
        description:
          "Content pipeline: episodes produced vs published, upload lag, waiting list, by channel, AND the studio's current series position (which episode we're on, finished flag).",
        parameters: {
          type: "object",
          properties: {
            days: { type: "number", description: "default 30" },
          },
        },
      },
      {
        name: "mark_episode_published",
        description:
          "Mark an episode as posted (creates the record if the hub never heard of it). Use when user says they posted an episode.",
        parameters: {
          type: "object",
          properties: {
            series_id: {
              type: "string",
              description: "series slug, e.g. farmer-s1 — see STUDIO NOW in context",
            },
            episode_number: { type: "number" },
            channel_name: {
              type: "string",
              description: "only when creating a missing record",
            },
          },
          required: ["series_id", "episode_number"],
        },
      },
      {
        name: "add_episode_record",
        description:
          "Backfill an older episode the hub never tracked (e.g. episodes 1-6 from before wiring).",
        parameters: {
          type: "object",
          properties: {
            series_id: { type: "string" },
            episode_number: { type: "number" },
            channel_name: { type: "string" },
            title: { type: "string" },
            published: { type: "boolean", description: "true if already posted" },
          },
          required: ["series_id", "episode_number"],
        },
      },
      {
        name: "log_channel_stat",
        description:
          "Log manual channel stats (TikTok, Instagram, etc.) — views, likes, followers. Auto-computes deltas vs the previous log.",
        parameters: {
          type: "object",
          properties: {
            platform: {
              type: "string",
              description: "tiktok | instagram | other",
            },
            name: { type: "string", description: "channel handle or name" },
            views: { type: "number" },
            likes: { type: "number" },
            followers: { type: "number" },
            note: { type: "string" },
          },
          required: ["platform", "name"],
        },
      },
      {
        name: "create_flip_watch",
        description:
          "Create a hunt for the Flip Broker engine (cars, electronics, anything resellable). Syncs to the engine within ~15 min.",
        parameters: {
          type: "object",
          properties: {
            query: {
              type: "string",
              description: "what to search on Marketplace, e.g. 'used cars'",
            },
            city: { type: "string", description: "US city slug, e.g. miami" },
            max_price: { type: "number", description: "max asking price USD" },
            category: {
              type: "string",
              description: "electronics | furniture | instruments | other",
            },
          },
          required: ["query", "city", "max_price"],
        },
      },
      {
        name: "list_flip_deals",
        description:
          "Flip deal pipeline: active deals by status, wins/losses, estimated profit (ESTIMATE only).",
        parameters: {
          type: "object",
          properties: {
            days: { type: "number", description: "default 30" },
          },
        },
      },
      {
        name: "create_series",
        description:
          "Start a brand-new arc in a studio: new premise, newly invented character, episode 1. Also use when an arc has finished.",
        parameters: {
          type: "object",
          properties: {
            studio: { type: "string", description: "turkce | english | history | all" },
            topic: { type: "string", description: "optional brief/theme for the new arc" },
            max_episodes: { type: "number", description: "how long the arc should run" },
          },
          required: ["studio"],
        },
      },
      {
        name: "run_studio",
        description:
          "Produce the next episode of a studio's current arc right now (repository_dispatch to its GitHub repo).",
        parameters: {
          type: "object",
          properties: {
            studio: { type: "string", description: "turkce/truecrime | english/trendscope | history/deep-history" },
            topic: { type: "string", description: "optional brief for this one episode" },
          },
          required: ["studio"],
        },
      },
      {
        name: "list_studios",
        description:
          "Where every studio is: current series, episode, finished flag, schedule, last dispatch.",
        parameters: { type: "object", properties: {} },
      },
      {
        name: "schedule_studio",
        description:
          "Set or change a studio's recurring local-time run (e.g. every day 20:00, or mon/wed/fri 19:30). Times are LOCAL.",
        parameters: {
          type: "object",
          properties: {
            studio: { type: "string", description: "turkce | english | history" },
            local_time: { type: "string", description: "HH:MM in local time" },
            days: { type: "string", description: "'daily' or 'mon,wed,fri'" },
            enabled: { type: "boolean" },
            topic: { type: "string" },
            max_episodes: { type: "number" },
          },
          required: ["studio", "local_time"],
        },
      },
      {
        name: "set_timezone",
        description:
          "Change the operator timezone (IANA name, e.g. Europe/Istanbul). Reminders, schedules and both daily reports follow it.",
        parameters: {
          type: "object",
          properties: { timezone: { type: "string" } },
          required: ["timezone"],
        },
      },
      {
        name: "snooze_reminder",
        description: "Push the next due reminder back by N minutes.",
        parameters: {
          type: "object",
          properties: { minutes: { type: "number", description: "default 30" } },
          required: ["minutes"],
        },
      },
    ],
  },
];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function sendTelegram(token: string, chatId: number, text: string) {
  await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text }),
  });
}

// Try each model twice (with backoff) before giving up.
async function callGemini(apiKey: string, contents: any[]) {
  let lastErr = "";
  for (const model of MODELS) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const res = await fetch(`${API}/${model}:generateContent?key=${apiKey}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
            contents,
            tools: TOOLS,
            generationConfig: { temperature: 0.4 },
          }),
        });
        if (res.ok) return await res.json();
        lastErr = `Gemini ${model} → ${res.status}: ${(await res.text()).slice(0, 200)}`;
      } catch (e: any) {
        lastErr = `Gemini ${model} → ${String(e?.message ?? e).slice(0, 200)}`;
      }
      await sleep(1500 * (attempt + 1)); // 1.5s, then 3s
    }
  }
  throw new Error(`All models busy. Last error: ${lastErr}`);
}

export const handleUpdate = internalAction({
  args: { update: v.any() },
  handler: async (ctx, { update }) => {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    const apiKey = process.env.GOOGLE_API_KEY;
    if (!token || !apiKey) return;
    const msg = update.message;
    if (!msg || typeof msg.text !== "string") return;
    const chatId = msg.chat.id as number;

    const allowed = process.env.ALLOWED_TELEGRAM_ID;
    if (!allowed) {
      await sendTelegram(
        token,
        chatId,
        `🔑 Your Telegram ID is ${chatId}\n\nAdd it as ALLOWED_TELEGRAM_ID in Convex env vars, then message me again.`
      );
      return;
    }
    if (String(chatId) !== allowed) return;

    const text = msg.text.trim();

    // Deterministic production commands: no AI interpretation required.
    const runCommand = text.match(/^\/run\s+(all|icc|flip|english|trendscope|turkce|turkish|truecrime|true-crime|history|deep-history|deep_history)\s*$/i);
    if (runCommand) {
      const target = runCommand[1].toLowerCase();
      let result: any;
      if (target === "all") {
        result = await ctx.runAction(internal.engineDispatch.runAll, {});
      } else if (target === "icc" || target === "flip") {
        result = await ctx.runAction(internal.engineDispatch.dispatchEngine, {
          engineKey: target,
          reason: "telegram /run " + target,
        });
      } else {
        const aliases: Record<string, string> = {\n          turkish: "turkce", truecrime: "turkce", "true-crime": "turkce",\n          trendscope: "english", "deep-history": "history", deep_history: "history",\n        };\n        const studioKey = aliases[target] ?? target;
        result = await ctx.runAction(internal.dispatch.runStudio, {
          studioKey,
          reason: "telegram /run " + target,
        });
      }
      const rows = result.results ?? [result];
      const report = rows.map((row: any) =>
        `${row.studio ?? row.engine ?? "target"}: ${row.ok ? "queued" : "FAILED"}${row.detail ? " — " + row.detail : row.error ? " — " + row.error : ""}`
      ).join("\n");
      const reply = `${result.ok ? "✅" : "⚠️"} Telegram dispatch report\n${report}\n\nQueued means GitHub accepted the event; check Actions for the actual run result.`;
      await ctx.runMutation(internal.tools.appendChat, { chatId, userText: text, botText: reply });
      await sendTelegram(token, chatId, reply);
      return;
    }

    // 1) Mechanical confirm/cancel of a staged record — no AI needed
    const pending = await ctx.runQuery(internal.tools.getPending, { chatId });
    if (pending) {
      if (/^(yes|y|ok|save|confirm|✅|👍)/i.test(text)) {
        const saved = await ctx.runMutation(internal.tools.savePending, {
          chatId,
        });
        const label = saved.amount != null ? ` · ${saved.amount}` : "";
        const biz = saved.businessName ? ` · ${saved.businessName}` : "";
        await sendTelegram(
          token,
          chatId,
          `✅ Saved: ${saved.kind}${biz}${label} — "${saved.text}"`
        );
        await ctx.runMutation(internal.tools.appendChat, {
          chatId,
          userText: text,
          botText: "Saved ✅",
        });
        return;
      }
      if (/^(no|n|cancel|wrong|✖|❌)/i.test(text)) {
        await ctx.runMutation(internal.tools.clearPending, { chatId });
        await sendTelegram(
          token,
          chatId,
          "✖ Cancelled. Send the corrected version."
        );
        return;
      }
    }

    // 2) Build context + conversation for the AI
    const businesses = await ctx.runQuery(internal.tools.listBusinesses);
    const recentEntries = await ctx.runQuery(internal.tools.getRecentEntries);
    const history = await ctx.runQuery(internal.tools.getChat, { chatId });

    let ytLine = "";
    try {
      const yt = await ctx.runQuery(internal.youtube.snapshotForDigest);
      if (yt.length) {
        ytLine =
          "\nYouTube: " +
          yt
            .map(
              (y: any) =>
                `@${String(y.handle).replace(/^@/, "")} — ${y.subscribers ?? "?"} subs, ${y.views ?? "?"} views${
                  y.delta
                    ? ` (Δ +${y.delta.subs ?? 0} subs, +${y.delta.views ?? 0} views)`
                    : ""
                }`
            )
            .join(" | ");
      }
    } catch {}

    let socialLine = "";
    try {
      const soc = await ctx.runQuery(internal.social.listSocialStats);
      if (soc.length) {
        socialLine =
          "\nOther channels: " +
          soc
            .map(
              (s: any) =>
                `${s.platform} ${s.name} — views ${s.views ?? "?"}, followers ${s.followers ?? "?"}${
                  s.delta?.views != null ? ` (Δ +${s.delta.views})` : ""
                }`
            )
            .join(" | ");
      }
    } catch {}

    let nowLine = "";
    try {
      const s = await ctx.runQuery(internal.settings.get, {});
      nowLine = `NOW: ${s.nowLocal} · morning report ${s.morningHour}:00 · evening report ${s.eveningHour}:00`;
    } catch {}

    let studioLine = "";
    try {
      const ov = await ctx.runQuery(internal.studio.contentOverview, {
        days: 30,
      });
      const list = (ov.studios ?? []).filter((s: any) => s?.channelName);
      if (list.length) {
        studioLine =
          "\nSTUDIOS: " +
          list
            .map(
              (s: any) =>
                `${s.channelName}: "${s.title ?? s.seriesId}" ep ${s.episodeNumber}${
                  s.maxEpisodes ? `/${s.maxEpisodes}` : ""
                }${s.finished ? " FINISHED" : ""}`
            )
            .join(" | ");
      } else if (ov.studioState) {
        const st = ov.studioState;
        studioLine = `\nSTUDIOS: "${st.title ?? st.seriesId}" ep ${st.episodeNumber}`;
      }
    } catch {}

    let reminderLine = "";
    try {
      const rem = await ctx.runQuery(internal.reminders.listUpcoming, {
        horizonDays: 3,
      });
      if (rem.length) {
        reminderLine =
          "\nReminders: " +
          rem
            .slice(0, 8)
            .map(
              (r: any) =>
                `${r.localTime} ${r.text}${r.overdue ? " (OVERDUE)" : ""}${
                  r.repeat !== "once" ? ` [${r.repeat}]` : ""
                }`
            )
            .join(" | ");
      }
    } catch {}

    let flipLine = "";
    try {
      const fw = await ctx.runQuery(internal.flips.listWatches);
      if (fw.length) {
        flipLine =
          "\nFlip watches (synced to flip engine): " +
          fw
            .map(
              (w: any) =>
                `${w.watchId} — "${w.query}" in ${w.city}, max $${w.maxPrice}`
            )
            .join(" | ");
      }
    } catch {}

    const bizList = businesses.length
      ? businesses.map((b: any) => `${b.name} (${b.kind})`).join(", ")
      : "none yet";
    const contextNote = `CURRENT DATA\n${nowLine}\nBusinesses: ${bizList}\nRecent entries:\n${recentEntries || "(empty)"}${ytLine}${socialLine}${studioLine}${reminderLine}${flipLine}`;

    const contents: any[] = [
      { role: "user", parts: [{ text: contextNote }] },
      {
        role: "model",
        parts: [
          { text: "Understood. I'll use this data and follow the hard rules." },
        ],
      },
      ...history.map((h: any) => ({
        role: h.role === "bot" ? "model" : "user",
        parts: [{ text: h.text }],
      })),
      { role: "user", parts: [{ text }] },
    ];

    // 3) Gemini loop with tools (max 3 rounds)
    let reply = "";
    try {
      for (let round = 0; round < 3; round++) {
        const data = await callGemini(apiKey, contents);
        const parts: any[] = data?.candidates?.[0]?.content?.parts ?? [];
        const calls = parts.filter((p) => p.functionCall);
        const textOut = parts
          .filter((p) => typeof p.text === "string")
          .map((p) => p.text)
          .join("");

        if (calls.length === 0) {
          reply = textOut || "Done.";
          break;
        }

        contents.push({ role: "model", parts });

        for (const call of calls) {
          const name = call.functionCall.name as string;
          const args = call.functionCall.args ?? {};
          let result: any;
          try {
            if (name === "propose_record") {
              result = await ctx.runMutation(internal.tools.proposePending, {
                chatId,
                record: args,
              });
            } else if (name === "save_pending_record") {
              result = await ctx.runMutation(internal.tools.savePending, {
                chatId,
              });
            } else if (name === "add_entry") {
              result = await ctx.runMutation(internal.tools.addEntry, {
                kind: String(args.kind ?? "journal"),
                text: String(args.text ?? text),
                businessName: args.businessName
                  ? String(args.businessName)
                  : undefined,
              });
            } else if (name === "add_business") {
              result = await ctx.runMutation(internal.tools.addBusiness, {
                name: String(args.name ?? "Unnamed"),
                kind: String(args.kind ?? "other"),
                platform: args.platform ? String(args.platform) : undefined,
              });
            } else if (name === "create_reminder") {
              result = await ctx.runMutation(internal.reminders.addReminder, {
                text: String(args.text ?? "reminder"),
                dueAt: String(args.dueAt ?? ""),
                repeat: args.repeat ? String(args.repeat) : undefined,
                channel: "telegram",
              });
            } else if (name === "check_income") {
              result = await ctx.runQuery(internal.tools.checkIncome, {
                days: Number(args.days ?? 7),
                businessName: args.businessName
                  ? String(args.businessName)
                  : undefined,
              });
            } else if (name === "check_expenses") {
              result = await ctx.runQuery(internal.tools.checkExpenses, {
                days: Number(args.days ?? 7),
                businessName: args.businessName
                  ? String(args.businessName)
                  : undefined,
              });
            } else if (name === "check_reminders") {
              result = await ctx.runQuery(internal.reminders.listUpcoming, { horizonDays: 7 });
            } else if (name === "list_businesses") {
              result = businesses.map((b: any) => ({
                name: b.name,
                kind: b.kind,
              }));
            } else if (name === "check_trades") {
              result = await ctx.runQuery(internal.insights.tradeStats, {
                days: Number(args.days ?? 30),
              });
            } else if (name === "check_episodes") {
              result = await ctx.runQuery(internal.studio.contentOverview, {
                days: Number(args.days ?? 30),
              });
            } else if (name === "mark_episode_published") {
              result = await ctx.runMutation(internal.social.markEpisodePosted, {
                seriesId: String(args.series_id ?? ""),
                episodeNumber: Number(args.episode_number ?? 0),
                channelName: args.channel_name
                  ? String(args.channel_name)
                  : undefined,
              });
            } else if (name === "add_episode_record") {
              result = await ctx.runMutation(internal.social.addEpisodeRecord, {
                seriesId: String(args.series_id ?? ""),
                episodeNumber: Number(args.episode_number ?? 0),
                channelName: args.channel_name
                  ? String(args.channel_name)
                  : undefined,
                title: args.title ? String(args.title) : undefined,
                published: args.published === true,
              });
            } else if (name === "log_channel_stat") {
              result = await ctx.runMutation(internal.social.logSocialStat, {
                platform: String(args.platform ?? "tiktok"),
                name: String(args.name ?? "channel"),
                views: typeof args.views === "number" ? args.views : undefined,
                likes: typeof args.likes === "number" ? args.likes : undefined,
                followers:
                  typeof args.followers === "number" ? args.followers : undefined,
                note: args.note ? String(args.note) : undefined,
              });
            } else if (name === "create_flip_watch") {
              result = await ctx.runMutation(internal.flips.createWatch, {
                query: String(args.query ?? ""),
                city: String(args.city ?? ""),
                maxPrice: Number(args.max_price ?? 0),
                category: args.category ? String(args.category) : undefined,
              });
            } else if (name === "list_flip_deals") {
              result = await ctx.runQuery(internal.flips.dealStats, {
                days: Number(args.days ?? 30),
              });
            } else if (name === "create_series") {
              const key = String(args.studio ?? "").toLowerCase();
              result =
                key === "all"
                  ? await ctx.runAction(internal.dispatch.createSeriesEverywhere, {
                      topic: args.topic ? String(args.topic) : undefined,
                    })
                  : await ctx.runAction(internal.dispatch.createSeries, {
                      studioKey: key,
                      topic: args.topic ? String(args.topic) : undefined,
                      maxEpisodes:
                        typeof args.max_episodes === "number" ? args.max_episodes : undefined,
                    });
            } else if (name === "run_studio") {
              result = await ctx.runAction(internal.dispatch.runStudio, {
                studioKey: String(args.studio ?? "").toLowerCase(),
                topic: args.topic ? String(args.topic) : undefined,
                reason: "telegram request",
              });
            } else if (name === "list_studios") {
              result = await ctx.runQuery(internal.dispatch.listStudios, {});
            } else if (name === "schedule_studio") {
              const daysRaw = args.days ? String(args.days).toLowerCase() : "";
              const dow: Record<string, number> = {
                sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6,
              };
              const wanted =
                daysRaw && daysRaw !== "daily" && daysRaw !== "every day"
                  ? daysRaw
                      .split(/[,\s]+/)
                      .map((d) => dow[d.slice(0, 3)])
                      .filter((n) => n !== undefined)
                  : [];
              result = await ctx.runMutation(internal.dispatch.setSchedule, {
                studioKey: String(args.studio ?? "").toLowerCase(),
                localTime: String(args.local_time ?? ""),
                days: wanted.length ? wanted : undefined,
                enabled: typeof args.enabled === "boolean" ? args.enabled : true,
                topic: args.topic ? String(args.topic) : undefined,
                maxEpisodes:
                  typeof args.max_episodes === "number" ? args.max_episodes : undefined,
              });
            } else if (name === "set_timezone") {
              result = await ctx.runMutation(internal.settings.setTimezone, {
                timezone: String(args.timezone ?? ""),
              });
            } else if (name === "snooze_reminder") {
              result = await ctx.runMutation(internal.reminders.snooze, {
                minutes: Number(args.minutes ?? 30),
              });
            } else {
              result = { error: `Unknown tool ${name}` };
            }
          } catch (e: any) {
            result = { error: String(e?.message ?? e) };
          }
          contents.push({
            role: "user",
            parts: [
              {
                functionResponse: {
                  name,
                  response: { result },
                  ...(call.functionCall.id ? { id: call.functionCall.id } : {}),
                },
              },
            ],
          });
        }
        if (round === 2) reply = textOut || "Done ✅";
      }
    } catch (e: any) {
      const m = String(e?.message ?? e);
      reply = m.includes("All models busy")
        ? "🧠 All AI models are busy right now. Wait a minute and resend — your message wasn't lost."
        : `⚠️ Brain error: ${m.slice(0, 300)}`;
    }

    // 4) Remember the exchange + answer
    await ctx.runMutation(internal.tools.appendChat, {
      chatId,
      userText: text,
      botText: reply,
    });
    await sendTelegram(token, chatId, reply);
  },
});
