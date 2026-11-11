// Runs the eval cases against a real Ollama model and prints how well it understood each caller.
// Usage: HAANJI_MODEL=gemma3:4b node eval/run.ts   (needs Ollama running locally)
import { readFileSync, writeFileSync } from "node:fs";
import { newCall, takeTurn } from "../src/agent.ts";
import { loadCatalog } from "../src/catalog.ts";
import { configFromEnv } from "../src/server.ts";
import type { Lang } from "../src/guard.ts";

interface Case { lang: Lang; text: string; product: string; qty: number; unit: string; offer?: number }
const cases = JSON.parse(readFileSync(new URL("./cases.json", import.meta.url), "utf8")) as Case[];
const cfg = configFromEnv();
const catalog = loadCatalog(cfg.catalogPath);

/** Which script most of the reply is written in. */
function script(s: string): "devanagari" | "gujarati" | "latin" {
  const dev = (s.match(/[ऀ-ॿ]/g) ?? []).length, guj = (s.match(/[઀-૿]/g) ?? []).length, lat = (s.match(/[a-z]/gi) ?? []).length;
  return guj > dev && guj > lat ? "gujarati" : dev >= lat ? "devanagari" : "latin";
}
const WANT_SCRIPT: Record<Lang, string[]> = { hi: ["devanagari"], mr: ["devanagari"], gu: ["gujarati"], en: ["latin"], mixed: ["devanagari", "latin"] };

const rows: any[] = [];
console.log(`Model ${cfg.ollama.model} at ${cfg.ollama.host}, ${cases.length} cases\n`);
for (const c of cases) {
  const t0 = Date.now();
  let r;
  try { r = await takeTurn(newCall("eval", catalog, c.lang === "mixed" ? "hi" : c.lang, cfg.ollama.model), c.text, { catalog, ollama: cfg.ollama }); }
  catch (e) { console.error(`  ${(e as Error).message}`); process.exit(2); }
  const it = r.call.lead.items.find((i) => i.product_id === c.product);
  const offer = r.call.lead.offers.at(-1)?.price;
  const row = {
    lang: c.lang, text: c.text, reply: r.reply, ms: Date.now() - t0,
    product: !!it, qty: it?.quantity === c.qty, unit: it?.unit === c.unit,
    offer: c.offer === undefined ? offer === undefined : offer === c.offer,
    script: WANT_SCRIPT[c.lang].includes(script(r.reply)),
    blocked: r.guard?.rule ?? "", blockedReply: r.guard?.blockedReply ?? "",
    got: r.call.lead.items.map((i) => `${i.quantity} ${i.unit} ${i.product_id}`).join(", "),
  };
  rows.push(row);
  const mark = (b: boolean) => (b ? "ok " : "NO ");
  console.log(`${c.lang.padEnd(5)} product ${mark(row.product)} qty ${mark(row.qty)} unit ${mark(row.unit)} offer ${mark(row.offer)} script ${mark(row.script)} ${(row.ms / 1000).toFixed(1)}s${row.blocked ? "  [guard: " + row.blocked + "]" : ""}`);
  console.log(`      caller: ${c.text}\n      got:    ${row.got || "(nothing)"}\n      reply:  ${r.reply}${row.blockedReply ? "\n      model wanted to say: " + row.blockedReply : ""}\n`);
}

const pct = (k: string, list = rows) => `${list.filter((r) => r[k]).length}/${list.length}`;
console.log("Summary");
for (const lang of ["hi", "mr", "gu", "mixed", "en"]) {
  const l = rows.filter((r) => r.lang === lang);
  if (l.length) console.log(`  ${lang.padEnd(5)} product ${pct("product", l)}  qty ${pct("qty", l)}  unit ${pct("unit", l)}  offer ${pct("offer", l)}  reply script ${pct("script", l)}`);
}
console.log(`  all   product ${pct("product")}  qty ${pct("qty")}  unit ${pct("unit")}  offer ${pct("offer")}  reply script ${pct("script")}`);
console.log(`  replies blocked by the guard: ${rows.filter((r) => r.blocked).length}; median time per turn ${(rows.map((r) => r.ms).sort((a, b) => a - b)[Math.floor(rows.length / 2)] / 1000).toFixed(1)}s`);
const out = new URL(`./results-${cfg.ollama.model.replace(/[^\w.-]/g, "_")}.json`, import.meta.url);
writeFileSync(out, JSON.stringify({ model: cfg.ollama.model, at: new Date().toISOString(), rows }, null, 2));
console.log(`\nSaved ${out.pathname}`);
