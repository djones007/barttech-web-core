import { test } from "node:test";
import assert from "node:assert/strict";
import { browserFamily, cleanClientBasics, cleanPlainText, fitJsonSnapshot, MAX_CLIENT_ERRORS } from "./problemReport";

test("cleanPlainText strips control chars and tags, collapses whitespace, caps", () => {
  assert.equal(cleanPlainText("  hi\u0000 <b>there</b>\n\n friend  ", 100), "hi there friend");
  assert.equal(cleanPlainText("a<script>alert(1)</script>b", 100), "a alert(1) b");
  assert.equal(cleanPlainText("1 < 2 > 0", 100), "1 0"); // "< 2 >" reads as a tag and goes
  assert.equal(cleanPlainText("a > b", 100), "a b");
  assert.equal(cleanPlainText("abcdef", 3), "abc");
  assert.equal(cleanPlainText(42, 10), "");
  assert.equal(cleanPlainText(null, 10), "");
});

test("browserFamily: specific browsers before the generic ones they imitate", () => {
  const cases: [string, string][] = [
    ["Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 Chrome/128.0 Safari/537.36 Edg/128.0", "Edge 128"],
    ["Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 SamsungBrowser/25.0 Chrome/121.0 Mobile Safari/537.36", "Samsung 25"],
    ["Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 Chrome/127.0 Safari/537.36 OPR/112.0", "Opera 112"],
    ["Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 FxiOS/129.0 Mobile/15E148 Safari/605.1.15", "Firefox 129"],
    ["Mozilla/5.0 (X11; Linux x86_64; rv:130.0) Gecko/20100101 Firefox/130.0", "Firefox 130"],
    ["Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 CriOS/128.0 Mobile/15E148 Safari/604.1", "Chrome 128"],
    ["Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/17.5 Safari/605.1.15", "Safari 17"],
    ["Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Instagram 340.0", "iOS in-app"],
    ["curl/8.4.0", "Other"],
  ];
  for (const [ua, want] of cases) assert.equal(browserFamily(ua), want, ua);
  assert.equal(browserFamily(null), null);
  assert.equal(browserFamily(""), null);
});

test("fitJsonSnapshot: untouched when small, trims then drops, null when hopeless", () => {
  const small = { a: 1, events: [1, 2, 3] };
  assert.equal(fitJsonSnapshot(small, 1000), small);
  const events = Array.from({ length: 200 }, (_, i) => ({ i, pad: "x".repeat(50) }));
  const big = { flags: { a: true }, events, trail: "y".repeat(5000) };
  const trimmed = fitJsonSnapshot(big, 6500, { trim: ["events"], keepLast: 10, drop: ["events", "trail"] });
  assert.ok(trimmed);
  assert.equal((trimmed!.events as unknown[]).length, 10);
  assert.equal(trimmed!.trail, big.trail);
  const dropped = fitJsonSnapshot(big, 500, { trim: ["events"], drop: ["events", "trail"] });
  assert.ok(dropped);
  assert.deepEqual(dropped!.events, []);
  assert.equal("trail" in dropped!, false);
  assert.deepEqual(dropped!.flags, { a: true });
  assert.equal(fitJsonSnapshot(big, 10, { drop: ["events", "trail"] }), null);
  assert.equal(fitJsonSnapshot("nope", 100), null);
  assert.equal(fitJsonSnapshot([1], 100), null);
  assert.equal(fitJsonSnapshot(null, 100), null);
  assert.equal(big.events.length, 200, "the input is never mutated");
});

test("cleanClientBasics keeps only allow-listed, bounded fields", () => {
  const out = cleanClientBasics({
    viewport: { w: 390, h: 844, dpr: 3.00001 },
    errors: Array.from({ length: 9 }, (_, i) => ({ message: `<b>boom ${i}</b>`, source: "x.js", at: i })),
    sentryEventId: "0123456789abcdef0123456789abcdef",
    elapsedMs: 1234,
    reducedMotion: true,
    evil: "<script>",
    __proto__: { polluted: true },
  });
  assert.deepEqual(out.viewport, { w: 390, h: 844, dpr: 3 });
  assert.equal(out.errors.length, MAX_CLIENT_ERRORS);
  assert.equal(out.errors[0].message, "boom 4");
  assert.equal(out.sentryEventId, "0123456789abcdef0123456789abcdef");
  assert.equal(out.elapsedMs, 1234);
  assert.equal(out.reducedMotion, true);
  assert.equal("evil" in out, false);
  const bad = cleanClientBasics({ viewport: { w: -1, h: 1.5, dpr: 50 }, sentryEventId: "nope", elapsedMs: -5, errors: "x" });
  assert.deepEqual(bad.viewport, { w: null, h: null, dpr: null });
  assert.equal(bad.sentryEventId, null);
  assert.equal(bad.elapsedMs, null);
  assert.deepEqual(bad.errors, []);
  assert.deepEqual(cleanClientBasics(null).errors, []);
  assert.deepEqual(cleanClientBasics([1, 2]).viewport, { w: null, h: null, dpr: null });
});
