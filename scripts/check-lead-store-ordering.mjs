#!/usr/bin/env node
// ---------------------------------------------------------------------------
// Primary-lead-store ordering gate.
//
// WHY THIS EXISTS
// A form route typically talks to several systems: the primary contact store,
// a notification mailbox, an ESP, an analytics sink. Whichever one is written
// FIRST is the only one guaranteed to run. Everything after it is conditional
// on nothing above it ending the request.
//
// Two real incidents, same root cause, found six days apart:
//
//   1. The primary write sat below a secondary system's graceful-degrade early
//      return (`if (!res.ok) return json({ success: false }, { status: 200 })`).
//      That secondary system was misconfigured and failed on EVERY request, so
//      every signup for roughly six weeks hit the early return. The visitor saw
//      a success screen; the lead was recorded in no system at all; and because
//      the response was a 200, nothing anywhere reported a problem.
//
//   2. The primary write sat below an awaited, individually-unguarded call to a
//      notification mailbox. A provider outage would throw straight past it to
//      the handler's outer catch, so the request 500s having stored nothing —
//      even though the submission was already fully received and validated.
//
// Neither is visible in review: in both cases the primary write is RIGHT THERE
// in the handler, correctly awaited, wrapped in its own try/catch. Only its
// POSITION is wrong. That is what this gate checks, because a human reading the
// diff reliably does not.
//
// THE INVARIANT
// Nothing that can end the request early may appear above the primary write.
// A request ends early two ways: it RETURNS, or it THROWS. So above the primary
// write, this gate rejects:
//
//   * a success-shaped return  — 2xx/3xx, `ok: true`, `success: true`, redirect
//   * an unguarded `await` of a secondary system — not inside a nested
//     try/catch that closes before the primary write
//
// Validation guards are fine and are not flagged: a 4xx/5xx rejection means the
// request was refused outright, so there is no lead to lose.
//
// DELIBERATE EXCEPTIONS
// Some early returns are correct — a honeypot must return the same success
// shape a real submission gets, without recording the bot. Annotate the line
// (on it, or within the 3 lines above it):
//
//     // primary-store-ordering-ok: honeypot — bot must not learn the field name
//
// The reason text is required. An annotation with no reason is itself a
// failure: this gate exists because "it looked fine" is how both incidents
// shipped, and a bare suppression is the same claim with fewer words.
//
// CONFIG (optional) — .lead-store-ordering.json at the repo root:
//     {
//       "primary":   "bartmailOptin",        // regex: the primary-store call
//       "secondary": "sendMail|getGraphToken" // regex: systems that must not precede it
//     }
// Defaults are below. `secondary` defaults to a generic pattern covering
// mail/notification/ESP/webhook-shaped calls.
//
// Exit codes: 0 = every primary write is first, or the repo has none.
//             1 = at least one ordering violation.
//
// Usage: node check-lead-store-ordering.mjs [rootDir]   (default: cwd)
// ---------------------------------------------------------------------------

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const ROOT = process.argv[2] || process.cwd();

const DEFAULTS = {
  primary: "bartmailOptin",
  // Generic shapes for "a system that is not the primary store". Deliberately
  // matches on the CALL name, not the import path, so a locally-wrapped helper
  // (`sendNotification`) is caught as readily as a direct client call.
  // NOTE: terms here must name an ACTION on a secondary system, never a noun
  // that also appears in unrelated plumbing. A broad `\w*[Ww]ebhook\w*` was
  // tried first and matched `getWebhookSecretForBrand` — a local secret lookup
  // — in a payments handler. A gate that cries wolf on config reads is a gate
  // people learn to skim past, which costs more than the rule earns.
  secondary:
    "sendMail|sendEmail|sendNotification|notify[A-Z]\\w*|getGraphToken|" +
    "emailit\\w*|subscribeTo\\w*|writeTo[A-Z]\\w*|postTo[A-Z]\\w*|" +
    "(post|call|trigger|dispatch)[A-Z]?\\w*Webhook|slackNotify|sendSms\\w*",
};

function loadConfig() {
  const p = path.join(ROOT, ".lead-store-ordering.json");
  if (!fs.existsSync(p)) return DEFAULTS;
  try {
    return { ...DEFAULTS, ...JSON.parse(fs.readFileSync(p, "utf8")) };
  } catch (e) {
    // Fail loudly: an unreadable config must not silently downgrade to defaults
    // that might not match this repo's naming at all, reporting a clean run
    // over code the gate never actually understood.
    console.log(`::error::.lead-store-ordering.json is present but unparseable: ${e.message}`);
    process.exit(1);
  }
}

const cfg = loadConfig();
const PRIMARY = new RegExp(`\\b(${cfg.primary})\\s*\\(`);
const SECONDARY = new RegExp(`await\\s+[\\w.]*\\b(${cfg.secondary})\\s*\\(`, "i");

