import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyUndeliverable, buyerContactDedupeKey, renderComplaintDraft, renderBounceTaskBody } from "./buyerContact";

test("complaints and spam are complaints; hard bounces and anything unrecognised are hard bounces", () => {
  assert.equal(classifyUndeliverable("recipient marked as spam"), "complaint");
  assert.equal(classifyUndeliverable("complaint"), "complaint");
  assert.equal(classifyUndeliverable("unsubscribed"), "complaint");
  assert.equal(classifyUndeliverable("too many hard fails"), "hard_bounce");
  assert.equal(classifyUndeliverable("too many bounces"), "hard_bounce");
  assert.equal(classifyUndeliverable("something new"), "hard_bounce");
  assert.equal(classifyUndeliverable(null), "hard_bounce");
});

test("the dedupe key is stable per order and kind", () => {
  assert.equal(buyerContactDedupeKey("complaint", "ord1"), "buyer-undeliverable:complaint:ord1");
  assert.notEqual(buyerContactDedupeKey("complaint", "ord1"), buyerContactDedupeKey("hard_bounce", "ord1"));
});

test("the complaint draft is personal, carries the code and link, and escapes the buyer's name", () => {
  const d = renderComplaintDraft({ senderName: "Jess", brandName: "Acme", productName: "The Thing", firstName: "<b>Sam</b>", opensWhen: "Saturday 10 October at 6pm UK time", claimCode: "STILL-ABCD-EFGH", claimUrl: "https://x.test/redeem?code=STILL-ABCD-EFGH", orderRef: "AB12" });
  assert.match(d.text, /STILL-ABCD-EFGH/);
  assert.match(d.text, /Saturday 10 October/);
  assert.match(d.text, /\nJess$/);
  assert.match(d.html, /href="https:\/\/x\.test\/redeem\?code=STILL-ABCD-EFGH"/);
  assert.ok(!d.html.includes("<b>Sam"));
  assert.ok(!/—/.test(d.text), "no em dashes");
  assert.match(d.subject, /The Thing/);
});

test("without a code the draft points at the account sign-in instead", () => {
  const d = renderComplaintDraft({ senderName: "Jess", brandName: "Acme", productName: "The Thing", accessUrl: "https://x.test/account", orderRef: "AB12" });
  assert.match(d.text, /https:\/\/x\.test\/account/);
  assert.ok(!/ticket code is/.test(d.text));
});

test("the bounce task body lists the order and every other contact detail, and skips blanks", () => {
  const b = renderBounceTaskBody({ brandName: "Acme", productName: "The Thing", orderRef: "AB12", email: "x@dead.test", reason: "too many hard fails", otherContacts: [{ label: "Phone", value: "0123" }, { label: "Shipping address", value: "" }], whereToLook: "https://cc.test/orders/1" });
  assert.match(b, /^Why: /);
  assert.match(b, /Order ref: AB12/);
  assert.match(b, /Phone: 0123/);
  assert.ok(!/Shipping address/.test(b));
  assert.match(b, /cc\.test\/orders\/1/);
});
