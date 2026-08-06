#!/usr/bin/env node
// ---------------------------------------------------------------------------
// Resource-registration gate — closes the loop on the inlining gate.
//
// WHY THIS EXISTS
// `check-shared-module-inlining.mjs` enforces the resources a repo has
// REGISTERED in its `.shared-resources.json`. It is opt-in and silent without a
// config, which leaves one hole wide open: nothing checks that you registered.
// A module promoted into web-core without its resources being registered
// downstream passes every gate in the estate, and the copy it was meant to
// prevent can quietly reappear.
//
// This closes it from the other end. The canonical list of what each module
// owns lives ONCE, in web-core's `shared-modules.json`, written by whoever
// promoted the module. This script reads that, works out which modules THIS
// repo actually imports, and fails if a consumed module's resources are not
// registered locally.
//
// So: promote a module and declare its resources → every consumer's next CI run
// tells them to register. No sweep, no remembering.
//
// THE PART THAT MAKES IT HONEST
// web-core's own CI fails if a module has NO manifest entry — including modules
// that own nothing, which must say so explicitly with a `why`. An empty
// `resources` is a decision; a missing entry is an oversight. If those two look
// the same, the manifest rots into a list of the things someone remembered.
//
// Exit codes: 0 = every consumed module's resources are registered.
//             1 = an unregistered resource, or an unreadable manifest.
//
// Usage: node check-resource-registration.mjs [rootDir] [--manifest <path>]
//        Without --manifest it fetches the canonical one from the public repo.
// ---------------------------------------------------------------------------

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const args = process.argv.slice(2);
const mIdx = args.indexOf("--manifest");
const manifestPath = mIdx >= 0 ? args[mIdx + 1] : null;
const ROOT = args.find((a, i) => !a.startsWith("--") && i !== mIdx + 1) || process.cwd();

const MANIFEST_URL =
  "https://raw.githubusercontent.com/djones007/barttech-web-core/main/shared-modules.json";

async function loadManifest() {
  if (manifestPath) return JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const res = await fetch(MANIFEST_URL);
  if (!res.ok) throw new Error(`manifest fetch returned HTTP ${res.status}`);
  return JSON.parse(await res.text());
}

function trackedSource() {
  try {
    return execFileSync("git", ["-C", ROOT, "ls-files", "*.ts", "*.tsx"], {
      encoding: "utf8",
      maxBuffer: 1 << 28,
    })
      .split("\n")
      .filter(Boolean)
      // the submodule mount is the source, not a consumer
      .filter((f) => !/(^|\/)(web-core|app-ui|node_modules)\//.test(f));
  } catch {
    console.log("::error::Not a git repository, or `git ls-files` failed.");
    process.exit(1);
  }
}

let manifest;
try {
  manifest = await loadManifest();
} catch (e) {
  // Never degrade to "clean". A gate that passes because it could not read its
  // own rules is the failure mode the estate keeps rediscovering.
  console.log(`::error::Could not load shared-modules.json — this check did NOT run: ${e.message}`);
  process.exit(1);
}

const modules = manifest.modules ?? {};
const configPath = path.join(ROOT, ".shared-resources.json");
let registered = [];
if (fs.existsSync(configPath)) {
  try {
    const cfg = JSON.parse(fs.readFileSync(configPath, "utf8"));
    registered = (cfg.resources ?? []).map((r) => r.match);
  } catch (e) {
    console.log(`::error::.shared-resources.json is unparseable: ${e.message}`);
    process.exit(1);
  }
}

// Which web-core modules does this repo actually import? Only those are its
// responsibility — a marketing site that never touches supportKb should not be
// asked to register a support table.
const files = trackedSource();
const consumed = new Set();
for (const rel of files) {
  let src;
  try {
    src = fs.readFileSync(path.join(ROOT, rel), "utf8");
  } catch {
    continue;
  }
  for (const name of Object.keys(modules)) {
    if (new RegExp(`web-core/${name}\\b`).test(src)) consumed.add(name);
  }
}

const missing = [];
for (const name of consumed) {
  for (const r of modules[name].resources ?? []) {
    if (!registered.includes(r.match)) missing.push({ module: name, ...r });
  }
}

if (missing.length) {
  console.log(
    "::error::This repo imports a shared module whose resources it has not registered." +
      " Until they are in .shared-resources.json, nothing stops that module's logic being" +
      " re-implemented inline here — which is exactly how the estate drifted before." +
      " Copy the entries below verbatim from web-core's shared-modules.json."
  );
  for (const m of missing) {
    console.log(`  ${m.module} — unregistered resource:`);
    console.log(`      "match": ${JSON.stringify(m.match)}`);
    console.log(`      why: ${m.reason}`);
  }
  console.log(
    "\n  If this repo genuinely diverges on purpose (a local implementation the shared one cannot" +
      " cover), register the resource anyway and `allow` the specific file — an explicit exception" +
      " with a reason, not silence."
  );
  process.exit(1);
}

const owning = [...consumed].filter((n) => (modules[n].resources ?? []).length);
console.log(
  `Resource-registration gate OK — ${consumed.size} web-core module(s) consumed, ` +
    `${owning.length} own resources, all registered.`
);