// A return that tells the caller "we're done, all good".
const SUCCESSY =
  /status:\s*(200|201|202|204|301|302|307|308)\b|\b(ok|success)\s*:\s*true|\.redirect\s*\(/;
// A return that refuses the request outright — no lead exists to lose.
const REJECTY = /status:\s*(4\d\d|5\d\d)\b/;

const ANNOTATION = /primary-store-ordering-ok\s*:\s*(\S.*)$/;

function trackedSourceFiles() {
  try {
    return execFileSync("git", ["-C", ROOT, "ls-files", "*.ts", "*.tsx"], {
      encoding: "utf8",
      maxBuffer: 1 << 28,
    })
      .split("\n")
      .filter(Boolean)
      .filter((f) => !/(^|\/)(node_modules|web-core|app-ui|lms)\//.test(f));
  } catch {
    console.log("::error::Not a git repository, or `git ls-files` failed — cannot determine scope.");
    process.exit(1);
  }
}

/**
 * Is line `i` annotated as a deliberate exception?
 *
 * Scans the line itself plus the whole contiguous comment block directly above
 * it. Anchoring on the comment block rather than a fixed line count means the
 * annotation can sit anywhere in the explanation the exception deserves — these
 * reasons are usually a paragraph, not a clause — while still being
 * unambiguously attached to this one statement and no other.
 */
function annotatedReason(lines, i) {
  if (ANNOTATION.test(lines[i])) return lines[i].match(ANNOTATION)[1].trim();
  let found = null;
  for (let j = i - 1; j >= 0; j--) {
    const t = lines[j].trim();
    if (t === "") continue; // blank lines inside a block comment
    if (!/^(\/\/|\/\*|\*)/.test(t)) break; // reached real code — stop
    const m = t.match(ANNOTATION);
    if (m) found = m[1].trim();
  }
  return found;
}

/**
 * Is line `i` inside a try block that closes before line `limit`?
 *
 * Brace-counting rather than parsing: the question is only "is this await's
 * failure contained before the primary write", and a nested try that opens
 * above and closes below `limit` does NOT contain it for our purposes — the
 * throw still skips the primary write. Counting `try {` against `} catch`
 * between the await and the primary write answers exactly that.
 */
function guardedBefore(lines, i, limit, from = 0) {
  let open = 0;
  for (let j = from; j < i; j++) {
    if (/\btry\s*\{/.test(lines[j])) open++;
    if (/\}\s*catch\b/.test(lines[j])) open--;
  }
  if (open <= 1) return false; // only the handler's own outer try is open
  // an inner try is open — does it close before the primary write?
  let depth = open;
  for (let j = i; j < limit; j++) {
    if (/\btry\s*\{/.test(lines[j])) depth++;
    if (/\}\s*catch\b/.test(lines[j])) {
      depth--;
      if (depth <= 1) return true;
    }
  }
  return false;
}

const findings = [];
let filesWithPrimary = 0;
let suppressions = 0;

for (const rel of trackedSourceFiles()) {
  let src;
  try {
    src = fs.readFileSync(path.join(ROOT, rel), "utf8");
  } catch {
    continue;
  }
  if (!PRIMARY.test(src)) continue;

  const lines = src.split("\n");
  const firstPrimary = lines.findIndex(
    (l) => PRIMARY.test(l) && !/^\s*(\/\/|\*)/.test(l) && !/\bimport\b|\bfunction\b/.test(l)
  );
  if (firstPrimary < 0) continue;
  filesWithPrimary++;

  // Scan only the enclosing handler, not the whole file. Helper functions
  // defined ABOVE the handler routinely contain their own awaited sends and
  // their own returns; those are not in the request path ahead of the primary
  // write, and flagging them would make the gate noise rather than signal.
  //
  // (If the primary write itself lives in a helper, `handlerStart` lands on
  // that helper and the check applies within it — the ordering question then
  // simply moves to the helper's own call site, which is the right place for
  // it anyway.)
  // Anchor on an EXPORTED boundary only. A nested `async function` helper
  // declared mid-handler is not a handler boundary, and treating it as one
  // would shrink the scanned window past the very code we care about. When no
  // export is found, fall back to the whole file — scanning too much produces a
  // finding that can be annotated, whereas scanning too little produces silence,
  // and silence is the failure mode this gate exists to remove.
  let handlerStart = 0;
  for (let j = firstPrimary; j >= 0; j--) {
    if (/\bexport\s+(async\s+function|function|const\s+\w+\s*=)/.test(lines[j])) {
      handlerStart = j;
      break;
    }
  }

  for (let i = handlerStart; i < firstPrimary; i++) {
    const line = lines[i];
    if (/^\s*(\/\/|\*)/.test(line)) continue; // comment

    const chunk = lines.slice(i, i + 3).join("\n");
    const isBadReturn = /\breturn\b/.test(line) && SUCCESSY.test(chunk) && !REJECTY.test(chunk);
    const isBadAwait = SECONDARY.test(line) && !guardedBefore(lines, i, firstPrimary, handlerStart);
    if (!isBadReturn && !isBadAwait) continue;

    const reason = annotatedReason(lines, i);
    if (reason) {
      suppressions++;
      continue;
    }
    findings.push({
      file: rel,
      line: i + 1,
      primaryLine: firstPrimary + 1,
      kind: isBadReturn ? "success-return" : "unguarded secondary call",
      text: line.trim().slice(0, 100),
    });
  }
}

if (findings.length) {
  console.log(
    "::error::Primary lead store is not written first. Move the primary write above every" +
      " early return and every unguarded third-party await in the handler, so a secondary" +
      " system failing cannot discard the lead. If an exception is genuinely correct" +
      ' (a honeypot, typically), annotate the line "// primary-store-ordering-ok: <reason>".'
  );
  for (const f of findings) {
    console.log(`  ${f.file}:${f.line}  ${f.kind} — precedes the primary write at line ${f.primaryLine}`);
    console.log(`      ${f.text}`);
  }
  process.exit(1);
}

console.log(
  `Lead-store ordering gate OK — primary write is first in all ${filesWithPrimary} route(s)` +
    ` (${suppressions} annotated exception(s)).`
);
