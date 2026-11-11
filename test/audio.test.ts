import { test } from "node:test";
import assert from "node:assert/strict";
import { fromBytes, fromWav, phoneChunks, resample, rms, silence, toBytes, tone, toWav } from "../src/audio.ts";
import { Vad } from "../src/vad.ts";

test("bytes and WAV round trip", () => {
  const t = tone(100, 16000);
  assert.deepEqual(fromBytes(toBytes(t)), t);
  const w = fromWav(toWav({ samples: t, rate: 16000 }));
  assert.equal(w.rate, 16000);
  assert.deepEqual(w.samples, t);
});

test("stereo WAV is averaged to mono", () => {
  const stereo = new Int16Array([100, 300, -100, -300]);
  const mono = toWav({ samples: stereo, rate: 8000 });
  mono.writeUInt16LE(2, 22); mono.writeUInt32LE(8000 * 4, 28); mono.writeUInt16LE(4, 32); // mark it as 2-channel
  assert.deepEqual([...fromWav(mono).samples], [200, -200]);
});

test("resampling changes length by the rate ratio and keeps loudness", () => {
  const t = tone(1000, 16000);
  const down = resample(t, 16000, 8000);
  assert.equal(down.length, 8000);
  assert.ok(Math.abs(rms(down) - rms(t)) / rms(t) < 0.05);
  assert.equal(resample(t, 16000, 16000), t);
});

test("phone chunks are n×320 bytes and at least 3.2 KB, padded with silence", () => {
  const chunks = phoneChunks(tone(1234, 8000));
  for (const c of chunks) { assert.equal(c.length % 320, 0); assert.ok(c.length >= 3200); }
  assert.equal(chunks.length, Math.ceil((Math.round(1.234 * 8000) * 2) / 3200));
});

function vadRun(parts: Int16Array[], rate = 8000) {
  const v = new Vad(rate);
  const events: string[] = [];
  const utterances: number[] = [];
  v.onSpeechStart = () => events.push("start");
  v.onUtterance = (s, r) => { events.push("utterance"); utterances.push(Math.round((s.length / r) * 1000)); };
  for (const p of parts) for (let i = 0; i < p.length; i += 160) v.push(p.subarray(i, i + 160)); // 20 ms packets like a phone line
  return { events, utterances };
}

test("VAD: speech followed by silence is one utterance", () => {
  const r = vadRun([silence(500, 8000), tone(800, 8000), silence(900, 8000)]);
  assert.deepEqual(r.events, ["start", "utterance"]);
  assert.ok(r.utterances[0] >= 800 && r.utterances[0] < 2000, String(r.utterances[0]));
});

test("VAD: a short pause inside a sentence does not end the turn", () => {
  const r = vadRun([tone(500, 8000), silence(300, 8000), tone(500, 8000), silence(900, 8000)]);
  assert.deepEqual(r.events, ["start", "utterance"]);
});

test("VAD: a click shorter than the minimum is ignored", () => {
  const r = vadRun([silence(200, 8000), tone(100, 8000), silence(900, 8000)]);
  assert.deepEqual(r.events.filter((e) => e === "utterance"), []);
});

test("VAD: steady background hum is not speech", () => {
  const r = vadRun([tone(3000, 8000, 50, 400)]);
  assert.deepEqual(r.events, []);
});

test("VAD: someone talking without pause is cut at the maximum", () => {
  const r = vadRun([tone(16_500, 8000), silence(900, 8000)]);
  assert.equal(r.events.filter((e) => e === "utterance").length, 2);
});
