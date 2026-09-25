#!/usr/bin/env node
/**
 * Gate: a PRODUCTION build must not ship placeholder legal pages.
 *
 * WHY THIS EXISTS
 * The shared scaffold ships /privacy, /terms and /disclaimer as deliberate placeholders ("TODO:
 * who we are", "[BRAND]", "[CONTACT EMAIL]"). A site launched from it went live with all three
 * still in place, plus the wrong company name in the footer, and nobody noticed until someone read
 * the rendered page. The build was green, the pages rendered, and a consumer-law page promising
 * nothing is worse than no page: it looks finished. `check-scaffold-metadata.mjs` deliberately does
 * not check legal body copy (it runs in every environment, and a gate that arrives red on work
 * nobody has scheduled gets muted). This gate is the other half, scoped to the moment it matters.
 *
 * WHEN IT FAILS
 *   - `VERCEL_ENV=production` (a Vercel production build), or `--strict` on the command line.
 *   Anywhere else (local, preview, CI) it prints the findings as warnings and exits 0, so work in
 *   progress is never blocked but is never silent either.
 *
 * WHAT IT CHECKS
 *   The page files for /privacy, /terms and /disclaimer (app router, with or without `src/`, any
 *   route group), and a seller-identity module if one exists (`lib/seller.ts`), for:
 *     - the word TODO,
 *     - bracketed scaffold placeholders: [BRAND], [CONTACT EMAIL], [COMPANY …], [ADDRESS …],
 *     - REPLACE_WITH_<TOKEN>.
 *   Comments are blanked first, so an explanatory comment never trips it; JSX text and string
 *   literals are what render, so they are what is checked.
 *
 * A repo whose package name ends in `-template` is the scaffold that OWNS these placeholders, and
 * is skipped (announced loudly). Waiver for a genuinely correct match, on or above the line:
 *
 *   // legal-placeholder-ok: <why>
 *
 * Usage: node check-legal-placeholders.mjs [repoDir] [--strict]
 * No git needed: `vercel --prod` uploads without .git, and this runs as a prebuild step there.
 */
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join, resolve, sep, relative } from "node:path";

const args = process.argv.slice(2);
const strictFlag = args.includes("--strict");
const ROOT = resolve(args.find((a) => !a.startsWith("--")) ?? process.cwd());
const STRICT = strictFlag || process.env.VERCEL_ENV === "production";

let pkgName = "";
try {
  pkgName = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).name ?? "";
} catch {
  /* not a Node repo; nothing below will match */
}
if (/-template$/.test(pkgName)) {
  console.log(`Legal-placeholder gate SKIPPED — package "${pkgName}" is the scaffold that owns the placeholders.`);
  console.log("::warning::If this is NOT a scaffold template, rename it in package.json; the gate is skipping this repo.");
  process.exit(0);
}

function withinRoot(p) {
  const base = ROOT + sep;
  const target = resolve(p);
  if (target !== ROOT && !target.startsWith(base)) throw new Error(`refusing to read outside repo root: ${p}`);
  return target;
}

/** Page files for the three legal routes, in any route group, under app/ or src/app/. */
function legalPageFiles() {
  const out = [];
  const routes = new Set(["privacy", "terms", "disclaimer"]);
  const walk = (dir, depth) => {
    if (depth > 4 || !existsSync(dir)) return;
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (!st.isDirectory()) continue;
      if (routes.has(name)) {
        for (const f of ["page.tsx", "page.jsx", "page.ts", "page.js", "page.mdx"]) {
          if (existsSync(join(full, f))) out.push(join(full, f));
        }
      } else if (/^\(.*\)$/.test(name)) {
        walk(full, depth + 1); // route groups are transparent in the URL
      }
    }
  };
  walk(join(ROOT, "src", "app"), 0);
  walk(join(ROOT, "app"), 0);
  for (const f of ["src/lib/seller.ts", "lib/seller.ts"]) if (existsSync(join(ROOT, f))) out.push(join(ROOT, f));
  return out;
}

function blankComments(src) {
  let out = "";
  let i = 0;
  let state = "code";
  while (i < src.length) {
    const c = src[i];
    const next = src[i + 1];
    if (state === "code") {
      if (c === "/" && next === "/" && src[i - 1] !== ":") { state = "line"; out += "  "; i += 2; continue; }
      if (c === "/" && next === "*") { state = "block"; out += "  "; i += 2; continue; }
      if (c === "'") { state = "single"; out += c; i++; continue; }
      if (c === '"') { state = "double"; out += c; i++; continue; }
      if (c === "`") { state = "template"; out += c; i++; continue; }
      out += c; i++; continue;
    }
    if (state === "line") {
      if (c === "\n") { state = "code"; out += c; i++; continue; }
      out += " "; i++; continue;
    }
    if (state === "block") {
      if (c === "*" && next === "/") { state = "code"; out += "  "; i += 2; continue; }
      out += c === "\n" ? "\n" : " "; i++; continue;
    }
    if (c === "\\") { out += src.slice(i, i + 2); i += 2; continue; }
    if ((state === "single" && c === "'") || (state === "double" && c === '"') || (state === "template" && c === "`")) state = "code";
    out += c; i++;
  }
  return out;
}

const PATTERNS = [
  { re: /\bTODO\b/, what: "TODO" },
  { re: /\[(BRAND|CONTACT[ _-]?EMAIL|COMPANY[^\]\n]*|ADDRESS[^\]\n]*|BRAND NAME)\]/, what: "bracketed placeholder" },
  { re: /\bREPLACE_WITH_[A-Z0-9_]+/, what: "REPLACE_WITH_ token" },
];
const WAIVER = /legal-placeholder-ok:\s*(\S.*)/;

const findings = [];
const files = legalPageFiles();
for (const file of files) {
  const raw = readFileSync(withinRoot(file), "utf8");
  const rawLines = raw.split("\n");
  const lines = blankComments(raw).split("\n");
  lines.forEach((line, idx) => {
    for (const { re, what } of PATTERNS) {
      const m = line.match(re);
      if (!m) continue;
      const waived = [rawLines[idx], rawLines[idx - 1]].some((l) => l && WAIVER.test(l));
      if (waived) continue;
      findings.push(`${relative(ROOT, file)}:${idx + 1}  ${what}: "${m[0]}"  →  ${line.trim().slice(0, 100)}`);
      break;
    }
  });
}

if (files.length === 0) {
  console.log("Legal-placeholder gate: no /privacy, /terms, /disclaimer page or seller module found — nothing to check.");
  process.exit(0);
}
if (findings.length === 0) {
  console.log(`Legal-placeholder gate: OK (${files.length} file(s) checked, no placeholders).`);
  process.exit(0);
}

const header = `${findings.length} placeholder(s) in the legal pages / seller identity:`;
if (STRICT) {
  console.log(`::error::Legal-placeholder gate FAILED — a production build cannot ship placeholder legal pages. ${header}`);
  for (const f of findings) console.log(`  ${f}`);
  console.log("Write the real /privacy, /terms and /disclaimer (seller identity from lib/seller.ts), or waive a correct match with `// legal-placeholder-ok: <why>`.");
  process.exit(1);
}
console.log(`::warning::Legal-placeholder gate (not a production build, so warning only). ${header}`);
for (const f of findings) console.log(`  ${f}`);
console.log("This FAILS a production build (VERCEL_ENV=production). Fill the legal pages before launch.");
process.exit(0);
