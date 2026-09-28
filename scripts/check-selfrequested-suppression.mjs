#!/usr/bin/env node
// ---------------------------------------------------------------------------
// Self-requested transactional send must clear the soft-fail suppression gate.
//
// WHY THIS EXISTS
// `clearSelfRequestedSoftFailSuppression()` (emailit.ts) exists so a SELF-
// REQUESTED transactional send (a receipt, sign-in code, sign-up
// confirmation, password reset, magic link) clears a soft-fail suppression on
// that exact address before sending — otherwise it is silently dropped for
// every address a prior bounce soft-suppressed (~6,300 Microsoft addresses
// estate-wide at last count). The established pattern (a consumer's own
// `lib/email.ts` plus an auth-mail route) is a single low-level `sendEmail()`
// wrapper that calls the raw `sendEmailitEmail()` transport, takes an
// OPTIONAL `selfRequested` argument, and clears suppression only when that
// argument is passed. The rule "a new self-requested send path must pass
// `selfRequested`" is documented (template, website-build, brand-email,
// project_nutty_orange_ms_deliverability) but nothing enforced it.
//
// TWO THINGS THIS GATE CHECKS
//
//   A) A call to the raw transport directly (`sendEmailitEmail(`) whose
//      nearby context looks self-requested (same keyword+capture logic as B)
//      must have `clearSelfRequestedSoftFailSuppression` referenced
//      SOMEWHERE in the file. If it doesn't, that call site is sending a
//      receipt/sign-in/confirm-shaped email with no suppression-clearing
//      mechanism reachable at all. Deliberately does NOT fire on a transport
//      call with no self-requested-looking neighbour — a repo whose direct
//      transport use is purely marketing/ops mail has nothing to clear and a
//      gate that fires anyway teaches people to ignore it.
//
//   B) Every OTHER call site of the repo's send wrapper (default name
//      `sendEmail`) whose call expression or its subject/body text — matched
//      in a narrow window around the call, not the whole file, to avoid
//      matching unrelated prose elsewhere in the file — names a self-
//      requested send shape (sign-in code, OTP, magic link, confirm/verify
//      signup, password reset, receipt) must pass `selfRequested` as an
//      argument to that call.
//
// This is heuristic by nature — classifying "was this send self-requested"
// is a judgement call the author already made — so it only fires on an
// unambiguous keyword match near the call, and can be silenced with a reason.
//
// DELIBERATE EXCEPTIONS
// A send that LOOKS self-requested but is not (an ops/admin test send, a
// resend triggered by an admin rather than the recipient) — annotate the
// line (on it, or within 3 lines above it):
//
//     // selfrequested-suppression-ok: admin/ops test send, not the customer's own request
//
// The reason text is required.
//
// CONFIG (optional) — .selfrequested-suppression.json at the repo root:
//     {
//       "transportCall": "sendEmailitEmail",
//       "wrapperCall":   "sendEmail",
//       "clearCall":     "clearSelfRequestedSoftFailSuppression",
//       "selfRequestedArg": "selfRequested",
//       "keywords": ["sign-?in", "signup", "sign-?up", "otp", "magic-?link",
//                     "confirm", "verify", "password-?reset", "reset-?password",
//                     "receipt", "order-?confirm"],
//       "windowLines": 8
//     }
//
// Exit codes: 0 = the transport wrapper supports clearing AND every
//                 self-requested-looking call site passes selfRequested, or
//                 the repo has neither.
//             1 = at least one violation.
//
// Usage: node check-selfrequested-suppression.mjs [rootDir]   (default: cwd)
// ---------------------------------------------------------------------------

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const ROOT = process.argv[2] || process.cwd();

function readWithinRoot(root, rel) {
  const base = path.resolve(root) + path.sep;
  const target = path.resolve(root, rel);
  if (!target.startsWith(base)) {
    throw new Error(`refusing to read outside repo root: ${rel}`);
  }
  return fs.readFileSync(target, "utf8");
}

const DEFAULTS = {
  transportCall: "sendEmailitEmail",
  wrapperCall: "sendEmail",
  clearCall: "clearSelfRequestedSoftFailSuppression",
  selfRequestedArg: "selfRequested",
  keywords: [
    "sign-?in",
    "signup",
    "sign-?up",
    "otp",
    "one-?time-?(?:code|password)",
    "magic-?link",
    "confirm",
    "verify",
    "verification",
    "password-?reset",
    "reset-?password",
    "receipt",
    "order-?confirm",
    "auth-?mail",
  ],
  windowLines: 8,
};

function loadConfig(root) {
  const p = path.join(root, ".selfrequested-suppression.json");
  if (!fs.existsSync(p)) return DEFAULTS;
  try {
    const user = JSON.parse(fs.readFileSync(p, "utf8"));
    return { ...DEFAULTS, ...user };
  } catch (err) {
    console.error(`WARNING: could not parse ${p}: ${err.message}. Using defaults.`);
    return DEFAULTS;
  }
}

