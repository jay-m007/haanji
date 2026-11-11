// Shared helpers for the call desk and the ledger.
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const inr = (n) => "₹" + Number(n).toLocaleString("en-IN");
const LANG_LABEL = { hi: "Hindi", mr: "Marathi", gu: "Gujarati", en: "English", mixed: "Mixed" };
const RULE_LABEL = {
  unlisted_price: "Blocked: the model said a price that is not on the list",
  price_agreement: "Blocked: the model tried to accept the caller's price",
  discount_promise: "Blocked: the model offered a discount",
};

async function api(path, opts = {}) {
  const res = await fetch(path, { headers: { "content-type": "application/json" }, ...opts, body: opts.body ? JSON.stringify(opts.body) : undefined });
  const data = res.headers.get("content-type")?.includes("json") ? await res.json() : await res.text();
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

function itemsTable(items) {
  if (!items.length) return `<p class="none">No product yet.</p>`;
  const rows = items.map((i) => `<tr>
    <td>${esc(i.name.replace(/ — SAMPLE$/, ""))}${(i.check || []).map((c) => `<span class="check">⚠ ${esc(c)}</span>`).join("")}</td>
    <td class="n">${i.quantity ? esc(i.quantity) + " " + esc(i.unit || "?") : "—"}</td>
    <td class="n">${i.pieces !== undefined && i.unit !== "piece" ? esc(i.pieces.toLocaleString("en-IN")) : ""}</td>
    <td class="n">${i.listValue !== undefined ? inr(i.listValue) + (i.listValueMax ? "–" + inr(i.listValueMax).slice(1) : "") : "ask owner"}</td></tr>`).join("");
  return `<table class="items"><thead><tr><th>Item</th><th class="n">Qty</th><th class="n">Pieces</th><th class="n">List value</th></tr></thead><tbody>${rows}</tbody></table>`;
}

function offersHtml(offers, isNew) {
  if (!offers.length) return "";
  const o = offers[offers.length - 1];
  const before = offers.length > 1 ? `<small>earlier: ${offers.slice(0, -1).map((x) => inr(x.price)).join(", ")}</small>` : "";
  return `<div class="stamp${isNew ? " new" : ""}">Owner to confirm<small>caller offered ${inr(o.price)}${o.per ? " per " + esc(o.per) : ""}</small>${before}</div>`;
}
