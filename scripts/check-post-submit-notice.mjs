#!/usr/bin/env node
// ---------------------------------------------------------------------------
// Post-submit deliverability-notice gate.
//
// WHY THIS EXISTS
// Any page or component that tells a visitor "if you don't see the email,
// look here" is writing deliverability copy, not just UX copy. Before the
// shared mailProviderNotice module existed, that exact instruction was
// hand-written five different ways across sites and drifted every time one
// of them was touched. Worse than inconsistent tone: telling someone the
// RIGHT recovery action for THEIR provider (drag out of Promotions for
// Gmail, Safe senders for Outlook, Not Junk for iCloud/Yahoo) is one of the
// strongest positive reputation signals a mailbox provider accepts about a
// sending domain — so a stale or wrong hand-written version is not a
// cosmetic bug, it is a deliverability regression nobody would notice from
// the page rendering fine.
//
// THE INVARIANT
// A `.tsx`/`.jsx` file that contains hand-written inbox/spam-folder copy
// must import the shared notice — either the copy module itself
// (`.../web-core/mailProviderNotice`) or a local `PostSubmitNotice`
// component that renders it. A file that imports or renders either is
// trusted wholesale: the copy living there IS the canonical copy, so its
// own JSX text is not re-scanned line by line.
//
// WHAT COUNTS AS HAND-WRITTEN INBOX/SPAM COPY
// Case-insensitive, matched per source line (comments blanked first — see
// check-unsanitised-html.mjs for why: the files most likely to MENTION this
// topic in prose are the ones that got it right and are explaining so):
//
//   check (your )?(spam|junk)
//   spam (or junk )?folder
//   junk (mail )?folder
//   promotions tab
//   safe senders?
//   add .{0,40} to your contacts
//   mark (it )?(as )?not (spam|junk)
//   (land|go|went|filed|hiding|arrive[sd]?|end(s|ed)? up)... (in|under|into) (your |the )?(spam|junk|promotions)
//   (spam|junk) (or )?(junk|spam)                      — "spam/junk" or "spam or junk" pairs
//   (look|check) (in )?(your |the )?(promotions|spam|junk)
//
// The middle group ("where the email goes") was added 2026-09-08 after a real
// consumer's "Sometimes they land in Junk, so keep an eye out." passed clean:
// it names no folder/tab/contacts action, so none of the first seven phrases
// matched, even though it is the identical hand-written drift this gate
// exists to catch — just phrased as where the provider filed the message
// rather than where to go look for it.
//
// A generic deliverability PROMISE ("No spam. Unsubscribe any time.", "we
// don't spam", "No spam, ever") is not a folder instruction and deliberately
// does not match any of the above — it names no folder, tab, or contacts
// action to take.
//
// DELIBERATE EXCEPTIONS
// Annotate the line, or the line directly above it:
//
//     // post-submit-notice-ok: legal disclosure text, not a recovery instruction
//
// The reason is required — an annotation whose capture is empty does not
// suppress the finding, mirroring every other annotation-gated check in this
// repo (safe-html-ok, primary-store-ordering-ok, etc.): "someone looked at
// this" and "someone decided this" must not be indistinguishable.
//
// SCOPE
// Same tradeoffs as check-unsanitised-html.mjs, whose walker this reuses
// near-verbatim: `.tsx`/`.jsx` only, skips node_modules/build output/public
// (vendored bundles), every dot-directory (`.git`, `.next`, `.vercel`,
// `.turbo`, `.claude`, `.playwright-mcp` — tooling state, never source; a
// stale `.claude/worktrees/<name>/…` checkout is exactly the kind of thing
// this rule exists to stop double-reporting), the vendored web-core mount
// path itself (gated in its own repo), and test files/directories. Matching
// is per source LINE,
// not across a line-wrap boundary — a phrase split by JSX text wrapping onto
// a second line is a known, accepted gap, same trade as every regex-based
// gate here: the alternative is a much noisier multi-line window that starts
// double-reporting boundary lines.
//
// SECOND INVARIANT (added 2026-09-26) — a screen that TRIGGERS an email must
// show a notice at all, not just show it correctly if it bothers to
// hand-write one.
//
// The invariant above only fires on hand-written junk-folder COPY — it says
// nothing about a screen that sends an email and shows no recovery guidance
// whatsoever. a live consumer's sign-in/sign-up/reset screens shipped
// exactly that way: they call Supabase's email-sending auth methods and land
// on a "check your email" success state with zero notice, hand-written or
// otherwise, and a real user (Hotmail) never saw junk-folder guidance because
// there was nothing there to see. A gate that only inspects copy that exists
// cannot catch copy that was never written.
//
// So a `.tsx`/`.jsx` file is ALSO a finding if it calls one of the known
// email-triggering methods, or shows "check your email/inbox"-style success
// copy, and does not import/render the shared notice — regardless of whether
// it also contains any of the PHRASE matches above. Known triggers:
//
//   supabase auth: signInWithOtp, signUp, resetPasswordForEmail, resend,
//                  updateUser({ email: ... })
//   optin/lead routes: fetch(...".../api/optin"...), bartmailOptin(...)
//   success copy: "check your email/inbox", "we've emailed you", "we sent
//                 you an email" — the tell that a screen believes it just
//                 triggered a send, whether or not the actual API call is
//                 visible in this file (it may be server-side).
//
// Same exceptions apply: a server action / API route file that returns a
// provider and leaves rendering to a client file which itself renders the
// notice is not a finding on its own (this gate is `.tsx`/`.jsx`-scoped, so a
// plain `.ts` route handler is out of scope by construction). A genuine false
// positive — a trigger call whose result is deliberately never surfaced to
// this user (e.g. a background reconciliation job) — is allowlisted per path
// in `.post-submit-trigger-baseline` (repo root), one path per line with a
// mandatory `# reason`; an entry with no reason after the `#` is not honoured
// and the file is still flagged, same principle as every other annotation
// gate here (a waiver you cannot see the reason for is not a waiver, it is
// silence).
//
// Exit codes: 0 = no hand-written notice copy found (or the repo has none).
//             1 = at least one file has hand-written copy with no import, or
//                 triggers an email / shows "check your email" success copy
//                 with no notice rendered.
//
// Usage: node check-post-submit-notice.mjs [rootDir]   (default: cwd)
// ---------------------------------------------------------------------------

