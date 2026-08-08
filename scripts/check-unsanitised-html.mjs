#!/usr/bin/env node
/**
 * Gate: every `dangerouslySetInnerHTML` must have a visible reason to be safe.
 *
 * WHY THIS EXISTS
 * On 2026-08-08 two live sites were found rendering agent-written blog markdown
 * straight into `dangerouslySetInnerHTML` with no sanitiser at all, and two more
 * each maintained a private near-identical copy of the same sanitiser. None of
 * it was noticed for months, because nothing looked wrong: the pages rendered,
 * the builds were green, and the only signal was a value buried in a lib file.
 *
 * Worse, the manual check people reach for is actively misleading — grepping a
 * file for "sanitize" matches `sanitize: false`, the flag that TURNS IT OFF.
 * That produced two wrong "already sanitised" conclusions in one session.
 *
 * WHAT IT DOES
 * Finds every `dangerouslySetInnerHTML={{ __html: EXPR }}` and passes it only if
 * EXPR is self-evidently safe at the call site:
 *
 *   - `renderSafeHtml(...)`  — the shared pass
 *   - `jsonLd(...)`          — the escaping serialiser
 *   - `A_SCREAMING_CONSTANT` — a compile-time literal, not foreign content
 *
 * Anything else — including the very common case of sanitising upstream at the
 * data layer — needs an annotation on or just above the line:
 *
 *   // safe-html-ok: sanitised in lib/posts.ts via renderSafeHtml
 *
 * The annotation is not a rubber stamp. It forces someone to name WHERE the
 * sanitising happens, which is the exact question nobody asked for months, and
 * it leaves a grep-able trail for the next audit.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = process.cwd();
const SKIP_DIRS = new Set([
  "node_modules", ".next", ".git", "dist", "build", ".vercel", ".turbo", "coverage", ".testbuild",
  // Built/vendored bundles, not source anyone edits. the checkout app ships a
  // minified React bundle here, and matching inside it is pure noise.
  "public",
]);
// The vendored submodule is gated in its own repo; a consumer must not re-check it.
const SKIP_PATH = /(^|\/)(web-core|app-ui|lms)(\/|$)/;
const EXT = /\.(tsx|ts|jsx|js)$/;

const SAFE_EXPR = [
  /renderSafeHtml\s*\(/,
  /jsonLd\s*\(/,
  /^[A-Z][A-Z0-9_]*$/,          // SCREAMING_CASE constant, e.g. CONSENT_MODE_HEAD_SNIPPET
];
const ANNOTATION = /safe-html-ok:\s*(\S.*)/;

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const full = join(dir, name);
    const rel = relative(ROOT, full);
    if (SKIP_PATH.test(rel)) continue;
    const st = statSync(full);
    if (st.isDirectory()) walk(full, out);
    else if (EXT.test(name)) out.push(full);
  }
  return out;
}

/**
 * Blank out comment bodies while preserving line count and offsets, so a line
 * number still means what it says.
 *
 * Needed because the honest, well-written files are the ones that TALK about
 * this API: a client site's and a private app's help pages both carry a JSX block
 * comment explaining that they deliberately do NOT use dangerouslySetInnerHTML,
 * because their articles can be drafted from a customer's own words. Flagging
 * the two repos that got it right is exactly how a gate loses its audience.
 */
