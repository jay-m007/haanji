import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { createServer } from "node:http";
import { loadCatalog } from "../src/catalog.ts";
import { fromBytes, silence, tone } from "../src/audio.ts";
import { makeServer } from "../src/server.ts";
import { fakeSpeech, sarvamSpeech, localSpeech } from "../src/speech.ts";
import { callMessage, telegram, type Notifier } from "../src/notify.ts";
import { Store } from "../src/store.ts";
import { VoiceSession, callbackLine, type Transport } from "../src/voice.ts";
import { startFake, turn, type Fake } from "./fake-ollama.ts";
import { ROOT, tempDir } from "./helpers.ts";

const cat = loadCatalog(join(ROOT, "catalog.json"));
let fake: Fake, tmp: ReturnType<typeof tempDir>;
before(async () => { fake = await startFake(); tmp = tempDir(); });
after(async () => { await fake.close(); tmp.cleanup(); });

/** Speech then silence, in 20 ms packets, the way a phone line delivers it. */
function say(session: { audio: (s: Int16Array) => void }, rate: number, ms = 600) {
  for (const part of [tone(ms, rate), silence(900, rate)]) for (let i = 0; i < part.length; i += rate / 50) session.audio(part.subarray(i, i + rate / 50));
}
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => boolean, ms = 4000) { const t = Date.now(); while (!cond()) { if (Date.now() - t > ms) throw new Error("timed out waiting"); await wait(20); } }

function fakeTransport(rate = 8000) {
  const t = { rate, audio: [] as number[], clears: 0, hungUp: false, events: [] as any[],
    sendAudio(s: Int16Array) { t.audio.push(s.length); }, clear() { t.clears++; }, hangup() { t.hungUp = true; }, event(e: any) { t.events.push(e); } };
  return t;
}
const notes: string[] = [];
const notifier: Notifier = { async send(t) { notes.push(t); } };

test("voice session: discloses, greets, hears, answers through the guard, and reports the call", async () => {
  const speech = fakeSpeech(["मुझे 1000 बॉक्स पेपर पिन चाहिए", "18 रुपये में दोगे?"], 2);
  const store = new Store(join(tmp.dir, "v1.json"));
  const t = fakeTransport();
  fake.replies.push(
    turn({ reply: "पेपर पिन ₹20 से ₹75 प्रति बॉक्स है। आपका नाम?", lead: { items: [{ product_id: "paper-pin", product_words: "पेपर पिन", quantity: 1000, unit: "box" }] } }),
    turn({ reply: "ठीक है, ₹18 में दे देंगे।", intent: "bargain", lead: { offer_price: 18, offer_per: "box", offer_product_id: "paper-pin" } }),
  );
  const s = new VoiceSession({ catalog: cat, ollama: { host: fake.host, model: "gemma3:4b" }, store, speech, notifier }, t, { lang: "hi", channel: "phone", from: "+919800000000" });
  await s.start();
  assert.match(speech.spoken[0], /ऑटोमैटिक असिस्टेंट.*Priya/s, "disclosure comes first");
  assert.equal(s.call.lead.phone, "+919800000000");
  say(s, 8000); await until(() => speech.spoken.length >= 2);
  say(s, 8000); await until(() => speech.spoken.length >= 3);
  assert.match(speech.spoken[2], /Maurya ji/, "the ₹18 agreement was replaced");
  const call = await s.finish();
  assert.equal(call.status, "new");
  assert.equal(call.channel, "phone");
  assert.deepEqual(call.lead.offers.map((o) => o.price), [18]);
  assert.equal(call.turns.filter((x) => x.guard).length, 1);
  assert.equal(store.get(call.id)?.status, "new");
  assert.match(notes.at(-1)!, /\+919800000000[\s\S]*Bargaining: offered ₹18\/box/);
  await s.finish(); assert.equal(notes.length, 1, "finishing twice notifies once");
});

test("voice session: the caller talking over the assistant stops its audio", async () => {
  const speech = fakeSpeech([], 40); // greeting takes ~3 s to play
  const t = fakeTransport();
  const s = new VoiceSession({ catalog: cat, ollama: { host: fake.host, model: "gemma3:4b" }, store: new Store(join(tmp.dir, "v2.json")), speech }, t, { lang: "hi", channel: "phone" });
  await s.start();
  for (let i = 0; i < 10; i++) s.audio(tone(20, 8000)); // 200 ms of speech while the greeting plays
  assert.equal(t.clears, 1);
  await s.finish();
});

