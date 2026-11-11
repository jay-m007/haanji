import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { convert, loadCatalog, validateCatalog, product, allowedPrices, type Catalog } from "../src/catalog.ts";
import { emptyLead, itemMaths, mergeLead, summary, verifyAgainstCaller } from "../src/lead.ts";
import { ROOT } from "./helpers.ts";

const cat = loadCatalog(join(ROOT, "test/fixtures/catalog.json"));

test("sample catalog loads; conversions and price list", () => {
  assert.equal(convert(product(cat, "box-small")!, "carton", "piece"), 100);
  assert.equal(convert(product(cat, "box-small")!, "box", "piece"), undefined);
  assert.ok(allowedPrices(cat).has(1100));
});

test("catalog validation rejects bad entries", () => {
  const bad = (c: unknown, re: RegExp) => assert.throws(() => validateCatalog(c as Catalog), re);
  bad({ business: { name: "x" }, products: [] }, /at least one product/);
  bad({ business: { name: "x" }, products: [{ id: "a", units: { crate: { price: 1 } } }] }, /unknown unit/);
  bad({ business: { name: "x" }, products: [{ id: "a", units: { piece: { price: 0 } } }] }, /positive price/);
  bad({ business: { name: "x" }, products: [{ id: "a", units: { piece: { price: 1 } } }, { id: "a", units: { piece: { price: 1 } } }] }, /unique/);
});

test("merge keeps earlier details and ignores invented products", () => {
  let l = mergeLead(emptyLead(), { name: "Ramesh", items: [{ product_id: "box-small", product_words: "chhota box", quantity: 50, unit: "carton" }] }, cat, 1);
  l = mergeLead(l, { name: "", city: "Surat", items: [{ product_id: "box-small", product_words: "", quantity: 0, unit: "" }, { product_id: "bubble-wrap", product_words: "bubble wrap", quantity: 10, unit: "piece" }] }, cat, 2);
  assert.equal(l.name, "Ramesh");
  assert.equal(l.city, "Surat");
  assert.deepEqual(l.items.map((i) => [i.product_id, i.quantity, i.unit]), [["box-small", 50, "carton"]]);
  assert.deepEqual(l.unknown_products, ["bubble wrap"]);
});

test("unknown units are dropped, not guessed", () => {
  const l = mergeLead(emptyLead(), { items: [{ product_id: "tape", product_words: "tape", quantity: 3, unit: "crate" }] }, cat, 1);
  assert.equal(l.items[0].unit, "");
});

test("offers are recorded in order, repeated offers once", () => {
  let l = mergeLead(emptyLead(), { items: [{ product_id: "box-small", product_words: "", quantity: 50, unit: "carton" }], offer_price: 1000, offer_per: "carton" }, cat, 1);
  l = mergeLead(l, { offer_price: 1000, offer_per: "carton" }, cat, 2);
  l = mergeLead(l, { offer_price: 1050, offer_per: "carton" }, cat, 3);
  assert.deepEqual(l.offers.map((o) => [o.product_id, o.price, o.per, o.turn]), [["box-small", 1000, "carton", 1], ["box-small", 1050, "carton", 3]]);
});

test("verification flags quantities and units the caller never said", () => {
  const l = mergeLead(emptyLead(), { items: [{ product_id: "box-small", product_words: "", quantity: 15, unit: "carton" }] }, cat, 1);
  const v = verifyAgainstCaller(l, "pachaas peti chahiye");
  assert.deepEqual(v.items[0].check, ["caller never said 15"]);
  const good = verifyAgainstCaller(mergeLead(emptyLead(), { items: [{ product_id: "box-small", product_words: "", quantity: 50, unit: "carton" }] }, cat, 1), "pachaas peti chahiye");
  assert.equal(good.items[0].check, undefined);
  const unit = verifyAgainstCaller(mergeLead(emptyLead(), { items: [{ product_id: "box-small", product_words: "", quantity: 50, unit: "box" }] }, cat, 1), "50 peti");
  assert.deepEqual(unit.items[0].check, ['caller never said "box"']);
});

test("maths and summary come from the price list", () => {
  const l = mergeLead(emptyLead(), { name: "Ramesh", company: "Patel Traders", city: "Surat", items: [{ product_id: "box-small", product_words: "", quantity: 50, unit: "carton" }], offer_price: 1000, offer_per: "carton", delivery_by: "Friday" }, cat, 1);
  assert.deepEqual(itemMaths(cat, l.items[0]), { pieces: 5000, listValue: 55000, listValueMax: undefined });
  const s = summary(cat, l);
  assert.match(s, /Ramesh \(Patel Traders, Surat\) asked for 50 carton of Corrugated box, small/);
  assert.match(s, /5,000 pieces, ₹55,000 at list price/);
  assert.match(s, /offered ₹1,000 per carton\. Owner to confirm/);
  assert.match(s, /Friday/);
});

test("the shipped S S Industries catalog is valid; ranges and unpriced items behave", () => {
  const real = loadCatalog(join(ROOT, "catalog.json"));
  assert.match(real.business.name, /S S Industries/);
  const prices = allowedPrices(real);
  assert.ok(prices.has(20) && prices.has(75), "range ends are both sayable");
  assert.ok(!prices.has(23), "conflicting IndiaMART prices are not in the list");
  const pin = mergeLead(emptyLead(), { items: [{ product_id: "paper-pin", product_words: "", quantity: 1000, unit: "box" }] }, real, 1).items[0];
  assert.deepEqual(itemMaths(real, pin), { pieces: undefined, listValue: 20000, listValueMax: 75000 });
  const carton = mergeLead(emptyLead(), { items: [{ product_id: "paper-pin-16mm", product_words: "", quantity: 5, unit: "carton" }] }, real, 1).items[0];
  assert.equal(itemMaths(real, carton).listValue, 5 * 100 * 75, "a carton is priced through the boxes it holds");
  const bell = mergeLead(emptyLead(), { items: [{ product_id: "paper-bell-pin", product_words: "", quantity: 100, unit: "box" }] }, real, 1).items[0];
  assert.deepEqual(itemMaths(real, bell), { pieces: undefined, listValue: undefined, listValueMax: undefined });
});
