// Call simulator: you play the caller, the receptionist answers through the local model.
const $ = (id) => document.getElementById(id);
const SPEECH_LANG = { hi: "hi-IN", mr: "mr-IN", gu: "gu-IN", en: "en-IN", mixed: "hi-IN" };
let call = null, busy = false, offerCount = 0;

async function health() {
  try {
    const h = await api("/api/health");
    $("biz").textContent = h.business.name + " · " + h.business.city;
    $("sample").hidden = !(h.sampleCatalog || h.reviewNote);
    if (h.reviewNote) $("sample").textContent = h.reviewNote + " (edit catalog.json)";
    const pill = $("health");
    if (!h.ollama.reachable) { pill.textContent = "Ollama not running"; pill.classList.add("bad"); pill.title = h.ollama.error; }
    else if (!h.modelInstalled) { pill.textContent = `Run: ollama pull ${h.model}`; pill.classList.add("bad"); }
    else { pill.textContent = `Model: ${h.model}`; pill.classList.remove("bad"); }
  } catch (e) { $("health").textContent = "Server not reachable"; $("health").classList.add("bad"); }
}

function showError(msg) { $("error").hidden = !msg; $("error").textContent = msg || ""; }

function render(thinkingText) {
  const lines = call.turns.map((t) => {
    const who = t.role === "caller" ? "Caller" : "Haanji";
    const blocked = t.guard ? `<span class="why">${esc(RULE_LABEL[t.guard.rule] || t.guard.rule)}. It wanted to say: <span class="blocked">${esc(t.guard.blockedReply)}</span></span>` : "";
    return `<li class="${t.role}"><span class="who">${who}</span><span class="text" lang="${call.language === "gu" ? "gu" : "hi"}">${esc(t.text)}</span>${blocked}</li>`;
  });
  if (thinkingText) lines.push(`<li class="caller"><span class="who">Caller</span><span class="text">${esc(thinkingText)}</span></li><li class="agent thinking"><span class="who">Haanji</span><span class="text"></span></li>`);
  $("lines").innerHTML = lines.join("");
  $("lines").scrollTop = $("lines").scrollHeight;

  const L = call.lead;
  const row = (k, v) => `<dt>${k}</dt><dd>${esc(v)}</dd>`;
  $("who").innerHTML = row("Name", L.name) + row("Company", L.company) + row("City", L.city) + row("Phone", L.phone) + row("Delivery", L.delivery_by);
  $("items").innerHTML = itemsTable(L.items);
  $("offers").innerHTML = offersHtml(L.offers, L.offers.length > offerCount);
  offerCount = L.offers.length;
  const extra = [];
  if (L.unknown_products.length) extra.push(`<p><b>Not on the list:</b> ${esc(L.unknown_products.join(", "))}</p>`);
  if (L.notes.length) extra.push(`<p><b>Notes:</b> ${esc(L.notes.join("; "))}</p>`);
  $("extra").innerHTML = extra.join("");
  $("summary").innerHTML = call.summary ? `<div class="summary"><b>Summary for the owner</b><br>${esc(call.summary)}</div>` : "";

  const live = call.status === "live";
  for (const id of ["text", "send", "end"]) $(id).disabled = !live || busy;
  $("mic").disabled = !live || busy || !Recognition;
  $("start").textContent = live ? "New call" : "Start call";
}

function speak(text) {
  if (!$("speak").checked || !("speechSynthesis" in window)) return;
  const want = SPEECH_LANG[call.language];
  const voices = speechSynthesis.getVoices();
  const voice = voices.find((v) => v.lang === want) || voices.find((v) => v.lang.startsWith(want.slice(0, 2))) || voices.find((v) => v.lang === "hi-IN");
  if (!voice && voices.length) $("hint").textContent = `This device has no ${LANG_LABEL[call.language]} voice, so replies may be read in another accent.`;
  const u = new SpeechSynthesisUtterance(text);
  u.lang = voice?.lang || want; if (voice) u.voice = voice;
  speechSynthesis.cancel(); speechSynthesis.speak(u);
}

async function start() {
  showError("");
  call = await api("/api/calls", { method: "POST", body: { language: $("lang").value } });
  offerCount = 0;
  render();
  speak(call.turns[0].text);
  $("text").focus();
}

async function say(text) {
  if (!text.trim() || busy || !call) return;
  busy = true; showError(""); render(text);
  try {
    const r = await api(`/api/calls/${call.id}/turn`, { method: "POST", body: { text } });
    call = r.call;
    speak(r.reply);
  } catch (e) { showError(e.message); }
  busy = false; render();
  $("text").value = ""; $("text").focus();
}

async function end() {
  try { call = await api(`/api/calls/${call.id}/end`, { method: "POST" }); render(); } catch (e) { showError(e.message); }
}

// Speech input (Chrome and Edge; uses the browser's own speech service)
const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
let rec = null;
function listen() {
  if (rec) { rec.stop(); return; }
  rec = new Recognition();
  rec.lang = SPEECH_LANG[call.language]; rec.interimResults = true; rec.maxAlternatives = 1;
  $("mic").classList.add("on");
  speechSynthesis?.cancel();
  rec.onresult = (ev) => {
    const r = ev.results[ev.results.length - 1];
    $("text").value = r[0].transcript;
    if (r.isFinal) say(r[0].transcript);
  };
  rec.onerror = (ev) => showError(ev.error === "not-allowed" ? "Microphone permission was refused." : `Speech input stopped (${ev.error}). You can type instead.`);
  rec.onend = () => { rec = null; $("mic").classList.remove("on"); };
  rec.start();
}

$("start").onclick = start;
$("end").onclick = end;
$("mic").onclick = listen;
$("say").onsubmit = (e) => { e.preventDefault(); say($("text").value); };
$("lang").onchange = () => { if (call && call.status === "live") $("hint").textContent = "Language changes apply to the next call."; };
if (!Recognition) $("hint").textContent = "Voice input needs Chrome or Edge. You can still type as the caller.";
if ("speechSynthesis" in window) speechSynthesis.onvoiceschanged = () => {};
health();
setInterval(health, 15000);
