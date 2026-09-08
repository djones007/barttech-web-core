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
// Exit codes: 0 = no hand-written notice copy found (or the repo has none).
//             1 = at least one file has hand-written copy with no import.
//
// Usage: node check-post-submit-notice.mjs [rootDir]   (default: cwd)
// ---------------------------------------------------------------------------

import { readFileSync, readdirSync, statSync } from "node:fs";
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

const findings = [];
let checked = 0;
let annotated = 0;

for (const file of walk(ROOT)) {
  let src;
  try { src = readWithinRoot(ROOT, file); } catch { continue; }
  checked++;

  if (IMPORTS_OR_RENDERS_SHARED_NOTICE.some((re) => re.test(src))) continue;

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

    findings.push({ file: relative(ROOT, file), line: i + 1, text: m[0].trim() });
  });
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
  process.exit(1);
}

console.log(`Post-submit notice gate OK — ${checked} file(s) checked, ${annotated} annotated exception(s).`);
