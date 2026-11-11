// One turn of the receptionist: ask the model, then check its answer before the caller hears it.
import { allowedPrices, priceListText, product, type Catalog } from "./catalog.ts";
import { checkReply, repeatReply, safeReply, type GuardEvent, type Lang } from "./guard.ts";
import { emptyLead, itemMaths, mergeLead, summary, verifyAgainstCaller, type Lead, type LeadUpdate } from "./lead.ts";
import { chatJson, type ChatMessage, type OllamaOptions } from "./ollama.ts";
import { UNITS } from "./units.ts";

export interface Turn { role: "caller" | "agent"; text: string; at: string; guard?: GuardEvent }
export type Status = "live" | "new" | "called_back" | "won" | "lost";
export interface Call {
  id: string;
  started_at: string;
  ended_at?: string;
  language: Lang;
  model: string;
  turns: Turn[];
  lead: Lead;
  status: Status;
  intent?: string;
  summary?: string;
  errors: string[];
  /** Where the call came from. Missing on calls saved before voice support (simulator). */
  channel?: "simulator" | "phone" | "web";
}

export const LANG_NAMES: Record<Lang, string> = { hi: "Hindi", mr: "Marathi", gu: "Gujarati", en: "English", mixed: "the caller's mix of languages" };

export function greeting(c: Catalog, lang: Lang): string {
  const b = c.business;
  switch (lang) {
    case "mr": return `नमस्कार, ${b.name} मधून ${b.agent_name} बोलतेय. सांगा, तुम्हाला काय हवं आहे?`;
    case "gu": return `નમસ્તે, ${b.name} માંથી ${b.agent_name} બોલું છું. બોલો, તમને શું જોઈએ છે?`;
    case "en": return `Hello, this is ${b.agent_name} from ${b.name}. How can I help you?`;
    default: return `नमस्ते, ${b.name} से ${b.agent_name} बोल रही हूँ। बताइए, आपको क्या चाहिए?`;
  }
}

/** Said first on real calls: the caller must know they are talking to a machine and that the call is written down. */
export function disclosure(c: Catalog, lang: Lang): string {
  const n = c.business.name;
  switch (lang) {
    case "mr": return `हा ${n} चा ऑटोमॅटिक असिस्टंट आहे, बोलणं लिहून ठेवलं जातं.`;
    case "gu": return `આ ${n} નો ઓટોમેટિક આસિસ્ટન્ટ છે, વાતચીત લખીને રાખવામાં આવે છે.`;
    case "en": return `This is the automated assistant of ${n}; this call is written down.`;
    default: return `यह ${n} का ऑटोमैटिक असिस्टेंट है, बातचीत लिखकर रखी जाती है।`;
  }
}

export function newCall(id: string, c: Catalog, lang: Lang, model: string, now = new Date(), opts: { channel?: Call["channel"]; from?: string } = {}): Call {
  const voice = opts.channel === "phone" || opts.channel === "web";
  const lead = emptyLead();
  if (opts.from) lead.phone = opts.from;
  const text = voice ? `${disclosure(c, lang)} ${greeting(c, lang)}` : greeting(c, lang);
  return { id, started_at: now.toISOString(), language: lang, model, turns: [{ role: "agent", text, at: now.toISOString() }], lead, status: "live", errors: [], channel: opts.channel ?? "simulator" };
}

const UNIT_ENUM = [...UNITS, ""];
export const TURN_SCHEMA = {
  type: "object",
  required: ["reply", "language", "intent", "end_call", "lead"],
  properties: {
    reply: { type: "string" },
    language: { type: "string", enum: ["hi", "mr", "gu", "en", "mixed"] },
    intent: { type: "string", enum: ["price_enquiry", "order", "bargain", "availability", "complaint", "other"] },
    end_call: { type: "boolean" },
    lead: {
      type: "object",
      required: ["name", "company", "city", "phone", "delivery_by", "note", "items", "offer_price", "offer_per", "offer_product_id"],
      properties: {
        name: { type: "string" }, company: { type: "string" }, city: { type: "string" }, phone: { type: "string" },
        delivery_by: { type: "string" }, note: { type: "string" },
        items: {
          type: "array",
          items: {
            type: "object",
            required: ["product_id", "product_words", "quantity", "unit"],
            properties: { product_id: { type: "string" }, product_words: { type: "string" }, quantity: { type: "number" }, unit: { type: "string", enum: UNIT_ENUM } },
          },
        },
        offer_price: { type: "number" }, offer_per: { type: "string", enum: UNIT_ENUM }, offer_product_id: { type: "string" },
      },
    },
  },
} as const;

/** What is still missing, in the order a good receptionist asks for it. */
export function nextQuestion(lead: Lead): string {
  if (!lead.items.length) return "which product they need";
  const it = lead.items.find((i) => !i.quantity || !i.unit);
  if (it) return `how many of ${it.product_id} they need, and in which unit (piece, box, carton...)`;
  if (!lead.name) return "their name";
  if (!lead.company && !lead.city) return "their company name and city";
  if (!lead.delivery_by) return "when they need delivery";
  return "whether they need anything else, then close the call politely";
}

