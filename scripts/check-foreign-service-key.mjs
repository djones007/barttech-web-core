#!/usr/bin/env node
// ---------------------------------------------------------------------------
// Foreign service-role key gate.
//
// WHY THIS EXISTS
// An internal back-office app's service-role key bypasses row-level security on
// everything that app stores. A public site that reads that key puts it in the
// environment of an internet-facing app: one SSRF, one leaked log line or one
// compromised dependency there and the whole back-office database is readable
// and writable. A public app that needs back-office data should call a narrow,
// token-scoped route instead of holding the master key. Estate issue d74fff61.
//
// WHAT IT CHECKS
// Every source/config file under the target dir (not node_modules, .next, .git, a
// web-core submodule, lockfiles or *.md) is scanned for an env var whose name
// starts with a FORBIDDEN prefix and ends in SERVICE_KEY or SERVICE_ROLE_KEY.
// The forbidden prefixes are supplied by the caller (CI step), not baked in, so this
// public script carries mechanism only:
//     node check-foreign-service-key.mjs . --forbid PREFIX_A,PREFIX_B
// or in the repo's .foreign-service-key.json: {"forbid": ["PREFIX_A"], "allow": []}
// With no prefixes at all it FAILS (a gate with nothing to look for must not report a pass).
// A repo whose package.json name is listed under "owner" (or equals --owner NAME) is exempt:
// the app that owns a key may of course use it. "allow" removes a prefix for that repo.
//
// DELIBERATE EXCEPTIONS
// Annotate the line (or the line above), reason required:
//     // foreign-service-key-ok: <why this app must hold that key>
//
// Exit 0 = clean. 1 = a reference, or an annotation with no reason.
// Usage: node check-foreign-service-key.mjs [rootDir] --forbid A,B [--owner pkg-name]
// ---------------------------------------------------------------------------

import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(process.argv[2] && !process.argv[2].startsWith("--") ? process.argv[2] : process.cwd());
const SKIP_DIRS = new Set(["node_modules", ".next", ".git", ".vercel", "web-core", "coverage", "dist", "build", "test-results"]);
const SKIP_FILES = /(^|\/)(package-lock\.json|CHANGELOG\.md|.*\.md|.*\.lock|.*\.png|.*\.jpg|.*\.webp|.*\.mp4|.*\.woff2?)$/i;
const MAX_BYTES = 1_000_000;

function readConfig() {
  try {
    const c = JSON.parse(fs.readFileSync(path.join(ROOT, ".foreign-service-key.json"), "utf8"));
    return { forbid: Array.isArray(c.forbid) ? c.forbid : [], allow: Array.isArray(c.allow) ? c.allow : [], owner: Array.isArray(c.owner) ? c.owner : [] };
  } catch { return { forbid: [], allow: [], owner: [] }; }
}

function ownName() {
  try { return JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")).name || ""; } catch { return ""; }
}

export function scanText(text, forbid) {
  const out = [];
  const lines = text.split("\n");
  const re = new RegExp(`\\b(?:${forbid.map((f) => f.replace(/[^A-Z0-9_]/gi, "")).join("|")})_[A-Z0-9_]*SERVICE(?:_ROLE)?_KEY\\b`, "g");
  for (let i = 0; i < lines.length; i++) {
    const hits = lines[i].match(re);
    if (!hits) continue;
    const near = [lines[i], lines[i - 1] || ""].join("\n");
    const ann = near.match(/foreign-service-key-ok:\s*(.*)/);
    if (ann) {
      if (ann[1].trim().replace(/[*/\-\s]/g, "").length < 4) out.push({ line: i + 1, name: hits[0], problem: "annotation has no reason" });
      continue;
    }
    out.push({ line: i + 1, name: hits[0], problem: "references another app's service-role key" });
  }
  return out;
}

function* walk(dir) {
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) yield* walk(path.join(dir, e.name)); continue; }
    if (!e.isFile() || SKIP_FILES.test(e.name)) continue;
    yield path.join(dir, e.name);
  }
}

function main() {
  const cfg = readConfig();
  const arg = (n) => { const i = process.argv.indexOf(n); return i > -1 ? String(process.argv[i + 1] || "") : ""; };
  const csv = (v) => v.split(",").map((x) => x.trim()).filter(Boolean);
  const all = [...new Set([...csv(arg("--forbid")), ...cfg.forbid])];
  if (all.length === 0) { console.error("foreign-service-key gate: no forbidden prefixes given (--forbid A,B or .foreign-service-key.json). Failing rather than passing over nothing."); return 1; }
  if ([...csv(arg("--owner")), ...cfg.owner].includes(ownName())) { console.log("foreign-service-key gate: exempt (this repo owns the key)."); return 0; }
  const forbid = all.filter((f) => !cfg.allow.includes(f));
  if (forbid.length === 0) { console.log("foreign-service-key gate: every forbidden prefix is allowed for this repo."); return 0; }
  const bad = [];
  let scanned = 0;
  for (const f of walk(ROOT)) {
    let st; try { st = fs.statSync(f); } catch { continue; }
    if (st.size > MAX_BYTES) continue;
    let text; try { text = fs.readFileSync(f, "utf8"); } catch { continue; }
    if (text.includes("\u0000")) continue;
    scanned++;
    for (const h of scanText(text, forbid)) bad.push({ file: path.relative(ROOT, f), ...h });
  }
  if (scanned === 0) { console.error("foreign-service-key gate: scanned 0 files - wrong directory? Failing rather than reporting a pass over nothing."); return 1; }
  if (!bad.length) { console.log(`foreign-service-key gate OK - ${scanned} files, no reference to ${forbid.join("/")} service-role keys.`); return 0; }
  for (const b of bad) console.error(`FAIL ${b.file}:${b.line} ${b.name} - ${b.problem}`);
  console.error(`\n${bad.length} problem(s). A public app must not hold another app's service-role key; use a narrow token route, or annotate with "// foreign-service-key-ok: <reason>".`);
  return 1;
}

import { fileURLToPath } from "node:url";
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exit(main());