import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";

const ROOT = process.argv[2] || process.cwd();

/**
 * Defense-in-depth: every path reaching this function comes from this
 * script's own `readdirSync`-based walk of ROOT — never external input —
 * but static analysis cannot see that, and the check is cheap. Refuses to
 * read outside ROOT regardless of how the path was built.
 */
function readWithinRoot(root, target) {
  const base = resolve(root) + sep;
  const resolved = resolve(root, target);
  if (!resolved.startsWith(base)) {
    throw new Error(`refusing to read outside repo root: ${target}`);
  }
  return readFileSync(resolved, "utf8");
}

const SKIP_DIRS = new Set([
  "node_modules", ".next", ".git", "dist", "build", ".vercel", ".turbo", "coverage", ".testbuild",
  // Static-export output. Untracked, so per the estate rule "scope by what is
  // committed" it is not ours to scan — and it is minified, so any match is noise.
  "out", ".output", "storybook-static",
  // Built/vendored bundles, not source anyone edits.
  "public",
  // Test directories — this gate is about production copy, not test fixtures
  // that deliberately exercise the unimported phrasing.
  "test", "tests", "__tests__", "e2e",
]);
// The vendored submodule is gated in its own repo; a consumer must not re-check it.
const SKIP_PATH = /(^|\/)(web-core|app-ui|lms)(\/|$)/;
const EXT = /\.(tsx|jsx)$/;
const TEST_FILE = /\.test\.(tsx|jsx)$/;

// A file that carries the canonical copy itself, or renders the shared
// component wrapping it, is trusted wholesale — its own JSX text is not the
// hand-written drift this gate exists to catch.
const IMPORTS_OR_RENDERS_SHARED_NOTICE = [
  /from\s+["'][^"']*\/web-core\/mailProviderNotice["']/,
  /from\s+["'][^"']*PostSubmitNotice["']/,
  /<PostSubmitNotice\b/,
];

