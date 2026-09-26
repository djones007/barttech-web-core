import { test } from "node:test";
import assert from "node:assert/strict";

import {
  assignSticky,
  requestVisitorKey,
  safeHttpsUrl,
  stickyBucket,
  variantCheckoutUrl,
  assignVariant,
  createExperimentConfigReader,
  experimentParams,
  experimentSuperProperties,
  forcedVariant,
  normaliseExperimentConfig,
  parseExperimentParams,
  pickWeighted,
  type ExperimentConfig,
  assignPageRequest,
  checkoutCurrency,
  createCheckoutClickHandler,
  createVariantOfferResolver,
  decodeAssignments,
  encodeAssignments,
  experimentEventTag,
  formatPrice,
  liveAssignment,
  offerSlugOf,
  priceFor,
  trustedCheckoutUrl,
  type PageAssignment,
} from "./experiments";

const base: ExperimentConfig = {
  key: "home-test",
  path: "/",
  status: "running",
  variants: [
    { id: "a", weight: 50 },
    { id: "b", weight: 50 },
  ],
  control: "a",
  winner: null,
};

test("pickWeighted splits by weight and never picks a zero-weight variant", () => {
  const v = [
    { id: "a", weight: 1 },
    { id: "z", weight: 0 },
    { id: "b", weight: 3 },
  ];
  assert.equal(pickWeighted(v, 0), "a");
  assert.equal(pickWeighted(v, 0.2499), "a");
  assert.equal(pickWeighted(v, 0.25), "b");
  assert.equal(pickWeighted(v, 0.9999999), "b");
  // Out-of-range input is clamped rather than throwing.
  assert.equal(pickWeighted(v, 1.5), "b");
  assert.equal(pickWeighted(v, -1), "a");
});

test("pickWeighted with every weight zero fails safe to the first variant", () => {
  assert.equal(pickWeighted([{ id: "a", weight: 0 }, { id: "b", weight: 0 }], 0.7), "a");
});

test("a 50/50 running test lands close to 50/50 over many draws", () => {
  let b = 0;
  let seed = 1;
  const rand = () => {
    // Small deterministic LCG so the test is not flaky.
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  };
  for (let i = 0; i < 10000; i++) if (assignVariant(base, { random: rand }).variant === "b") b++;
  assert.ok(b > 4700 && b < 5300, `expected ~5000, got ${b}`);
});

test("paused gives everyone the control, concluded gives the winner, neither is live", () => {
  const paused = assignVariant({ ...base, status: "paused" }, { random: () => 0.99 });
  assert.deepEqual(paused, { key: "home-test", variant: "a", forced: false, live: false });
  const won = assignVariant({ ...base, status: "concluded", winner: "b" });
  assert.deepEqual(won, { key: "home-test", variant: "b", forced: false, live: false });
  const noWinner = assignVariant({ ...base, status: "concluded" });
  assert.equal(noWinner.variant, "a");
});

test("a valid ?v= forces the variant even while paused, and is flagged forced", () => {
  const cfg = { ...base, status: "paused" as const };
  const f = forcedVariant(cfg, { v: "B" });
  assert.equal(f, "b");
  assert.deepEqual(assignVariant(cfg, { forced: f }), { key: "home-test", variant: "b", forced: true, live: true });
  // An unknown variant is ignored, not trusted.
  assert.equal(forcedVariant(cfg, { v: "c" }), null);
  assert.equal(forcedVariant(cfg, new URLSearchParams("v=a&v=b")), "a");
});

test("experimentParams carries only live assignments", () => {
  assert.deepEqual(experimentParams({ key: "k", variant: "b", forced: false, live: true }), { exp: "k", v: "b" });
  assert.deepEqual(experimentParams({ key: "k", variant: "b", forced: true, live: true }), { exp: "k", v: "b", xf: "1" });
  assert.deepEqual(experimentParams({ key: "k", variant: "a", forced: false, live: false }), {});
  assert.deepEqual(experimentParams(null), {});
});

test("parseExperimentParams validates shape and is null when absent", () => {
  assert.deepEqual(parseExperimentParams(new URLSearchParams("exp=home-test&v=b")), { key: "home-test", variant: "b", forced: false });
  assert.deepEqual(parseExperimentParams({ exp: "home-test", v: "a", xf: "1" }), { key: "home-test", variant: "a", forced: true });
  assert.equal(parseExperimentParams({}), null);
  assert.equal(parseExperimentParams({ exp: "home-test" }), null);
  assert.equal(parseExperimentParams({ exp: "bad key!", v: "a" }), null);
  assert.equal(parseExperimentParams({ exp: "k", v: "<script>" }), null);
});

