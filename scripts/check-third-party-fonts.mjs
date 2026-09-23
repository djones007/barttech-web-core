#!/usr/bin/env node
// ---------------------------------------------------------------------------
// Third-party font gate.
//
// WHY THIS EXISTS
// Loading a webfont stylesheet or font file from someone else's server sends
// every visitor's IP to that server on every page load. LG München I awarded
// a visitor €100 in damages for exactly this (Google Fonts, Jan 2022) and it
// remains a live GDPR complaint pattern across the EU/UK. This is not a
// Google-specific problem: on 2026-09-22 the estate found the SAME bug shape
// twice in one day — a legacy CMS-exported stylesheet `@import`-ing
// `fonts.googleapis.com`, and a deliberate per-brand configurable-font design
// that rendered a chosen Google Fonts stylesheet URL as a `<link>` href at
// runtime. Neither was caught until someone went looking.
//
// THE RULE, AND WHY IT IS NOT "JUST DON'T USE GOOGLE"
// Self-host every font: `next/font/google` (downloads at build time, no
// runtime request to Google) or a font file committed to the repo/served
// from our own bucket. A privacy-friendlier CDN is still a CDN — Bunny Fonts
// (fonts.bunny.net) markets itself as GDPR-positioned and IP-logless, and it
// is still a third-party runtime request most visitors never agreed to. A
// rule written as "no Google Fonts" would wave every other font CDN straight
// through, including whichever one someone picks after this one is fixed.
//
// WHAT COUNTS AS A LOAD (flagged) VS A PERMISSION (not flagged)
// Listing a font-CDN host in a Content-Security-Policy `style-src`/`font-src`
// directive is a PERMISSION, not a LOAD — CSP only allows a request if one is
// made elsewhere; it does not make one. A repo can correctly carry
// `font-src https://fonts.gstatic.com` in its CSP while never actually
// fetching from it (one scaffold template did exactly that until
// 2026-09-22 — a leftover from copying another site's CSP, removed once
// self-hosting via next/font made it dead weight). This gate skips any match
// that sits on a line/string also naming a CSP directive token (`style-src`,
// `font-src`, etc.) or the `Content-Security-Policy` header itself, and flags
// everything else: a `<link rel="stylesheet" href="...">`, a CSS `@import`,
// a `fetch()`, or a hardcoded stylesheet URL string assigned to something
// that gets rendered as an href.
//
// WHY A NAMED DENYLIST, NOT AN ARBITRARY-THIRD-PARTY-ORIGIN MATCH
// A regex for "any external URL near font-looking code" would fire on
// `@font-face { src: url(...) }` pointing at OUR OWN R2/Cloudinary bucket,
// on documentation prose, and on any brand asset host — the false-positive
// rate would be high enough that the gate gets switched off within a week,
// which is how this bug class survived in the first place (see
// memory/feedback_mechanical_rule_gates.md). A named list of known
// font-CDN hosts is precise and low-noise; it costs an entry per new CDN
// discovered, which is a fine trade. Add to FONT_CDN_HOSTS below with a
// one-line comment when a new one turns up.
//
// WHAT THIS GATE CANNOT SEE
// A per-brand or DB-sourced font URL (a `brands.theme.fontUrl`-shaped design,
// found live in one consumer) is the same violation with an extra layer of
// indirection — the hostname lives in a database row, not in the consuming
// repo's source, so no grep here can see it. If a future build genuinely
// needs brand-configurable fonts, constrain the value to a self-hosted file
// path already in the repo/bucket and validate against THAT allowlist,
// never against a third-party hostname regex. See
// memory/reference_website_security_standard.md.
//
// A GREP HIT IS A HYPOTHESIS, NOT A FINDING
// This gate (and any manual grep sweep like it) tells you a string is
// present in a tracked file — not that a browser ever requests it. The
// 2026-09-22 calibration case was a false positive: the matching `@import`
// sat in an archival, CMS-exported CSS source file imported by nothing,
// confirmed dead by grepping the built output and the live HTML. Treat every
// hit this script reports the same way a human
// audit should: confirm against the built/served page before treating it as
// a real exposure, and don't let a clean run stand in for having checked the
// live page for a load this gate structurally cannot see (a dashboard-toggled
// third-party script, a DB-sourced URL). See
// memory/feedback_verify_before_asserting.md.
//
// DELIBERATE EXCEPTIONS
// Annotate the line, or the line directly above it:
//
//     // third-party-font-ok: <reason>
//
// or list the path in `.font-cdn-baseline` (one per line, `#` comment
// required) for a whole-file exception. The reason is required, same
// contract as every other annotation-gated check in this repo.
//
// PROMOTION HISTORY: written 2026-09-22 as a local script in a consumer's
// scaffold template because this repo was mid-edit by another session at
// the time. Promoted here 2026-09-22 unchanged in behaviour — consumers
// switch from running a local copy to fetching this file by pinned SHA (see
// this repo's own README / the WEB_CORE_REF pattern other scripts/ gates
// use). Retiring the template's own local copy is a separate decision for
// whoever owns that repo's ci.yml next.
//
// Exit codes: 0 = no unpermissioned third-party font load found.
//             1 = at least one found.
//
// Usage: node check-third-party-fonts.mjs [rootDir]   (default: cwd)
// ---------------------------------------------------------------------------

import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";

const ROOT = process.argv[2] || process.cwd();

