import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { makeServer } from "../src/server.ts";
import { Store } from "../src/store.ts";
import { startFake, turn, type Fake } from "./fake-ollama.ts";
import { ROOT, tempDir } from "./helpers.ts";

let fake: Fake, base: string, close: () => Promise<void>, tmp: ReturnType<typeof tempDir>;
before(async () => {
  fake = await startFake();
  tmp = tempDir();
  const { server } = makeServer({ port: 0, host: "127.0.0.1", catalogPath: join(ROOT, "test/fixtures/catalog.json"), dataFile: join(tmp.dir, "calls.json"), ollama: { host: fake.host, model: "gemma3:4b" } });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  close = () => new Promise((r) => server.close(() => r()));
});
after(async () => { await close(); await fake.close(); tmp.cleanup(); });

const j = async (path: string, init: RequestInit & { json?: unknown } = {}) => {
  const res = await fetch(base + path, { ...init, headers: { "content-type": "application/json" }, body: init.json !== undefined ? JSON.stringify(init.json) : undefined });
  const text = await res.text();
  return { status: res.status, body: res.headers.get("content-type")?.includes("json") ? JSON.parse(text) : text, headers: res.headers };
};

test("health reports Ollama, model and the sample catalog", async () => {
  const h = await j("/api/health");
  assert.equal(h.body.ollama.reachable, true);
  assert.equal(h.body.modelInstalled, true);
  assert.equal(h.body.sampleCatalog, true);
});

test("pages and scripts are served; anything else is 404", async () => {
  for (const p of ["/", "/dashboard", "/app.js", "/common.js", "/dashboard.js", "/style.css"]) assert.equal((await fetch(base + p)).status, 200, p);
  const home = await fetch(base + "/");
  assert.match(home.headers.get("content-type")!, /text\/html/);
  assert.match(await home.text(), /<title>Haanji call desk<\/title>/);
  assert.match(await (await fetch(base + "/app.js")).text(), /SpeechRecognition/);
  for (const p of ["/../package.json", "/%2e%2e/package.json", "/nope.js", "/src/server.ts"]) assert.equal((await fetch(base + p)).status, 404, p);
});

test("a whole call: start, two turns, bargaining, end, status, CSV, and it survives a restart", async () => {
  const start = await j("/api/calls", { method: "POST", json: { language: "hi" } });
  assert.equal(start.status, 201);
  const id = start.body.id;

  fake.replies.push(turn({ reply: "छोटा बॉक्स ₹1100 प्रति कार्टन है। आपका नाम?", lead: { items: [{ product_id: "box-small", product_words: "chhota box", quantity: 50, unit: "carton" }] } }));
  const t1 = await j(`/api/calls/${id}/turn`, { method: "POST", json: { text: "pachaas peti chhota box, rate?" } });
  assert.equal(t1.status, 200);
  assert.equal(t1.body.call.lead.items[0].listValue, 55000);
  assert.equal(t1.body.call.lead.items[0].pieces, 5000);

  fake.replies.push(turn({ reply: "डील, 1000 में दे देंगे।", intent: "bargain", lead: { name: "=HYPERLINK(\"x\")", offer_price: 1000, offer_per: "carton", offer_product_id: "box-small" } }));
  const t2 = await j(`/api/calls/${id}/turn`, { method: "POST", json: { text: "1000 mein do, final" } });
  assert.equal(t2.body.guard.rule, "price_agreement");

  const end = await j(`/api/calls/${id}/end`, { method: "POST" });
  assert.equal(end.body.status, "new");
  assert.match(end.body.summary, /Owner to confirm/);
  assert.equal((await j(`/api/calls/${id}/turn`, { method: "POST", json: { text: "hello" } })).status, 409);

  assert.equal((await j(`/api/calls/${id}`, { method: "PATCH", json: { status: "won" } })).body.status, "won");
  assert.equal((await j(`/api/calls/${id}`, { method: "PATCH", json: { status: "bogus" } })).status, 400);

  const csv = await j("/api/calls.csv");
  assert.match(csv.headers.get("content-disposition")!, /haanji-calls\.csv/);
  assert.match(csv.body, /'=HYPERLINK/, "caller text starting with = is defused for spreadsheets");
  assert.match(csv.body, /1000\/carton/);

  const saved = new Store(join(tmp.dir, "calls.json")).get(id)!;
  assert.equal(saved.status, "won");
  assert.equal(saved.turns.length, 5);
  assert.ok(JSON.parse(readFileSync(join(tmp.dir, "calls.json"), "utf8")).length >= 1);
});

test("bad input gets clear errors", async () => {
  const id = (await j("/api/calls", { method: "POST", json: {} })).body.id;
  assert.equal((await j(`/api/calls/${id}/turn`, { method: "POST", json: { text: "  " } })).status, 400);
  assert.equal((await j(`/api/calls/${id}/turn`, { method: "POST", json: { text: "x".repeat(1001) } })).status, 400);
  assert.equal((await j(`/api/calls/${id}`, { method: "PATCH", json: { status: "won" } })).status, 409, "a live call cannot be marked won");
  assert.equal((await j("/api/calls/does-not-exist")).status, 404);
  const bad = await fetch(base + "/api/calls", { method: "POST", body: "{nope" });
  assert.equal(bad.status, 400);
});

test("when the model is unavailable the turn fails with 503 and the call is unchanged", async () => {
  const id = (await j("/api/calls", { method: "POST", json: { language: "mr" } })).body.id;
  const prev = fake.models; fake.models = [];
  const r = await j(`/api/calls/${id}/turn`, { method: "POST", json: { text: "नमस्कार" } });
  fake.models = prev;
  assert.equal(r.status, 503);
  assert.match(r.body.error, /ollama pull/);
  assert.equal((await j(`/api/calls/${id}`)).body.turns.length, 1);
});

test("turns on one call run one at a time", async () => {
  const id = (await j("/api/calls", { method: "POST", json: {} })).body.id;
  fake.replies.push(turn({ reply: "एक" }), turn({ reply: "दो" }));
  const [a, b] = await Promise.all([j(`/api/calls/${id}/turn`, { method: "POST", json: { text: "pehla" } }), j(`/api/calls/${id}/turn`, { method: "POST", json: { text: "doosra" } })]);
  assert.equal(a.status, 200); assert.equal(b.status, 200);
  const turns = (await j(`/api/calls/${id}`)).body.turns.map((t: any) => t.text);
  assert.equal(turns.length, 5, "greeting plus two full exchanges, none lost");
});
