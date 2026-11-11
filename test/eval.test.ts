import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { loadCatalog, product } from "../src/catalog.ts";
import { findNumbers } from "../src/numbers.ts";
import { findUnits } from "../src/units.ts";
import { ROOT } from "./helpers.ts";

test("every eval case names a real product and says its quantity and unit in words the parser understands", () => {
  const cat = loadCatalog(join(ROOT, "catalog.json"));
  const cases = JSON.parse(readFileSync(join(ROOT, "eval/cases.json"), "utf8"));
  assert.ok(cases.length >= 12);
  for (const c of cases) {
    assert.ok(product(cat, c.product), `${c.product} is in the catalog`);
    assert.ok(findNumbers(c.text).includes(c.qty), `"${c.text}" contains ${c.qty}`);
    assert.ok(findUnits(c.text).includes(c.unit), `"${c.text}" contains unit ${c.unit}`);
    if (c.offer) assert.ok(findNumbers(c.text).includes(c.offer), `"${c.text}" contains offer ${c.offer}`);
  }
  for (const l of ["hi", "mr", "gu", "mixed", "en"]) assert.ok(cases.some((c: any) => c.lang === l), l);
});
