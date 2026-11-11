// What a call is about, built up turn by turn, and checked against what the caller actually said.
import { convert, product, type Catalog } from "./catalog.ts";
import { findNumbers } from "./numbers.ts";
import { findUnits, isUnit, type Unit } from "./units.ts";

export interface Item {
  product_id: string;
  quantity: number;
  unit: Unit | "";
  /** Set when the caller's own words do not contain this quantity or unit. */
  check?: string[];
}
export interface Offer { product_id: string; price: number; per: Unit | ""; turn: number }
export interface Lead {
  name: string; company: string; city: string; phone: string;
  items: Item[];
  offers: Offer[];
  delivery_by: string;
  notes: string[];
  unknown_products: string[];
}

export function emptyLead(): Lead {
  return { name: "", company: "", city: "", phone: "", items: [], offers: [], delivery_by: "", notes: [], unknown_products: [] };
}

/** The model's view of the lead after one turn (shape fixed by the JSON schema in agent.ts). */
export interface LeadUpdate {
  name?: string; company?: string; city?: string; phone?: string; delivery_by?: string; note?: string;
  items?: { product_id: string; product_words: string; quantity: number; unit: string }[];
  offer_price?: number; offer_per?: string; offer_product_id?: string;
}

const clean = (s: unknown) => (typeof s === "string" ? s.trim().slice(0, 120) : "");

/** Folds one turn's update into the lead. Never trusts product ids, units or quantities blindly. */
export function mergeLead(lead: Lead, u: LeadUpdate, catalog: Catalog, turn: number): Lead {
  const next: Lead = structuredClone(lead);
  for (const k of ["name", "company", "city", "phone", "delivery_by"] as const) { const v = clean(u[k]); if (v) next[k] = v; }
  const note = clean(u.note); if (note && !next.notes.includes(note)) next.notes.push(note);
  for (const it of u.items ?? []) {
    const id = clean(it.product_id);
    if (!product(catalog, id)) {
      const words = clean(it.product_words) || id;
      if (words && !next.unknown_products.includes(words)) next.unknown_products.push(words);
      continue;
    }
    const qty = typeof it.quantity === "number" && it.quantity > 0 && Number.isFinite(it.quantity) ? it.quantity : 0;
    const unit = isUnit(it.unit) ? it.unit : "";
    if (!qty && !unit && next.items.some((x) => x.product_id === id)) continue; // a mention without details does not wipe what we know
    const existing = next.items.find((x) => x.product_id === id);
    if (existing) { if (qty) existing.quantity = qty; if (unit) existing.unit = unit; }
    else next.items.push({ product_id: id, quantity: qty, unit });
  }
  if (typeof u.offer_price === "number" && u.offer_price > 0) {
    const pid = product(catalog, clean(u.offer_product_id)) ? clean(u.offer_product_id) : (next.items[0]?.product_id ?? "");
    const last = next.offers[next.offers.length - 1];
    if (!last || last.price !== u.offer_price || last.product_id !== pid) {
      next.offers.push({ product_id: pid, price: u.offer_price, per: isUnit(u.offer_per) ? u.offer_per : "", turn });
    }
  }
  return next;
}

/** Marks quantities and units the caller never said. Models mishear "pachaas" as 15 more often than you would like. */
export function verifyAgainstCaller(lead: Lead, callerText: string): Lead {
  const said = new Set(findNumbers(callerText));
  const units = new Set(findUnits(callerText));
  const next = structuredClone(lead);
  for (const it of next.items) {
    const check: string[] = [];
    if (it.quantity && !said.has(it.quantity)) check.push(`caller never said ${it.quantity}`);
    if (!it.quantity) check.push("quantity not given");
    if (it.unit && !units.has(it.unit)) check.push(`caller never said "${it.unit}"`);
    if (!it.unit) check.push("unit not given");
    it.check = check.length ? check : undefined;
  }
  for (const o of next.offers) if (!said.has(o.price)) next.notes.includes(`offer ₹${o.price} not heard in caller's words`) || next.notes.push(`offer ₹${o.price} not heard in caller's words`);
  return next;
}

/** List-price value and piece count for an item, when the price list allows working it out. */
export function itemMaths(catalog: Catalog, it: Item): { pieces?: number; listValue?: number; listValueMax?: number } {
  const p = product(catalog, it.product_id);
  if (!p || !it.quantity || !it.unit) return {};
  const per = convert(p, it.unit, "piece");
  // price the item in its own unit, or in a smaller priced unit it is made of (1 carton = 100 box × ₹75)
  let listValue: number | undefined, listValueMax: number | undefined;
  const units = Object.entries(p.units).sort(([a], [b]) => Number(b === it.unit) - Number(a === it.unit)); // own unit's price first
  for (const [u, up] of units) {
    if (up?.price === undefined) continue;
    const n = convert(p, it.unit, u as Unit);
    if (n === undefined) continue;
    listValue = it.quantity * n * up.price;
    if (up.max) listValueMax = it.quantity * n * up.max;
    break;
  }
  return { pieces: per !== undefined ? it.quantity * per : undefined, listValue, listValueMax };
}

const inr = (n: number) => "₹" + n.toLocaleString("en-IN");

/** A short summary the owner can read in five seconds. Built from fields, not by the model, so it cannot invent anything. */
export function summary(catalog: Catalog, lead: Lead): string {
  const who = [lead.name || "Unknown caller", lead.company && `(${lead.company}${lead.city ? ", " + lead.city : ""})`, !lead.company && lead.city && `from ${lead.city}`].filter(Boolean).join(" ");
  const parts: string[] = [];
  for (const it of lead.items) {
    const p = product(catalog, it.product_id)!;
    const m = itemMaths(catalog, it);
    const qty = it.quantity ? `${it.quantity} ${it.unit || "(unit?)"}` : "quantity not given";
    const extra = [m.pieces !== undefined && it.unit !== "piece" ? `${m.pieces.toLocaleString("en-IN")} pieces` : "", m.listValue !== undefined ? `${inr(m.listValue)}${m.listValueMax ? " to " + inr(m.listValueMax) : ""} at list price` : ""].filter(Boolean).join(", ");
    parts.push(`${qty} of ${p.name.replace(/ — SAMPLE$/, "")}${extra ? ` (${extra})` : ""}${it.check ? " [check: " + it.check.join("; ") + "]" : ""}`);
  }
  let s = `${who} ${parts.length ? "asked for " + parts.join(" and ") : "did not name a product"}.`;
  if (lead.unknown_products.length) s += ` Also asked about items not on the list: ${lead.unknown_products.join(", ")}.`;
  const lastOffer = lead.offers[lead.offers.length - 1];
  if (lastOffer) s += ` Bargained: offered ${inr(lastOffer.price)}${lastOffer.per ? " per " + lastOffer.per : ""}. Owner to confirm.`;
  if (lead.delivery_by) s += ` Wants delivery: ${lead.delivery_by}.`;
  if (lead.phone) s += ` Phone: ${lead.phone}.`;
  return s;
}