test("voice session: a slow model gets a filler line, a dead model gets a promise of a call back and a hang-up", async () => {
  const speech = fakeSpeech(["hello", "hello"], 2);
  const store = new Store(join(tmp.dir, "v3.json"));
  const slow = createServer(async (req, res) => { await wait(400); res.end(JSON.stringify({ message: { content: JSON.stringify(turn({ reply: "जी बताइए।" })) } })); });
  await new Promise<void>((r) => slow.listen(0, "127.0.0.1", r));
  const t = fakeTransport();
  const s = new VoiceSession({ catalog: cat, ollama: { host: `http://127.0.0.1:${(slow.address() as AddressInfo).port}`, model: "m" }, store, speech, fillerAfterMs: 100 }, t, { lang: "hi", channel: "phone" });
  await s.start(); say(s, 8000);
  await until(() => speech.spoken.includes("जी बताइए।"));
  assert.ok(speech.spoken.includes("जी, एक सेकंड।"), "filler was spoken while waiting");
  await s.finish(); slow.close();

  const t2 = fakeTransport();
  const s2 = new VoiceSession({ catalog: cat, ollama: { host: "http://127.0.0.1:9", model: "m", timeoutMs: 500 }, store, speech: fakeSpeech(["मुझे पिन चाहिए"], 2) }, t2, { lang: "hi", channel: "phone" });
  await s2.start(); say(s2, 8000);
  const done = await s2.done;
  assert.ok(t2.hungUp);
  assert.equal(done.turns.at(-1)!.text, callbackLine("hi", "Maurya ji"));
  assert.ok(done.turns.some((x) => x.role === "caller" && x.text === "मुझे पिन चाहिए"), "what the caller said is kept");
  assert.match(done.errors.join(), /model: .*not reachable/);
});

test("voice session: silence or noise that transcribes to nothing is ignored", async () => {
  const speech = fakeSpeech([""], 2);
  const s = new VoiceSession({ catalog: cat, ollama: { host: fake.host, model: "gemma3:4b" }, store: new Store(join(tmp.dir, "v4.json")), speech }, fakeTransport(), { lang: "mr", channel: "web" });
  await s.start(); say(s, 8000); await wait(150);
  assert.equal(speech.spoken.length, 1);
  assert.equal((await s.finish()).turns.length, 1);
});

