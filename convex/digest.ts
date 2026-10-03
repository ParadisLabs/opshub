import { internalAction } from "./_generated/server";
import { internal } from "./_generated/api";

const API = "https://generativelanguage.googleapis.com/v1beta/models";
const MODELS = ["gemini-3.5-flash-lite", "gemini-3.8-flash", "gemini-3.1-flash-lite"];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export const weeklyDigest = internalAction({
  handler: async (ctx) => {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    const apiKey = process.env.GOOGLE_API_KEY;
    const allowed = process.env.ALLOWED_TELEGRAM_ID;
    if (!token || !apiKey || !allowed) return;

    const money = await ctx.runQuery(internal.insights.moneySummary, { days: 7 });
    const trades = await ctx.runQuery(internal.insights.tradeStats, { days: 7 });
    const content = await ctx.runQuery(internal.insights.episodeStats, { days: 7 });

    const stats = `MONEY (7d): income ${money.totalIncome}, expenses ${money.totalExpense}. By business: ${money.byBusiness.join(" | ") || "no records"}. Recent: ${money.recent.join(" ; ") || "none"}.
TRADING (7d): ${trades.closedCount} closed, ${trades.openCount} open now, WR ${trades.winRate ?? "n/a"}%, total ${trades.totalR}R, avg ${trades.avgR ?? "n/a"}R, best ${trades.best ?? "n/a"}R, worst ${trades.worst ?? "n/a"}R. By symbol: ${trades.bySymbol}. By tier: ${trades.byTier}. By strategy: ${trades.byStrategy}. Recent: ${trades.recent.join(" ; ") || "none"}.
CONTENT (7d): produced ${content.produced}, published ${content.published}, waiting to post ${content.unpublishedCount}${content.unpublished.length ? ` (${content.unpublished.map((u) => `${u.label} ${u.hoursWaiting}h`).join(", ")})` : ""}, avg publish lag ${content.avgPublishLagHours ?? "n/a"}h. By channel: ${JSON.stringify(content.byChannel)}.`;

    const prompt = `You are OpsHub, writing the WEEKLY OPS DIGEST for one operator running a restaurant, a poultry farm, manual trading, freelance work, and faceless video channels. Below are the REAL computed numbers. Do NOT invent any figures not present. If a section has no data, cover it in one short line.

${stats}

Write a Telegram digest, max ~1800 characters, exactly this structure:
📊 WEEKLY OPS DIGEST
💰 Money: 2-3 lines, signal not noise
📈 Trading: 2-3 lines (mention if the sample is too small to judge)
📺 Content: 2-3 lines, call out anything waiting too long to post
✅ Do next: 3-5 concrete actions tied to the numbers above
Plain text, emojis ok, no markdown headers, direct and specific.`;

    let digest = "";
    let lastErr = "";
    for (const model of MODELS) {
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const res = await fetch(`${API}/${model}:generateContent?key=${apiKey}`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              contents: [{ role: "user", parts: [{ text: prompt }] }],
              generationConfig: { temperature: 0.5 },
            }),
          });
          if (res.ok) {
            const data = await res.json();
            digest = (data?.candidates?.[0]?.content?.parts ?? [])
              .filter((p: any) => typeof p.text === "string")
              .map((p: any) => p.text)
              .join("");
            break;
          }
          lastErr = `${model} -> ${res.status}`;
        } catch (e: any) {
          lastErr = `${model} -> ${String(e?.message ?? e)}`;
        }
        await sleep(1500 * (attempt + 1));
      }
      if (digest) break;
    }

    const text =
      digest ||
      `📊 WEEKLY OPS DIGEST (AI busy: ${lastErr})
💰 Money: +${money.totalIncome} / -${money.totalExpense}
📈 Trading: ${trades.closedCount} closed, ${trades.totalR}R, ${trades.openCount} open
📺 Content: ${content.produced} produced, ${content.unpublishedCount} waiting`;

    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: Number(allowed), text }),
    });
  },
});