export function systemPrompt(c: Catalog, call: Call): string {
  const b = c.business;
  const lead = { ...call.lead, items: call.lead.items.map((i) => ({ ...i, ...itemMaths(c, i) })) };
  return [
    `You are ${b.agent_name}, the phone receptionist of ${b.name}, a manufacturer in ${b.city}. The owner is ${b.owner}. Office hours: ${b.hours}.`,
    `Callers are traders and shop owners. They speak Hindi, Marathi, Gujarati, English, or a mix. Reply in the language the caller used in their last message; if they mix, mix the same way. Write Hindi and Marathi in Devanagari and Gujarati in Gujarati script, because the reply is read aloud.`,
    `Keep every reply to one or two short spoken sentences. Ask one question at a time.`,
    ``,
    `PRICE LIST (the only prices that exist):`,
    priceListText(c),
    ``,
    `RULES:`,
    ...c.policies.map((p) => `- ${p}`),
    `- You may say a list price exactly as written above. Never say any other price, never calculate a discounted price, never agree to the caller's price, never promise credit or a delivery date.`,
    `- If the caller bargains or asks for a lower rate, put the number they offered in lead.offer_price, say that ${b.owner} decides the final rate and will call back, and continue.`,
    `- If they ask for something not on the list, say you will ask ${b.owner}, and put their words in an item with product_id "" .`,
    `- Record quantities exactly as the caller said them, with the unit they used. "50 peti" is 50 carton. Do not convert units yourself.`,
    `- Use product ids from the price list. Leave a field as "" or 0 when the caller has not said it.`,
    `- Set end_call to true only after the caller says goodbye or has nothing more to ask.`,
    ``,
    `WHAT WE KNOW SO FAR: ${JSON.stringify(lead)}`,
    `NEXT THING TO FIND OUT (if the caller has not already said it): ${nextQuestion(call.lead)}.`,
  ].join("\n");
}

function history(call: Call): ChatMessage[] {
  return call.turns.map((t) => ({ role: t.role === "caller" ? "user" : "assistant", content: t.text }) as ChatMessage);
}

const BARGAIN_CUES = /\b(kam|kami|discount|last rate|final rate|best rate|best price|thoda kam|sasta|rate kam|less)\b|कम|कमी|डिस्काउंट|आखिरी|फाइनल|ઓછું|ઓછા|છેલ્લો ભાવ|ડિસ્કાઉન્ટ/i;

interface ModelTurn { reply?: string; language?: string; intent?: string; end_call?: boolean; lead?: LeadUpdate }

export interface Deps { catalog: Catalog; ollama: OllamaOptions; now?: () => Date }

/** Runs one caller turn and returns the updated call. Throws only if the model cannot be reached at all. */
export async function takeTurn(call: Call, callerText: string, d: Deps): Promise<{ call: Call; reply: string; guard?: GuardEvent; endCall: boolean }> {
  const now = (d.now ?? (() => new Date()))().toISOString();
  const next: Call = structuredClone(call);
  next.turns.push({ role: "caller", text: callerText, at: now });

  const messages: ChatMessage[] = [{ role: "system", content: systemPrompt(d.catalog, call) }, ...history(next)];
  let out: ModelTurn;
  try {
    out = (await chatJson(d.ollama, messages, TURN_SCHEMA)) as ModelTurn;
  } catch (e) {
    // one retry for malformed output; connection errors go straight up
    if (e instanceof Error && /valid JSON|without a message/.test(e.message)) {
      next.errors.push(e.message);
      out = (await chatJson(d.ollama, messages, TURN_SCHEMA)) as ModelTurn;
    } else throw e;
  }

  const lang = (["hi", "mr", "gu", "en", "mixed"].includes(out.language ?? "") ? out.language : call.language) as Lang;
  const turnNo = next.turns.filter((t) => t.role === "caller").length;
  next.lead = mergeLead(next.lead, out.lead ?? {}, d.catalog, turnNo);
  const callerAll = next.turns.filter((t) => t.role === "caller").map((t) => t.text).join("\n");
  next.lead = verifyAgainstCaller(next.lead, callerAll);
  if (out.intent) next.intent = out.intent;

  // Prices the receptionist may say: list prices, and list price × a quantity the caller asked for.
  const allowed = allowedPrices(d.catalog);
  for (const it of next.lead.items) { const m = itemMaths(d.catalog, it); for (const v of [m.listValue, m.listValueMax]) if (v !== undefined) allowed.add(v); }
  const bargaining = out.intent === "bargain" || (out.lead?.offer_price ?? 0) > 0 || BARGAIN_CUES.test(callerText);

  let reply = (out.reply ?? "").trim();
  let guard: GuardEvent | undefined;
  if (!reply) { reply = repeatReply(lang === "mixed" ? call.language : lang); next.errors.push("model returned an empty reply"); }
  else {
    guard = checkReply(reply, { allowed, callerBargaining: bargaining });
    if (guard) reply = safeReply(lang === "mixed" ? call.language : lang, d.catalog.business.owner);
  }
  next.turns.push({ role: "agent", text: reply, at: now, guard });
  return { call: next, reply, guard, endCall: !!out.end_call };
}

export function endCall(call: Call, catalog: Catalog, now = new Date()): Call {
  const next = structuredClone(call);
  next.ended_at = now.toISOString();
  if (next.status === "live") next.status = "new";
  next.summary = summary(catalog, next.lead);
  return next;
}

export function productName(c: Catalog, id: string): string { return product(c, id)?.name ?? id; }