test("Exotel stream end to end: auth, start, media in, n×320-byte media out, stop", async () => {
  const speech = fakeSpeech(["मुझे 1000 बॉक्स पेपर पिन चाहिए"], 2);
  const notes2: string[] = [];
  fake.replies.push(turn({ reply: "जी, पेपर पिन ₹20 से ₹75 प्रति बॉक्स है।", lead: { items: [{ product_id: "paper-pin", product_words: "", quantity: 1000, unit: "box" }] } }));
  const { server, store, sessions } = makeServer({ port: 0, host: "127.0.0.1", catalogPath: join(ROOT, "catalog.json"), dataFile: join(tmp.dir, "ex.json"), ollama: { host: fake.host, model: "gemma3:4b" },
    speech, exotelToken: "s3cret", notifier: { async send(t) { notes2.push(t); } } });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `ws://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const bad = new WebSocket(`${base}/exotel/ws?key=wrong`);
  await new Promise<void>((r) => { bad.onerror = () => r(); bad.onopen = () => assert.fail("wrong token accepted"); });

  const ws = new WebSocket(`${base}/exotel/ws?key=s3cret`);
  const media: number[] = [];
  ws.onmessage = (e) => { const m = JSON.parse(String(e.data)); if (m.event === "media") { assert.equal(m.stream_sid, "SID1"); media.push(Buffer.from(m.media.payload, "base64").length); } };
  await new Promise<void>((r) => (ws.onopen = () => r()));
  ws.send(JSON.stringify({ event: "connected" }));
  ws.send(JSON.stringify({ event: "start", sequence_number: 1, stream_sid: "SID1", start: { stream_sid: "SID1", call_sid: "C1", from: "09812345678", to: "0222", custom_parameters: {}, media_format: { encoding: "raw", sample_rate: "8000", bit_rate: "128" } } }));
  await until(() => media.length > 0);
  const greetingChunks = media.length;
  for (const part of [tone(600, 8000), silence(900, 8000)]) for (let i = 0; i < part.length; i += 160) {
    const b = Buffer.alloc(320); for (let k = 0; k < 160 && i + k < part.length; k++) b.writeInt16LE(part[i + k], k * 2);
    ws.send(JSON.stringify({ event: "media", stream_sid: "SID1", media: { chunk: i / 160, timestamp: String(i / 8), payload: b.toString("base64") } }));
  }
  await until(() => media.length > greetingChunks && speech.spoken.length >= 2);
  for (const n of media) { assert.equal(n % 320, 0); assert.ok(n >= 3200); }
  ws.send(JSON.stringify({ event: "stop", stream_sid: "SID1", stop: { call_sid: "C1", reason: "callended" } }));
  await until(() => notes2.length === 1);
  const call = store.list()[0];
  assert.equal(call.channel, "phone");
  assert.equal(call.lead.phone, "09812345678");
  assert.equal(call.lead.items[0].quantity, 1000);
  assert.equal(sessions.size, 0);
  server.closeAllConnections?.(); server.close();
});

test("web call end to end: start, PCM in, PCM and captions out, busy when full", async () => {
  const speech = fakeSpeech(["50 બોક્સ ટી પિન"], 2);
  fake.replies.push(turn({ reply: "ટી પિન ₹20 થી ₹75 પ્રતિ બોક્સ છે.", language: "gu", lead: { items: [{ product_id: "ss-t-pin", product_words: "", quantity: 50, unit: "box" }] } }));
  const { server, store } = makeServer({ port: 0, host: "127.0.0.1", catalogPath: join(ROOT, "catalog.json"), dataFile: join(tmp.dir, "web.json"), ollama: { host: fake.host, model: "gemma3:4b" }, speech, maxWebCalls: 1 });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `ws://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const ws = new WebSocket(`${base}/web/ws`);
  ws.binaryType = "arraybuffer";
  let audioBytes = 0; const events: any[] = [];
  ws.onmessage = (e) => { if (typeof e.data === "string") events.push(JSON.parse(e.data)); else audioBytes += (e.data as ArrayBuffer).byteLength; };
  await new Promise<void>((r) => (ws.onopen = () => r()));
  ws.send(JSON.stringify({ type: "start", lang: "gu" }));
  const busy = new WebSocket(`${base}/web/ws`);
  await new Promise<void>((r) => { busy.onerror = () => r(); busy.onopen = () => assert.fail("second call should be refused"); });
  await until(() => audioBytes > 0);
  for (const part of [tone(600, 16000), silence(900, 16000)]) for (let i = 0; i < part.length; i += 1600) ws.send(new Int16Array(part.subarray(i, i + 1600)).buffer);
  await until(() => events.filter((e) => e.type === "agent").length >= 2); // greeting, then the answer
  assert.deepEqual(events.filter((e) => e.type === "caller").map((e) => e.text), ["50 બોક્સ ટી પિન"]);
  ws.send(JSON.stringify({ type: "hangup" }));
  await until(() => store.list()[0]?.status === "new");
  assert.equal(store.list()[0].channel, "web");
  assert.match(store.list()[0].turns[0].text, /ઓટોમેટિક આસિસ્ટન્ટ/);
  server.closeAllConnections?.(); server.close();
});

