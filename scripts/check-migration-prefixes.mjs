#!/usr/bin/env node
// ---------------------------------------------------------------------------
// Migration-prefix duplicate gate.
//
// WHY THIS EXISTS
// A migration runner records what it applied by filename and assigns its
// own version/order independently of anything encoded in that filename — so
// the numeric or date prefix on a migration file is a label for humans, not
// a mechanism the runner relies on. That makes a duplicate prefix a silent
// labelling fault rather than a loud one: nothing rejects the second file,
// nothing reorders it, it just sits there reading as "this happened right
// after that other migration with the same number" when the two were
// written independently, sometimes months apart. Two unrelated migrations
// claiming `0053`, or two claiming the disambiguating letter `d` on the same
// date, is exactly the shape of mistake concurrent authors make without
// coordinating — and it goes unnoticed until someone reads the directory
// listing in prefix order and gets confused, or worse, assumes the prefix
// DOES control apply order and reasons about safety from it.
//
// THE RULE
// A migration filename's PREFIX is the leading digits, optionally followed
// by a single lowercase letter, before the first underscore:
//   `0053_foo.sql`        -> `0053`
//   `20260729_foo.sql`    -> `20260729`
//   `20260729d_foo.sql`   -> `20260729d`
//
// Two prefix shapes coexist by convention, and the uniqueness rule differs
// between them — this distinction is the entire point of this gate:
//
//   SEQUENTIAL (digits only, and the digit run is NOT exactly 8 characters —
//   covers short counters like `0053`/`0253` and long CLI-generated
//   timestamps alike): the prefix MUST be unique. Two files claiming the
//   same ordinal slot is the fault this gate exists to catch.
//
//   DATE-STYLE (the digit run is exactly 8 characters, `YYYYMMDD`),
//   optionally suffixed with one lowercase letter:
//     - WITH a letter (`20260729d`): MUST be unique. The letter's only job
//       is to disambiguate two migrations authored the same day — a second
//       file reusing that letter defeats the one thing it exists to do.
//     - WITHOUT a letter (`20260729`): duplicates are ALLOWED. Writing
//       several same-day migrations that all share the bare date is an
//       established, intentional convention in this estate, not a defect —
//       some repos carry seven-plus files on one bare date. Failing on
//       these would fire on every pre-existing same-day group and teach
//       everyone to ignore the gate. Only a repeated LETTER on the same
//       date is a real collision; the bare date repeating is not.
//
// WHY THIS ISN'T "JUST RENAME THE DUPLICATE"
// Renaming an already-applied migration file buys nothing — the runner
// ordered and deduped by its own assigned version, not the filename — and
// it can actively cost something: some runners record the applied
// migration's NAME (not just a version) in their own ledger table, using
// the filename verbatim. Renaming the file after the fact desyncs it from
// that recorded name, trading a harmless labelling fault for a real one.
// This gate flags the collision; it never decides the fix. Fixing it is
// exactly two choices — relabel a migration that has NOT shipped yet, or
// leave both alone and baseline the prefix once both are confirmed
// object-disjoint and already applied.
//
// ESCAPE HATCH
// A `.migration-prefix-baseline` file in the repo root, one prefix per line,
// each requiring a `# reason` comment:
//
//     0053   # both applied and object-disjoint; renaming would desync one from its ledger name
//
// A bare entry with no `# reason` does NOT suppress the finding — same
// contract as every other annotation-gated check in this repo. This stops
// the escape hatch being used to silence a real collision by dropping a
// prefix in with no explanation.
//
// WHAT THIS GATE CANNOT SEE
// It only reads filenames under `supabase/migrations/`. It has no idea
// whether two same-prefix files touch the same database objects — that
// judgement (object-disjoint, both already applied, safe to baseline) has
// to be made by hand before adding a baseline entry, the same way a font-CDN
// baseline entry requires confirming the code path is genuinely dead before
// listing it.
//
// Exit codes: 0 = no un-baselined duplicate prefix found.
//             1 = at least one found.
//
// Usage: node check-migration-prefixes.mjs [rootDir]   (default: cwd)
// ---------------------------------------------------------------------------

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";

const ROOT = process.argv[2] || process.cwd();

/**
 * Defense-in-depth: `target` is always discovered by this script's own
 * directory read, never external input, but static analysis cannot see
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

const PREFIX_RE = /^([0-9]+[a-z]?)_/;
const SQL_EXT = /\.sql$/;

function classify(prefix) {
  const digits = prefix.match(/^[0-9]+/)[0];
  const hasLetter = /[a-z]$/.test(prefix);
  if (digits.length === 8) {
    return hasLetter ? "date-lettered" : "date-unlettered";
  }
  return "sequential"; // any non-8-digit run of digits, lettered or not
}

/**
 * `.migration-prefix-baseline`: one prefix per line, `# reason` required.
 * A line with no `#`, or a `#` with nothing meaningful after it, is a bare
 * entry and must NOT suppress — mirrors the annotation-without-reason rule
 * used elsewhere in this directory.
 */
function loadBaseline(root) {
  const p = join(root, ".migration-prefix-baseline");
  if (!existsSync(p)) return new Set();
  const allowed = new Set();
  for (const raw of readWithinRoot(root, p).split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    const hashIdx = line.indexOf("#");
    if (hashIdx === -1) continue; // bare entry — does not suppress
    const prefix = line.slice(0, hashIdx).trim();
    const reason = line.slice(hashIdx + 1).trim();
    if (!prefix || !reason) continue; // no prefix or no reason — does not suppress
    allowed.add(prefix);
  }
  return allowed;
}

function listMigrationFiles(root) {
  const dir = join(root, "supabase", "migrations");
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile() && SQL_EXT.test(e.name))
    .map((e) => join(dir, e.name));
}

const baseline = loadBaseline(ROOT);
const files = listMigrationFiles(ROOT);

const byPrefix = new Map();
let checked = 0;

for (const file of files) {
  const rel = relative(ROOT, file);
  const name = file.split(sep).pop();
  const m = name.match(PREFIX_RE);
  checked++;
  if (!m) continue; // not a prefixed migration filename — nothing for this gate to compare
  const prefix = m[1];
  if (!byPrefix.has(prefix)) byPrefix.set(prefix, []);
  byPrefix.get(prefix).push(rel);
}

const findings = [];
let baselineUsed = 0;

for (const [prefix, relFiles] of byPrefix) {
  if (relFiles.length < 2) continue;
  const kind = classify(prefix);
  if (kind === "date-unlettered") continue; // allowed — established same-day convention
  if (baseline.has(prefix)) {
    baselineUsed++;
    continue;
  }
  findings.push({ prefix, kind, files: relFiles });
}

if (findings.length) {
  console.log(
    "::error::Duplicate migration prefix found. A sequential prefix (e.g. 0053) and a " +
      "lettered date prefix (e.g. 20260729d) must each be unique — a bare same-day date " +
      "with no letter is the only duplicate this gate allows. Rename the one that has NOT " +
      "shipped yet, or if both are already applied and confirmed to touch disjoint " +
      'database objects, add "<prefix>  # reason" to .migration-prefix-baseline.'
  );
  for (const f of findings) {
    console.log(`  [${f.kind}] ${f.prefix}`);
    for (const file of f.files) console.log(`    ${file}`);
  }
  process.exit(1);
}

console.log(
  `Migration-prefix gate OK — ${checked} file(s) checked, ${baselineUsed} baselined prefix(es).`
);