/**
 * Defense-in-depth: `target` is always discovered by this script's own
 * directory walk, never external input, but static analysis cannot see
 * that, and the check is cheap. Refuses to read outside ROOT regardless of
 * how `target` was built. Same idiom as the rest of scripts/.
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
  "out", ".output", "storybook-static",
]);
// A consumer's own vendored submodules are gated in their own repo — a
// consumer running this script against its tree does not need to re-check
// what it mounted read-only.
//
// EVERY NAME HERE MUST BE VERIFIED TO SELF-GATE, NEVER ASSUMED. Each entry
// is a hole punched in every consumer's coverage, justified only by the
// named repo running this exact gate in its own CI. On 2026-09-22 two of
// the three names below did not: one had no font gate at all despite being
// vendored into eleven consumers, and one only unit-tested this script's
// logic against fixtures without ever running it over its own tree. A font
// CDN added to either would have been invisible to every consumer and
// shipped to all of them. Both were fixed the same day; the comment had
// asserted it for months and nobody had checked.
//
// So: before adding a fourth name, confirm that repo's CI actually runs
// this gate and that it reports a non-zero file count. A gate that checks
// nothing passes just as green as one that checks everything.
const SKIP_PATH = /(^|\/)(web-core|app-ui|lms)(\/|$)/;
const EXT = /\.(tsx?|jsx?|mjs|cjs|css|html?)$/;
const TEST_FILE = /\.test\.(tsx?|jsx?)$/;

// Named denylist. Each entry is a known third-party font-serving host —
// deliberately NOT an arbitrary-third-party-origin match; see the file
// header for why. Add a new host here (one line, one comment) rather than
// widening the pattern shape.
const FONT_CDN_HOSTS = [
  { name: "Google Fonts", re: /fonts\.googleapis\.com|fonts\.gstatic\.com/i },
  // Privacy-positioned (EU-hosted, states it logs no IPs) but still a
  // third-party runtime request — the 2026-09-22 correction that generalised
  // this gate beyond "not Google", after a consumer's self-hosting fix
  // replaced exactly this host.
  { name: "Bunny Fonts", re: /fonts\.bunny\.net/i },
  { name: "Adobe Fonts / Typekit", re: /use\.typekit\.net|p\.typekit\.net/i },
  { name: "Font Awesome CDN (kit loader)", re: /use\.fontawesome\.com|kit\.fontawesome\.com/i },
  { name: "cdnjs Font Awesome", re: /cdnjs\.cloudflare\.com\/ajax\/libs\/font-awesome/i },
  {
    name: "jsDelivr/unpkg font package",
    re: /(cdn\.jsdelivr\.net|unpkg\.com)\/npm\/(@fontsource|font-awesome)/i,
  },
];

// A match on a line/string that ALSO names a CSP directive (or the
// Content-Security-Policy header itself) is a PERMISSION, not a LOAD. See
// the file header — this is the distinction an earlier audit missed.
const CSP_CONTEXT =
  /(default|script|style|font|connect|img|frame|worker|object|media|manifest|child|prefetch|frame-ancestors)-src\b|base-uri\b|form-action\b|Content-Security-Policy/i;

const ANNOTATION = /third-party-font-ok\s*:\s*(\S.*)/;
const COMMENT_CLOSER = /\*\/\s*\}?\s*$/;

function loadBaseline(root) {
  const p = join(root, ".font-cdn-baseline");
  if (!existsSync(p)) return new Set();
  return new Set(
    readWithinRoot(root, p)
      .split("\n")
      .map((s) => s.replace(/#.*$/, "").trim())
      .filter(Boolean)
  );
}

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
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

/** Blank comment bodies, preserve offsets/line count. Strings left intact. */
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
    if (ch === "\\") { out += src.slice(i, i + 2); i += 2; continue; }
    if (ch === quote) { state = "code"; }
    out += ch; i++;
  }
  return out;
}

function annotatedReason(rawLines, i) {
  const extract = (line) => {
    const m = line.match(ANNOTATION);
    if (!m) return null;
    const reason = m[1].trim().replace(COMMENT_CLOSER, "").trim();
    return reason || null;
  };
  return extract(rawLines[i]) ?? (i > 0 ? extract(rawLines[i - 1]) : null);
}

const baseline = loadBaseline(ROOT);
const findings = [];
let checked = 0;
let annotated = 0;

for (const file of walk(ROOT)) {
  const rel = relative(ROOT, file);
  if (baseline.has(rel)) continue;

  let src;
  try { src = readWithinRoot(ROOT, file); } catch { continue; }
  checked++;

  const rawLines = src.split("\n");
  const lines = blankComments(src).split("\n");

  lines.forEach((line, i) => {
    for (const host of FONT_CDN_HOSTS) {
      if (!host.re.test(line)) continue;
      if (CSP_CONTEXT.test(line)) return; // permission, not a load — see header

      const reason = annotatedReason(rawLines, i);
      if (reason) { annotated++; return; }

      findings.push({ file: rel, line: i + 1, host: host.name, text: line.trim().slice(0, 160) });
    }
  });
}

if (findings.length) {
  console.log(
    "::error::Third-party font CDN referenced outside a CSP declaration — this looks like " +
      "a runtime font load, which sends every visitor's IP to that host. Self-host via " +
      "next/font (build-time download) or a committed/bucketed font file instead. A " +
      "privacy-positioned CDN (Bunny Fonts etc.) is still a third-party request and still " +
      "fails this rule. If this really is a CSP permission and the gate mis-classified it, " +
      'annotate the line "// third-party-font-ok: <reason>" or list the path in ' +
      ".font-cdn-baseline with a # reason."
  );
  for (const f of findings) console.log(`  ${f.file}:${f.line}  [${f.host}]  ${f.text}`);
  process.exit(1);
}

console.log(
  `Third-party font gate OK — ${checked} file(s) checked, ${annotated} annotated exception(s), ${baseline.size} baselined file(s).`
);
