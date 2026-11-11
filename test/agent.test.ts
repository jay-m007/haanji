import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { endCall, newCall, nextQuestion, systemPrompt, takeTurn, TURN_SCHEMA } from "../src/agent.ts";
import { loadCatalog } from "../src/catalog.ts";
import { emptyLead } from "../src/lead.ts";
import { startFake, turn, type Fake } from "./fake-ollama.ts";
import { ROOT } from "./helpers.ts";

const cat = loadCatalog(join(ROOT, "test/fixtures/catalog.json"));
let fake: Fake;
before(async () => { fake = await startFake(); });
after(async () => { await fake.close(); });
const deps = () => ({ catalog: cat, ollama: { host: fake.host, model: "gemma3:4b" } });

test("greeting is in the chosen language and names the business", () => {
  assert.match(newCall("1", cat, "hi", "m").turns[0].text, /S\.S\. Industries से Priya/);
  assert.match(newCall("1", cat, "mr", "m").turns[0].text, /बोलतेय/);
  assert.match(newCall("1", cat, "gu", "m").turns[0].text, /બોલું છું/);
});

test("a normal turn: lead is filled in, reply passes, model gets the schema, price list and history", async () => {
  fake.replies.push(turn({ reply: "छोटा बॉक्स ₹1100 प्रति कार्टन है। आपका नाम क्या है?", intent: "price_enquiry",
    lead: { items: [{ product_id: "box-small", product_words: "chhota box", quantity: 50, unit: "carton" }] } }));
  const r = await takeTurn(newCall("c1", cat, "hi", "gemma3:4b"), "pachaas peti chhota box chahiye, rate kya hai?", deps());
  assert.equal(r.guard, undefined);
  assert.equal(r.reply, "छोटा बॉक्स ₹1100 प्रति कार्टन है। आपका नाम क्या है?");
  assert.deepEqual(r.call.lead.items.map((i) => [i.product_id, i.quantity, i.unit, i.check]), [["box-small", 50, "carton", undefined]]);
  const req = fake.requests.at(-1);
  assert.deepEqual(req.format, JSON.parse(JSON.stringify(TURN_SCHEMA)));
  assert.equal(req.stream, false);
  assert.match(req.messages[0].content, /₹1100 per carton \(1 carton = 100 piece\)/);
  assert.deepEqual(req.messages.slice(1).map((m: any) => m.role), ["assistant", "user"]);
});

test("a made-up discount price is replaced with the safe reply in the caller's language, and logged", async () => {
  fake.replies.push(turn({ reply: "ठीक है, आपके लिए ₹950 में दे देंगे।", intent: "bargain", lead: { offer_price: 950, offer_per: "carton", offer_product_id: "box-small" } }));
  const r = await takeTurn(newCall("c2", cat, "hi", "m"), "950 mein do na, last rate?", deps());
  assert.equal(r.guard?.rule, "unlisted_price");
  assert.match(r.reply, /मालिक|Maurya ji/);
  assert.equal(r.call.turns.at(-1)!.guard?.blockedReply, "ठीक है, आपके लिए ₹950 में दे देंगे।");
  assert.deepEqual(r.call.lead.offers.map((o) => o.price), [950]);
});

test("accepting the caller's price without a number is blocked too (Gujarati)", async () => {
  fake.replies.push(turn({ reply: "સારું, ચાલશે.", language: "gu", intent: "bargain", lead: { offer_price: 1000 } }));
  const r = await takeTurn(newCall("c3", cat, "gu", "m"), "1000 માં આપી દો ને", deps());
  assert.equal(r.guard?.rule, "price_agreement");
  assert.match(r.reply, /ભાવ વિશે/);
});

test("an empty reply falls back safely and is logged as an error", async () => {
  fake.replies.push(turn({ reply: "", language: "mr" }));
  const r = await takeTurn(newCall("c4", cat, "mr", "m"), "हॅलो", deps());
  assert.match(r.reply, /पुन्हा एकदा/);
  assert.deepEqual(r.call.errors, ["model returned an empty reply"]);
});

test("malformed JSON is retried once", async () => {
  fake.replies.push("not json at all", turn({ reply: "जी, बताइए।" }));
  const r = await takeTurn(newCall("c5", cat, "hi", "m"), "hello", deps());
  assert.equal(r.reply, "जी, बताइए।");
  assert.equal(r.call.errors.length, 1);
});

test("a missing model gives a clear error that says how to install it", async () => {
  await assert.rejects(takeTurn(newCall("c6", cat, "hi", "m"), "hello", { catalog: cat, ollama: { host: fake.host, model: "llama9:1b" } }), /ollama pull llama9:1b/);
});

test("Ollama not running gives a clear error", async () => {
  await assert.rejects(takeTurn(newCall("c7", cat, "hi", "m"), "hello", { catalog: cat, ollama: { host: "http://127.0.0.1:9", model: "m", timeoutMs: 2000 } }), /not reachable.*ollama serve/);
});

test("next question walks product, quantity, name, place, delivery", () => {
  const l = emptyLead();
  assert.match(nextQuestion(l), /which product/);
  l.items.push({ product_id: "tape", quantity: 0, unit: "" });
  assert.match(nextQuestion(l), /how many of tape/);
  l.items[0] = { product_id: "tape", quantity: 5, unit: "box" };
  assert.match(nextQuestion(l), /name/);
  l.name = "A"; assert.match(nextQuestion(l), /company name and city/);
  l.city = "Vapi"; assert.match(nextQuestion(l), /delivery/);
  l.delivery_by = "Monday"; assert.match(nextQuestion(l), /anything else/);
});

test("system prompt forbids discounts and carries what is known", () => {
  const c = newCall("c8", cat, "hi", "m");
  c.lead.name = "Ramesh";
  const p = systemPrompt(cat, c);
  assert.match(p, /never agree to the caller's price/);
  assert.match(p, /"name":"Ramesh"/);
});

test("ending a call writes the summary and marks it new", () => {
  const c = endCall(newCall("c9", cat, "hi", "m"), cat);
  assert.equal(c.status, "new");
  assert.match(c.summary!, /did not name a product/);
  assert.ok(c.ended_at);
});

test("price list text shows ranges and says when a price must come from the owner", async () => {
  const { priceListText, loadCatalog: load } = await import("../src/catalog.ts");
  const t = priceListText(load(join(ROOT, "catalog.json")));
  assert.match(t, /₹20 to ₹75 per box depending on size/);
  assert.match(t, /paper-bell-pin.*price for box not listed, the owner will tell/);
  assert.match(t, /1 carton = 100 box/);
  assert.doesNotMatch(t, /IndiaMART/, "notes for the editor never reach the model");
});
