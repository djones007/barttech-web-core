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
// Exit codes: 0 = every primary write is first, or the repo has no lead routes (said out loud).
//             1 = at least one ordering violation, or lead routes exist and none was checked.
//
// Usage: node check-lead-store-ordering.mjs [rootDir]   (default: cwd)
// ---------------------------------------------------------------------------

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const ROOT = process.argv[2] || process.cwd();

/**
 * Defense-in-depth: `rel` is always enumerated from `git ls-files`, never
 * external input, but static analysis cannot see that, and the check is
 * cheap. Refuses to read outside ROOT regardless of how `rel` was built.
 */
function readWithinRoot(root, rel) {
  const base = path.resolve(root) + path.sep;
  const target = path.resolve(root, rel);
  if (!target.startsWith(base)) {
    throw new Error(`refusing to read outside repo root: ${rel}`);
  }
  return fs.readFileSync(target, "utf8");
}

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
const SECONDARY = new RegExp(`await\\s+[\\w.]*\\b(${cfg.secondary})\\s*\\(`, "i");

// A return that tells the caller "we're done, all good".
const SUCCESSY =
  /status:\s*(200|201|202|204|301|302|307|308)\b|\b(ok|success|received|saved|submitted|subscribed|done)\s*:\s*true|\.redirect\s*\(/;
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
const unreadable = [];
let filesWithPrimary = 0;
let suppressions = 0;

// Read every tracked file ONCE. A file that cannot be read is a finding, never a silent skip:
// a gate that swallows its own read error reports a clean run over code it never saw.
const SOURCES = new Map();
for (const rel of trackedSourceFiles()) {
  try {
    SOURCES.set(rel, readWithinRoot(ROOT, rel));
  } catch (e) {
    unreadable.push(`${rel}: ${e.message}`);
  }
}

// HELPER-WRAPPED WRITES. A route that calls `captureLead(...)`, which calls the primary store, used
// to escape this gate: the route has no direct primary call, and the helper's own file was checked
// only within the helper. So any function that directly calls the primary (found by scanning the
// enclosing function of each primary call) is itself treated as a primary write at its call sites,
// repeated up to 4 rounds so a wrapper of a wrapper is caught. Only EXPORTED, lower-camel-case names
// of 5+ characters count (a generic inner closure such as `once` or `ask` cascaded into hundreds of
// false wrappers when tried on a real repo; React components are not wrappers). Handler verbs and
// `default` are never wrappers. Extra names can be declared in .lead-store-ordering.json as "primaryWrappers": ["name"].
const HANDLER_VERBS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS", "default"]);
const ENCLOSING_FN = /^\s*export\s+(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)|^\s*export\s+const\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:async\s*)?(?:function\b|\(|[A-Za-z_$][\w$]*\s*=>)/;
// `function bartmailOptin(` DEFINES the name; it is not a call. Only that exact shape is excluded, so a
// one-line helper (`function store() { return await bartmailOptin(...) }`) still counts as a call.
function isDefinitionOf(line, re) {
  const m = line.match(re);
  return !!m && new RegExp(`\\bfunction\\s*\\*?\\s*${m[1]}\\s*\\(`).test(line);
}
const ANY_FN = /^\s*(?:async\s+)?function\b|^\s*const\s+[A-Za-z_$][\w$]*\s*(?::[^=]+)?=\s*(?:async\s*)?(?:function\b|\(|[A-Za-z_$][\w$]*\s*=>)/;
const HANDLER_FILE = /\bexport\s+(?:async\s+)?function\s+(?:GET|POST|PUT|PATCH|DELETE)\b|\bexport\s+const\s+(?:GET|POST|PUT|PATCH|DELETE)\s*=/;
const TOP_LEVEL_FN = /^(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)|^const\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:async\s*)?(?:function\b|\(|[A-Za-z_$][\w$]*\s*=>)/;
const wrapperNames = new Set(Array.isArray(cfg.primaryWrappers) ? cfg.primaryWrappers : []); // exported: estate-wide
const localWrappers = new Map(); // rel -> Set of top-level, non-exported helpers, scoped to that file only
const validName = (n) => n && n.length >= 5 && !/^[A-Z]/.test(n) && !HANDLER_VERBS.has(n) && n !== cfg.primary;
const nameRe = (rel) => new RegExp(`\\b(${[cfg.primary, ...wrapperNames, ...(localWrappers.get(rel) || [])].join("|")})\\s*\\(`);
for (let round = 0; round < 4; round++) {
  let added = 0;
  for (const [rel, src] of SOURCES) {
    if (/\.test\.|\.spec\./.test(rel)) continue;
    const re = nameRe(rel);
    if (!re.test(src)) continue;
    const handlerFile = HANDLER_FILE.test(src);
    const lines = src.split("\n");
    lines.forEach((l, i) => {
      if (!re.test(l) || /^\s*(\/\/|\*)/.test(l) || /\bimport\b/.test(l) || isDefinitionOf(l, re)) return;
      for (let j = i; j >= 0; j--) {
        const ex = lines[j].match(ENCLOSING_FN);
        if (ex) {
          const name = ex[1] || ex[2];
          if (validName(name) && !wrapperNames.has(name)) { wrapperNames.add(name); added++; }
          break;
        }
        if (ANY_FN.test(lines[j])) {
          // innermost function is not exported: it only counts when it is a top-level helper in a
          // file that defines an HTTP handler, and then only for call sites in that same file.
          const tl = handlerFile && lines[j].match(TOP_LEVEL_FN);
          const name = tl && (tl[1] || tl[2]);
          if (validName(name) && !wrapperNames.has(name)) {
            const set = localWrappers.get(rel) || new Set();
            if (!set.has(name)) { set.add(name); localWrappers.set(rel, set); added++; }
          }
          break;
        }
      }
    });
  }
  if (!added) break;
}
const alt = (rel) => [cfg.primary, ...wrapperNames, ...(localWrappers.get(rel) || [])].join("|");

for (const [rel, src] of SOURCES) {
  if (/\.test\.|\.spec\./.test(rel)) continue;
  const PRIMARY = nameRe(rel);
  if (!PRIMARY.test(src)) continue;
  const PRIMARY_CALL_AT_LINE_START = new RegExp(`^\\s*(void\\s+)?[\\w.]*\\b(${alt(rel)})\\s*\\(`);

  const lines = src.split("\n");
  // Prefer the first primary call INSIDE the exported HTTP handler (so a helper defined above it
  // that happens to call the primary is not mistaken for the handler's write); fall back to the
  // first call anywhere in the file when there is no handler.
  const handlerIdx = lines.findIndex((l) => HANDLER_FILE.test(l));
  const isCall = (l) => PRIMARY.test(l) && !/^\s*(\/\/|\*)/.test(l) && !/\bimport\b/.test(l) && !isDefinitionOf(l, PRIMARY);
  let firstPrimary = -1;
  if (handlerIdx >= 0) {
    for (let k = handlerIdx; k < lines.length; k++) {
      if (isCall(lines[k])) { firstPrimary = k; break; }
    }
  }
  if (firstPrimary < 0) firstPrimary = lines.findIndex(isCall);
  if (firstPrimary < 0) continue;
  filesWithPrimary++;

  // The primary write must be AWAITED (standard §20). A bare `bartmailOptin(...)` statement, or
  // `void bartmailOptin(...)`, fire-and-forgets it: the handler returns success and the serverless
  // instance can freeze before the write lands, so the lead is lost with a clean-looking response.
  const bareLine = lines[firstPrimary];
  if (PRIMARY_CALL_AT_LINE_START.test(bareLine) && !annotatedReason(lines, firstPrimary)) {
    findings.push({
      file: rel,
      line: firstPrimary + 1,
      primaryLine: firstPrimary + 1,
      kind: "primary write is not awaited",
      text: bareLine.trim().slice(0, 100),
    });
  }

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

if (unreadable.length) {
  console.log(`::error::Lead-store ordering gate could not read ${unreadable.length} tracked file(s); a gate that skips what it cannot read reports a clean run over code it never saw:`);
  for (const u of unreadable.slice(0, 10)) console.log(`  ${u}`);
  process.exit(1);
}

if (findings.length) {
  console.log(
    "::error::Primary lead store is not written first. Move the primary write above every" +
      " early return and every unguarded third-party await in the handler, so a secondary" +
      " system failing cannot discard the lead. If an exception is genuinely correct" +
      ' (a honeypot, typically), annotate the line "// primary-store-ordering-ok: <reason>".'
  );
  for (const f of findings) {
    console.log(`  ${f.file}:${f.line}  ${f.kind}${f.kind === "primary write is not awaited" ? "" : ` — precedes the primary write at line ${f.primaryLine}`}`);
    console.log(`      ${f.text}`);
  }
  process.exit(1);
}

// ZERO CHECKED IS NOT A PASS (estate issue b4bd94c4). This gate used to report
// "OK" over a repo where it had matched no primary write at all, which is what
// a renamed primary function, a moved app directory or a wrong `primary` regex
// all look like. A route whose PATH says it captures a lead (optin, subscribe,
// signup, contact, enquiry, waitlist, newsletter, lead, register) that never
// calls the primary store means the gate read nothing it was meant to read.
// Fail, unless the repo says so in .lead-store-ordering.json:
//     { "allowNoPrimary": true }   // lead routes legitimately use another store
if (cfg.allowNoPrimary !== true) {
  const LEAD_PATH = /(^|\/)(opt-?in|subscribe|sign-?up|contact|enquir\w*|inquir\w*|waitlist|newsletter|leads?|register)(\/|-|\.|$)[^]*route\.(ts|js|tsx|mjs)$/i;
  const leadRoutes = trackedSourceFiles().filter((f) => LEAD_PATH.test(f) && !/\.test\./.test(f));
  if (leadRoutes.length && filesWithPrimary === 0) {
    console.log(
      `::error::Lead-store ordering gate checked NOTHING: ${leadRoutes.length} lead-capture route(s) ` +
        `(${leadRoutes.slice(0, 3).join(", ")}${leadRoutes.length > 3 ? ", ..." : ""}) but none calls the primary store ` +
        `/${cfg.primary}/ (or a wrapper of it). Set "primary" in .lead-store-ordering.json to the real call name, or ` +
        `"allowNoPrimary": true if these routes legitimately write elsewhere.`
    );
    process.exit(1);
  }
}
if (filesWithPrimary === 0) {
  console.log("Lead-store ordering gate: NOT APPLICABLE - no route calls the primary store (" + cfg.primary + ")" + (cfg.allowNoPrimary === true ? ' (opted out via "allowNoPrimary")' : ", and no lead-capture route paths were found") + ". Nothing was checked.");
  process.exit(0);
}

console.log(
  `Lead-store ordering gate OK — primary write is first in all ${filesWithPrimary} route(s)` +
    ` (${suppressions} annotated exception(s)).`
);
