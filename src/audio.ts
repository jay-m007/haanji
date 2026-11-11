// 16-bit PCM helpers: phone lines and speech models disagree about sample rates, so everything passes through here.

export interface Pcm { samples: Int16Array; rate: number }

export function fromBytes(buf: Buffer): Int16Array {
  const even = buf.length - (buf.length % 2);
  const out = new Int16Array(even / 2);
  for (let i = 0; i < out.length; i++) out[i] = buf.readInt16LE(i * 2);
  return out;
}

export function toBytes(samples: Int16Array): Buffer {
  const buf = Buffer.alloc(samples.length * 2);
  for (let i = 0; i < samples.length; i++) buf.writeInt16LE(samples[i], i * 2);
  return buf;
}

/** Linear resampling. Good enough for speech going to and from a phone line. */
export function resample(samples: Int16Array, from: number, to: number): Int16Array {
  if (from === to || samples.length === 0) return samples;
  const n = Math.max(1, Math.round((samples.length * to) / from));
  const out = new Int16Array(n);
  const step = from / to;
  for (let i = 0; i < n; i++) {
    const x = i * step, j = Math.floor(x), f = x - j;
    const a = samples[Math.min(j, samples.length - 1)], b = samples[Math.min(j + 1, samples.length - 1)];
    out[i] = Math.round(a + (b - a) * f);
  }
  return out;
}

export function rms(samples: Int16Array, start = 0, end = samples.length): number {
  let sum = 0;
  for (let i = start; i < end; i++) sum += samples[i] * samples[i];
  return end > start ? Math.sqrt(sum / (end - start)) : 0;
}

export function concat(parts: Int16Array[]): Int16Array {
  const out = new Int16Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

export function durationMs(p: Pcm): number { return (p.samples.length / p.rate) * 1000; }

/** A mono 16-bit WAV file. */
export function toWav(p: Pcm): Buffer {
  const data = toBytes(p.samples);
  const h = Buffer.alloc(44);
  h.write("RIFF", 0); h.writeUInt32LE(36 + data.length, 4); h.write("WAVE", 8);
  h.write("fmt ", 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(p.rate, 24); h.writeUInt32LE(p.rate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write("data", 36); h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}

/** Reads a 16-bit PCM WAV (any channel count; channels are averaged to mono). */
export function fromWav(buf: Buffer): Pcm {
  if (buf.toString("ascii", 0, 4) !== "RIFF" || buf.toString("ascii", 8, 12) !== "WAVE") throw new Error("not a WAV file");
  let off = 12, rate = 0, channels = 1, bits = 16, data: Buffer | undefined;
  while (off + 8 <= buf.length) {
    const id = buf.toString("ascii", off, off + 4), size = buf.readUInt32LE(off + 4);
    const body = buf.subarray(off + 8, Math.min(buf.length, off + 8 + size));
    if (id === "fmt ") { channels = body.readUInt16LE(2); rate = body.readUInt32LE(4); bits = body.readUInt16LE(14); }
    if (id === "data") data = body;
    off += 8 + size + (size % 2);
  }
  if (!data || !rate) throw new Error("WAV file has no audio");
  if (bits !== 16) throw new Error(`WAV is ${bits}-bit; only 16-bit is supported`);
  const all = fromBytes(data);
  if (channels === 1) return { samples: all, rate };
  const mono = new Int16Array(Math.floor(all.length / channels));
  for (let i = 0; i < mono.length; i++) { let s = 0; for (let c = 0; c < channels; c++) s += all[i * channels + c]; mono[i] = Math.round(s / channels); }
  return { samples: mono, rate };
}

/**
 * Splits audio into chunks Exotel accepts: each a multiple of 320 bytes and at least 3,200 bytes.
 * The last chunk is padded with silence.
 */
export function phoneChunks(samples: Int16Array, chunkBytes = 3200): Buffer[] {
  const bytes = toBytes(samples);
  const out: Buffer[] = [];
  for (let i = 0; i < bytes.length; i += chunkBytes) {
    let c = bytes.subarray(i, i + chunkBytes);
    if (c.length < chunkBytes) c = Buffer.concat([c, Buffer.alloc(chunkBytes - c.length)]);
    out.push(c);
  }
  return out;
}

/** A sine tone; used by tests and the fake speech provider. */
export function tone(ms: number, rate: number, freq = 440, amp = 8000): Int16Array {
  const n = Math.round((ms / 1000) * rate);
  const out = new Int16Array(n);
  for (let i = 0; i < n; i++) out[i] = Math.round(amp * Math.sin((2 * Math.PI * freq * i) / rate));
  return out;
}

export function silence(ms: number, rate: number): Int16Array { return new Int16Array(Math.round((ms / 1000) * rate)); }
