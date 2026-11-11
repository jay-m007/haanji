// Rules the model cannot talk its way past. They run on every reply before the caller hears it.
import { findNumbers, isNumberToken, tokens } from "./numbers.ts";

export type Lang = "hi" | "mr" | "gu" | "en" | "mixed";

export interface GuardEvent { rule: "unlisted_price" | "price_agreement" | "discount_promise"; detail: string; blockedReply: string }

const CURRENCY = new Set(["₹", "rs", "rs.", "inr", "rupee", "rupees", "rupaye", "rupaiye", "rupay", "rupiya", "rupaya",
  "रुपये", "रुपए", "रूपये", "रुपया", "रुपयांना", "रुपयाला", "रुपयांत", "रु", "रु.", "રૂપિયા", "રૂપિયે", "રૂ", "રૂ."]);

/** Amounts of money in a text: numbers within two words of a currency word or ₹. */
export function moneyAmounts(text: string): number[] {
  const toks = tokens(text.replace(/₹/g, " ₹ ").replace(/₹/g, "rs"));
  const out: number[] = [];
  for (let i = 0; i < toks.length; i++) {
    if (!CURRENCY.has(toks[i])) continue;
    // number right after the currency word ("₹ 1100", "rs 12") or just before it ("1100 rupaye", "बारह रुपये")
    let j = i + 1;
    while (j < toks.length && j < i + 5 && isNumberToken(toks[j])) j++;
    const after = findNumbers(toks.slice(i + 1, j).join(" "))[0];
    if (after !== undefined) { out.push(after); continue; }
    let k = i;
    while (k > 0 && k > i - 5 && isNumberToken(toks[k - 1])) k--;
    const before = findNumbers(toks.slice(k, i).join(" ")).pop();
    if (before !== undefined) out.push(before);
  }
  return [...new Set(out)];
}

// Phrases that agree to the caller's terms. Checked only when the caller is bargaining.
const AGREE = [
  /\b(deal|done|agreed|fine,? we'?ll|ok(ay)?,? we can do|we can give)\b/i,
  /\b(chalega|chal jayega|de denge|de dengi|kar denge|kar dengi|manzoor|pakka|theek hai,? de)\b/i,
  /(चलेगा|चल जाएगा|दे देंगे|दे दूंगी|दे दूँगी|कर देंगे|मंजूर|मंज़ूर|पक्का|डील)/,
  /(चालेल|देऊ|देतो|देते|करतो|करते|ठरलं|ठरले|मान्य)/,
  /(ચાલશે|આપી દઈશું|આપીશું|કરી દઈશું|નક્કી|મંજૂર|ડીલ)/,
];
// Promises of a lower price, whether or not the caller asked.
const DISCOUNT = [
  /\b(discount|kam kar|sasta|kam rate|special rate|less price)\b/i,
  /(डिस्काउंट|कम कर|सस्ता|कम रेट|स्पेशल रेट|सूट देऊ|कमी करतो|कमी करते|કમી કરી|ઓછું કરી|ડિસ્કાઉન્ટ|સસ્તું)/,
];
// Words that make a discount mention safe: "the owner decides", "I can't".
const DEFERS = [
  /\b(owner|malik|maalik|sethji|seth ji|confirm|cannot|can't|nahi|nahin|nai)\b/i,
  /(मालिक|सेठ|कन्फर्म|नहीं|नही|नाही|शक्य नाही|માલિક|શેઠ|નહીં|કન્ફર્મ)/,
];

export function checkReply(reply: string, opts: { allowed: Set<number>; callerOffer?: number; callerBargaining: boolean }): GuardEvent | undefined {
  for (const n of moneyAmounts(reply)) {
    if (!opts.allowed.has(n)) return { rule: "unlisted_price", detail: `reply mentioned ₹${n}, which is not on the price list`, blockedReply: reply };
  }
  const defers = DEFERS.some((r) => r.test(reply));
  if (opts.callerBargaining && AGREE.some((r) => r.test(reply)) && !defers) {
    return { rule: "price_agreement", detail: "reply seemed to accept the caller's price", blockedReply: reply };
  }
  if (DISCOUNT.some((r) => r.test(reply)) && !defers) {
    return { rule: "discount_promise", detail: "reply offered a discount or lower rate", blockedReply: reply };
  }
  return undefined;
}

/** What the receptionist says instead of a blocked reply. Spoken, short, and in the caller's language. */
export function safeReply(lang: Lang, owner: string): string {
  switch (lang) {
    case "mr": return `दराबद्दल अंतिम निर्णय ${owner} घेतील. मी तुमची ऑफर नोंदवली आहे, ते तुम्हाला फोन करून कळवतील.`;
    case "gu": return `ભાવ વિશે છેલ્લો નિર્ણય ${owner} લેશે. મેં તમારી ઓફર નોંધી લીધી છે, તેઓ તમને ફોન કરીને જણાવશે.`;
    case "en": return `Only ${owner} can decide the final rate. I have noted your offer and he will call you back to confirm.`;
    default: return `रेट का आख़िरी फ़ैसला ${owner} ही करेंगे। मैंने आपका ऑफ़र नोट कर लिया है, वो आपको फ़ोन करके बताएंगे।`;
  }
}

/** When the model gives nothing usable: ask the caller to repeat. */
export function repeatReply(lang: Lang): string {
  switch (lang) {
    case "mr": return "माफ करा, पुन्हा एकदा सांगाल का?";
    case "gu": return "માફ કરજો, ફરીથી કહેશો?";
    case "en": return "Sorry, could you say that again?";
    default: return "माफ़ कीजिए, एक बार फिर से बताइए?";
  }
}
