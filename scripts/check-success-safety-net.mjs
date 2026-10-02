#!/usr/bin/env node
// ---------------------------------------------------------------------------
// Success-page safety-net gate.
//
// WHY THIS EXISTS
// A delivery email can be blocked (a hard bounce, a spam complaint) or sent to a typo, and the
// provider answers 200 and silently drops it. The buyer has paid and has nothing. So a page that
// confirms a payment must also show everything the email would have said (the order ref, a code or
// link where the product has one, how to reach support) and the buyer's own-address check. That is
// the shared safety net (`safetyNet.ts` for the content, a per-repo `SafetyNet` component for the
// page). A success page built without it is the gap this gate closes, the same shape as
// check-post-submit-notice.mjs: a screen that tells the buyer "we've emailed you" and renders no
// safety net.
//
// THE INVARIANT
// A `.tsx`/`.jsx` file under a directory named success / thank-you / thankyou / order-complete /
// confirmation (or whose own name says so) that shows payment-confirmed copy must have the safety
// net rendered somewhere in the same success directory: an import of `.../SafetyNet` or
// `.../web-core/safetyNet`, or `<SafetyNet`. A thin server `page.tsx` that renders a sibling client
// component which renders the net passes (the check is per success directory, not per file).
//
// DELIBERATE EXCEPTIONS
// A page that is not a purchase confirmation (an optin thank-you, a booking page), or a repo whose
// payment is taken somewhere that can not render it: annotate the file
//
//     // safety-net-ok: <reason>
//
// or list the path in `.safety-net-baseline` (repo root), one path per line with a mandatory
// `# reason`. A waiver with no reason is not honoured.
//
// Exit codes: 0 = clean (or the repo has no success page). 1 = a selling success page without it.
// Usage: node check-success-safety-net.mjs [rootDir]   (default: cwd)
// ---------------------------------------------------------------------------

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";

const ROOT = resolve(process.argv[2] || process.cwd());

const SKIP_DIRS = new Set(["node_modules", ".next", ".git", "dist", "build", ".vercel", ".turbo", "coverage", ".testbuild", "out", ".output", "storybook-static", "public", "test", "tests", "__tests__", "e2e"]);
const SKIP_PATH = /(^|\/)(web-core|app-ui|lms)(\/|$)/;
const EXT = /\.(tsx|jsx)$/;
const TEST_FILE = /\.test\.(tsx|jsx)$/;

// A success directory, or a file named for one (SuccessClient.tsx, ThankYou.tsx).
const SUCCESS_SEGMENT = /(^|\/)(success|thank-?you|thankyou|order-?complete|order-?confirmed?|confirmation)(\/|$)/i;
const SUCCESS_FILE = /(^|\/)[^/]*(success|thank-?you|thankyou|order-?complete|order-?confirmed?)[^/]*\.(tsx|jsx)$/i;

// Evidence the page confirms a PAYMENT (not an optin or a booking).
const SELLING = /payment[_ ]?intent|payment (complete|received|confirmed)|order (complete|confirmed|received)|your (order|purchase|receipt)|you(?:'|’)?re all set|thanks? for (your )?(order|purchase|buying)/i;

const RENDERS_NET = [/from\s+["'][^"']*\/web-core\/safetyNet["']/, /from\s+["'][^"']*\/SafetyNet["']/, /<SafetyNet\b/];
const ANNOTATION = /safety-net-ok[ \t]*:[ \t]*(\S.*)/;
const COMMENT_CLOSER = /\*\/\s*\}?\s*$/;

function readWithinRoot(target) {
  const full = resolve(ROOT, target);
  if (!full.startsWith(ROOT + sep)) throw new Error(`refusing to read outside repo root: ${target}`);
  return readFileSync(full, "utf8");
}

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (name.startsWith(".") || SKIP_DIRS.has(name)) continue;
    const full = join(dir, name);
    const rel = relative(ROOT, full).split(sep).join("/");
    if (SKIP_PATH.test(rel)) continue;
    const st = statSync(full);
    if (st.isDirectory()) walk(full, out);
    else if (EXT.test(name) && !TEST_FILE.test(name)) out.push(rel);
  }
  return out;
}

function loadBaseline() {
  const p = join(ROOT, ".safety-net-baseline");
  const map = new Map();
  if (!existsSync(p)) return map;
  for (const raw of readFileSync(p, "utf8").split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const i = line.indexOf("#");
    const path = (i === -1 ? line : line.slice(0, i)).trim();
    const reason = i === -1 ? "" : line.slice(i + 1).trim();
    if (path) map.set(path, reason || null);
  }
  return map;
}

function waived(src) {
  const m = src.match(ANNOTATION);
  if (!m) return false;
  return m[1].trim().replace(COMMENT_CLOSER, "").trim().length > 0;
}

/** The success directory a file belongs to: the nearest ancestor segment that names one, else the file's own dir. */
function successDir(rel) {
  const parts = rel.split("/");
  for (let i = parts.length - 2; i >= 0; i--) if (SUCCESS_SEGMENT.test(`${parts[i]}/`) || SUCCESS_SEGMENT.test(`/${parts[i]}`)) return parts.slice(0, i + 1).join("/");
  return dirname(rel);
}

const baseline = loadBaseline();
const files = walk(ROOT);
const candidates = files.filter((rel) => SUCCESS_SEGMENT.test(rel) || SUCCESS_FILE.test(rel));

// Per success directory: does any file in it render the net?
const dirHasNet = new Map();
for (const rel of candidates) {
  const dir = successDir(rel);
  if (dirHasNet.get(dir)) continue;
  let src = "";
  try { src = readWithinRoot(rel); } catch { continue; }
  if (RENDERS_NET.some((re) => re.test(src))) dirHasNet.set(dir, true);
  else if (!dirHasNet.has(dir)) dirHasNet.set(dir, false);
}

const findings = [];
let checked = 0;
let waivedCount = 0;
for (const rel of candidates) {
  let src = "";
  try { src = readWithinRoot(rel); } catch { continue; }
  if (!SELLING.test(src)) continue;
  checked++;
  if (dirHasNet.get(successDir(rel))) continue;
  if (waived(src)) { waivedCount++; continue; }
  if (baseline.has(rel)) {
    if (baseline.get(rel)) { waivedCount++; continue; }
    findings.push({ file: rel, why: "listed in .safety-net-baseline with no `# reason`" });
    continue;
  }
  findings.push({ file: rel, why: "confirms a payment but renders no SafetyNet" });
}

if (findings.length) {
  console.error("Success-page safety-net gate FAILED:");
  for (const f of findings) console.error(`  ${f.file}: ${f.why}`);
  console.error("\nA success page must render the shared SafetyNet block (order ref, code/link, support, own-address check),");
  console.error("or carry `// safety-net-ok: <reason>` if it is not a purchase confirmation. See scripts/CLAUDE.md.");
  process.exit(1);
}
console.log(`Success-page safety-net gate passed (${checked} selling success file(s) checked, ${waivedCount} waived).`);
