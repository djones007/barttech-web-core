import { test } from "node:test";
import assert from "node:assert/strict";
import { CLICK_EVENTS, clickEventGate, fbclidFromUrl, isFromAllowedHost, parseClickEventBody } from "./metaClickEvent";
import { isAutomatedRequest } from "./requestSignals";

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

// ── The whole pre-network gate, against the headers real browsers send ─────
// 2026-10-13: the server twin sent ZERO AddToCart while the browser pixel counted ~45 a week.
// The beacon carries sec-fetch-mode no-cors/cors + sec-fetch-dest empty on every modern browser,
// and the page-visit rule refused exactly that. These pin the fix in both directions.

const SITE = "https://shop.example.com";
const allowedHosts = ["shop.example.com"];
const body = { ...good, sourceUrl: `${SITE}/?fbclid=abc` };
const CHROME_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36";
const SAFARI_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";
const FIREFOX_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:140.0) Gecko/20100101 Firefox/140.0";

/** Chrome navigator.sendBeacon with an application/json Blob (what trackMetaTwin sends). */
const chromeBeacon = {
  "user-agent": CHROME_UA,
  "content-type": "application/json",
  origin: SITE,
  referer: `${SITE}/`,
  "sec-fetch-site": "same-origin",
  "sec-fetch-mode": "cors",
  "sec-fetch-dest": "empty",
  "sec-ch-ua": '"Chromium";v="143", "Not A(Brand";v="24", "Google Chrome";v="143"',
  "sec-ch-ua-mobile": "?0",
};
/** A beacon with a CORS-safelisted type goes out as no-cors. */
const chromeBeaconNoCors = { ...chromeBeacon, "content-type": "text/plain;charset=UTF-8", "sec-fetch-mode": "no-cors" };
/** Safari 16.4+ / iOS: keepalive fetch fallback. */
const safariFetch = {
  "user-agent": SAFARI_UA,
  "content-type": "application/json",
  origin: SITE,
  referer: `${SITE}/`,
  "sec-fetch-site": "same-origin",
  "sec-fetch-mode": "cors",
  "sec-fetch-dest": "empty",
};
const firefoxBeacon = { ...chromeBeaconNoCors, "user-agent": FIREFOX_UA };
delete (firefoxBeacon as Record<string, string>)["sec-ch-ua"];
/** The refusal reason, or "" when accepted (the test build is not strict, so no union narrowing). */
const reasonOf = (r: ReturnType<typeof clickEventGate>): string => ("reason" in r ? r.reason : "");
delete (firefoxBeacon as Record<string, string>)["sec-ch-ua-mobile"];

test("regression: the page-visit rule alone refuses every real beacon (why the gate passes formSubmit)", () => {
  for (const h of [chromeBeacon, chromeBeaconNoCors, safariFetch, firefoxBeacon]) {
    assert.equal(isAutomatedRequest(hdrs(h)), true, "page-visit rule reads a beacon as not-a-visit");
  }
});

test("a real browser's click beacon passes the gate (Chrome cors + no-cors, Safari fetch, Firefox)", () => {
  for (const h of [chromeBeacon, chromeBeaconNoCors, safariFetch, firefoxBeacon]) {
    const r = clickEventGate(hdrs(h), body, allowedHosts);
    assert.ok(r.ok, `${h["user-agent"]} ${h["sec-fetch-mode"]}: ${reasonOf(r)}`);
  }
});

test("a beacon from www. of the site passes too", () => {
  const h = { ...chromeBeacon, origin: "https://www.shop.example.com", referer: "https://www.shop.example.com/" };
  assert.ok(clickEventGate(hdrs(h), body, allowedHosts).ok);
});

test("bots, scripts and prefetches are still refused at the gate", () => {
  const refused: Record<string, string>[] = [
    { ...chromeBeacon, "user-agent": "facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)" },
    { ...chromeBeacon, "user-agent": "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)" },
    { ...chromeBeacon, "user-agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/143.0.0.0 Safari/537.36" },
    { ...chromeBeacon, "user-agent": "curl/8.4.0" },
    { ...chromeBeacon, "user-agent": "python-requests/2.32.3" },
    { ...chromeBeacon, "user-agent": "node-fetch/1.0" },
    { ...chromeBeacon, "user-agent": "" },
    { ...chromeBeacon, "sec-purpose": "prefetch" },
    { ...chromeBeacon, "sec-purpose": "prefetch;prerender" },
    { ...chromeBeacon, "next-router-prefetch": "1" },
  ];
  for (const h of refused) {
    const r = clickEventGate(hdrs(h), body, allowedHosts);
    assert.equal(reasonOf(r), "automated request", JSON.stringify(h));
  }
});

test("a forged cross-site or headerless POST is refused even with a browser UA", () => {
  const cross = { ...chromeBeacon, origin: "https://evil.example", referer: "https://evil.example/", "sec-fetch-site": "cross-site" };
  const r1 = clickEventGate(hdrs(cross), body, allowedHosts);
  assert.equal(reasonOf(r1), "origin not allowed");
  const bare = { "user-agent": CHROME_UA, "content-type": "application/json" };
  const r2 = clickEventGate(hdrs(bare), body, allowedHosts);
  assert.equal(reasonOf(r2), "origin not allowed");
});

test("a real beacon with a page-load event is still refused (the allowlist is unchanged)", () => {
  const r = clickEventGate(hdrs(chromeBeacon), { ...body, event: "ViewContent" }, allowedHosts);
  assert.equal(r.ok, false);
});
