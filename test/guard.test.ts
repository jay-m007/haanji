import { test } from "node:test";
import assert from "node:assert/strict";
import { checkReply, moneyAmounts, safeReply } from "../src/guard.ts";

const allowed = new Set([12, 28, 1100, 1300, 55000]);
const ok = (reply: string, bargaining = false) => assert.equal(checkReply(reply, { allowed, callerBargaining: bargaining }), undefined, reply);
const blocked = (reply: string, rule: string, bargaining = true) => assert.equal(checkReply(reply, { allowed, callerBargaining: bargaining })?.rule, rule, reply);

test("money amounts: digits, ₹, rupee words in four languages, number before or after", () => {
  assert.deepEqual(moneyAmounts("₹1100 per carton"), [1100]);
  assert.deepEqual(moneyAmounts("1100 rupaye carton"), [1100]);
  assert.deepEqual(moneyAmounts("बारह रुपये पीस"), [12]);
  assert.deepEqual(moneyAmounts("एक पेटी अकराशे म्हणजे 1100 रुपये"), [1100]);
  assert.deepEqual(moneyAmounts("એક પીસ ના 12 રૂપિયા"), [12]);
  assert.deepEqual(moneyAmounts("Rs. 28 per piece"), [28]);
  assert.deepEqual(moneyAmounts("50 carton ka ₹55000 hoga"), [55000], "the quantity before is not a price");
  assert.deepEqual(moneyAmounts("50 carton chahiye"), []);
});

test("list prices and list-price totals pass", () => {
  ok("छोटा बॉक्स ₹12 प्रति पीस है, और कार्टन ₹1100 का।");
  ok("50 कार्टन का ₹55000 होगा, लिस्ट रेट पर।");
  ok("Small box is Rs 12 per piece.");
});

test("an invented price is blocked", () => {
  blocked("हम आपको ₹1000 में कार्टन दे सकते हैं।", "unlisted_price", false);
  blocked("ઠીક છે, 1050 રૂપિયા માં આપીશું", "unlisted_price");
});

test("agreeing to the caller's price is blocked when they bargain", () => {
  blocked("ठीक है, चलेगा, मैं नोट कर लेती हूँ।", "price_agreement");
  blocked("Okay, deal.", "price_agreement");
  blocked("चालेल, आम्ही देऊ.", "price_agreement");
  blocked("સારું, ચાલશે.", "price_agreement");
});

test("deferring to the owner is not an agreement", () => {
  ok("रेट मालिक ही कन्फर्म करेंगे, मैंने आपका ऑफ़र नोट कर लिया है।", true);
  ok("Only the owner can confirm that rate, I have noted it.", true);
  ok("ભાવ શેઠ કન્ફર્મ કરશે.", true);
});

test("discount promises are blocked even without bargaining", () => {
  blocked("हम आपको थोड़ा डिस्काउंट दे देंगे।", "discount_promise", false);
  blocked("We can give a special rate for you.", "discount_promise", false);
  ok("डिस्काउंट मालिक ही दे सकते हैं।");
});

test("safe replies exist for every language and name the owner", () => {
  for (const l of ["hi", "mr", "gu", "en", "mixed"] as const) assert.match(safeReply(l, "Maurya ji"), /Maurya ji/);
  assert.match(safeReply("gu", "X"), /ભાવ/);
  assert.match(safeReply("mr", "X"), /दराबद्दल/);
});