test("normaliseExperimentConfig rejects malformed configs rather than half-trusting them", () => {
  assert.deepEqual(normaliseExperimentConfig(base), base);
  assert.equal(normaliseExperimentConfig(null), null);
  assert.equal(normaliseExperimentConfig({ ...base, status: "live" }), null);
  assert.equal(normaliseExperimentConfig({ ...base, control: "c" }), null);
  assert.equal(normaliseExperimentConfig({ ...base, variants: [{ id: "a", weight: 1 }] }), null);
  assert.equal(normaliseExperimentConfig({ ...base, variants: [{ id: "a", weight: 1 }, { id: "a", weight: 1 }] }), null);
  assert.equal(normaliseExperimentConfig({ ...base, path: "no-slash" }), null);
  // A winner that is not a variant is dropped, not kept.
  assert.equal(normaliseExperimentConfig({ ...base, winner: "q" })?.winner, null);
  // Negative weights become 0.
  assert.equal(normaliseExperimentConfig({ ...base, variants: [{ id: "a", weight: -5 }, { id: "b", weight: 1 }] })?.variants[0].weight, 0);
});

test("experimentSuperProperties names the variant per experiment and skips non-live", () => {
  assert.deepEqual(
    experimentSuperProperties([{ key: "k", variant: "b", forced: false, live: true }, { key: "x", variant: "a", forced: false, live: false }]),
    { exp_k: "b", experiment: "k", experiment_variant: "b" },
  );
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

test("config reader: unconfigured is no experiments, never a fetch", async () => {
  let calls = 0;
  const read = createExperimentConfigReader({ url: undefined, token: "t", site: "s", fetchImpl: async () => { calls++; return jsonResponse({}); } });
  assert.deepEqual(await read(), []);
  assert.equal(calls, 0);
});

test("config reader: caches for the TTL, then refetches; bad rows are dropped", async () => {
  let t = 0;
  let calls = 0;
  let seenUrl = "";
  let seenAuth = "";
  const read = createExperimentConfigReader({
    url: "https://example.test/api/x",
    token: "tok",
    site: "site.example",
    ttlMs: 1000,
    now: () => t,
    fetchImpl: async (url, init) => {
      calls++;
      seenUrl = url;
      seenAuth = new Headers(init?.headers).get("authorization") ?? "";
      return jsonResponse({ experiments: [base, { key: "BROKEN" }] });
    },
  });
  assert.deepEqual(await read(), [base]);
  assert.equal(seenUrl, "https://example.test/api/x?site=site.example");
  assert.equal(seenAuth, "Bearer tok");
  t = 500;
  await read();
  assert.equal(calls, 1);
  t = 1500;
  await read();
  assert.equal(calls, 2);
});

test("config reader: a failing endpoint serves the last good list, then falls back to control (empty)", async () => {
  let t = 0;
  let fail = false;
  const read = createExperimentConfigReader({
    url: "https://example.test/api/x",
    token: "tok",
    site: "s",
    ttlMs: 10,
    maxStaleMs: 100,
    now: () => t,
    fetchImpl: async () => {
      if (fail) throw new Error("down");
      return jsonResponse({ experiments: [base] });
    },
  });
  assert.equal((await read()).length, 1);
  fail = true;
  t = 50;
  assert.equal((await read()).length, 1, "within maxStale: last good list");
  t = 500;
  assert.deepEqual(await read(), [], "past maxStale: no experiment, everyone gets control");
});

test("config reader: a non-200 is treated as a failure", async () => {
  const read = createExperimentConfigReader({ url: "https://e.test/x", token: "t", site: "s", fetchImpl: async () => jsonResponse({ error: "no" }, 401) });
  assert.deepEqual(await read(), []);
});

// ---- Sticky assignment (assignSticky / stickyBucket), 2026-09-26 ----

function hdrs(h: Record<string, string>) {
  return { get: (n: string) => h[n.toLowerCase()] ?? null };
}

test("stickyBucket is deterministic, in [0,1), and keyed by experiment", async () => {
  const a1 = await stickyBucket("price-test", "1.2.3.4|UA");
  const a2 = await stickyBucket("price-test", "1.2.3.4|UA");
  assert.equal(a1, a2);
  assert.ok(a1 >= 0 && a1 < 1);
  // Another experiment gives an independent position for the same visitor.
  const others = await Promise.all(["t1", "t2", "t3", "t4", "t5"].map((k) => stickyBucket(k, "1.2.3.4|UA")));
  assert.ok(new Set(others.map((x) => x.toFixed(6))).size > 1);
});

test("stickyBucket splits a population close to 50/50", async () => {
  let low = 0;
  const n = 4000;
  for (let i = 0; i < n; i++) if ((await stickyBucket("split", `10.0.${i >> 8}.${i & 255}|Mozilla/${i % 7}`)) < 0.5) low++;
  assert.ok(Math.abs(low / n - 0.5) < 0.03, `share ${low / n}`);
});

test("assignSticky returns the same variant on every visit for one visitor", async () => {
  const cfg: ExperimentConfig = { ...base, key: "price" };
  const vk = requestVisitorKey(hdrs({ "x-forwarded-for": "81.2.69.160, 10.0.0.1", "user-agent": "Mozilla/5.0 Test" }));
  assert.equal(vk, "81.2.69.160|Mozilla/5.0 Test");
  const first = await assignSticky(cfg, { visitorKey: vk });
  for (let i = 0; i < 20; i++) assert.deepEqual(await assignSticky(cfg, { visitorKey: vk }), first);
  assert.equal(first.live, true);
  assert.equal(first.forced, false);
  // Both variants occur across visitors.
  const seen = new Set<string>();
  for (let i = 0; i < 50; i++) seen.add((await assignSticky(cfg, { visitorKey: `ip${i}|ua` })).variant);
  assert.deepEqual([...seen].sort(), ["a", "b"]);
});

test("assignSticky: forced wins, paused gives the control, concluded the winner", async () => {
  assert.deepEqual(await assignSticky(base, { forced: "b", visitorKey: "x|y" }), { key: "home-test", variant: "b", forced: true, live: true });
  assert.equal((await assignSticky({ ...base, status: "paused" }, { visitorKey: "x|y" })).variant, "a");
  const c = await assignSticky({ ...base, status: "concluded", winner: "b" }, { visitorKey: "x|y" });
  assert.equal(c.variant, "b");
  assert.equal(c.live, false);
});

test("requestVisitorKey is null with no headers (falls back to per-view random)", () => {
  assert.equal(requestVisitorKey(hdrs({})), null);
});

test("checkoutUrl: https only, kept by normalise, read by variantCheckoutUrl", () => {
  assert.equal(safeHttpsUrl("http://x.example/a"), null);
  assert.equal(safeHttpsUrl("javascript:alert(1)"), null);
  assert.equal(safeHttpsUrl("https://u:p@x.example/a"), null);
  assert.equal(safeHttpsUrl("https://checkout.example/play-p"), "https://checkout.example/play-p");
  const cfg = normaliseExperimentConfig({
    key: "price", path: "/", status: "running", control: "a", winner: null,
    variants: [
      { id: "a", weight: 1, checkoutUrl: "https://checkout.example/play" },
      { id: "b", weight: 1, checkoutUrl: "http://evil.example/x" },
    ],
  });
  assert.ok(cfg);
  assert.equal(variantCheckoutUrl(cfg!, "a"), "https://checkout.example/play");
  assert.equal(variantCheckoutUrl(cfg!, "b"), null);
});

// ---------------------------------------------------------------------------
// Per-request assignment, header round-trip, event tag
// ---------------------------------------------------------------------------

const visitor = hdrs({ "x-forwarded-for": "203.0.113.9", "user-agent": "Mozilla/5.0 (iPhone) Safari" });

test("assignPageRequest: only configs on the path; sticky for a real visitor", async () => {
  const other = { ...base, key: "other-page", path: "/pricing" };
  const first = await assignPageRequest([base, other], { pathname: "/", searchParams: new URLSearchParams(), headers: visitor, automated: false, salt: "site" });
  assert.equal(first.length, 1);
  assert.equal(first[0].key, "home-test");
  assert.equal(first[0].path, "/");
  assert.equal(first[0].live, true);
  for (let i = 0; i < 10; i++) {
    const again = await assignPageRequest([base], { pathname: "/", searchParams: new URLSearchParams(), headers: visitor, automated: false, salt: "site" });
    assert.deepEqual(again, first);
  }
  assert.deepEqual(await assignPageRequest([other], { pathname: "/", searchParams: new URLSearchParams(), headers: visitor, automated: false }), []);
});

test("assignPageRequest: a crawler gets the control while running, the WINNER once concluded, never tagged", async () => {
  const running = await assignPageRequest([{ ...base, control: "b" }], { pathname: "/", searchParams: new URLSearchParams(), headers: visitor, automated: true });
  assert.deepEqual(running, [{ key: "home-test", variant: "b", forced: false, live: false, path: "/" }]);
  const concluded = await assignPageRequest([{ ...base, status: "concluded", winner: "b" }], { pathname: "/", searchParams: new URLSearchParams(), headers: visitor, automated: true });
  assert.equal(concluded[0].variant, "b");
  assert.equal(concluded[0].live, false);
  // Forced still wins for a crawler (QA with a link-preview tool).
  const forced = await assignPageRequest([base], { pathname: "/", searchParams: new URLSearchParams("v=b"), headers: visitor, automated: true });
  assert.equal(forced[0].variant, "b");
  assert.equal(forced[0].forced, true);
});

test("assignPageRequest: ?v= forces only the RUNNING test when one runs, any test when none does", async () => {
  const done = { ...base, key: "old-test", status: "concluded" as const, winner: "a", variants: [{ id: "a", weight: 1 }, { id: "b", weight: 1 }] };
  const list = await assignPageRequest([done, base], { pathname: "/", searchParams: new URLSearchParams("v=b"), headers: visitor, automated: false });
  assert.deepEqual(list.map((a) => [a.key, a.variant, a.forced]), [["old-test", "a", false], ["home-test", "b", true]]);
  const qa = await assignPageRequest([done], { pathname: "/", searchParams: new URLSearchParams("v=b"), headers: visitor, automated: false });
  assert.deepEqual([qa[0].variant, qa[0].forced], ["b", true]);
});

test("encode/decode assignments round-trip; malformed tokens are dropped", () => {
  const list: PageAssignment[] = [
    { key: "home-test", variant: "b", forced: false, live: false, path: "/" },
    { key: "price", variant: "a", forced: true, live: true, path: "/a b" },
  ];
  assert.deepEqual(decodeAssignments(encodeAssignments(list)), list);
  assert.deepEqual(decodeAssignments(null), []);
  assert.deepEqual(decodeAssignments("BAD KEY;a;0;1;%2F,price;a;0;1;nopath,price;a;0;1;%E0%A4%A"), []);
  assert.equal(decodeAssignments(Array(8).fill("price;a;0;1;%2F").join(",")).length, 5);
});

test("experimentEventTag: live assignment under the REQUESTED path; nothing when none is live", () => {
  const list: PageAssignment[] = [
    { key: "home-test", variant: "b", forced: false, live: false, path: "/" },
    { key: "price", variant: "a", forced: false, live: true, path: "/" },
  ];
  assert.equal(liveAssignment(list)?.key, "price");
  assert.deepEqual(experimentEventTag(list), { path: "/", experiment: { key: "price", variant: "a", forced: false } });
  assert.deepEqual(experimentEventTag([list[0]]), {});
});

// ---------------------------------------------------------------------------
// Price tests: variant -> offer -> price, and the page price == checkout price rule
// ---------------------------------------------------------------------------

const DEFAULT_OFFER = "https://checkout.example/play";
const priceCfg: ExperimentConfig = {
  key: "price", path: "/", status: "running", control: "a", winner: null,
  variants: [
    { id: "a", weight: 50, checkoutUrl: "https://checkout.example/play" },
    { id: "b", weight: 50, checkoutUrl: "https://checkout.example/play-p" },
    { id: "c", weight: 0, checkoutUrl: "https://evil.example/play-p" },
  ],
};
const OFFERS: Record<string, { currency: string; amount: number }[]> = {
  play: [{ currency: "gbp", amount: 1999 }, { currency: "usd", amount: 2499 }],
  "play-p": [{ currency: "gbp", amount: 2499 }, { currency: "usd", amount: 2999 }],
};
function offerFetch(calls: string[] = []) {
  return async (url: string) => {
    calls.push(url);
    const slug = new URL(url).searchParams.get("offer") ?? "";
    return OFFERS[slug] ? new Response(JSON.stringify({ currencies: OFFERS[slug] }), { status: 200 }) : new Response("{}", { status: 404 });
  };
}

test("trustedCheckoutUrl: only a bare https slug on the default offer's host", () => {
  assert.equal(trustedCheckoutUrl("https://checkout.example/play-p", DEFAULT_OFFER), "https://checkout.example/play-p");
  for (const bad of ["https://evil.example/play-p", "http://checkout.example/play-p", "https://checkout.example/a/b", "https://checkout.example/play-p?x=1", "https://checkout.example/play-p#x", "not a url", null, undefined]) {
    assert.equal(trustedCheckoutUrl(bad, DEFAULT_OFFER), DEFAULT_OFFER, String(bad));
  }
  assert.equal(offerSlugOf("https://checkout.example/play-p"), "play-p");
});

test("priceFor: the checkout's own currency choice, formatted from minor units", () => {
  assert.equal(checkoutCurrency("US", ["gbp", "usd"]), "usd");
  assert.equal(checkoutCurrency("gb", ["gbp", "usd"]), "gbp");
  assert.equal(checkoutCurrency("FR", ["gbp", "usd"]), "gbp");
  assert.equal(checkoutCurrency("US", ["gbp"]), "gbp");
  assert.equal(formatPrice(1999, "eur"), null);
  assert.equal(formatPrice(0, "gbp"), null);
  assert.deepEqual(priceFor(OFFERS.play, "US"), { price: "$24.99", money: { currency: "USD", value: 24.99 } });
  assert.deepEqual(priceFor(OFFERS["play-p"], null), { price: "£24.99", money: { currency: "GBP", value: 24.99 } });
  assert.equal(priceFor([{ currency: "usd", amount: 100 }], "FR"), null);
});

test("createVariantOfferResolver: each variant's own offer and price; untrusted/unknown -> default", async () => {
  const calls: string[] = [];
  const r = createVariantOfferResolver({ defaultCheckoutUrl: DEFAULT_OFFER, readConfigs: async () => [priceCfg], fetchImpl: offerFetch(calls) });
  for (const [variant, country, url, price] of [
    ["a", "GB", "https://checkout.example/play", "£19.99"],
    ["b", "GB", "https://checkout.example/play-p", "£24.99"],
    ["b", "US", "https://checkout.example/play-p", "$29.99"],
    ["c", "GB", DEFAULT_OFFER, "£19.99"],
  ] as const) {
    const o = await r.offerFor([{ key: "price", variant }], country);
    assert.equal(o.checkoutUrl, url, variant);
    assert.equal(o.price, price, `${variant}/${country}`);
    // The page price IS the charged price: same offer rows, same currency rule.
    const cur = checkoutCurrency(country, OFFERS[o.offer].map((c) => c.currency));
    assert.equal(Math.round(o.money!.value * 100), OFFERS[o.offer].find((c) => c.currency === cur)!.amount);
  }
  assert.equal((await r.offerFor([], "GB")).checkoutUrl, DEFAULT_OFFER);
  assert.equal((await r.offerFor([{ key: "nope", variant: "b" }], "GB")).checkoutUrl, DEFAULT_OFFER);
  // Cached: two offers read once each despite repeated calls.
  assert.equal(new Set(calls).size, calls.length);
  assert.equal(calls[0], "https://checkout.example/api/offer?offer=play");
});

test("createVariantOfferResolver: an unreadable offer gives no price, never a guessed one", async () => {
  const r = createVariantOfferResolver({ defaultCheckoutUrl: DEFAULT_OFFER, readConfigs: async () => [priceCfg], fetchImpl: async () => { throw new Error("down"); } });
  const o = await r.offerFor([{ key: "price", variant: "b" }], "GB");
  assert.deepEqual(o, { checkoutUrl: "https://checkout.example/play-p", offer: "play-p", price: null, money: null });
  const bad = createVariantOfferResolver({ defaultCheckoutUrl: DEFAULT_OFFER, readConfigs: async () => [], fetchImpl: async () => new Response(JSON.stringify({ currencies: [{ currency: "gbp", amount: 19.99 }] })) });
  assert.equal((await bad.offerFor([], "GB")).price, null);
  // No default offer configured yet (an unset env var): no offer, no price, no throw.
  const unset = createVariantOfferResolver({ defaultCheckoutUrl: "", readConfigs: async () => [priceCfg], fetchImpl: offerFetch() });
  assert.deepEqual(await unset.offerFor([{ key: "price", variant: "b" }], "GB"), { checkoutUrl: "", offer: "", price: null, money: null });
});

// ---------------------------------------------------------------------------
// The click handler
// ---------------------------------------------------------------------------

function clickReq(query: string, referer?: string): Request {
  return new Request(`https://site.example/go/checkout${query}`, { headers: referer ? { referer } : {} });
}

test("click handler: 404 when no checkout is configured", async () => {
  const res = await createCheckoutClickHandler({ checkoutUrl: undefined })(clickReq(""));
  assert.equal(res.status, 404);
});

test("click handler: fixed destination, every param passed through, logged after with the variant", async () => {
  const events: unknown[] = [];
  const deferred: (() => Promise<void>)[] = [];
  const GET = createCheckoutClickHandler({ checkoutUrl: () => DEFAULT_OFFER, onClick: (e) => { events.push(e); }, defer: (t) => { deferred.push(t); } });
  const res = await GET(clickReq("?exp=price&v=b&xf=1&utm_source=meta&fbclid=abc", "https://site.example/sale?x=1"));
  assert.equal(res.status, 302);
  const loc = new URL(res.headers.get("location")!);
  assert.equal(`${loc.origin}${loc.pathname}`, DEFAULT_OFFER);
  assert.deepEqual(Object.fromEntries(loc.searchParams), { exp: "price", v: "b", xf: "1", utm_source: "meta", fbclid: "abc" });
  assert.equal(events.length, 0, "logging waits for defer");
  await deferred[0]();
  const e = events[0] as { event: string; path: string; experiment: unknown; searchParams: Record<string, string> };
  assert.equal(e.event, "reserve_click");
  assert.equal(e.path, "/sale");
  assert.deepEqual(e.experiment, { key: "price", variant: "b", forced: true });
  assert.equal(e.searchParams.utm_source, "meta");
});

test("click handler: an off-site referrer logs as '/'; oversize params are dropped; a throwing logger never breaks the redirect", async () => {
  let path = "";
  const GET = createCheckoutClickHandler({ checkoutUrl: DEFAULT_OFFER, onClick: (e) => { path = e.path; throw new Error("log down"); }, defer: (t) => { void t(); } });
  const res = await GET(clickReq(`?${"k".repeat(65)}=1&ok=${"v".repeat(501)}&fine=1`, "https://other.example/x"));
  assert.equal(res.status, 302);
  assert.deepEqual(Object.fromEntries(new URL(res.headers.get("location")!).searchParams), { fine: "1" });
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(path, "/");
});

test("click handler: the variant's own offer, the priced offer (o=) on the trusted host only; never an open redirect", async () => {
  const r = createVariantOfferResolver({ defaultCheckoutUrl: DEFAULT_OFFER, readConfigs: async () => [priceCfg], fetchImpl: offerFetch() });
  const GET = createCheckoutClickHandler({
    checkoutUrl: DEFAULT_OFFER,
    variantCheckoutUrl: (exp) => r.checkoutUrlFor(exp ? [exp] : []),
    offerParam: "o",
  });
  const dest = async (q: string) => {
    const u = new URL((await GET(clickReq(q))).headers.get("location")!);
    return { at: `${u.origin}${u.pathname}`, params: Object.fromEntries(u.searchParams) };
  };
  assert.equal((await dest("?exp=price&v=b")).at, "https://checkout.example/play-p");
  assert.equal((await dest("?exp=price&v=a")).at, "https://checkout.example/play");
  assert.equal((await dest("?exp=price&v=c")).at, DEFAULT_OFFER, "untrusted variant URL falls back");
  assert.equal((await dest("")).at, DEFAULT_OFFER);
  // o= wins (the offer the page priced), and is stripped from what is passed on.
  const priced = await dest("?exp=price&v=a&o=play-p&utm_source=x");
  assert.equal(priced.at, "https://checkout.example/play-p");
  assert.deepEqual(priced.params, { exp: "price", v: "a", utm_source: "x" });
  for (const bad of ["evil.example", "a/b", "..%2F..", "https://evil.example/x", "UPPER"]) {
    assert.equal((await dest(`?exp=price&v=b&o=${encodeURIComponent(bad)}`)).at, "https://checkout.example/play-p", bad);
  }
  // A variant resolver that throws still redirects, to the default offer.
  const safe = createCheckoutClickHandler({ checkoutUrl: DEFAULT_OFFER, variantCheckoutUrl: () => { throw new Error("x"); } });
  assert.equal(new URL((await safe(clickReq("?exp=price&v=b"))).headers.get("location")!).pathname, "/play");
});
