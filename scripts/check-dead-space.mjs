#!/usr/bin/env node
// ---------------------------------------------------------------------------
// Dead-space audit gate.
//
// WHY THIS EXISTS
// Blank bands between sections (stacked section padding, an emptied reveal
// wrapper, a hidden block that still holds its height) are not a property
// anyone chooses, and no static pattern predicts them: they fall out of
// padding, content length and viewport together. So the check is a rendered
// one — `auditDeadSpace` in web-core/deadSpace walks a real page at a real
// phone and desktop viewport and fails on a gap over the threshold.
//
// WHAT THIS GATE ENFORCES
// A static check can prove the one thing a runtime test cannot prove about
// itself: that it was installed.
//
//   A repo with a UI and a tests/mobile.spec.ts must IMPORT auditDeadSpace
//   from web-core's deadSpace module and CALL it.
//
// A spec that merely names the thresholds (or retypes 120/200) is not an audit:
// it measures nothing and drifts the moment the shared numbers change. Same
// shape as check-consent-banner-size.mjs.
//
// INVARIANT
//   1. No tracked .tsx/.jsx outside tests -> no UI -> pass silently.
//   2. No tests/mobile.spec.ts            -> pass silently (the mobile-spec
//      baseline gate owns whether that file should exist).
//   3. Otherwise the spec must import auditDeadSpace from a path ending in
//      deadSpace and contain a call `auditDeadSpace(` (comments ignored).
//
// DELIBERATE EXCEPTION
// List `tests/mobile.spec.ts` in `.dead-space-baseline`, one path per line,
// `#` comments allowed, with a reason. The exception is recorded, not invisible.
//
// Usage: node check-dead-space.mjs [dir]   (dir defaults to cwd)
// ---------------------------------------------------------------------------
import { execSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.argv[2] || process.cwd();
const SPEC = "tests/mobile.spec.ts";
const BASELINE_FILE = ".dead-space-baseline";

const read = (f) => {
  try {
    return readFileSync(join(ROOT, f), "utf8");
  } catch {
    return "";
  }
};

function listFiles() {
  try {
    const out = execSync("git ls-files", { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    const files = out.split("\n").filter(Boolean);
    if (files.length) return files;
  } catch {
    /* not a git repo — walk instead */
  }
  const files = [];
  const walk = (rel) => {
    for (const e of readdirSync(join(ROOT, rel), { withFileTypes: true })) {
      if (e.name === "node_modules" || e.name === ".git") continue;
      const p = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(p);
      else files.push(p);
    }
  };
  walk("");
  return files;
}

const tracked = listFiles();

const baseline = existsSync(join(ROOT, BASELINE_FILE))
  ? read(BASELINE_FILE)
      .split("\n")
      .map((l) => l.replace(/#.*$/, "").trim())
      .filter(Boolean)
  : [];

const hasUi = tracked.some((f) => /\.(tsx|jsx)$/.test(f) && !/(^|\/)(tests?|e2e|node_modules)\//.test(f));
if (!hasUi) {
  console.log("Dead-space gate OK — no UI in this repo, nothing to gate.");
  process.exit(0);
}
if (!tracked.includes(SPEC)) {
  console.log(`Dead-space gate OK — no ${SPEC} in this repo, nothing to gate.`);
  process.exit(0);
}
if (baseline.includes(SPEC)) {
  console.log(`Dead-space gate OK — ${SPEC} is baselined in ${BASELINE_FILE}.`);
  process.exit(0);
}

// Comments removed so a commented-out call or a comment naming the function
// cannot satisfy the gate.
const src = read(SPEC)
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/(^|[^:])\/\/.*$/gm, "$1");

const imported = /import\s*(?:type\s*)?\{[^}]*\bauditDeadSpace\b[^}]*\}\s*from\s*["'][^"']*deadSpace["']/.test(src);
const withoutImports = src.replace(/import[\s\S]*?from\s*["'][^"']*["'];?/g, "");
const called = /\bauditDeadSpace\s*\(/.test(withoutImports);

const problems = [];
if (!imported) {
  problems.push(
    `${SPEC} does not import auditDeadSpace from web-core/deadSpace — a spec that names the thresholds or carries its own copy measures nothing shared and drifts.`
  );
}
if (!called) {
  problems.push(`${SPEC} never calls auditDeadSpace(page, viewport), so nothing walks the page for blank bands.`);
}

if (problems.length) {
  console.log(
    `::error::This repo has a UI but its mobile spec does not run the shared dead-space audit.` +
      ` Blank bands between sections come from stacked padding and emptied wrappers, not a chosen value,` +
      ` and only a rendered walk finds them. Import { auditDeadSpace, DEAD_SPACE_VIEWPORTS, ... } from` +
      ` "@/web-core/deadSpace" in ${SPEC}, call auditDeadSpace(page, viewport) after the page settles at each` +
      ` viewport, and fail on the result. If this repo genuinely should not be gated, list ${SPEC} in` +
      ` ${BASELINE_FILE} with a comment saying why.`
  );
  for (const p of problems) console.log(`  - ${p}`);
  process.exit(1);
}

console.log(`Dead-space gate OK — ${SPEC} imports and calls auditDeadSpace.`);
