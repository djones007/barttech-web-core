#!/usr/bin/env node
/**
 * Gate: every repo's vercel.json `ignoreCommand` is the canonical one, and a
 * repo that uploads a huge working folder carries a .vercelignore.
 *
 * Usage: node check-vercel-ignore.mjs [repoRoot]   (default: cwd)
 *
 * WHY: ignoreCommand used to be an inline string copied into ~40 repos. A fix
 * (Fix Engine 39be6bdb) meant editing all of them, and a drifted copy fails
 * silently: the site just stops deploying or deploys every markdown commit.
 * The logic now lives in scripts/vercel-ignore.sh; vercel.json holds a fixed
 * wrapper that must match byte for byte.
 *
 * CANONICAL forms (keep in step with tools/vercel-ignore-propagate.sh):
 *   WRAPPER  repos that mount web-core (src/web-core or web-core)
 *   INLINE   repos with no web-core submodule (the pre-fix command, kept)
 *
 * CHECKS
 *   1. vercel.json ignoreCommand equals WRAPPER (web-core repo) or INLINE.
 *   2. ignoreCommand is <= 256 characters (Vercel's cap).
 *   3. If the working folder holds more than HUGE_FILES files outside
 *      node_modules/.git/.next, or any single top-level directory over
 *      HUGE_BYTES, .vercelignore must exist. (CLI uploads ignore .gitignore
 *      once a .vercelignore exists, so it must also list the secrets/deps.)
 *   4. .vercelignore must exclude nested **\/node_modules (submodules carry
 *      their own installs: ~20k files in one site), .next, .env*, .git.
 *   5. .vercelignore must NOT exclude anything the build reads: src, public,
 *      package.json, lockfile, next.config.*, tsconfig.json, scripts, supabase.
 */
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const WRAPPER =
  'for p in src/web-core web-core; do [ -f $p/scripts/vercel-ignore.sh ] && { sh $p/scripts/vercel-ignore.sh; [ $? -eq 0 ] && exit 0; exit 1; }; done; exit 1';
export const INLINE =
  `case "$VERCEL_GIT_COMMIT_REF" in dependabot/*) exit 0 ;; esac; git diff --quiet HEAD^ HEAD -- ':(exclude,glob)*.md' ':(exclude,glob)**/CLAUDE.md' ':!.github' ':!docs' ':!tests' ':!.env.example' ':!.gitignore'`;
export const HUGE_FILES = 5000;
export const HUGE_BYTES = 1024 * 1024 * 1024; // 1 GiB
const SKIP = new Set(["node_modules", ".git", ".next", ".vercel"]);
const MUST_EXCLUDE = ["**/node_modules", ".next", ".env*", ".git"];
const MUST_NOT_EXCLUDE = ["src", "public", "package.json", "package-lock.json", "next.config.ts", "tsconfig.json", "scripts", "supabase", "tests"];

export function check(root) {
  const errs = [];
  const vj = join(root, "vercel.json");
  if (!existsSync(vj)) return errs; // not a Vercel site
  const ic = JSON.parse(readFileSync(vj, "utf8")).ignoreCommand;
  const hasWebCore = existsSync(join(root, "src/web-core/scripts/vercel-ignore.sh")) || existsSync(join(root, "web-core/scripts/vercel-ignore.sh"));
  const mounted = existsSync(join(root, "src/web-core")) || existsSync(join(root, "web-core"));
  const want = mounted ? WRAPPER : INLINE;
  if (ic === undefined) errs.push("vercel.json has no ignoreCommand");
  else if (ic !== want) errs.push(`ignoreCommand is not the canonical ${mounted ? "WRAPPER" : "INLINE"} command`);
  if (typeof ic === "string" && ic.length > 256) errs.push(`ignoreCommand is ${ic.length} chars (> 256 cap)`);
  if (ic === WRAPPER && !hasWebCore) errs.push("WRAPPER ignoreCommand but web-core submodule lacks scripts/vercel-ignore.sh (bump the submodule); it would build every push");

  // size / .vercelignore
  let files = 0, bigDir = null;
  const walk = (d, top) => {
    let n = 0;
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (SKIP.has(e.name)) continue;
      const p = join(d, e.name);
      if (e.isDirectory()) n += walk(p, top ?? e.name);
      else n++;
    }
    return n;
  };
  const du = (d) => {
    let b = 0;
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (SKIP.has(e.name)) continue;
      const p = join(d, e.name);
      try { b += e.isDirectory() ? du(p) : statSync(p).size; } catch { /* ignore */ }
    }
    return b;
  };
  files = walk(root, null);
  for (const e of readdirSync(root, { withFileTypes: true })) {
    if (e.isDirectory() && !SKIP.has(e.name) && du(join(root, e.name)) > HUGE_BYTES) bigDir = e.name;
  }
  const vi = join(root, ".vercelignore");
  // Submodules (src/web-core, src/app-ui ...) carry their OWN installed node_modules:
  // ~20k files in one repo. The CLI default ignore only drops the top-level one.
  const nested = [];
  const findNested = (d, depth) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (!e.isDirectory() || e.name === ".git" || e.name === ".next" || e.name === ".vercel") continue;
      const p = join(d, e.name);
      if (e.name === "node_modules") { if (depth > 0) nested.push(p.slice(root.length + 1)); continue; }
      if (depth < 4) findNested(p, depth + 1);
    }
  };
  findNested(root, 0);
  if (nested.length && !existsSync(vi)) errs.push(`nested node_modules would be uploaded by a CLI deploy (${nested.slice(0, 3).join(", ")}${nested.length > 3 ? ", ..." : ""}) and there is no .vercelignore with **/node_modules`);
  const huge = files > HUGE_FILES || bigDir;
  if (huge && !existsSync(vi)) errs.push(`working folder is huge (${files} files${bigDir ? `, ${bigDir}/ > 1 GiB` : ""}) and there is no .vercelignore: a CLI upload (vercel --prod) would send it all`);
  if (existsSync(vi)) {
    const lines = readFileSync(vi, "utf8").split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
    const norm = (l) => l.replace(/^\//, "").replace(/\/$/, "");
    const set = new Set(lines.map(norm));
    for (const m of MUST_EXCLUDE) if (!set.has(m)) errs.push(`.vercelignore does not exclude ${m}`);
    for (const m of MUST_NOT_EXCLUDE) if (set.has(m)) errs.push(`.vercelignore excludes ${m}, which the build reads`);
  }
  return errs;
}

if (import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const root = process.argv[2] ?? process.cwd();
  const errs = check(root);
  if (errs.length) {
    console.error("vercel-ignore gate FAILED:\n" + errs.map((e) => "  - " + e).join("\n"));
    process.exit(1);
  }
  console.log("vercel-ignore gate: ok");
}
