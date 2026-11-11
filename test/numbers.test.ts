import { test } from "node:test";
import assert from "node:assert/strict";
import { findNumbers, normaliseDigits } from "../src/numbers.ts";
import { findUnits } from "../src/units.ts";

const cases: [string, number[]][] = [
  ["50 carton chahiye", [50]],
  ["pachaas peti chhota box", [50]],
  ["do sau box", [200]],
  ["दो सौ पेटी चाहिए", [200]],
  ["पन्नास पेटी पाहिजे", [50]],
  ["મને પચાસ પેટી જોઈએ", [50]],
  ["50 carton aur 20 box", [50, 20]],
  ["das hazaar paanch sau", [10500]],
  ["dedh sau", [150]],
  ["ढाई हजार", [2500]],
  ["₹1,100 per carton", [1100]],
  ["१२ रुपये", [12]],
  ["૧૨૦૦ રૂપિયા", [1200]],
  ["2.5 lakh", [250000]],
  ["I want to do business", []],
  ["teen sau pachees", [325]],
  ["शंभर खोके", [100]],
  ["ek hazaar", [1000]],
];
for (const [text, want] of cases) test(`numbers: ${text}`, () => assert.deepEqual(findNumbers(text), want));

test("digits from Devanagari and Gujarati scripts become ASCII", () => {
  assert.equal(normaliseDigits("१२३ ૪૫૬"), "123 456");
});

test("unit words across languages map to one unit", () => {
  assert.deepEqual(findUnits("50 peti, 20 डिब्बे, 10 નંગ, 2 दर्जन, 5 पॅकेट, 3 किलो, 4 ખોખા"), ["carton", "box", "piece", "dozen", "packet", "kg", "box"]);
  assert.deepEqual(findUnits("कार्टून मध्ये"), ["carton"]);
});
