import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

// ---------------------------------------------------------------------------
// Every rule in `attribution.ts` is a fixed incident, and each one is invisible
// when it breaks: attribution silently becomes wrong, the lead or sale is filed
// under the wrong source, and the only symptom is a number in Ads Manager that
// disagrees with a number in our own table weeks later. So the rules are tested
// rather than trusted.
//
// There is no DOM here. `attribution.ts` is browser-oriented but touches only
// four globals — window, localStorage, sessionStorage, document.cookie — so
// they are stubbed rather than pulling in jsdom, which web-core's dependency
// rule forbids. The stubs are deliberately dumb: real Storage semantics
// (string values, null for missing) and nothing else.
// ---------------------------------------------------------------------------

class MemoryStorage {
  private map = new Map<string, string>();
  getItem(k: string): string | null {
    return this.map.has(k) ? (this.map.get(k) as string) : null;
  }
  setItem(k: string, v: string): void {
    this.map.set(k, String(v));
  }
  removeItem(k: string): void {
    this.map.delete(k);
  }
  clear(): void {
    this.map.clear();
  }
}

const localStorageStub = new MemoryStorage();
const sessionStorageStub = new MemoryStorage();
let currentSearch = "";

const g = globalThis as unknown as Record<string, unknown>;
g.localStorage = localStorageStub;
g.sessionStorage = sessionStorageStub;
g.document = { cookie: "" };
g.window = {
  get location() {
    return { search: currentSearch };
  },
  localStorage: localStorageStub,
  sessionStorage: sessionStorageStub,
};

// eslint-disable-next-line @typescript-eslint/no-require-imports
const attribution = require("./attribution") as typeof import("./attribution");
const { captureAttribution, getStoredUtmParams, getStoredClickIds, attributionQueryString } = attribution;

const KEY = "test_attribution";
const OPTS = { storageKey: KEY };

/** Grant marketing consent the way the real banner does, via the cookie. */
function grantMarketing(): void {
  const state = { necessary: true, analytics: true, marketing: true, version: 2, updatedAt: new Date().toISOString() };
  (g.document as { cookie: string }).cookie = `cookie_consent_v2=${encodeURIComponent(JSON.stringify(state))}`;
}

beforeEach(() => {
  localStorageStub.clear();
  sessionStorageStub.clear();
  (g.document as { cookie: string }).cookie = "";
  currentSearch = "";
});

test("captures utm, gclid and fbclid from the url", () => {
  currentSearch = "?utm_source=facebook&utm_medium=paid-social&utm_campaign=2026-choice&fbclid=ABC123";
  const result = captureAttribution(OPTS);

  assert.equal(result.utm.utm_source, "facebook");
  assert.equal(result.utm.utm_campaign, "2026-choice");
  assert.equal(result.fbclid, "ABC123");
  assert.equal(result.paid, true, "paid-social is a paid medium");
});

test("fbclid and gclid are separate fields, never conflated", () => {
  currentSearch = "?gclid=GGG&fbclid=FFF";
  const result = captureAttribution(OPTS);
  assert.equal(result.gclid, "GGG");
  assert.equal(result.fbclid, "FFF");
});

test("a click id alone marks the touch paid, with no utm params at all", () => {
  // Ad-platform auto-tagging is often the ONLY signal — the ad final URL carries no
  // utm_* and the visitor arrives with just ?gclid=.
  currentSearch = "?gclid=AUTOTAG";
  const result = captureAttribution(OPTS);
  assert.equal(result.paid, true);
  assert.equal(result.gclid, "AUTOTAG");
});

test("a paid touch is sticky — a later organic touch must not overwrite it", () => {
  // The 2026-09-01 incident: paid ad click, then a blog CTA hard-coding
  // utm_source=blog&utm_medium=organic, and the lead filed as organic.
  currentSearch = "?utm_source=google&utm_medium=cpc&gclid=PAID1";
  captureAttribution(OPTS);

  currentSearch = "?utm_source=blog&utm_medium=organic";
  const after = captureAttribution(OPTS);

  assert.equal(after.utm.utm_source, "google", "paid source survives");
  assert.equal(after.gclid, "PAID1");
  assert.equal(after.paid, true);
});

