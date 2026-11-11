// Trade units as callers say them. "peti" and "carton" are the same thing on a factory phone line.
import { tokens } from "./numbers.ts";

export const UNITS = ["piece", "box", "carton", "packet", "dozen", "kg"] as const;
export type Unit = (typeof UNITS)[number];

const SYNONYMS: Record<Unit, string[]> = {
  piece: ["piece", "pieces", "pcs", "pc", "nag", "nug", "pis", "peace", "नग", "पीस", "पिस", "નંગ", "પીસ"],
  box: ["box", "boxes", "dabba", "dabbe", "dabbo", "khoka", "khoke", "डिब्बा", "डिब्बे", "बॉक्स", "बोक्स", "खोका", "खोके", "બોક્સ", "ડબ્બો", "ડબ્બા", "ખોખું", "ખોખા"],
  carton: ["carton", "cartons", "karton", "peti", "petiyan", "petya", "कार्टन", "कार्टून", "पेटी", "पेटियां", "पेटियाँ", "पेट्या", "કાર્ટન", "પેટી", "પેટીઓ"],
  packet: ["packet", "packets", "pack", "packs", "paket", "pakit", "पैकेट", "पॅकेट", "पाकीट", "પેકેટ"],
  dozen: ["dozen", "darjan", "dazan", "दर्जन", "डझन", "ડઝન"],
  kg: ["kg", "kgs", "kilo", "kilos", "kilogram", "किलो", "कि.ग्रा", "કિલો"],
};

const LOOKUP = new Map<string, Unit>();
for (const u of UNITS) for (const w of SYNONYMS[u]) LOOKUP.set(w, u);

export function unitOf(word: string): Unit | undefined { return LOOKUP.get(word.toLowerCase()); }

/** Every unit word the caller used, in order. */
export function findUnits(text: string): Unit[] {
  const out: Unit[] = [];
  for (const t of tokens(text)) { const u = LOOKUP.get(t); if (u) out.push(u); }
  return out;
}

export function isUnit(x: unknown): x is Unit { return typeof x === "string" && (UNITS as readonly string[]).includes(x); }
