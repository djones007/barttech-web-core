#!/usr/bin/env node
// ---------------------------------------------------------------------------
// User-typed search term interpolated into a PostgREST filter.
//
// WHY THIS EXISTS
// `.or()` and `.ilike()` look symmetrical and are not. supabase-js appends an
// `.ilike()` pattern with `URLSearchParams.append`, so the value is percent-
// encoded and arrives as an opaque parameter. `.or()` appends ONE STRING that
// PostgREST then PARSES as a filter expression — so a comma in that string
// starts a new condition.
//
// Confirmed against a live instance on 2026-08-29:
//
//     or=(title.ilike.%a,b%)             -> 400 PGRST100
//     or=(title.ilike.%a%),or(id.gt.0)   -> PARSES, adds a second disjunct
//
// Five hand-rolled escapers existed across the estate when this gate was
// written. One stripped `%` and `,`; one escaped `%`, `_` and `\` but not `,`;
// one stripped `,()*`; two did nothing at all. Every one of them was somebody
// thinking about the problem and getting a different subset right, which is the
// signature of a rule that needs a shared implementation rather than more prose.
//
// WHAT THIS MATCHES
//
//   1. Interpolation into a like/ilike CONDITION STRING — `ilike.${x}` or
//      `ilike.%${x}%`. This is the injectable form, and it is matched wherever
//      it appears, because the condition is often built in an array and joined
//      into `.or()` later, several lines away from the `.or(` itself.
//      Fix: `.or(orIlikeContains(["col_a", "col_b"], term))`.
//
//   2. Interpolation into the `.ilike()` / `.like()` BUILDER pattern. Not
//      injectable, but `%` and `_` in the term are still LIKE wildcards, so a
//      customer called "50% Ltd" matches half the table.
//      Fix: `.ilike("name", `%${escapeLikeTerm(term)}%`)`.
//
// An interpolation already wrapped in the shared helpers passes. Filters on
// internal values — `.eq.${brandId}`, `.gte.${todayIso}` — are NOT matched and
// must not be: they were correct, and a gate that fires on correct code is one
// people learn to skim past.
//
// WAIVER
// A value that provably cannot contain a metacharacter — one matched out of a
// string by a narrow regex, say — is a real false positive. Annotate it:
//
//     // postgrest-filter-ok: ref is /^[0-9a-f]{8}$/ from TICKET_REF_PATTERN
//
// on the line itself or the line above. The reason is REQUIRED and a bare
// annotation fails, because "someone looked at this" and "someone decided this"
// must not be indistinguishable — same rule as the other gates here. Prefer
// escaping to waiving where escaping is a no-op: escaping hex costs nothing and
// survives someone widening the regex later.
// ---------------------------------------------------------------------------

import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();

/**
 * Defense-in-depth: `target` is always a path this script enumerated from
 * `git ls-files` in the same run, never external input — but static analysis
 * cannot see that provenance, and the check is cheap. Matches the containment
 * guard inlined in the other gates in this directory.
 */
function assertWithinRoot(root, target) {
  const base = path.resolve(root) + path.sep;
  const resolved = path.resolve(root, target);
  if (!resolved.startsWith(base)) {
    throw new Error(`refusing to read outside the scan root: ${target}`);
  }
  return resolved;
}

// `ilike.${` / `like.%${` — a value interpolated into a filter CONDITION.
const CONDITION = /(?:^|[^A-Za-z0-9_])i?like\.%?\$\{/;
// `.ilike("col", `...${` — a value interpolated into the builder's pattern arg.
const BUILDER = /\.i?like\(\s*['"][^'"]+['"]\s*,\s*`[^`]*\$\{/;
// Either shape is fine once the value goes through the shared module.
const SAFE = /orIlikeContains\(|orFilterLiteral\(|escapeLikeTerm\(/;

// The module that implements the rule, and the gates themselves, are exempt —
// their own text necessarily contains the pattern they describe.
const EXEMPT = /(^|\/)(postgrestFilters\.ts|postgrestFilters\.test\.ts)$|(^|\/)scripts\/check-/;

function trackedSourceFiles() {
  const out = execSync('git ls-files', { encoding: 'utf8' });
  return out
    .split('\n')
    .filter((f) => /\.(ts|tsx|js|mjs)$/.test(f))
    .filter((f) => !f.includes('node_modules/'))
    .filter((f) => !EXEMPT.test(f));
}

// `// postgrest-filter-ok: <reason>` — reason required, bare annotation fails.
const WAIVER = /\/\/\s*postgrest-filter-ok:\s*(\S.*)?$/;

const files = trackedSourceFiles();
const violations = [];
for (const file of files) {
  let src;
  try {
    src = fs.readFileSync(assertWithinRoot(ROOT, file), 'utf8');
  } catch {
    continue; // deleted between ls-files and read
  }
  const lines = src.split('\n');
  lines.forEach((line, i) => {
    if (SAFE.test(line)) return;
    const kind = CONDITION.test(line) ? 'or-filter' : BUILDER.test(line) ? 'like-pattern' : null;
    if (!kind) return;

    // Waiver on this line or the one above it.
    const waiver = WAIVER.exec(line) ?? WAIVER.exec(lines[i - 1] ?? '');
    if (waiver) {
      if ((waiver[1] ?? '').trim()) return;
      violations.push(`${file}:${i + 1}: [no-reason] postgrest-filter-ok with no reason given`);
      return;
    }
    violations.push(`${file}:${i + 1}: [${kind}] ${line.trim().slice(0, 110)}`);
  });
}

if (violations.length > 0) {
  console.error('User-supplied term interpolated into a PostgREST filter:\n');
  console.error(violations.join('\n'));
  console.error(
    '\n[or-filter] is an INJECTION: `.or()` is parsed as a filter expression, so a' +
      '\ncomma in the term appends conditions to the OR. Verified live —' +
      '\n  or=(title.ilike.%a%),or(id.gt.0) parses and broadens the result set.' +
      '\n  Fix: .or(orIlikeContains(["col_a", "col_b"], term))' +
      '\n' +
      '\n[like-pattern] is not injectable, but % and _ in the term are LIKE' +
      '\nwildcards, so "50% Ltd" silently matches half the table.' +
      '\n  Fix: .ilike("name", `%${escapeLikeTerm(term)}%`)' +
      '\n' +
      '\nBoth live in @/web-core/postgrestFilters. Do not hand-roll a sixth escaper.' +
      '\n' +
      '\n[no-reason] means the waiver annotation is there but says nothing. A' +
      '\nwaiver records a DECISION, so it must state why the value is safe:' +
      '\n  // postgrest-filter-ok: ref is /^[0-9a-f]{8}$/ from TICKET_REF_PATTERN'
  );
  process.exit(1);
}

console.log(`OK: no interpolated PostgREST filter terms (${files.length} files scanned)`);
