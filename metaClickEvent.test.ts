import { test } from "node:test";
import assert from "node:assert/strict";
import { CLICK_EVENTS, fbclidFromUrl, isFromAllowedHost, parseClickEventBody } from "./metaClickEvent";

const good = { event: "AddToCart", eventId: "0c3f8d52-1111-4a4a-9999-aaaaaaaaaaaa", sourceUrl: "https://playthestillroom.com/", currency: "GBP", value: 19.99 };
const hdrs = (o: Record<string, string>) => ({ get: (n: string) => o[n.toLowerCase()] ?? null });

test("the allowlist holds click events only: never ViewContent or PageView (a crawler can emit those)", () => {
  assert.ok(!(CLICK_EVENTS as readonly string[]).includes("ViewContent"));
  assert.ok(!(CLICK_EVENTS as readonly string[]).includes("PageView"));
  assert.ok(!(CLICK_EVENTS as readonly string[]).includes("Purchase"), "Purchase is sent by the checkout from the payment webhook, never from a browser beacon");
});

test("a valid click event parses", () => {
  const r = parseClickEventBody(good);
  assert.ok(r.ok && r.body.event === "AddToCart" && r.body.value === 19.99);
});

test("ViewContent, PageView and Purchase are refused at the door", () => {
  for (const event of ["ViewContent", "PageView", "Purchase"]) assert.equal(parseClickEventBody({ ...good, event }).ok, false);
});

test("the shared event id is mandatory and must be well formed", () => {
  assert.equal(parseClickEventBody({ ...good, eventId: undefined }).ok, false);
  assert.equal(parseClickEventBody({ ...good, eventId: "short" }).ok, false);
  assert.equal(parseClickEventBody({ ...good, eventId: "has spaces and ! chars padding1234" }).ok, false);
});

test("bad value, currency and url are refused", () => {
  assert.equal(parseClickEventBody({ ...good, value: -1 }).ok, false);
  assert.equal(parseClickEventBody({ ...good, value: 99999 }).ok, false);
  assert.equal(parseClickEventBody({ ...good, currency: "gbp" }).ok, false);
  assert.equal(parseClickEventBody({ ...good, sourceUrl: "javascript:alert(1)" }).ok, false);
  assert.equal(parseClickEventBody(null).ok, false);
});

test("origin check fails CLOSED: no header, or another host, is refused; the site and www are accepted", () => {
  const allowed = ["playthestillroom.com"];
  assert.equal(isFromAllowedHost(hdrs({}), allowed), false);
  assert.equal(isFromAllowedHost(hdrs({ origin: "https://evil.example" }), allowed), false);
  assert.equal(isFromAllowedHost(hdrs({ origin: "https://playthestillroom.com.evil.example" }), allowed), false);
  assert.equal(isFromAllowedHost(hdrs({ origin: "https://playthestillroom.com" }), allowed), true);
  assert.equal(isFromAllowedHost(hdrs({ referer: "https://www.playthestillroom.com/x" }), allowed), true);
});

test("fbclid is read from the page url so a decliner's click is still attributable", () => {
  assert.equal(fbclidFromUrl("https://x.test/?fbclid=AbC123&utm_source=facebook"), "AbC123");
  assert.equal(fbclidFromUrl("https://x.test/"), undefined);
  assert.equal(fbclidFromUrl("not a url"), undefined);
});
