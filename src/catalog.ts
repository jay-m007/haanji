// The price list the receptionist is allowed to quote from. Nothing outside this file is a valid price.
import { readFileSync } from "node:fs";
import { isUnit, type Unit } from "./units.ts";

/** A price for one unit. `max` makes it a range ("₹20 to ₹75 per box, depending on size"). No price means "ask the owner". */
export interface UnitPrice { price?: number; max?: number; contains?: { qty: number; unit: Unit } }
export interface Product {
  id: string;
  name: string;
  /** What callers might call it, in any language or script. */
  aliases: string[];
  units: Partial<Record<Unit, UnitPrice>>;
  min_order?: { qty: number; unit: Unit };
  /** For the person editing the file, never shown to callers. */
  note?: string;
}
export interface Catalog {
  sample?: boolean;
  /** Shown as a banner until removed, e.g. "prices copied from IndiaMART, check them". */
  review_note?: string;
  business: { name: string; city: string; owner: string; hours: string; agent_name: string };
  policies: string[];
  products: Product[];
}

export function loadCatalog(path: string): Catalog {
  const c = JSON.parse(readFileSync(path, "utf8")) as Catalog;
  validateCatalog(c);
  return c;
}

export function validateCatalog(c: Catalog): void {
  if (!c?.business?.name) throw new Error("catalog: business.name is required");
  if (!Array.isArray(c.products) || !c.products.length) throw new Error("catalog: at least one product is required");
  const ids = new Set<string>();
  for (const p of c.products) {
    if (!p.id || ids.has(p.id)) throw new Error(`catalog: product ids must be unique and non-empty (${p.id})`);
    ids.add(p.id);
    const units = Object.entries(p.units ?? {});
    if (!units.length) throw new Error(`catalog: ${p.id} has no units`);
    for (const [u, up] of units) {
      if (!isUnit(u)) throw new Error(`catalog: ${p.id} uses unknown unit "${u}"`);
      if (up.price !== undefined && !(typeof up.price === "number" && up.price > 0)) throw new Error(`catalog: ${p.id}/${u} needs a positive price`);
      if (up.max !== undefined && !(up.price !== undefined && up.max > up.price)) throw new Error(`catalog: ${p.id}/${u} max must be above price`);
      if (up.contains && !isUnit(up.contains.unit)) throw new Error(`catalog: ${p.id}/${u} contains an unknown unit`);
    }
  }
}

export function product(c: Catalog, id: string): Product | undefined { return c.products.find((p) => p.id === id); }

/** Every price that appears in the list. The receptionist may say these and no others. */
export function allowedPrices(c: Catalog): Set<number> {
  const s = new Set<number>();
  for (const p of c.products) for (const up of Object.values(p.units)) {
    if (up?.price !== undefined) s.add(up.price);
    if (up?.max !== undefined) s.add(up.max);
  }
  return s;
}

/** How many of `to` are in one `from` (carton → box → piece), or undefined if the list does not say. */
export function convert(p: Product, from: Unit, to: Unit): number | undefined {
  let factor = 1, u: Unit = from;
  for (let hops = 0; hops < 6; hops++) {
    if (u === to) return factor;
    const c = p.units[u]?.contains;
    if (!c) return undefined;
    factor *= c.qty; u = c.unit;
  }
  return undefined;
}

/** Price list as plain text for the model's instructions. */
export function priceListText(c: Catalog): string {
  return c.products.map((p) => {
    const units = Object.entries(p.units).map(([u, up]) => {
      const price = up!.price === undefined ? `price for ${u} not listed, the owner will tell` : up!.max ? `₹${up!.price} to ₹${up!.max} per ${u} depending on size` : `₹${up!.price} per ${u}`;
      return price + (up!.contains ? ` (1 ${u} = ${up!.contains.qty} ${up!.contains.unit})` : "");
    }).join("; ");
    const min = p.min_order ? `; minimum order ${p.min_order.qty} ${p.min_order.unit}` : "";
    return `- id "${p.id}": ${p.name} [also called: ${p.aliases.join(", ")}] — ${units}${min}`;
  }).join("\n");
}
