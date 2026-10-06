import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEAD_SPACE_FAIL_PX,
  DEAD_SPACE_VIEWPORTS,
  EMPTY_BOX_MAX_PX,
  FLAT_STDDEV,
  judgeDeadSpace,
  scanDeadSpace,
  bandTextureStddev,
  auditDeadSpace,
  type DeadSpacePage,
  type DeadSpaceScan,
} from "./deadSpace";

// The page.evaluate callbacks are shipped to a browser as SOURCE. If someone
// factors a constant or helper out to module scope, the code still compiles
// and typechecks and then throws "X is not defined" inside the browser, in CI,
// on a live page. There is no DOM here to run them against (jsdom would be a
// dependency, golden rule 1d), so capture the functions and read their source.
function captureEvaluates(): { page: DeadSpacePage; fns: string[] } {
  const fns: string[] = [];
  const page: DeadSpacePage = {
    evaluate: async (fn: { toString(): string }) => {
      fns.push(fn.toString());
      return fns.length === 1 ? 1000 : 0;
    },
    screenshot: async () => ({ toString: () => "" }),
    addStyleTag: async () => undefined,
    waitForTimeout: async () => undefined,
  };
  return { page, fns };
}

test("browser-side callbacks reference no module-scope names", async () => {
  const { page, fns } = captureEvaluates();
  await scanDeadSpace(page, EMPTY_BOX_MAX_PX).catch(() => undefined);
  await bandTextureStddev(page, 0, 100).catch(() => undefined);
  await auditDeadSpace(page, { h: 844, failPx: 120 }).catch(() => undefined);
  assert.ok(fns.length >= 3, "expected the callbacks to be captured");
  const moduleNames = [
    "DEAD_SPACE_FAIL_PX",
    "DEAD_SPACE_VIEWPORTS",
    "EMPTY_BOX_MAX_PX",
    "FLAT_STDDEV",
    "judgeDeadSpace",
    "scanDeadSpace",
    "bandTextureStddev",
    "auditDeadSpace",
  ];
  for (const src of fns)
    for (const n of moduleNames)
      assert.ok(!new RegExp(`\\b${n}\\b`).test(src), `a page.evaluate callback closes over ${n}; it will not exist in the browser`);
});

const scan = (over: Partial<DeadSpaceScan>): DeadSpaceScan => ({
  gaps: [],
  decor: [],
  revealStuck: [],
  emptyBoxes: [],
  blocks: 5,
  ...over,
});
const gap = (h: number, vfill = false) => ({ kind: "between", y: 1000, h, above: "p", below: "h2", vfill });

test("a flat gap over the limit fails, one at the limit does not", async () => {
  const flat = async () => 0;
  const over = await judgeDeadSpace(scan({ gaps: [gap(DEAD_SPACE_FAIL_PX.phone + 1)] }), { scrolls: true, failPx: 120 }, flat);
  assert.equal(over.bad.length, 1);
  const at = await judgeDeadSpace(scan({ gaps: [gap(120)] }), { scrolls: true, failPx: 120 }, flat);
  assert.deepEqual(at.bad, []);
});

test("a textured band, a decor-holding gap, a vfill gap and a non-scrolling page are exempt", async () => {
  const textured = async () => FLAT_STDDEV + 1;
  assert.deepEqual((await judgeDeadSpace(scan({ gaps: [gap(300)] }), { scrolls: true, failPx: 120 }, textured)).bad, []);
  const flat = async () => 0;
  const decor = [{ kind: "svg", top: 1000, bottom: 1300 }];
  assert.deepEqual((await judgeDeadSpace(scan({ gaps: [gap(300)], decor }), { scrolls: true, failPx: 120 }, flat)).bad, []);
  assert.deepEqual((await judgeDeadSpace(scan({ gaps: [gap(300, true)] }), { scrolls: true, failPx: 120 }, flat)).bad, []);
  assert.deepEqual((await judgeDeadSpace(scan({ gaps: [gap(300)] }), { scrolls: false, failPx: 120 }, flat)).bad, []);
});

test("reveal-stuck, empty boxes and block count pass straight through", async () => {
  const r = await judgeDeadSpace(scan({ revealStuck: ["x"], emptyBoxes: ["y"], blocks: 0 }), { scrolls: true, failPx: 120 }, async () => 0);
  assert.deepEqual([r.revealStuck, r.emptyBoxes, r.blocks], [["x"], ["y"], 0]);
});

test("viewports are the phone and desktop pair the canonical tool uses", () => {
  assert.deepEqual(
    DEAD_SPACE_VIEWPORTS.map((v) => [v.w, v.h, v.failPx]),
    [[390, 844, 120], [1440, 900, 200]]
  );
});
