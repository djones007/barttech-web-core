/**
 * requestSignals — what a request IS, from its headers alone.
 * ---------------------------------------------------------------------------
 * Pure header inspection: no secrets, no I/O, no Node built-ins, so it is
 * isomorphic and carries no `server-only` guard (golden rule 5).
 *
 * Extracted from `metaCapi.ts` on 2026-09-10 so it could be TESTED — that
 * module imports `server-only`, which cannot resolve in the node:test build.
 * The rules here are the ones that stop a real, costly incident recurring, so
 * being able to pin them in tests is the point.
 */

/**
 * Bot / crawler / prefetch user agents. Not exhaustive and cannot be — the point
 * is to catch the high-volume automated traffic that renders a page, not to win
 * an arms race against a determined scraper.
 *
 * `facebookexternalhit` and `meta-externalagent` are in here and they matter
 * most: Meta scrapes a link the moment it appears in an ad, repeatedly, and
 * those hits land on exactly the pages that fire this event.
 */
const AUTOMATED_UA =
  /(bot|crawl|spider|slurp|headless|phantom|curl|wget|python-requests|aiohttp|axios|go-http-client|java\/|okhttp|scrapy|facebookexternalhit|meta-externalagent|bingpreview|ahrefs|semrush|mj12|dotbot|petalbot|applebot|gptbot|claudebot|ccbot|perplexity|bytespider|dataforseo|lighthouse|pagespeed|chrome-lighthouse|uptime|pingdom|statuscake|monitoring|vercel-screenshot|node-fetch|undici)/i;

/**
 * Headers a browser sets when a request is a PREFETCH or PRERENDER rather than
 * a visit. Chrome sends `sec-purpose`, older Chrome `purpose`, Safari
 * `x-purpose`, Firefox `x-moz`, and Next.js sets `next-router-prefetch` when it
 * warms a link on hover. None of these is a person looking at the page.
 */
const PREFETCH_HEADERS: readonly [string, RegExp][] = [
  ["sec-purpose", /prefetch|prerender/i],
  ["purpose", /prefetch|preview/i],
  ["x-purpose", /prefetch|preview/i],
  ["x-moz", /prefetch/i],
  ["next-router-prefetch", /1|true/i],
];

/**
 * Is this request something OTHER than a human loading the page in a browser?
 *
 * WHY THIS EXISTS — read before loosening it. On 2026-09-08 a server-side
 * `ViewContent` was added to a landing page inside `after()`, firing on every
 * render. The page was `force-dynamic`, so every crawler, link-scraper and
 * prefetch rendered it and fired the event too. Server-side ViewContent on that
 * pixel went from about **1 an hour to 267, 333 and 230 in single hours** —
 * roughly a twentyfold inflation of the exact event the live ad sets were
 * optimising on (`custom_event_type: CONTENT_VIEW`). Meta spent real money
 * learning to find traffic that looks like a crawler.
 *
 * The call site was not wrong to forget this; a call site that has to remember
 * is the bug. So the gate lives in `sendLandingPageView` below, where it cannot
 * be forgotten, and this function is exported only so it can be TESTED and
 * reused — not so a caller can decide whether to apply it.
 *
 * FAILS TOWARD SENDING, deliberately. A request that looks like an ordinary
 * browser navigation is sent even if we cannot fully identify it: the cost of a
 * missed genuine view is one under-counted visit, while the cost of blocking
 * real traffic is a starved optimisation signal, which is the harder failure to
 * notice. Only positive evidence of automation blocks.
 */
export function isAutomatedRequest(hdrs: { get(name: string): string | null }): boolean {
  const ua = hdrs.get("user-agent");

  // No user agent at all is not a browser. Every real one sends it.
  if (!ua || !ua.trim()) return true;
  if (AUTOMATED_UA.test(ua)) return true;

  for (const [name, pattern] of PREFETCH_HEADERS) {
    const value = hdrs.get(name);
    if (value && pattern.test(value)) return true;
  }

  // Sec-Fetch metadata, when present, says what the request IS. A real page
  // visit is `navigate` + `document`; anything else is a subresource, an API
  // call or an embed. Absent entirely (Safari below 16.4, some proxies) it
  // proves nothing, so it is not treated as evidence either way.
  const mode = hdrs.get("sec-fetch-mode");
  if (mode && mode !== "navigate") return true;
  const dest = hdrs.get("sec-fetch-dest");
  if (dest && dest !== "document") return true;

  return false;
}