const PHRASE = new RegExp(
  [
    "check\\s+(your\\s+)?(spam|junk)",
    "spam\\s+(or\\s+junk\\s+)?folder",
    "junk\\s+(mail\\s+)?folder",
    "promotions\\s+tab",
    "safe\\s+senders?",
    "add\\s+.{0,40}\\s+to\\s+your\\s+contacts",
    "mark\\s+(it\\s+)?(as\\s+)?not\\s+(spam|junk)",
    // "Where the email goes" family — added after a real consumer's
    // "Sometimes they land in Junk, so keep an eye out." passed clean. That
    // sentence names no folder/tab/contacts action, so none of the phrases
    // above matched it, even though it is exactly the same hand-written
    // drift this gate exists to catch: telling the reader where their
    // provider filed the message.
    "(land|lands|landed|end(s|ed)?\\s+up|go|goes|went|filed|file|files|hiding|hides|hidden|arrive[sd]?|ends?\\s+up)\\s+(in|under|into)\\s+(your\\s+|the\\s+)?(spam|junk|promotions)",
    "(spam|junk)\\s+(or\\s+)?(junk|spam)",
    "(look|check)\\s+(in\\s+)?(your\\s+|the\\s+)?(promotions|spam|junk)",
  ].join("|"),
  "i"
);

const ANNOTATION = /post-submit-notice-ok\s*:\s*(\S.*)/;
// JSX comments are block comments (`{/* ... */}`), so a "bare" annotation
// still has trailing `\S` on the line — the comment closer itself. Strip it
// before deciding whether a reason was actually given, or every bare
// `{/* post-submit-notice-ok: */}` silently captures "*/}" as its reason.
const COMMENT_CLOSER = /\*\/\s*\}?\s*$/;

// --- Second invariant: trigger-without-notice ------------------------------

// Matched against the WHOLE cleaned source (not per-line) — a trigger call
// and its success-state copy routinely sit dozens of lines apart in the same
// component (e.g. LoginForm.tsx: the `signInWithOtp` call in one handler, the
// "sent" mode's JSX far below it), so a per-line scan the way PHRASE works
// would miss the exact shape this invariant exists to catch.
const TRIGGER = new RegExp(
  [
    // Supabase Auth methods that send mail — matched as a bare `.<method>(`
    // member call so it fires whether the receiver is a chained client
    // (`supabase.auth.signInWithOtp(...)`) or a local helper commonly named
    // `auth()` (`const auth = () => supabaseBrowser().auth;` then
    // `auth().signInWithOtp(...)`, as seen in a real consumer's
    // LoginForm.tsx) — requiring a literal preceding `auth` token would miss
    // the second, very common shape.
    "\\.\\s*signInWithOtp\\s*\\(",
    "\\.\\s*signUp\\s*\\(",
    "\\.\\s*resetPasswordForEmail\\s*\\(",
    "\\.\\s*resend\\s*\\(",
    // updateUser sends a confirmation email only when the payload changes
    // the email address — narrowed to require "email" within the same call
    // via UPDATE_USER_EMAIL below, not this alternation alone.
    "\\.\\s*updateUser\\s*\\(",
    // Optin / lead-capture routes.
    "bartmailOptin\\s*\\(",
    "fetch\\s*\\(\\s*[`'\"][^`'\"]*/api/optin",
  ].join("|"),
  "i"
);

