// Tells the owner about each finished call. Telegram, because its bot API is free and needs no SMS registration.
import type { Call } from "./agent.ts";

export interface Notifier { send(text: string): Promise<void> }

export function telegram(o: { token: string; chatId: string; base?: string }): Notifier {
  const base = o.base ?? "https://api.telegram.org";
  return {
    async send(text) {
      const res = await fetch(`${base}/bot${o.token}/sendMessage`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ chat_id: o.chatId, text: text.slice(0, 4000), disable_web_page_preview: true }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) throw new Error(`Telegram returned ${res.status}: ${(await res.text()).slice(0, 200)}`);
    },
  };
}

export function notifierFromEnv(env = process.env): Notifier | undefined {
  if (env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID) return telegram({ token: env.TELEGRAM_BOT_TOKEN, chatId: env.TELEGRAM_CHAT_ID, base: env.TELEGRAM_API });
  return undefined;
}

/** The message the owner gets on his phone. */
export function callMessage(call: Call, dashboardUrl?: string): string {
  const L = call.lead;
  const lines = [`📞 New ${call.channel === "web" ? "web " : ""}call${L.phone ? " from " + L.phone : ""}`, call.summary ?? "(no summary)"];
  const o = L.offers.at(-1);
  if (o) lines.push(`⚠ Bargaining: offered ₹${o.price}${o.per ? "/" + o.per : ""}. Please call back to confirm.`);
  if (L.items.some((i) => i.check)) lines.push("⚠ Some quantities need checking.");
  if (call.turns.some((t) => t.guard)) lines.push("ℹ The assistant was stopped from quoting a price it should not.");
  if (call.errors.length) lines.push(`ℹ ${call.errors.length} problem(s) during the call; see the ledger.`);
  if (dashboardUrl) lines.push(dashboardUrl);
  return lines.join("\n");
}
