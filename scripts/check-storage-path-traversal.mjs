#!/usr/bin/env node
/**
 * Gate: a file that calls Supabase Storage with a write/read-by-key operation
 * must import the shared filename sanitiser.
 *
 * WHY THIS EXISTS
 * Aikido flagged grouped issue 37987812 (High, "path traversal in Supabase
 * Storage") on 2026-08-24, 7 subissues across two live repos. In every case a
 * user- or DB-controlled string was concatenated straight into a storage key —
 * one site hand-rolled its own version of the exact sanitiser web-core already
 * exports (`safeUploadFilename`), the other built a key from a raw filename with
 * a narrower, worse regex. Both passed review because nothing made the missing
 * guard visible at the call site — the storage call reads the same either way.
 *
 * WHAT IT DOES
 * File-level heuristic, same precision tradeoff as this repo's other regex
 * gates (see shared-modules.json's own `_readme`): flags any file containing
 * `.storage.from(...)` chained with one of `.upload(` `.remove(`
 * `.createSignedUrl(` `.createSignedUrls(` `.download(` `.move(` `.copy(` that
 * does NOT also import `safeUploadFilename` (or a documented alias, e.g.
 * `sanitizeStorageSegment`) from `@/web-core/uploads` or `@/lib/uploads` (the
 * per-repo shim). It cannot see whether the sanitiser is actually applied to
 * the specific key built in this file — that needs a human, same as every
 * other gate here — but it catches the far more common failure: nobody
 * imported it at all.
 *
 * A file that builds its storage key entirely from compile-time constants (no
 * interpolation) is a legitimate, rare false positive. Add it to
 * `.storage-path-baseline` (repo root) with a `#` reason — same ratchet
 * pattern as `.web-core-baseline`. A baseline line with no reason is not a
 * waiver, it is an unreviewed exception; keep the reason.
 *
 * Exit codes: 0 = clean. 1 = a finding, or the check could not run.
 */
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = process.cwd();
const SKIP_DIRS = new Set([
  "node_modules", ".next", ".git", "dist", "build", ".vercel", ".turbo", "coverage", ".testbuild",
  "out", ".output", "storybook-static",
  "public",
]);
// The vendored submodules are gated in their own repo; a consumer must not re-check them.
const SKIP_PATH = /(^|\/)(web-core|app-ui|lms)(\/|$)/;
const EXT = /\.(tsx|ts)$/;

const STORAGE_METHODS = "upload|remove|createSignedUrl|createSignedUrls|download|move|copy";
const STORAGE_CALL = new RegExp(
  `\\.storage\\s*\\.\\s*from\\s*\\([^)]*\\)\\s*\\.\\s*(?:${STORAGE_METHODS})\\s*\\(`
);
const IMPORT_RE = /import\s*\{[^}]*\b(safeUploadFilename|sanitizeStorageSegment)\b[^}]*\}\s*from\s*["'][^"']*\/uploads["']/;

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const full = join(dir, name);
    const rel = relative(ROOT, full);
    if (SKIP_PATH.test(rel)) continue;
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) walk(full, out);
    else if (EXT.test(name)) out.push(full);
  }
  return out;
}

/**
 * Blank out comment bodies while preserving line count and offsets. Without
 * this a file that explains IN A COMMENT why it is safe (e.g. "no change
 * needed here, the write path sanitises") can accidentally satisfy the import
 * regex if the comment happens to mention the function name, or the storage
 * regex can trip on a commented-out call. Same approach as
 * check-unsanitised-html.mjs.
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
    if (ch === "\\") { out += src.slice(i, i + 2); i += 2; continue; }
    if (ch === quote) { state = "code"; }
    out += ch; i++;
  }
  return out;
}

function loadBaseline() {
  const p = join(ROOT, ".storage-path-baseline");
  if (!existsSync(p)) return [];
  return readFileSync(p, "utf8")
    .split("\n")
    .map((s) => s.replace(/#.*$/, "").trim())
    .filter(Boolean);
}

const baseline = loadBaseline();
const findings = [];
let checked = 0;

for (const file of walk(ROOT)) {
  let src;
  try {
    src = readFileSync(file, "utf8");
  } catch {
    continue;
  }
  const cleaned = blankComments(src);
  if (!STORAGE_CALL.test(cleaned)) continue;

  checked++;
  const rel = relative(ROOT, file);
  if (baseline.includes(rel)) continue;
  if (IMPORT_RE.test(cleaned)) continue;

  findings.push(rel);
}

if (findings.length) {
  console.log(
    "::error::A file calls Supabase Storage (.upload/.remove/.createSignedUrl(s)/.download/.move/.copy)" +
      " without importing the shared filename sanitiser. Any user- or DB-controlled string reaching a" +
      " storage key without it is a path-traversal risk — this is what Aikido finding 37987812 flagged." +
      " Import safeUploadFilename (or a documented alias) from @/web-core/uploads (or your repo's" +
      " @/lib/uploads shim) and run it over every path SEGMENT before it reaches the storage call." +
      " If this file's storage key is built entirely from compile-time constants with no interpolation," +
      " add its path to .storage-path-baseline with a # reason."
  );
  for (const f of findings) console.log(`  ${f}`);
  process.exit(1);
}

console.log(
  `Storage-path-traversal gate OK — ${checked} file(s) calling Supabase Storage checked,` +
    ` ${baseline.length} baselined exception(s).`
);
