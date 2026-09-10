import { test } from "node:test";
import assert from "node:assert/strict";

import { isAutomatedRequest } from "./requestSignals";

// ---------------------------------------------------------------------------
// These tests exist because of a specific, expensive failure.
//
// On 2026-09-08 a server-side CAPI `ViewContent` was added to a landing page
// inside `after()`, so it fired on every render. The page was `force-dynamic`,
// which meant every crawler, link-scraper and prefetch rendered it and fired
// the event too. Server-side ViewContent on that pixel went from ~1/hour to
// 267, 333 and 230 in single hours — about a twentyfold inflation of the exact
// event the live ad sets were optimising on. Meta was paid to learn to find
// traffic that looks like a crawler.
//
// The gate now lives inside `sendLandingPageView`, so a page cannot forget it.
// `isAutomatedRequest` is exported for these tests; the rules it encodes are
// what stop the inflation coming back, so each one is pinned here.
//
// The bias is deliberate and asymmetric: only POSITIVE evidence of automation
// blocks. A missed genuine view under-counts by one; blocking real traffic
// starves the optimisation signal, which is far harder to notice. Any change
// that makes this stricter needs a very good reason.
// ---------------------------------------------------------------------------

/** Minimal Headers-alike. Keys are matched case-insensitively, as Headers does. */
function hdrs(map: Record<string, string>): { get(name: string): string | null } {
  const lower = Object.fromEntries(Object.entries(map).map(([k, v]) => [k.toLowerCase(), v]));
  return { get: (name: string) => lower[name.toLowerCase()] ?? null };
}

const CHROME =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36";
const IPHONE_SAFARI =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";

// ── The real visitors this must never block ────────────────────────────────

test("a normal desktop navigation is a real view", () => {
  assert.equal(
    isAutomatedRequest(
      hdrs({
        "user-agent": CHROME,
        "sec-fetch-mode": "navigate",
        "sec-fetch-dest": "document",
      })
    ),
    false
  );
});

test("an older browser that sends no Sec-Fetch headers is still a real view", () => {
  // Safari below 16.4 sends no Sec-Fetch metadata. Absence proves nothing and
  // must not be read as evidence of a bot.
  assert.equal(isAutomatedRequest(hdrs({ "user-agent": IPHONE_SAFARI })), false);
});

test("a client-side navigation (RSC, not a prefetch) is a real view", () => {
  // Next.js fetches the RSC payload when a visitor navigates in-app. That IS a
  // person arriving on the page — only the hover PREFETCH is not.
  assert.equal(
    isAutomatedRequest(hdrs({ "user-agent": CHROME, rsc: "1", "sec-fetch-mode": "navigate", "sec-fetch-dest": "document" })),
    false
  );
});

// ── The automated traffic that caused the incident ─────────────────────────

test("Meta's own link scraper is not a view", () => {
  // This one matters most: Meta scrapes a link the moment it appears in an ad,
  // repeatedly, onto exactly the pages that fire this event.
  assert.equal(isAutomatedRequest(hdrs({ "user-agent": "facebookexternalhit/1.1" })), true);
  assert.equal(isAutomatedRequest(hdrs({ "user-agent": "meta-externalagent/1.1" })), true);
});

test("search and SEO crawlers are not views", () => {
  for (const ua of [
    "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)",
    "Mozilla/5.0 (compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm)",
    "Mozilla/5.0 (compatible; AhrefsBot/7.0; +http://ahrefs.com/robot/)",
    "Mozilla/5.0 (compatible; SemrushBot/7~bl)",
    "Mozilla/5.0 (compatible; PetalBot;+https://webmaster.petalsearch.com/site/petalbot)",
  ]) {
    assert.equal(isAutomatedRequest(hdrs({ "user-agent": ua })), true, ua);
  }
});

test("AI crawlers are not views", () => {
  for (const ua of ["GPTBot/1.0", "ClaudeBot/1.0", "CCBot/2.0", "PerplexityBot/1.0", "Bytespider"]) {
    assert.equal(isAutomatedRequest(hdrs({ "user-agent": ua })), true, ua);
  }
});

test("scripted clients and monitors are not views", () => {
  for (const ua of [
    "curl/8.4.0",
    "Wget/1.21.4",
    "python-requests/2.31.0",
    "axios/1.6.0",
    "Go-http-client/2.0",
    "node-fetch/1.0",
    "Pingdom.com_bot_version_1.4",
    "Mozilla/5.0 (X11; Linux x86_64) HeadlessChrome/120.0.0.0",
    "Chrome-Lighthouse",
  ]) {
    assert.equal(isAutomatedRequest(hdrs({ "user-agent": ua })), true, ua);
  }
});

test("no user agent at all is not a browser", () => {
  assert.equal(isAutomatedRequest(hdrs({})), true);
  assert.equal(isAutomatedRequest(hdrs({ "user-agent": "   " })), true);
});

// ── Prefetch and prerender: a real browser, but nobody is looking ──────────

test("a prefetch or prerender is not a view, on any browser's header", () => {
  const cases: Record<string, string>[] = [
    { "sec-purpose": "prefetch" },
    { "sec-purpose": "prefetch;prerender" },
    { purpose: "prefetch" },
    { "x-purpose": "preview" },
    { "x-moz": "prefetch" },
    { "next-router-prefetch": "1" },
  ];
  for (const extra of cases) {
    assert.equal(
      isAutomatedRequest(hdrs({ "user-agent": CHROME, ...extra })),
      true,
      JSON.stringify(extra)
    );
  }
});

// ── Sec-Fetch: what the request actually is ────────────────────────────────

test("a subresource or API fetch is not a page view", () => {
  assert.equal(isAutomatedRequest(hdrs({ "user-agent": CHROME, "sec-fetch-mode": "cors" })), true);
  assert.equal(isAutomatedRequest(hdrs({ "user-agent": CHROME, "sec-fetch-mode": "no-cors" })), true);
  assert.equal(isAutomatedRequest(hdrs({ "user-agent": CHROME, "sec-fetch-dest": "image" })), true);
  assert.equal(isAutomatedRequest(hdrs({ "user-agent": CHROME, "sec-fetch-dest": "empty" })), true);
});

test("an embed in an iframe is not a landing-page view", () => {
  assert.equal(isAutomatedRequest(hdrs({ "user-agent": CHROME, "sec-fetch-dest": "iframe" })), true);
});

// ── The bias itself ────────────────────────────────────────────────────────

test("an unrecognised but browser-shaped agent is allowed through", () => {
  // Fails toward sending: a missed view under-counts by one, blocking real
  // traffic starves the signal. Only positive evidence of automation blocks.
  assert.equal(
    isAutomatedRequest(hdrs({ "user-agent": "Mozilla/5.0 (SomeNewBrowser/1.0)" })),
    false
  );
});

test("header lookup is case-insensitive, as Headers is", () => {
  assert.equal(isAutomatedRequest(hdrs({ "User-Agent": "Googlebot/2.1" })), true);
  assert.equal(isAutomatedRequest(hdrs({ "user-agent": CHROME, "Sec-Purpose": "prefetch" })), true);
});