// updateUser(...) only sends mail when the call touches `email` — narrow
// separately so `updateUser({ data: { name } })` (no mail sent) isn't flagged.
// Scans up to 200 chars after the call opens for an `email` key, generous
// enough for a multi-field payload without running into the next statement.
const UPDATE_USER_EMAIL = /updateUser\s*\(\s*\{[^{}]{0,200}\bemail\b/i;

// A screen that believes it just triggered a send says so in its success
// copy, whether or not the actual trigger call is visible in THIS file (the
// call is routinely server-side, e.g. a form POST to an API route).
const SUCCESS_COPY = new RegExp(
  [
    // Negative lookahead on "address"/"is correct"/"and try again" — "Check
    // your email address" (and its siblings) is validation-error copy asking
    // the visitor to re-type what they entered, not a post-submit
    // deliverability notice telling them where a sent email might have
    // landed. Found as a real false positive in a contact form's 400-response
    // toast, which never triggers a send at all on that code path.
    "check\\s+your\\s+(email|inbox)(?!\\s+(address|is\\s+correct|and\\s+try\\s+again))",
    "we\\W?(ve|have)\\s+emailed",
    "we\\s+emailed\\s+you",
    "we\\W?(ve|have)\\s+sent\\s+(you\\s+)?an?\\s+email",
    "we\\s+sent\\s+(you\\s+)?an?\\s+email",
    "an\\s+email\\s+(is|has\\s+been)\\s+on\\s+its\\s+way",
  ].join("|"),
  "i"
);

function loadBaseline(root, filename) {
  const p = join(root, filename);
  if (!existsSync(p)) return new Map();
  const map = new Map();
  for (const raw of readFileSync(p, "utf8").split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const hashIdx = line.indexOf("#");
    const path = (hashIdx === -1 ? line : line.slice(0, hashIdx)).trim();
    const reason = hashIdx === -1 ? "" : line.slice(hashIdx + 1).trim();
    if (!path) continue;
    // A mandatory reason: an entry with nothing after the `#` (or no `#` at
    // all) is not honoured — same principle as every inline annotation in
    // this repo. Recorded but marked unreasoned so it still fails, loudly,
    // rather than silently matching nothing.
    map.set(path, reason || null);
  }
  return map;
}

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    // Any dot-directory is tooling state, not source — `.git`, `.next`,
    // `.vercel`, `.turbo` are already in SKIP_DIRS by name, but that list is
    // never exhaustive: a stale `.claude/worktrees/<name>/…` checkout inside
    // a consumer repo reported the SAME file twice (once real, once from the
    // worktree copy) because `.claude` was not enumerated. A general rule
    // covers every present and future dot-directory — `.git`, `.next`,
    // `.vercel`, `.turbo`, `.claude`, `.playwright-mcp` — without needing to
    // keep guessing names one at a time.
    if (name.startsWith(".") || SKIP_DIRS.has(name)) continue;
    const full = join(dir, name);
    const rel = relative(ROOT, full);
    if (SKIP_PATH.test(rel)) continue;
    const st = statSync(full);
    if (st.isDirectory()) {
      walk(full, out);
    } else if (EXT.test(name) && !TEST_FILE.test(name)) {
      out.push(full);
    }
  }
  return out;
}

/**
 * Blank out comment bodies while preserving line count and offsets, so a
 * line number still means what it says.
 *
 * Same reasoning as check-unsanitised-html.mjs: the files most likely to
 * TALK about spam-folder copy in prose are exactly the ones that got it
 * right and are explaining why — flagging that is how a gate loses its
 * audience. Strings/template literals are left intact, since JSX text is
 * frequently authored as a template literal, not a bare comment.
 */
function blankComments(src) {
  let out = "";
  let i = 0;
  let state = "code"; // code | line | block | str
  let quote = "";
  while (i < src.length) {
    const two = src.slice(i, i + 2);
    const ch = src[i];
    if (state === "code") {
      if (two === "//") { state = "line"; out += "  "; i += 2; continue; }
      if (two === "/*") { state = "block"; out += "  "; i += 2; continue; }
      if (ch === "'" || ch === '"' || ch === "`") { state = "str"; quote = ch; out += ch; i++; continue; }
      out += ch; i++; continue;
    }
    if (state === "line") {
      if (ch === "\n") { state = "code"; out += "\n"; i++; continue; }
      out += " "; i++; continue;
    }
    if (state === "block") {
      if (two === "*/") { state = "code"; out += "  "; i += 2; continue; }
      out += ch === "\n" ? "\n" : " "; i++; continue;
    }
    // inside a string/template — copy through, honouring escapes
    if (ch === "\\") { out += src.slice(i, i + 2); i += 2; continue; }
    if (ch === quote) { state = "code"; }
    out += ch; i++;
  }
  return out;
}

/** Annotation may sit on the match line itself, or the line directly above it. */
function annotatedReason(rawLines, i) {
  const extract = (line) => {
    const m = line.match(ANNOTATION);
    if (!m) return null;
    const reason = m[1].trim().replace(COMMENT_CLOSER, "").trim();
    return reason || null;
  };
  return extract(rawLines[i]) ?? (i > 0 ? extract(rawLines[i - 1]) : null);
}

const triggerBaseline = loadBaseline(ROOT, ".post-submit-trigger-baseline");

const findings = [];
const triggerFindings = [];
let checked = 0;
let annotated = 0;
let triggerBaselined = 0;