test("Sarvam provider sends the documented fields and reads transcript and WAV audio", async () => {
  const seen: any[] = [];
  const srv = createServer(async (req, res) => {
    const chunks: Buffer[] = []; for await (const c of req) chunks.push(c as Buffer);
    const body = Buffer.concat(chunks).toString("latin1");
    seen.push({ url: req.url, key: req.headers["api-subscription-key"], type: req.headers["content-type"], body });
    if (req.url === "/speech-to-text") return res.end(JSON.stringify({ transcript: " पचास पेटी ", language_code: "hi-IN" }));
    const { toWav, tone: t } = await import("../src/audio.ts");
    res.end(JSON.stringify({ audios: [toWav({ samples: t(200, 16000), rate: 16000 }).toString("base64")] }));
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  const sp = sarvamSpeech({ key: "k1", base: `http://127.0.0.1:${(srv.address() as AddressInfo).port}` });
  assert.equal(await sp.stt({ samples: tone(300, 8000), rate: 8000 }, "mr"), "पचास पेटी");
  const out = await sp.tts("नमस्ते", "gu");
  assert.equal(out.rate, 16000); assert.equal(out.samples.length, 3200);
  assert.equal(seen[0].key, "k1");
  assert.match(seen[0].type, /multipart\/form-data/);
  assert.match(seen[0].body, /name="language_code"\r\n\r\nmr-IN/);
  assert.match(seen[0].body, /RIFF/);
  const tts = JSON.parse(seen[1].body);
  assert.equal(tts.language_code, "gu-IN"); assert.equal(tts.speaker, "priya"); assert.equal(tts.model, "bulbul:v3"); assert.equal(tts.speech_sample_rate, 16000);
  srv.close();
});

test("local speech provider talks to the Python service's JSON API", async () => {
  const srv = createServer(async (req, res) => {
    const chunks: Buffer[] = []; for await (const c of req) chunks.push(c as Buffer);
    const b = JSON.parse(Buffer.concat(chunks).toString());
    if (req.url === "/stt") { assert.equal(b.sample_rate, 16000); assert.equal(Buffer.from(b.audio, "base64").length, 16000 * 2 * 0.5); return res.end(JSON.stringify({ text: "हाँ जी" })); }
    res.end(JSON.stringify({ sample_rate: 44100, audio: Buffer.alloc(882).toString("base64") }));
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  const sp = localSpeech(`http://127.0.0.1:${(srv.address() as AddressInfo).port}`);
  assert.equal(await sp.stt({ samples: tone(500, 8000), rate: 8000 }, "hi"), "हाँ जी");
  assert.deepEqual(await sp.tts("x", "hi").then((p) => [p.rate, p.samples.length]), [44100, 441]);
  srv.close();
  await assert.rejects(localSpeech("http://127.0.0.1:9", 500).tts("x", "hi"), /speech service is not reachable/);
});

test("Telegram notifier posts the summary to the chat", async () => {
  let got: any;
  const srv = createServer(async (req, res) => { const c: Buffer[] = []; for await (const x of req) c.push(x as Buffer); got = { url: req.url, body: JSON.parse(Buffer.concat(c).toString()) }; res.end("{}"); });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  await telegram({ token: "123:abc", chatId: "42", base: `http://127.0.0.1:${(srv.address() as AddressInfo).port}` }).send("hello");
  assert.equal(got.url, "/bot123:abc/sendMessage");
  assert.deepEqual([got.body.chat_id, got.body.text], ["42", "hello"]);
  srv.close();
});

test("call message flags bargaining, checks and blocked replies", async () => {
  const { newCall, endCall } = await import("../src/agent.ts");
  const c = endCall(newCall("x", cat, "hi", "m", new Date(), { channel: "phone", from: "+91 98" }), cat);
  c.lead.offers.push({ product_id: "paper-pin", price: 18, per: "box", turn: 1 });
  const m = callMessage(c, "https://example.test/dashboard");
  assert.match(m, /from \+91 98/); assert.match(m, /offered ₹18\/box/); assert.match(m, /example\.test\/dashboard/);
});

test("the speech service's default port is not one fetch refuses (5060/5061 are blocked as SIP ports)", async () => {
  const { speechFromEnv } = await import("../src/speech.ts");
  const sp = speechFromEnv({ HAANJI_SPEECH: "local" } as any)!;
  const err = (await sp.tts("x", "hi").then(() => undefined, (e) => e)) as Error | undefined;
  assert.doesNotMatch(String(err?.message ?? ""), /bad port/);
  assert.equal(speechFromEnv({ HAANJI_SPEECH: "off" } as any), undefined);
  assert.throws(() => speechFromEnv({ HAANJI_SPEECH: "sarvam" } as any), /SARVAM_API_KEY/);
});