function gitFiles(root) {
  try {
    const out = execFileSync("git", ["-C", root, "ls-files", "*.ts", "*.tsx", "*.js", "*.mjs"], {
      encoding: "utf8",
    });
    return out.split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

function hasExceptionComment(lines, idx, windowBefore = 3) {
  for (let i = Math.max(0, idx - windowBefore); i <= idx; i++) {
    if (/selfrequested-suppression-ok:\s*\S/.test(lines[i] ?? "")) return true;
  }
  return false;
}

/**
 * Capture the full call expression starting at `callRe`'s match on `lines[idx]`,
 * by paren-balancing rather than a fixed line window — a real call site
 * (`sendEmail(brand, {...multi-line object...}, { selfRequested }))`) routinely
 * runs well past a handful of lines, and a window that ends early reads a
 * correctly-guarded call as unguarded because the guard sits one line past
 * the cutoff. Returns the captured text plus `windowLines` of context above
 * (the keyword often sits in a comment or subject string just before the call
 * is built, not inside the call itself).
 */
function captureCallWindow(lines, idx, callRe, windowLines) {
  const line = lines[idx];
  const callStart = line.search(callRe);
  let depth = 0;
  let started = false;
  let capture = "";
  outer: for (let i = idx; i < Math.min(lines.length, idx + 200); i++) {
    const segment = i === idx ? lines[i].slice(callStart) : lines[i];
    capture += segment + "\n";
    for (const ch of segment) {
      if (ch === "(") {
        depth++;
        started = true;
      } else if (ch === ")") {
        depth--;
        if (started && depth <= 0) break outer;
      }
    }
  }
  const contextAbove = lines.slice(Math.max(0, idx - windowLines), idx).join("\n");
  return contextAbove + "\n" + capture;
}

function main() {
  const cfg = loadConfig(ROOT);
  const transportRe = new RegExp(`\\b${cfg.transportCall}\\s*\\(`);
  const wrapperCallRe = new RegExp(`\\b${cfg.wrapperCall}\\s*\\(`);
  const clearRe = new RegExp(cfg.clearCall);
  const selfArgRe = new RegExp(`\\b${cfg.selfRequestedArg}\\b\\s*:`);
  const keywordRe = new RegExp(cfg.keywords.join("|"), "i");
  const declRe = new RegExp(
    `\\b(?:function|const|let|var)\\s+${cfg.wrapperCall}\\s*[=(]|export\\s+(?:async\\s+)?function\\s+${cfg.wrapperCall}\\b`
  );

  const files = gitFiles(ROOT).filter(
    (f) =>
      !f.includes("web-core/") &&
      !f.includes("node_modules/") &&
      !f.endsWith(".test.ts") &&
      !f.endsWith(".test.mjs")
  );

  const violations = [];

  for (const rel of files) {
    let text;
    try {
      text = readWithinRoot(ROOT, rel);
    } catch {
      continue;
    }
    const lines = text.split("\n");
    const fileHasClear = clearRe.test(text);

    // --- Check A: a self-requested-looking DIRECT transport call must have
    //     the clear-call reachable somewhere in the file. ---
    if (transportRe.test(text)) {
      lines.forEach((line, idx) => {
        if (!transportRe.test(line)) return;
        if (hasExceptionComment(lines, idx)) return;
        const window = captureCallWindow(lines, idx, transportRe, cfg.windowLines);
        if (!keywordRe.test(window)) return; // not self-requested-looking — fine either way
        if (fileHasClear) return; // mechanism is reachable in this file
        violations.push({
          file: rel,
          line: idx + 1,
          snippet: line.trim().slice(0, 120),
          reason: `looks self-requested (sign-in/confirm/verify/receipt/etc. nearby) but calls ${cfg.transportCall}() directly with no ${cfg.clearCall} reachable in this file`,
        });
      });
    }

    // --- Check B: call sites of the wrapper must pass selfRequested when the
    //     call looks like a self-requested send ---
    if (!wrapperCallRe.test(text)) continue;

    lines.forEach((line, idx) => {
      if (!wrapperCallRe.test(line)) return;
      if (declRe.test(line)) return; // the wrapper's own definition, not a call site
      if (hasExceptionComment(lines, idx)) return;

      const window = captureCallWindow(lines, idx, wrapperCallRe, cfg.windowLines);

      if (!keywordRe.test(window)) return; // doesn't look self-requested
      if (selfArgRe.test(window)) return; // already passes selfRequested

      violations.push({
        file: rel,
        line: idx + 1,
        snippet: line.trim().slice(0, 120),
        reason: `looks self-requested (sign-in/confirm/verify/receipt/etc. nearby) but does not pass ${cfg.selfRequestedArg} to ${cfg.wrapperCall}()`,
      });
    });
  }

  if (violations.length === 0) {
    console.log("check-selfrequested-suppression: OK — no unguarded self-requested send found.");
    return 0;
  }

  console.error(`check-selfrequested-suppression: ${violations.length} violation(s):\n`);
  for (const v of violations) {
    console.error(`  ${v.file}:${v.line}  ${v.snippet}`);
    console.error(`      ${v.reason}`);
  }
  console.error(
    `\nPass selfRequested: {...} to the send call, or annotate the line with ` +
      `// selfrequested-suppression-ok: <reason> if this send is deliberately excluded.`
  );
  return 1;
}

process.exit(main());
