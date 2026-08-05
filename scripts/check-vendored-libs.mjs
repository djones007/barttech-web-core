#!/usr/bin/env node
// ---------------------------------------------------------------------------
// Vendored third-party library audit.
//
// WHY THIS EXISTS
// `npm audit`, Dependabot and Socket all read the lockfile. A library COPIED
// into the repo — typically a `.min.js` dropped under `public/` during a
// migration off an older stack — is not in the lockfile, so all three are blind
// to it. It still ships to every visitor on every page that loads it. A CVE can
// land against that exact version and nothing anywhere will say so.
//
// This closes that gap: find vendored libraries, read their version from the
// banner comment they ship with, and ask OSV.dev whether that version has known
// advisories.
//
// THE DESIGN RULE THAT MATTERS
// A file it cannot identify is reported as UNKNOWN and fails the run — it is
// never skipped silently. A check that quietly ignores what it does not
// understand reports success while missing the thing it was written to catch,
// which is precisely the failure mode this estate has already been bitten by.
//
// Exit codes: 0 = nothing vendored, or everything vendored is clean.
//             1 = a vulnerable version, or a file that could not be identified.
//
// No API key, no auth, no data sent beyond package name + version.
// Usage: node check-vendored-libs.mjs [rootDir]   (default: cwd)
// ---------------------------------------------------------------------------

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const ROOT = process.argv[2] || process.cwd();
const OSV = "https://api.osv.dev/v1/query";

/**
 * Only files COMMITTED to the repo are in scope.
 *
 * This is the discriminator between the two kinds of minified JavaScript that
 * end up in `public/`. A vendored library is committed — that is exactly what
 * makes it invisible to the lockfile tools while still shipping to visitors,
 * and it is the thing this check exists to find. A build artifact produced at
 * deploy time is gitignored, is rebuilt from source that IS in the lockfile,
 * and is already covered by `npm audit`.
 *
 * Without this, an app's own bundled output gets reported as an unidentifiable
 * vendored library on every run — a permanently red check for a non-issue,
 * which is how a gate stops being read at all.
 */
function trackedFiles() {
  try {
    return new Set(
      execFileSync("git", ["-C", ROOT, "ls-files"], { encoding: "utf8", maxBuffer: 1 << 28 })
        .split("\n")
        .filter(Boolean)
    );
  } catch {
    return null; // not a git repo — fall back to scanning everything
  }
}
const TRACKED = trackedFiles();

/** Directories that ship to the browser verbatim. */
const SCAN_DIRS = ["public", "static", "assets", "vendor"];
const SKIP = new Set(["node_modules", ".git", ".next", "dist", "build", "coverage"]);

/**
 * Version banners as shipped by the common minified distributions, e.g.
 *   /*! jQuery v3.7.1 | (c) OpenJS Foundation ...
 *   /*! jQuery Migrate v3.4.1 | ...
 *   /*! Bootstrap v5.3.2 (https://getbootstrap.com/) ...
 *   /** @license lodash v4.17.21 ...
 * Order matters: the most explicit pattern wins.
 */
const BANNERS = [
  /\/\*![\s*]*([A-Za-z][\w .-]*?)\s+v?(\d+\.\d+\.\d+)/,
  /@license\s+([A-Za-z][\w .-]*?)\s+v?(\d+\.\d+\.\d+)/i,
  /([A-Za-z][\w.-]*?)\s+JavaScript\s+Library\s+v?(\d+\.\d+\.\d+)/i,
];

/** Display name -> npm package name, where they differ. */
const NPM_NAME = {
  "jquery migrate": "jquery-migrate",
  "jquery ui": "jquery-ui",
  bootstrap: "bootstrap",
  jquery: "jquery",
  lodash: "lodash",
  moment: "moment",
  underscore: "underscore",
  handlebars: "handlebars",
  angular: "angular",
  backbone: "backbone",
};

/**
 * Every `.js` file in a browser-served directory is a candidate. Deliberately
 * NOT filtered by filename: the first version of this check keyed off names
 * like `jquery*.js` / `*.min.js`, and missed an 829 KB vendored bundle called
 * `theme.js` — the exact file that prompted writing this. What a vendored
 * library is called tells you nothing; what is inside it does.
 */