function blankComments(src) {
  let out = "";
  let i = 0;
  let state = "code"; // code | line | block | tmpl | str
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

/** An annotation may sit on the line, or on any of the 6 lines above it. */
function annotatedReason(lines, i) {
  for (let j = i; j >= Math.max(0, i - 6); j--) {
    const m = lines[j].match(ANNOTATION);
    if (m) return m[1].trim();
  }
  return null;
}

const findings = [];
const stale = [];
let checked = 0;
let annotated = 0;

for (const file of walk(ROOT)) {
  let src;
  try { src = readFileSync(file, "utf8"); } catch { continue; }
  if (!src.includes("dangerouslySetInnerHTML")) continue;
  // Annotations live in comments, so keep the raw text for that lookup and use
  // the comment-blanked copy for detection.
  const rawLines = src.split("\n");
  const lines = blankComments(src).split("\n");

  lines.forEach((line, i) => {
    if (!line.includes("dangerouslySetInnerHTML")) return;

    // Comments and doc-strings mention this API constantly — including the two
    // help pages that exist specifically to say they AVOID it. Counting those as
    // findings is how a gate earns a reputation for crying wolf.
    checked++;

    // Grab the __html expression — it may be on this line or the next few.
    const window = lines.slice(i, i + 3).join(" ");
    const m = window.match(/__html:\s*([^}]+?)\s*\}/);
    const expr = m ? m[1].trim() : "";

    if (SAFE_EXPR.some((re) => re.test(expr))) return;

    // A bare identifier assigned from a safe call in the SAME file is safe —
    // `const html = renderSafeHtml(...)` then `__html: html` is the normal shape
    // and should not need an annotation. Cross-FILE sanitising still does: that
    // is precisely the case nobody could see from the call site.
    if (/^[A-Za-z_$][\w$]*$/.test(expr)) {
      const assign = new RegExp(
        `(?:const|let|var)\\s+${expr}\\s*(?::[^=]+)?=[^;]*?(?:renderSafeHtml|jsonLd)\\s*\\(`
      );
      if (assign.test(src)) return;
    }

    const reason = annotatedReason(rawLines, i);
    if (reason) {
      // An annotation that names a FILE is a checkable claim, so check it.
      // Otherwise the annotation outlives the thing it describes: delete the
      // sanitiser from lib/posts.ts and the render site still says "sanitised in
      // lib/posts.ts", and the gate believes it. That is a worse failure than no
      // gate, because it reads as verified.
      const named = reason.match(/([\w./-]+\.(?:ts|tsx|js|jsx))/);
      if (named) {
        const target = join(ROOT, named[1]);
        let body = null;
        try { body = readFileSync(target, "utf8"); } catch { /* unreadable */ }
        if (body === null) {
          stale.push({ file: relative(ROOT, file), line: i + 1, named: named[1], why: "named file not found" });
          return;
        }
        // Blank comments first. Without this the check is fooled by exactly the
        // bug it exists to prevent: this file's own comment mentions
        // renderSafeHtml, so a grep passes while the CALL has been deleted.
        // (Observed while testing this gate — the third instance of that same
        // mistake in one session.)
        if (!/renderSafeHtml|DOMPurify|sanitize-?[Hh]tml/.test(blankComments(body))) {
          stale.push({ file: relative(ROOT, file), line: i + 1, named: named[1], why: "named file contains no sanitiser" });
          return;
        }
      }
      annotated++;
      return;
    }

    findings.push({ file: relative(ROOT, file), line: i + 1, expr: expr || "(unparsed)" });
  });
}

if (stale.length) {
  console.log(
    "::error::A safe-html-ok annotation names a file that no longer sanitises. The annotation" +
      " is now a false assurance — worse than none, because it reads as verified. Either restore" +
      " the sanitising in that file or correct the annotation to say where it really happens."
  );
  for (const s2 of stale) console.log(`  ${s2.file}:${s2.line}  claims "${s2.named}" — ${s2.why}`);
}

if (findings.length || stale.length) {
  if (findings.length) console.log(
    "::error::dangerouslySetInnerHTML with no visible sanitiser. Route the value through" +
      " renderSafeHtml from @/web-core/safeHtml, or — if it is already sanitised upstream —" +
      ' annotate the line "// safe-html-ok: <where it is sanitised>". Naming the place is the' +
      " point: two sites rendered unsanitised markdown for months because nobody could tell" +
      " from the call site. Note that grepping for \"sanitize\" is NOT evidence — it matches" +
      " `sanitize: false`, which turns it off."
  );
  for (const f of findings) console.log(`  ${f.file}:${f.line}  __html: ${f.expr}`);
  process.exit(1);
}

console.log(
  `Unsanitised-HTML gate OK — ${checked} dangerouslySetInnerHTML site(s) checked,` +
    ` ${annotated} annotated exception(s), all verified.`
);
