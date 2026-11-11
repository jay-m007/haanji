// Decides when the caller has started and finished speaking, from loudness alone.
// Simple on purpose: phone audio is 8 kHz and noisy, and the rules have to be explainable.
import { concat, rms } from "./audio.ts";

export interface VadOptions {
  /** Silence after speech that ends a turn. */
  endSilenceMs: number;
  /** Shorter sounds (a cough, a click) are ignored. */
  minSpeechMs: number;
  /** A turn is cut here even if the caller keeps talking. */
  maxSpeechMs: number;
  /** Loudness that always counts as speech, whatever the background. */
  floor: number;
}
export const DEFAULT_VAD: VadOptions = { endSilenceMs: 700, minSpeechMs: 250, maxSpeechMs: 15_000, floor: 600 };

export class Vad {
  private o: VadOptions;
  private rate: number;
  private frame: number;
  private pending: Int16Array = new Int16Array(0);
  private noise = 200;
  private speaking = false;
  private speechMs = 0;
  private silenceMs = 0;
  private loudRun = 0;
  private buf: Int16Array[] = [];
  onSpeechStart: () => void = () => {};
  onUtterance: (samples: Int16Array, rate: number) => void = () => {};

  constructor(rate: number, o: Partial<VadOptions> = {}) {
    this.o = { ...DEFAULT_VAD, ...o };
    this.rate = rate;
    this.frame = Math.round(rate * 0.02); // 20 ms frames
  }

  push(samples: Int16Array): void {
    let data = this.pending.length ? concat([this.pending, samples]) : samples;
    let i = 0;
    for (; i + this.frame <= data.length; i += this.frame) this.step(data.subarray(i, i + this.frame));
    this.pending = data.slice(i);
  }

  private step(f: Int16Array): void {
    const level = rms(f);
    const threshold = Math.max(this.o.floor, this.noise * 3);
    const loud = level > threshold;
    if (!this.speaking) {
      // track background noise only while nobody is talking
      this.noise = this.noise * 0.95 + Math.min(level, threshold) * 0.05;
      this.loudRun = loud ? this.loudRun + 20 : 0;
      this.buf.push(f.slice());
      if (this.buf.length > 15) this.buf.shift(); // keep 300 ms before speech so the first syllable is not lost
      if (this.loudRun >= 60) { this.speaking = true; this.speechMs = this.loudRun; this.silenceMs = 0; this.onSpeechStart(); }
      return;
    }
    this.buf.push(f.slice());
    if (loud) { this.speechMs += 20 + this.silenceMs; this.silenceMs = 0; } else this.silenceMs += 20;
    if (this.silenceMs >= this.o.endSilenceMs || this.speechMs >= this.o.maxSpeechMs) this.finish();
  }

  private finish(): void {
    const audio = concat(this.buf);
    const keep = this.speechMs >= this.o.minSpeechMs;
    this.speaking = false; this.speechMs = 0; this.silenceMs = 0; this.loudRun = 0; this.buf = [];
    if (keep) this.onUtterance(audio, this.rate);
  }

  get isSpeaking(): boolean { return this.speaking; }
}
