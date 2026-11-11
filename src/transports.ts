// The two ways audio reaches Haanji: Exotel's phone stream and the free "call us online" page.
import { fromBytes, phoneChunks, toBytes } from "./audio.ts";
import type { Lang } from "./guard.ts";
import { VoiceSession, type VoiceDeps } from "./voice.ts";
import type { WebSocketConnection } from "./ws.ts";

const LANGS: Lang[] = ["hi", "mr", "gu", "en", "mixed"];
const pickLang = (x: unknown, fallback: Lang): Lang => (LANGS.includes(x as Lang) ? (x as Lang) : fallback);

/**
 * Exotel Voicebot applet (AgentStream). Protocol: https://developer.exotel.com/docs/agentstream/stream-voicebot-applet
 * In: connected, start {stream_sid, call_sid, from, to, custom_parameters, media_format}, media {payload}, dtmf, mark, stop.
 * Out: media {payload} (16-bit PCM, chunks of n×320 bytes, at least 3.2 KB), clear.
 */
export function handleExotel(conn: WebSocketConnection, deps: VoiceDeps, defaultLang: Lang): { session: () => VoiceSession | undefined } {
  let session: VoiceSession | undefined;
  let streamSid = "";
  conn.on("text", (raw: string) => {
    let msg: any;
    try { msg = JSON.parse(raw); } catch { return; }
    const ev = msg.event;
    if (ev === "start" && !session) {
      const s = msg.start ?? {};
      streamSid = String(msg.stream_sid ?? s.stream_sid ?? "");
      const rate = Number(s.media_format?.sample_rate) || 8000;
      const from = typeof s.from === "string" ? s.from : "";
      session = new VoiceSession(deps, {
        rate,
        sendAudio: (samples) => { for (const c of phoneChunks(samples)) conn.sendText(JSON.stringify({ event: "media", stream_sid: streamSid, media: { payload: c.toString("base64") } })); },
        clear: () => conn.sendText(JSON.stringify({ event: "clear", stream_sid: streamSid })),
        hangup: () => conn.close(1000, "call finished"),
      }, { lang: pickLang(s.custom_parameters?.lang, defaultLang), channel: "phone", from });
      void session.start();
    } else if (ev === "media" && session && typeof msg.media?.payload === "string") {
      session.audio(fromBytes(Buffer.from(msg.media.payload, "base64")));
    } else if (ev === "stop") {
      void session?.finish();
      conn.close(1000);
    }
  });
  conn.on("close", () => void session?.finish());
  return { session: () => session };
}

/**
 * Browser calls from the public /call page. The page sends {"type":"start","lang":"hi"} and then 16 kHz 16-bit PCM
 * as binary messages; it gets the same back, plus JSON caption events.
 */
export function handleWebCall(conn: WebSocketConnection, deps: VoiceDeps, defaultLang: Lang): { session: () => VoiceSession | undefined } {
  let session: VoiceSession | undefined;
  conn.on("text", (raw: string) => {
    let msg: any;
    try { msg = JSON.parse(raw); } catch { return; }
    if (msg.type === "start" && !session) {
      session = new VoiceSession(deps, {
        rate: 16000,
        sendAudio: (samples) => { const b = toBytes(samples); for (let i = 0; i < b.length; i += 32000) conn.sendBinary(b.subarray(i, i + 32000)); },
        clear: () => conn.sendText(JSON.stringify({ type: "clear" })),
        hangup: () => setTimeout(() => conn.close(1000, "call finished"), 200),
        event: (e) => conn.sendText(JSON.stringify(e)),
      }, { lang: pickLang(msg.lang, defaultLang), channel: "web" });
      void session.start();
    } else if (msg.type === "hangup") {
      void session?.finish();
      conn.close(1000);
    }
  });
  conn.on("binary", (b: Buffer) => session?.audio(fromBytes(b)));
  conn.on("close", () => void session?.finish());
  return { session: () => session };
}
