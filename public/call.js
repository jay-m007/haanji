// Browser phone: microphone → 16 kHz PCM over a WebSocket → Haanji; Haanji's voice comes back the same way.
const $ = (id) => document.getElementById(id);
const RATE = 16000;
let ws = null, ctx = null, stream = null, node = null, playAt = 0, playing = [], pending = [], pendingLen = 0;

function state(t) { $("state").textContent = t; }
function caption(who, text, note) {
  const li = document.createElement("li");
  li.innerHTML = `<b></b><span></span>`;
  li.querySelector("b").textContent = who;
  li.querySelector("span").textContent = text + (note ? " " + note : "");
  $("captions").appendChild(li);
  li.scrollIntoView({ block: "nearest" });
}

function toPcm16(float32, fromRate) {
  const ratio = fromRate / RATE, n = Math.floor(float32.length / ratio), out = new Int16Array(n);
  for (let i = 0; i < n; i++) { const s = Math.max(-1, Math.min(1, float32[Math.floor(i * ratio)])); out[i] = s < 0 ? s * 0x8000 : s * 0x7fff; }
  return out;
}

function play(buf) {
  const pcm = new Int16Array(buf.slice(0, buf.byteLength - (buf.byteLength % 2)));
  const ab = ctx.createBuffer(1, pcm.length, RATE);
  const ch = ab.getChannelData(0);
  for (let i = 0; i < pcm.length; i++) ch[i] = pcm[i] / 0x8000;
  const src = ctx.createBufferSource();
  src.buffer = ab; src.connect(ctx.destination);
  playAt = Math.max(playAt, ctx.currentTime + 0.05);
  src.start(playAt); playAt += ab.duration;
  playing.push(src); src.onended = () => { playing = playing.filter((s) => s !== src); };
}
function stopPlayback() { for (const s of playing) { try { s.stop(); } catch {} } playing = []; playAt = 0; }

async function start() {
  const lang = document.querySelector("input[name=lang]:checked").value;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
  } catch { state("Microphone permission is needed to talk. Allow it in the browser and try again."); return; }
  ctx = new AudioContext();
  await ctx.audioWorklet.addModule("/call-worklet.js");
  const src = ctx.createMediaStreamSource(stream);
  node = new AudioWorkletNode(ctx, "capture");
  src.connect(node);
  ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/web/ws`);
  ws.binaryType = "arraybuffer";
  ws.onopen = () => { ws.send(JSON.stringify({ type: "start", lang })); state("Connected. Speak after the greeting."); };
  ws.onmessage = (ev) => {
    if (typeof ev.data !== "string") return play(ev.data);
    const m = JSON.parse(ev.data);
    if (m.type === "clear") stopPlayback();
    if (m.type === "caller") caption("You", m.text);
    if (m.type === "agent") caption("Assistant", m.text);
    if (m.type === "ended") state("Call ended. Thank you, the owner will call you back.");
  };
  ws.onclose = (ev) => { cleanup(); if (ev.code === 1006 && !$("captions").children.length) state("Could not connect. The line may be busy; please try again in a minute."); };
  node.port.onmessage = (e) => {
    if (!ws || ws.readyState !== 1) return;
    const pcm = toPcm16(e.data, ctx.sampleRate);
    pending.push(pcm); pendingLen += pcm.length;
    if (pendingLen >= RATE / 10) { // send every 100 ms
      const out = new Int16Array(pendingLen); let o = 0;
      for (const p of pending) { out.set(p, o); o += p.length; }
      ws.send(out.buffer); pending = []; pendingLen = 0;
    }
  };
  $("dial").textContent = "End call"; $("dial").classList.add("hang");
}

function cleanup() {
  stream?.getTracks().forEach((t) => t.stop());
  node?.disconnect(); ctx?.close().catch(() => {});
  stream = node = ctx = null; ws = null; playing = []; playAt = 0;
  $("dial").textContent = "Start call"; $("dial").classList.remove("hang");
}

$("dial").onclick = () => {
  if (ws) { try { ws.send(JSON.stringify({ type: "hangup" })); } catch {} ws.close(); cleanup(); state("Call ended."); }
  else { $("captions").innerHTML = ""; state("Connecting…"); start(); }
};
if (!window.AudioWorkletNode || !navigator.mediaDevices) state("This browser cannot make online calls. Please use a recent Chrome, Edge or Safari.");
