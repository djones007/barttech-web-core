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
