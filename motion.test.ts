import { test } from "node:test";
import assert from "node:assert/strict";

import {
  easeOutCubic,
  formatCount,
  initMotion,
  isInViewport,
  MAX_STAGGER_STEPS,
  parseCountTarget,
  staggerDelay,
} from "./motion";

test("staggerDelay steps linearly and caps so long lists still finish quickly", () => {
  assert.equal(staggerDelay(0, 60), 0);
  assert.equal(staggerDelay(3, 60), 180);
  assert.equal(staggerDelay(50, 60), MAX_STAGGER_STEPS * 60);
});

test("staggerDelay treats nonsense input as no delay rather than NaN ms", () => {
  assert.equal(staggerDelay(-1, 60), 0);
  assert.equal(staggerDelay(2, 0), 0);
  assert.equal(staggerDelay(Number.NaN, 60), 0);
});

test("easeOutCubic is clamped to [0, 1] and hits both ends exactly", () => {
  assert.equal(easeOutCubic(0), 0);
  assert.equal(easeOutCubic(1), 1);
  assert.equal(easeOutCubic(-5), 0);
  assert.equal(easeOutCubic(5), 1);
  assert.ok(easeOutCubic(0.5) > 0.5, "ease-out front-loads progress");
});

test("formatCount applies decimals, prefix, suffix and thousands separators", () => {
  assert.equal(formatCount(1250), "1,250");
  assert.equal(formatCount(12.345, { decimals: 1, suffix: "%" }), "12.3%");
  assert.equal(formatCount(2500, { prefix: "£", suffix: "+" }), "£2,500+");
  // Mid-animation values are rounded to the requested precision, never shown raw.
  assert.equal(formatCount(833.3333), "833");
});

test("parseCountTarget accepts separators and rejects anything non-numeric", () => {
  assert.equal(parseCountTarget("1,250"), 1250);
  assert.equal(parseCountTarget(" 15 000 "), 15000);
  assert.equal(parseCountTarget("99.5"), 99.5);
  // A typo must leave the server-rendered text alone, not count to NaN.
  assert.equal(parseCountTarget("12k"), null);
  assert.equal(parseCountTarget(""), null);
  assert.equal(parseCountTarget(null), null);
});

test("isInViewport: any overlap counts, fully above or below does not", () => {
  assert.equal(isInViewport({ top: 100, bottom: 300 }, 800), true);
  assert.equal(isInViewport({ top: -200, bottom: 10 }, 800), true);
  assert.equal(isInViewport({ top: 790, bottom: 900 }, 800), true);
  assert.equal(isInViewport({ top: 800, bottom: 900 }, 800), false);
  assert.equal(isInViewport({ top: -300, bottom: 0 }, 800), false);
});

test("initMotion no-ops outside a browser (server render, node) and returns a callable cleanup", () => {
  const cleanup = initMotion();
  assert.equal(typeof cleanup, "function");
  cleanup();
});