for (const file of walk(ROOT)) {
  let src;
  try { src = readWithinRoot(ROOT, file); } catch { continue; }
  checked++;
  const rel = relative(ROOT, file);

  const hasSharedNotice = IMPORTS_OR_RENDERS_SHARED_NOTICE.some((re) => re.test(src));

  if (!hasSharedNotice) {
    const rawLines = src.split("\n");
    const lines = blankComments(src).split("\n");

    lines.forEach((line, i) => {
      const m = line.match(PHRASE);
      if (!m) return;

      const reason = annotatedReason(rawLines, i);
      if (reason) {
        annotated++;
        return;
      }

      findings.push({ file: rel, line: i + 1, text: m[0].trim() });
    });
  }

  // Second invariant — independent of the first: a trigger call or "check
  // your email" success copy with no shared notice anywhere in the file,
  // regardless of whether hand-written junk-folder phrasing is also present
  // (that case is already caught above; this catches the file that shows NO
  // notice at all, which the phrase-only scan cannot see).
  if (hasSharedNotice) continue;
  const cleaned = blankComments(src);
  // TRIGGER's updateUser(...) alternative matches any updateUser call; narrow
  // it down to the email-changing shape so `updateUser({ data: { name } })`
  // (no mail sent) isn't flagged on its own.
  const matchedUpdateUserOnly = /\.\s*updateUser\s*\(/i.test(cleaned)
    && !/\.\s*signInWithOtp\s*\(|\.\s*signUp\s*\(|\.\s*resetPasswordForEmail\s*\(|\.\s*resend\s*\(|bartmailOptin\s*\(|\/api\/optin/i.test(cleaned);
  const isTrigger = matchedUpdateUserOnly ? UPDATE_USER_EMAIL.test(cleaned) : TRIGGER.test(cleaned);
  const isSuccessCopy = SUCCESS_COPY.test(cleaned);

  if (!isTrigger && !isSuccessCopy) continue;

  const reason = triggerBaseline.get(rel);
  if (triggerBaseline.has(rel)) {
    if (reason) {
      triggerBaselined++;
      continue;
    }
    // Present but no reason after the `#` — not honoured, falls through to a finding.
  }

  triggerFindings.push({ file: rel, kind: isTrigger ? "trigger" : "success-copy" });
}

if (findings.length) {
  console.log(
    "::error::Hand-written inbox/spam-folder copy found with no import of the shared" +
      " deliverability notice. Wording that tells a visitor where to look for a missing" +
      " email (spam/junk folder, Promotions tab, Safe senders, 'add to contacts') is a" +
      " deliverability lever as much as it is UX copy — it steers the reader toward the" +
      " exact action their provider rewards, and it has drifted into five different" +
      " phrasings before. Import PostSubmitNotice (or mailProviderNotice from" +
      " @/web-core/mailProviderNotice directly) instead of hand-writing this text. If the" +
      ' text is not actually a recovery instruction, annotate it "// post-submit-notice-ok:' +
      ' <reason>".'
  );
  for (const f of findings) console.log(`  ${f.file}:${f.line}  ${f.text}`);
}

if (triggerFindings.length) {
  console.log(
    "::error::A screen triggers an email (or shows \"check your email\" success copy)" +
      " with no post-submit notice rendered at all. a live consumer's sign-in, sign-up and" +
      " reset screens shipped exactly this way and a real user (Hotmail) never saw" +
      " junk-folder guidance because none was ever shown — a hand-written-copy gate cannot" +
      " catch copy that was never written. Render PostSubmitNotice (or call" +
      " mailProviderNotice from @/web-core/mailProviderNotice) on this screen's success" +
      " state. If this call's result is genuinely never surfaced to a user (e.g. a" +
      " background job), add the path to .post-submit-trigger-baseline with a mandatory" +
      " `# reason` — an entry with no reason is not honoured."
  );
  for (const f of triggerFindings) console.log(`  ${f.file}  [${f.kind}]`);
}

if (findings.length || triggerFindings.length) process.exit(1);

console.log(
  `Post-submit notice gate OK — ${checked} file(s) checked, ${annotated} annotated exception(s),` +
    ` ${triggerBaselined} trigger-baselined exception(s).`
);
