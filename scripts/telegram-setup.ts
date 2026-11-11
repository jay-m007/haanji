// Finds the chat id to put in .env as TELEGRAM_CHAT_ID, then sends a test message.
// 1. Create a bot with @BotFather in Telegram and put its token in .env as TELEGRAM_BOT_TOKEN.
// 2. From the phone that should get call alerts, open the bot and send it any message (e.g. "hi").
// 3. Run: npm run telegram
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { telegram } from "../src/notify.ts";

try { process.loadEnvFile(join(fileURLToPath(new URL("..", import.meta.url)), ".env")); } catch { /* use the real environment */ }
const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) { console.error("Put TELEGRAM_BOT_TOKEN=... in .env first (from @BotFather)."); process.exit(2); }
const base = process.env.TELEGRAM_API ?? "https://api.telegram.org";
const res = await fetch(`${base}/bot${token}/getUpdates`);
const data = (await res.json()) as { ok: boolean; description?: string; result?: { message?: { chat: { id: number; first_name?: string; title?: string }; text?: string } }[] };
if (!data.ok) { console.error(`Telegram said: ${data.description ?? res.status}. Check the token.`); process.exit(2); }
const chats = new Map<number, string>();
for (const u of data.result ?? []) if (u.message) chats.set(u.message.chat.id, u.message.chat.first_name ?? u.message.chat.title ?? "");
if (!chats.size) { console.error("No messages yet. Open your bot in Telegram, send it \"hi\", then run this again."); process.exit(1); }
for (const [id, name] of chats) console.log(`TELEGRAM_CHAT_ID=${id}    (${name})`);
const [first] = chats.keys();
await telegram({ token, chatId: String(first), base }).send("✅ Haanji is connected. Call summaries will arrive here.");
console.log(`Sent a test message to ${first}. Copy the TELEGRAM_CHAT_ID line into .env.`);
