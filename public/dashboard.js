// The owner's view: every call, newest first, with what needs his attention.
const STATUS = { live: "On call", new: "New", called_back: "Called back", won: "Won", lost: "Lost" };
let calls = [], open = new Set();

function when(iso) { return new Date(iso).toLocaleString("en-IN", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" }); }

function rowHtml(c) {
  const L = c.lead;
  const who = [L.name || "Unknown", L.company, L.city].filter(Boolean).map(esc).join("<br>") + (L.phone ? `<br>${esc(L.phone)}` : "");
  const wants = L.items.length ? L.items.map((i) => `${i.quantity ? esc(i.quantity) + " " + esc(i.unit) : "?"} ${esc(i.name.replace(/ — SAMPLE$/, ""))}${i.check ? ` <span class="flag">⚠ check</span>` : ""}`).join("<br>") : `<span class="none">no product</span>`;
  const o = L.offers[L.offers.length - 1];
  const guards = c.turns.filter((t) => t.guard).length;
  const offer = (o ? `${inr(o.price)}${o.per ? "/" + esc(o.per) : ""}<br><span class="flag">owner to confirm</span>` : "") + (guards ? `<br><span class="flag">${guards} reply blocked</span>` : "");
  const status = c.status === "live" ? STATUS.live : `<select data-id="${esc(c.id)}" aria-label="Status">${["new", "called_back", "won", "lost"].map((s) => `<option value="${s}"${s === c.status ? " selected" : ""}>${STATUS[s]}</option>`).join("")}</select>`;
  const detail = open.has(c.id) ? `<tr class="open"><td></td><td colspan="4">${c.summary ? `<p><b>Summary:</b> ${esc(c.summary)}</p>` : ""}<ol class="transcript">${c.turns.map((t) => `<li><b>${t.role === "caller" ? "Caller" : "Haanji"}:</b> ${esc(t.text)}${t.guard ? ` <span class="flag">(${esc(RULE_LABEL[t.guard.rule])}: “${esc(t.guard.blockedReply)}”)</span>` : ""}</li>`).join("")}</ol><p class="none">${esc(LANG_LABEL[c.language])} · model ${esc(c.model)}</p></td></tr>` : "";
  return `<tr data-row="${esc(c.id)}" class="${open.has(c.id) ? "open" : ""}" style="cursor:pointer"><td class="when">${when(c.started_at)}</td><td>${who}</td><td>${wants}</td><td>${offer}</td><td>${status}</td></tr>${detail}`;
}

function render() {
  const f = document.getElementById("filter").value;
  const shown = calls.filter((c) => !f || (f === "offer" ? c.lead.offers.length : f === "check" ? c.lead.items.some((i) => i.check) || c.lead.unknown_products.length : c.status === f));
  document.getElementById("count").textContent = `${shown.length} of ${calls.length} calls`;
  document.getElementById("rows").innerHTML = shown.length ? shown.map(rowHtml).join("") : `<tr><td colspan="5" class="none">No calls here yet. Take one on the call desk.</td></tr>`;
}

async function load() { calls = await api("/api/calls"); render(); }

document.getElementById("rows").addEventListener("click", (e) => {
  if (e.target.closest("select")) return;
  const tr = e.target.closest("tr[data-row]"); if (!tr) return;
  const id = tr.dataset.row; open.has(id) ? open.delete(id) : open.add(id); render();
});
document.getElementById("rows").addEventListener("change", async (e) => {
  const sel = e.target.closest("select[data-id]"); if (!sel) return;
  const updated = await api(`/api/calls/${sel.dataset.id}`, { method: "PATCH", body: { status: sel.value } });
  calls = calls.map((c) => (c.id === updated.id ? updated : c)); render();
});
document.getElementById("filter").onchange = render;
load();
setInterval(load, 10000);
