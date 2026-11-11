// One spoken call, whatever carries the audio (an Exotel phone line or a browser).
// Listens, waits for the caller to finish, asks the model, speaks the checked reply, and lets the caller interrupt.
import { randomUUID } from "node:crypto";
import { endCall, newCall, takeTurn, type Call } from "./agent.ts";
import { durationMs, resample, type Pcm } from "./audio.ts";
import type { Catalog } from "./catalog.ts";
import { repeatReply, type Lang } from "./guard.ts";
import { callMessage, type Notifier } from "./notify.ts";
import type { OllamaOptions } from "./ollama.ts";
import type { Speech } from "./speech.ts";
import type { Store } from "./store.ts";
import { Vad, type VadOptions } from "./vad.ts";

export interface Transport {
  /** Sample rate of the audio this transport sends and expects. */
  rate: number;
  sendAudio(samples: Int16Array): void;
  /** Drop audio that has not been played yet (the caller interrupted). */
  clear(): void;
  hangup(): void;
  /** Optional live events for a screen (captions). */
  event?(e: Record<string, unknown>): void;
}

export interface VoiceDeps {
  catalog: Catalog;
  ollama: OllamaOptions;
  store: Store;
  speech: Speech;
  notifier?: Notifier;
  dashboardUrl?: string;
  /** Say a short filler if the model has not answered by then. */
  fillerAfterMs?: number;
  maxCallMs?: number;
  vad?: Partial<VadOptions>;
  log?: (msg: string) => void;
}

export function fillerLine(lang: Lang): string {
  switch (lang) {
    case "mr": return "एक सेकंद हं.";
    case "gu": return "એક સેકન્ડ.";
    case "en": return "One moment please.";
    default: return "जी, एक सेकंड।";
  }
}

export function callbackLine(lang: Lang, owner: string): string {
  switch (lang) {
    case "mr": return `माफ करा, आत्ता उत्तर देता येत नाही. ${owner} तुम्हाला लवकरच फोन करतील.`;
    case "gu": return `માફ કરજો, હમણાં જવાબ આપી શકતી નથી. ${owner} તમને જલ્દી ફોન કરશે.`;
    case "en": return `Sorry, I cannot answer right now. ${owner} will call you back soon.`;
    default: return `माफ़ कीजिए, अभी जवाब नहीं दे पा रही। ${owner} आपको जल्दी फ़ोन करेंगे।`;
  }
}

export function goodbyeLine(lang: Lang, owner: string): string {
  switch (lang) {
    case "mr": return `धन्यवाद. ${owner} तुम्हाला फोन करतील. नमस्कार.`;
    case "gu": return `આભાર. ${owner} તમને ફોન કરશે. નમસ્તે.`;
    case "en": return `Thank you. ${owner} will call you. Goodbye.`;
    default: return `धन्यवाद। ${owner} आपको फ़ोन करेंगे। नमस्ते।`;
  }
}

export class VoiceSession {
  call: Call;
  private d: VoiceDeps;
  private t: Transport;
  private vad: Vad;
  private queue: Promise<void> = Promise.resolve();
  private speakingUntil = 0;
  private ended = false;
  private hangingUp = false;
  private timers: NodeJS.Timeout[] = [];
  private cache = new Map<string, Pcm>();
  /** Resolves when the call is over and saved (for tests and clean shutdown). */
  done: Promise<Call>;
  private resolveDone!: (c: Call) => void;

  constructor(d: VoiceDeps, t: Transport, o: { lang: Lang; channel: "phone" | "web"; from?: string }) {
    this.d = d; this.t = t;
    this.call = newCall(randomUUID(), d.catalog, o.lang, d.ollama.model, new Date(), { channel: o.channel, from: o.from });
    this.done = new Promise((r) => (this.resolveDone = r));
    this.vad = new Vad(t.rate, d.vad);
    this.vad.onSpeechStart = () => {
      if (Date.now() < this.speakingUntil && !this.hangingUp) { this.t.clear(); this.speakingUntil = 0; this.t.event?.({ type: "clear" }); }
    };
    this.vad.onUtterance = (samples, rate) => { this.queue = this.queue.then(() => this.handle({ samples, rate })).catch((e) => this.fail(e)); };
  }

