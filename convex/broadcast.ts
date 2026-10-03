import { internalAction } from "./_generated/server";
import { v } from "convex/values";

export const notifyEvent = internalAction({
  args: { type: v.string(), summary: v.string() },
  handler: async (ctx, { type, summary }) => {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    const allowed = process.env.ALLOWED_TELEGRAM_ID;
    if (!token || !allowed) return;
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: Number(allowed),
        text: `${summary}\n──\n(via ${type} event)`,
      }),
    });
  },
});
