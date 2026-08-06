#!/usr/bin/env node
// ---------------------------------------------------------------------------
// Shared-module re-inlining gate.
//
// WHY THIS EXISTS, AND WHY THE EXISTING GATE IS NOT ENOUGH
// The web-core shim gate catches a local FILE that shadows a canonical module —
// it matches on basename, so a stray `security.ts` or `bartmail.ts` is caught.
// It is blind to the far more common way drift actually happens: someone writes
// the logic *inline*, inside a file with an ordinary name.
//
// That is exactly how the cron-heartbeat drift occurred. Three repos each had a
// `writeHeartbeat` inside `lib/cron.ts` — no file called `cronHeartbeat.ts`
// anywhere, so nothing flagged it. Two of the copies silently diverged on one
// column (`updated_at`), and the difference went unnoticed for as long as the
// column was only wrong and never read.
//
// This gate works on CONTENT, not filenames: it looks for direct use of the
// external resources a shared module owns — a table name, an endpoint — outside
// the shared module itself.
//
// THE RULE
// If a resource is listed in `.shared-resources.json`, the only sanctioned way
// to touch it is through the module that owns it. Reaching for the table or
// endpoint directly is what re-creates the copy.
//
// CONFIG — `.shared-resources.json` at the repo root:
//     {
//       "resources": [
//         {
//           "match": "cron_heartbeats",
//           "owner": "@/web-core/cronHeartbeat",
//           "reason": "three repos each grew their own upsert and two drifted"
//         }
//       ],
//       "allow": ["supabase/migrations/**", "src/web-core/**"]
//     }
//
// `match` is a regex tested against file content. `allow` is a list of glob-ish
// path prefixes/suffixes exempt from the check — migrations legitimately name
// the table, and the submodule IS the owner.
//
// A repo with no config file is skipped silently: this is opt-in per resource,
// because a list of every shared thing in the estate would go stale and a stale
// gate is worse than none.
//
// Exit codes: 0 = clean, or no config. 1 = a resource reached directly.
//
// Usage: node check-shared-module-inlining.mjs [rootDir]   (default: cwd)
// ---------------------------------------------------------------------------

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const ROOT = process.argv[2] || process.cwd();
const CONFIG = path.join(ROOT, ".shared-resources.json");

if (!fs.existsSync(CONFIG)) {
  console.log("Shared-module gate skipped — no .shared-resources.json in this repo.");
  process.exit(0);
}

let cfg;
try {
  cfg = JSON.parse(fs.readFileSync(CONFIG, "utf8"));
} catch (e) {
  // Fail loudly. An unreadable config silently downgrading to "clean" is the
  // same class of bug this gate exists to catch.
  console.log(`::error::.shared-resources.json is present but unparseable: ${e.message}`);
  process.exit(1);
}

const resources = Array.isArray(cfg.resources) ? cfg.resources : [];
const allow = Array.isArray(cfg.allow) ? cfg.allow : [];

if (!resources.length) {
  console.log("::error::.shared-resources.json defines no resources — remove the file or populate it.");
  process.exit(1);
}

function tracked() {
  try {
    return execFileSync("git", ["-C", ROOT, "ls-files", "*.ts", "*.tsx"], {
      encoding: "utf8",
      maxBuffer: 1 << 28,
    })
      .split("\n")
      .filter(Boolean);
  } catch {
    console.log("::error::Not a git repository, or `git ls-files` failed — cannot determine scope.");
    process.exit(1);
  }
}

/** Crude but sufficient: prefix, suffix, or `**` glob segment match. */
function allowed(rel) {
  return allow.some((pattern) => {
    const p = pattern.replace(/\*\*/g, "");
    return rel.startsWith(p) || rel.endsWith(p) || rel.includes(p);
  });
}

const findings = [];

for (const rel of tracked()) {
  if (allowed(rel)) continue;
  let src;
  try {
    src = fs.readFileSync(path.join(ROOT, rel), "utf8");
  } catch {
    continue;
  }

  for (const r of resources) {
    const rx = new RegExp(r.match);
    if (!rx.test(src)) continue;
    // Importing the owning module is the sanctioned path. A file that does that
    // may legitimately also mention the resource name in a comment.
    if (r.owner && src.includes(r.owner)) continue;

    const line = src.split("\n").findIndex((l) => rx.test(l)) + 1;
    findings.push({ file: rel, line, ...r });
  }
}

if (findings.length) {
  console.log(
    "::error::A shared resource is being reached directly instead of through the module that owns it." +
      " That is how a shared implementation gets quietly re-inlined and drifts — import the owner instead." +
      " If this use is genuinely legitimate (a migration, a read-only dashboard query), add its path to" +
      " `allow` in .shared-resources.json."
  );
  for (const f of findings) {
    console.log(`  ${f.file}:${f.line}  reaches "${f.match}" directly — owner is ${f.owner}`);
    if (f.reason) console.log(`      why this rule exists: ${f.reason}`);
  }
  process.exit(1);
}

console.log(
  `Shared-module gate OK — ${resources.length} resource(s) reached only through their owning module.`
);
