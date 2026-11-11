// Speech-to-text and text-to-speech behind one interface, so the free local models and Sarvam can be swapped with one setting.
import { fromWav, resample, toWav, tone, type Pcm } from "./audio.ts";
import type { Lang } from "./guard.ts";

export interface Speech {
  name: string;
  stt(audio: Pcm, lang: Lang): Promise<string>;
  tts(text: string, lang: Lang): Promise<Pcm>;
}

export class SpeechError extends Error {}

const BCP47: Record<Lang, string> = { hi: "hi-IN", mr: "mr-IN", gu: "gu-IN", en: "en-IN", mixed: "hi-IN" };

async function post(url: string, init: RequestInit, timeoutMs: number, what: string): Promise<Response> {
  let res: Response;
  try { res = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) }); }
  catch (e) { throw new SpeechError(`${what} is not reachable at ${url} (${e instanceof Error && e.name === "TimeoutError" ? "timed out" : "connection refused"}).`); }
  if (!res.ok) throw new SpeechError(`${what} returned ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res;
}

/** The Python service in speech/ running the free AI4Bharat models on this computer. */
export function localSpeech(baseUrl: string, timeoutMs = 20_000): Speech {
  return {
    name: "local",
    async stt(audio, lang) {
      const pcm = resample(audio.samples, audio.rate, 16000);
      const res = await post(`${baseUrl}/stt`, { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ lang, sample_rate: 16000, audio: Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength).toString("base64") }) }, timeoutMs, "The speech service");
      return String(((await res.json()) as { text?: string }).text ?? "").trim();
    },
    async tts(text, lang) {
      const res = await post(`${baseUrl}/tts`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ lang, text }) }, timeoutMs, "The speech service");
      const data = (await res.json()) as { sample_rate: number; audio: string };
      const b = Buffer.from(data.audio, "base64");
      return { samples: new Int16Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.length - (b.length % 2))), rate: data.sample_rate };
    },
  };
}

/** Sarvam AI's paid API (https://docs.sarvam.ai). Faster on a laptop without a strong GPU. */
export function sarvamSpeech(o: { key: string; base?: string; ttsModel?: string; speaker?: string; sttModel?: string; timeoutMs?: number }): Speech {
  const base = o.base ?? "https://api.sarvam.ai";
  const t = o.timeoutMs ?? 20_000;
  return {
    name: "sarvam",
    async stt(audio, lang) {
      const form = new FormData();
      form.append("file", new Blob([new Uint8Array(toWav(audio))], { type: "audio/wav" }), "turn.wav");
      form.append("model", o.sttModel ?? "saaras:v3");
      form.append("language_code", lang === "mixed" ? "unknown" : BCP47[lang]);
      const res = await post(`${base}/speech-to-text`, { method: "POST", headers: { "api-subscription-key": o.key }, body: form }, t, "Sarvam speech-to-text");
      return String(((await res.json()) as { transcript?: string }).transcript ?? "").trim();
    },
    async tts(text, lang) {
      const res = await post(`${base}/text-to-speech`, { method: "POST", headers: { "api-subscription-key": o.key, "content-type": "application/json" },
        body: JSON.stringify({ text: text.slice(0, 2500), language_code: BCP47[lang], model: o.ttsModel ?? "bulbul:v3", speaker: o.speaker ?? "priya", speech_sample_rate: 16000 }) }, t, "Sarvam text-to-speech");
      const data = (await res.json()) as { audios?: string[] };
      if (!data.audios?.length) throw new SpeechError("Sarvam returned no audio.");
      return fromWav(Buffer.from(data.audios[0], "base64"));
    },
  };
}

/** For tests and demos without models: hears the next scripted line, speaks a tone as long as the text. */
export function fakeSpeech(heard: string[] = [], msPerChar = 40): Speech & { heard: string[]; spoken: string[] } {
  const spoken: string[] = [];
  return {
    name: "fake", heard, spoken,
    async stt() { return heard.shift() ?? ""; },
    async tts(text) { spoken.push(text); return { samples: tone(Math.min(4000, msPerChar * text.length), 16000, 300, 3000), rate: 16000 }; },
  };
}

export function speechFromEnv(env = process.env): Speech | undefined {
  const which = (env.HAANJI_SPEECH ?? "local").toLowerCase();
  if (which === "off") return undefined;
  if (which === "sarvam") {
    if (!env.SARVAM_API_KEY) throw new Error("HAANJI_SPEECH=sarvam needs SARVAM_API_KEY in .env");
    return sarvamSpeech({ key: env.SARVAM_API_KEY, ttsModel: env.SARVAM_TTS_MODEL, speaker: env.SARVAM_SPEAKER, sttModel: env.SARVAM_STT_MODEL });
  }
  if (which === "fake") return fakeSpeech();
  return localSpeech((env.HAANJI_SPEECH_URL ?? "http://127.0.0.1:5070").replace(/\/$/, ""));
}