function isCandidate(file) {
  if (!path.basename(file).toLowerCase().endsWith(".js")) return false;
  if (TRACKED && !TRACKED.has(path.relative(ROOT, file))) return false;
  return true;
}

/**
 * Minified/bundled shape, used only to decide whether an UNidentified file is
 * suspicious enough to fail on. Hand-written source in `public/` (a small
 * inline widget) is normal and should not fail the build; a 300 KB single-line
 * blob with no banner is a vendored library we cannot audit, which must.
 */
function looksBundled(file) {
  const { size } = fs.statSync(file);
  if (size < 50 * 1024) return false;
  const head = readHead(file, 8192);
  const lines = head.split("\n");
  const longest = Math.max(...lines.map((l) => l.length));
  return longest > 500;
}

function walk(dir, out = []) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (SKIP.has(e.name)) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, out);
    else if (isCandidate(full)) out.push(full);
  }
  return out;
}

/** Read only the head of a file — these bundles can be hundreds of KB. */
function readHead(file, bytes = 4096) {
  const fd = fs.openSync(file, "r");
  const buf = Buffer.alloc(bytes);
  const n = fs.readSync(fd, buf, 0, bytes, 0);
  fs.closeSync(fd);
  return buf.subarray(0, n).toString("utf8");
}

/** Identify a library from the banner comment its distribution ships with. */
function identify(file) {
  const head = readHead(file);
  for (const re of BANNERS) {
    const m = head.match(re);
    if (!m) continue;
    const display = m[1].trim().replace(/\s+/g, " ");
    const npm = NPM_NAME[display.toLowerCase()] || display.toLowerCase().replace(/\s+/g, "-");
    return { display, npm, version: m[2] };
  }
  return null;
}

async function osvQuery(name, version) {
  const res = await fetch(OSV, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ package: { name, ecosystem: "npm" }, version }),
  });
  if (!res.ok) throw new Error(`OSV HTTP ${res.status}`);
  const json = await res.json();
  return json.vulns || [];
}

const files = SCAN_DIRS.flatMap((d) => walk(path.join(ROOT, d)));
if (files.length === 0) {
  console.log("No vendored JavaScript found — nothing to audit.");
  process.exit(0);
}

let failed = false;
let identified = 0;
let skipped = 0;
console.log(
  `Scanned ${files.length} committed .js file(s) in browser-served directories.\n`
);

for (const file of files) {
  const rel = path.relative(ROOT, file);
  const id = identify(file);

  if (!id) {
    // An unidentified file that LOOKS like a bundle is a failure, not a skip —
    // see the design rule at the top. Hand-written source in these directories
    // is legitimate and stays quiet.
    if (looksBundled(file)) {
      failed = true;
      console.log(`  UNKNOWN  ${rel}`);
      console.log(`           Looks like a vendored bundle but carries no version banner,`);
      console.log(`           so it cannot be checked for advisories. Identify it and add its`);
      console.log(`           banner pattern above, or delete the file if it is dead.`);
      console.log(`           ::warning file=${rel}::Unidentified vendored bundle — cannot be audited`);
    } else {
      skipped++; // small, hand-written, no banner — this repo's own script
    }
    continue;
  }
  identified++;

  let vulns;
  try {
    vulns = await osvQuery(id.npm, id.version);
  } catch (err) {
    failed = true;
    console.log(`  ERROR    ${rel} — ${id.display} ${id.version}: ${err.message}`);
    continue;
  }

  if (vulns.length === 0) {
    console.log(`  OK       ${rel} — ${id.display} ${id.version}`);
  } else {
    failed = true;
    const ids = vulns.map((v) => v.id).join(", ");
    console.log(`  VULN     ${rel} — ${id.display} ${id.version}`);
    console.log(`           ${vulns.length} advisory(ies): ${ids}`);
    console.log(`           ::error file=${rel}::${id.display} ${id.version} has ${vulns.length} known advisory(ies): ${ids}`);
  }
}

console.log(
  `\n${identified} third-party library(ies) identified and checked; ` +
    `${skipped} file(s) treated as this repo's own source (no version banner, not bundle-shaped).`
);
console.log(
  failed
    ? "FAIL — a vendored library is vulnerable, or a bundle could not be identified."
    : identified === 0
      ? "No vendored third-party libraries found."
      : "All vendored libraries are free of known advisories."
);
process.exit(failed ? 1 : 0);