test("an unpaid touch may replace another unpaid touch", () => {
  currentSearch = "?utm_source=newsletter&utm_medium=email";
  captureAttribution(OPTS);

  currentSearch = "?utm_source=partner&utm_medium=referral";
  const after = captureAttribution(OPTS);

  assert.equal(after.utm.utm_source, "partner", "last non-direct click wins");
});

test("an internal link naming itself merges, and does not claim to be the source", () => {
  // utm_content with no source/medium/click-id is an internal annotation, not a
  // traffic claim.
  currentSearch = "?utm_source=facebook&utm_medium=paid-social&fbclid=F1";
  captureAttribution(OPTS);

  currentSearch = "?utm_content=hero-cta";
  const after = captureAttribution(OPTS);

  assert.equal(after.utm.utm_source, "facebook", "real source preserved");
  assert.equal(after.utm.utm_content, "hero-cta", "detail merged in");
  assert.equal(after.fbclid, "F1");
});

test("a url with no attribution returns what was stored, and clears nothing", () => {
  currentSearch = "?utm_source=facebook&utm_medium=paid-social";
  captureAttribution(OPTS);

  currentSearch = "";
  const after = captureAttribution(OPTS);
  assert.equal(after.utm.utm_source, "facebook");
});

test("an expired record is dropped rather than credited forever", () => {
  const stale = {
    utm: { utm_source: "ancient" },
    paid: true,
    ts: Date.now() - 91 * 24 * 60 * 60 * 1000, // 91 days — past the 90-day window
  };
  localStorageStub.setItem(KEY, JSON.stringify(stale));
  sessionStorageStub.setItem(KEY, JSON.stringify(stale));

  assert.deepEqual(getStoredUtmParams(OPTS), {}, "stale attribution is not returned");
});

test("without marketing consent the durable copy is not written, but the session copy is", () => {
  currentSearch = "?utm_source=facebook&utm_medium=paid-social";
  captureAttribution(OPTS);

  assert.equal(localStorageStub.getItem(KEY), null, "no 90-day identifier before consent");
  assert.notEqual(sessionStorageStub.getItem(KEY), null, "per-tab mirror still carries the journey");
});

test("with marketing consent the durable copy is written", () => {
  grantMarketing();
  currentSearch = "?utm_source=facebook&utm_medium=paid-social";
  captureAttribution(OPTS);

  assert.notEqual(localStorageStub.getItem(KEY), null);
});

test("promoteStoredAttribution copies the session touch into the durable store on later consent", () => {
  // The normal order of events: land from an ad, then accept the banner.
  currentSearch = "?utm_source=facebook&utm_medium=paid-social&fbclid=LATE";
  captureAttribution(OPTS);
  assert.equal(localStorageStub.getItem(KEY), null);

  grantMarketing();
  attribution.promoteStoredAttribution(OPTS);

  const durable = JSON.parse(localStorageStub.getItem(KEY) as string);
  assert.equal(durable.fbclid, "LATE");
});

test("attributionQueryString round-trips utm and both click ids for an off-site checkout", () => {
  currentSearch = "?utm_source=facebook&utm_medium=paid-social&utm_campaign=2026-choice&fbclid=F9&gclid=G9";
  captureAttribution(OPTS);

  const qs = new URLSearchParams(attributionQueryString(OPTS));
  assert.equal(qs.get("utm_source"), "facebook");
  assert.equal(qs.get("utm_campaign"), "2026-choice");
  assert.equal(qs.get("fbclid"), "F9");
  assert.equal(qs.get("gclid"), "G9");
});

test("attributionQueryString is empty when nothing was ever captured", () => {
  // An empty string, not "?" or a stray "&" — callers concatenate it onto an href.
  assert.equal(attributionQueryString(OPTS), "");
});

test("stored values are length-capped so a hostile url cannot fill storage", () => {
  currentSearch = `?utm_source=${"x".repeat(500)}`;
  captureAttribution(OPTS);
  assert.equal(getStoredUtmParams(OPTS).utm_source?.length, 200);
});

test("corrupt stored json is survived, not thrown over", () => {
  localStorageStub.setItem(KEY, "{not json");
  sessionStorageStub.setItem(KEY, "{not json");
  assert.deepEqual(getStoredUtmParams(OPTS), {});
  assert.deepEqual(getStoredClickIds(OPTS), { gclid: undefined, fbclid: undefined });
});
