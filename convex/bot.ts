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

const SYSTEM_PROMPT = `You are OpsHub, the personal operator AI for one busy person running several businesses (see CURRENT DATA: restaurant, poultry farm, trading, freelance, faceless content channels).

HARD RULES:
1. Money records (income/expense): ALWAYS call propose_record first and show its card to the user. NEVER save money directly. The user confirms with yes/no (handled outside you).
2. add_entry is ONLY for journal and note entries — never for income/expense.
3. Store amounts as plain numbers in the user's own currency. Never convert, never assume USD.
4. Reminders: create_reminder with dueAt as ISO 8601 UTC datetime. If the exact date is unclear, ask.
5. When asked about money or progress, call check_income/check_expenses/check_reminders and report REAL numbers. Never invent figures.
6. New business or channel to track: add_business. Use exact business names on all records.
7. Be concise, warm, direct. No markdown headers. Match the user's language.
8. If CURRENT DATA shows no businesses, guide setup first: ask what businesses to add.`;

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

    const bizList = businesses.length
      ? businesses.map((b: any) => `${b.name} (${b.kind})`).join(", ")
      : "none yet";
    const contextNote = `CURRENT DATA\nBusinesses: ${bizList}\nRecent entries:\n${recentEntries || "(empty)"}`;

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
              result = await ctx.runMutation(internal.tools.createReminder, {
                text: String(args.text ?? "reminder"),
                dueAt: String(args.dueAt ?? ""),
                repeat: args.repeat ? String(args.repeat) : undefined,
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
              result = await ctx.runQuery(internal.tools.listUpcomingReminders);
            } else if (name === "list_businesses") {
              result = businesses.map((b: any) => ({
                name: b.name,
                kind: b.kind,
              }));
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

export const checkReminders = internalAction({
  handler: async (ctx) => {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    const allowed = process.env.ALLOWED_TELEGRAM_ID;
    if (!token || !allowed) return;
    const due = await ctx.runQuery(internal.tools.dueReminders);
    if (due.length === 0) return;
    const lines = due.map(
      (r: any) => `⏰ ${r.text}${r.repeat ? " (daily)" : ""}`
    );
    await sendTelegram(
      token,
      Number(allowed),
      `🔔 Due now:\n${lines.join("\n")}`
    );
    for (const r of due) {
      await ctx.runMutation(internal.tools.completeReminder, { id: r._id });
    }
  },
});
