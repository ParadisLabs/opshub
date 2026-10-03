import { internalAction } from "./_generated/server";
import { v } from "convex/values";

async function sendMessage(token: string, chatId: number, text: string) {
  await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text }),
  });
}

export const handleUpdate = internalAction({
  args: { update: v.any() },
  handler: async (ctx, { update }) => {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    if (!token) return;
    const msg = update.message;
    if (!msg || !msg.text) return;
    const chatId = msg.chat.id as number;

    const allowed = process.env.ALLOWED_TELEGRAM_ID;
    if (!allowed) {
      await sendMessage(
        token,
        chatId,
        `🔑 Your Telegram ID is ${chatId}\n\n` +
          `Add it in Convex → Settings → Environment Variables\n` +
          `as ALLOWED_TELEGRAM_ID, then message me again.`
      );
      return;
    }
    if (String(chatId) !== allowed) return; // strangers are ignored

    await sendMessage(
      token,
      chatId,
      "✅ OpsHub online. AI brain + journaling tools connect in Part 2."
    );
  },
});