  async start(): Promise<void> {
    this.d.store.put(this.call);
    this.timers.push(setTimeout(() => void this.closeWith(goodbyeLine(this.call.language, this.d.catalog.business.owner)), this.d.maxCallMs ?? 8 * 60_000));
    this.t.event?.({ type: "agent", text: this.call.turns[0].text });
    await this.say(this.call.turns[0].text);
  }

  audio(samples: Int16Array): void { if (!this.ended && !this.hangingUp) this.vad.push(samples); }

  private log(m: string): void { this.d.log?.(`[call ${this.call.id.slice(0, 8)}] ${m}`); }

  private async handle(audio: Pcm): Promise<void> {
    if (this.ended || this.hangingUp) return;
    const lang = this.call.language;
    let text = "";
    try { text = await this.d.speech.stt(audio, lang); }
    catch (e) { this.call.errors.push(`speech-to-text: ${(e as Error).message}`); this.log((e as Error).message); await this.say(repeatReply(lang)); return; }
    if (!text) return; // noise, not words
    this.t.event?.({ type: "caller", text });

    const filler = setTimeout(() => void this.say(fillerLine(lang)), this.d.fillerAfterMs ?? 2500);
    let reply: string, endNow = false;
    try {
      const r = await takeTurn(this.call, text, { catalog: this.d.catalog, ollama: this.d.ollama });
      this.call = r.call; reply = r.reply; endNow = r.endCall;
    } catch (e) {
      // The model is down: keep what the caller said, promise a call back, and end politely.
      this.call.turns.push({ role: "caller", text, at: new Date().toISOString() });
      this.call.errors.push(`model: ${(e as Error).message}`);
      this.log((e as Error).message);
      reply = callbackLine(lang, this.d.catalog.business.owner);
      this.call.turns.push({ role: "agent", text: reply, at: new Date().toISOString() });
      endNow = true;
    } finally { clearTimeout(filler); }
    this.d.store.put(this.call);
    const last = this.call.turns.at(-1);
    this.t.event?.({ type: "agent", text: reply, guard: last?.guard?.rule, lead: this.call.lead });
    if (endNow) await this.closeWith(reply, true);
    else await this.say(reply);
  }

  /** Speaks, then hangs up once the audio has played. */
  private async closeWith(text: string, alreadyLogged = false): Promise<void> {
    if (this.hangingUp || this.ended) return;
    this.hangingUp = true;
    if (!alreadyLogged) { this.call.turns.push({ role: "agent", text, at: new Date().toISOString() }); this.d.store.put(this.call); }
    await this.say(text);
    const wait = Math.max(0, this.speakingUntil - Date.now()) + 300;
    this.timers.push(setTimeout(() => { this.t.hangup(); void this.finish(); }, wait));
  }

  private async say(text: string): Promise<void> {
    if (this.ended) return;
    const key = `${this.call.language}|${text}`;
    let pcm = this.cache.get(key);
    if (!pcm) {
      try { pcm = await this.d.speech.tts(text, this.call.language); }
      catch (e) { this.call.errors.push(`text-to-speech: ${(e as Error).message}`); this.log((e as Error).message); return; }
      if (text.length < 80) this.cache.set(key, pcm); // greetings and fillers repeat
    }
    if (this.ended) return;
    const samples = resample(pcm.samples, pcm.rate, this.t.rate);
    this.t.sendAudio(samples);
    this.speakingUntil = Math.max(Date.now(), this.speakingUntil) + durationMs({ samples, rate: this.t.rate });
  }

  private async fail(e: unknown): Promise<void> {
    this.call.errors.push(`call: ${(e as Error)?.message ?? e}`);
    this.log(String((e as Error)?.stack ?? e));
  }

  /** Ends the call (caller hung up, or we did). Safe to call more than once. */
  async finish(): Promise<Call> {
    if (this.ended) return this.done;
    this.ended = true;
    for (const t of this.timers) clearTimeout(t);
    await this.queue.catch(() => {});
    this.call = endCall(this.call, this.d.catalog);
    this.d.store.put(this.call);
    this.t.event?.({ type: "ended", summary: this.call.summary });
    if (this.d.notifier) {
      try { await this.d.notifier.send(callMessage(this.call, this.d.dashboardUrl)); }
      catch (e) { this.call.errors.push(`notify: ${(e as Error).message}`); this.d.store.put(this.call); this.log((e as Error).message); }
    }
    this.resolveDone(this.call);
    return this.call;
  }
}
