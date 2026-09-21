#!/usr/bin/env node
// ---------------------------------------------------------------------------
// Classifier-test gate: "input classifiers are proven, not assumed."
//
// WHY THIS EXISTS
//
// A consumer site shipped a `device()` function that read `sec-ch-ua-mobile`
// and nothing else. Measured on the first day live (2026-09-12): 66 of 69
// rows came back with no device at all. Safari and
// every iOS browser send no Client Hints, and the traffic that function
// existed to classify was overwhelmingly Meta's in-app browser on iOS — so the
// one column meant to separate mobile from desktop was empty for almost
// everyone, in a live paid campaign, for a day, before anyone looked.
//
// The fix added a user-agent fallback and was proven against nine real UA
// strings before shipping. Those nine cases were run from a throwaway script
// and never committed as a test — so the exact function this gate exists to
// catch remained, itself, an unproven classifier after being fixed. That is
// the failure this gate targets directly: a classifier over untrusted input,
// with no committed proof it handles the real shapes of that input.
//
// WHY THIS IS NOT A CHECK THAT THE LOGIC IS RIGHT
//
// Same reasoning as check-consent-banner-size.mjs, which states it explicitly:
// a static pattern cannot verify behaviour, and a rule that fires on correct
// code is a rule people switch off. This gate does not read regex bodies or
// judge whether a classifier's rules are sensible — a change here would
// silently start blessing wrong logic as long as it looked test-shaped. What a
// static check CAN prove, and a passing test suite cannot prove about itself,
// is that a classifier-shaped function has a committed test file, that the
// file actually exercises the function, and that something in CI runs it.
//
// THE INVARIANT, precisely
//
//   1. A "classifier" is a function whose TypeScript return type annotation is
//      a union of 2-6 string literals (optionally including `null`/`undefined`),
//      declared in a file that is not itself a `.test.ts`, where the function
//      also takes a parameter that reads as request input: a `Headers`-typed
//      parameter, or a parameter named/typed to suggest headers, cookies, a
//      user agent or a request object. `device(headers: Headers): "mobile" |
//      "desktop" | null` is the shape this is built to catch, precisely.
//
//   2. If no classifier-shaped function exists in the repo -> pass, silently.
//      Most repos have none; a repo with none is not the failure mode.
//
//   3. Otherwise, for each one: a sibling test file must exist in the same
//      directory (`<basename>.test.ts`), must import the function by name, and
//      must contain at least MIN_CASES `test(` invocations (node:test is the
//      estate's runner - see barttech-web-core's own `*.test.ts` files).
//
//   4. That test file's basename must appear in package.json's `test` script,
//      or in a `.github/workflows/*.yml` file — a test nothing runs is a
//      comment, not a proof, same closing condition as the banner gate.
//
// DELIBERATE EXCEPTION
//
// A function that is a false positive (e.g. an enum-shaped return that has
// nothing to do with untrusted input) or is genuinely trivial enough not to
// need a case table lists as `path/to/file.ts:functionName` in
// `.classifier-baseline`, one per line, `#` comments allowed — same ratchet as
// `.web-core-baseline` and `.consent-banner-baseline`. The exception is
// recorded, never invisible. `--baseline` writes every currently-failing
// match into that file in one step, for adopting the gate in an existing repo
// without a blocking backlog.
// ---------------------------------------------------------------------------

import { execSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const BASELINE_FILE = ".classifier-baseline";
const MIN_CASES = 4;

/**
 * Defense-in-depth: every path reaching this function comes from this
 * script's own `git ls-files` listing of repoRoot — never external input —
 * but static analysis cannot see that, and the check is cheap. Refuses to
 * read outside repoRoot regardless of how the path was built. Same idiom as
 * check-post-submit-notice.mjs's readWithinRoot.
 */
function readWithinRoot(repoRoot, target) {
  const base = path.resolve(repoRoot) + path.sep;
  const resolved = path.resolve(repoRoot, target);
  if (!resolved.startsWith(base)) {
    throw new Error(`refusing to read outside repo root: ${target}`);
  }
  return readFileSync(resolved, "utf8");
}

const REQUEST_LIKE_TYPE = /\b(Headers|NextRequest|IncomingMessage)\b/;
const REQUEST_LIKE_NAME = /\b(headers?|hdrs|req|request|cookies?|ua|useragent|user_?agent)\b/i;

/** function name(params): "a" | "b" | null { ... }  — captures name, full param list, return union. */
const FUNCTION_DECL = /(?:export\s+)?function\s+(\w+)\s*\(([^)]*)\)\s*:\s*((?:"[^"]+"|'[^']+')(?:\s*\|\s*(?:"[^"]+"|'[^']+'|null|undefined)){1,5})\s*[{;]/g;

function findClassifiers(source) {
  const hits = [];
  let m;
  FUNCTION_DECL.lastIndex = 0;
  while ((m = FUNCTION_DECL.exec(source))) {
    const [, name, params] = m;
    if (REQUEST_LIKE_TYPE.test(params) || REQUEST_LIKE_NAME.test(params)) {
      hits.push(name);
    }
  }
  return hits;
}

function readBaseline(repoRoot) {
  const p = path.join(repoRoot, BASELINE_FILE);
  if (!existsSync(p)) return new Set();
  return new Set(
    readFileSync(p, "utf8")
      .split("\n")
      .map((l) => l.split("#")[0].trim())
      .filter(Boolean)
  );
}

function checkRepo(repoRoot, { write = false } = {}) {
  const tracked = execSync("git ls-files", { cwd: repoRoot, encoding: "utf8" })
    .split("\n")
    .filter(Boolean)
    .filter((f) => /\.tsx?$/.test(f) && !f.endsWith(".test.ts") && !f.endsWith(".d.ts"));

  const baseline = write ? new Set() : readBaseline(repoRoot);
  const pkgPath = path.join(repoRoot, "package.json");
  const pkg = existsSync(pkgPath) ? readFileSync(pkgPath, "utf8") : "";
  const testScript = (() => {
    try {
      return JSON.parse(pkg).scripts?.test || "";
    } catch {
      return "";
    }
  })();

  const violations = [];
  const found = [];

  for (const file of tracked) {
    const abs = path.join(repoRoot, file);
    if (!existsSync(abs)) continue;
    const source = readWithinRoot(repoRoot, file);
    const names = findClassifiers(source);
    if (!names.length) continue;

    for (const name of names) {
      found.push(`${file}:${name}`);
      if (baseline.has(`${file}:${name}`)) continue;

      const dir = path.dirname(file);
      const base = path.basename(file, path.extname(file));
      const testFile = path.join(dir, `${base}.test.ts`);
      const testAbs = path.join(repoRoot, testFile);

      if (!existsSync(testAbs)) {
        violations.push(`${file}:${name} — no ${testFile}`);
        continue;
      }

      const testSource = readWithinRoot(repoRoot, testFile);
      if (!new RegExp(`\\b${name}\\b`).test(testSource)) {
        violations.push(`${file}:${name} — ${testFile} exists but never references ${name}`);
        continue;
      }

      const caseCount = (testSource.match(/\btest\s*\(/g) || []).length;
      if (caseCount < MIN_CASES) {
        violations.push(
          `${file}:${name} — ${testFile} has ${caseCount} test( case(s), need >= ${MIN_CASES}`
        );
        continue;
      }

      const wired =
        testScript.includes(base) ||
        (existsSync(path.join(repoRoot, ".github/workflows")) &&
          execSync("git ls-files .github/workflows", { cwd: repoRoot, encoding: "utf8" })
            .split("\n")
            .filter(Boolean)
            .some((wf) => readFileSync(path.join(repoRoot, wf), "utf8").includes(base)));

      if (!wired) {
        violations.push(
          `${file}:${name} — ${testFile} exists but nothing in package.json's test script or .github/workflows runs it`
        );
      }
    }
  }

  if (write) {
    writeFileSync(
      path.join(repoRoot, BASELINE_FILE),
      "# Classifier-test gate exceptions — one path:functionName per line, # comments allowed.\n" +
        "# Written by --baseline. Remove a line once that classifier is actually tested.\n" +
        found.map((f) => `${f}\n`).join("")
    );
  }

  return { violations, found };
}

// ---------------------------------------------------------------------------

function selfTest() {
  const dir = mkdtempSync(path.join(tmpdir(), "classifier-gate-"));
  try {
    execSync("git init -q", { cwd: dir });

    // BAD: exactly the shape of the real bug — a classifier over Headers with
    // no test file at all.
    writeFileSync(
      path.join(dir, "bad.ts"),
      `export function device(headers: Headers): "mobile" | "desktop" | null {\n  return null;\n}\n`
    );

    // GOOD: same shape, but with a proper committed test file, referenced by
    // name, four real cases, and wired into package.json.
    writeFileSync(
      path.join(dir, "good.ts"),
      `export function device(headers: Headers): "mobile" | "desktop" | null {\n  return null;\n}\n`
    );
    writeFileSync(
      path.join(dir, "good.test.ts"),
      [
        `import { test } from "node:test";`,
        `import assert from "node:assert/strict";`,
        `import { device } from "./good";`,
        `test("case 1", () => { assert.equal(device(new Headers()), null); });`,
        `test("case 2", () => { assert.equal(device(new Headers()), null); });`,
        `test("case 3", () => { assert.equal(device(new Headers()), null); });`,
        `test("case 4", () => { assert.equal(device(new Headers()), null); });`,
        ``,
      ].join("\n")
    );

    // NEGATIVE CONTROL: a function that takes Headers but returns a boolean,
    // not a literal union — must never be flagged (this is isAutomatedRequest's
    // real shape, and it must stay untouched by this gate).
    writeFileSync(
      path.join(dir, "not-a-classifier.ts"),
      `export function isAutomated(headers: Headers): boolean {\n  return false;\n}\n`
    );

    writeFileSync(
      path.join(dir, "package.json"),
      JSON.stringify({ scripts: { test: "node --test good.test.ts" } })
    );

    execSync("git add -A", { cwd: dir });

    const { violations, found } = checkRepo(dir);

    const cases = [
      ["found exactly the two real classifiers, not the boolean one",
        found.length === 2 && found.includes("bad.ts:device") && found.includes("good.ts:device")],
      ["fired on the untested classifier (bad.ts)",
        violations.some((v) => v.startsWith("bad.ts:device"))],
      ["stayed silent on the fully-proven classifier (good.ts)",
        !violations.some((v) => v.startsWith("good.ts:device"))],
      ["did not touch the boolean-returning function at all",
        !violations.some((v) => v.includes("not-a-classifier"))],
    ];

    let failed = 0;
    for (const [name, ok] of cases) {
      if (!ok) failed++;
      console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
    }
    console.log(`\n${cases.length - failed}/${cases.length} passed`);
    process.exit(failed ? 1 : 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
if (args.includes("--self-test")) {
  selfTest();
} else {
  const repoRoot = args.find((a) => !a.startsWith("--")) || process.cwd();
  const { violations } = checkRepo(repoRoot, { write: args.includes("--baseline") });
  if (args.includes("--baseline")) {
    console.log(`Wrote ${BASELINE_FILE}.`);
    process.exit(0);
  }
  if (violations.length) {
    console.error("Classifier-test gate: unproven classifier(s) found.\n");
    for (const v of violations) console.error(`  ✗ ${v}`);
    console.error(
      "\nA classifier over untrusted input needs a committed <name>.test.ts with >= " +
        MIN_CASES +
        " real-shaped cases, wired into the test script or CI. If this is a genuine exception, add it to " +
        BASELINE_FILE +
        "."
    );
    process.exit(1);
  }
  console.log("Classifier-test gate: clean.");
}
