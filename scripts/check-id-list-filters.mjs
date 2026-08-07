#!/usr/bin/env node
// ---------------------------------------------------------------------------
// Unbounded-id-list-as-a-query-filter gate.
//
// WHY THIS EXISTS
// PostgREST imposes two separate caps, and fixing one leads straight into the
// other.
//
//   Cap 1 — a request returns at most 1000 rows. An unpaginated .select()
//   silently returns the first 1000 and reports success. That is the cap most
//   people know about, and the usual fix is to paginate with .range() and
//   collect the ids into an array.
//
//   Cap 2 — that array then goes back into the request URL as a filter, and
//   the URL is small. Measured with `id=not.in.(<uuids>)`:
//
//       1,000 ids ->  39 KB -> HTTP 400
//       3,000 ids -> 117 KB -> connection failure
//       9,500 ids -> 369 KB -> connection failure
//
//   So any filter over a set of more than a few hundred ids is already past
//   the cliff — including code written specifically to fix Cap 1.
//
// The lesson: paginating a read and then using the result as a filter does not
// fix anything — it relocates the failure. Filter in Postgres instead, with one
// RPC holding the whole predicate.
//
// A set-returning RPC (`returns setof <type>`) is NOT exempt from Cap 1 — it is
// a row set like any table read. Only a single-row aggregate (`returns jsonb`
// with jsonb_agg) escapes it. Verify set-returning RPCs through PostgREST, not
// in the SQL editor, where the truncation is invisible.
//
// WHAT THIS MATCHES
// Only the interpolated form, which is always this pattern and never anything
// else:
//
//     query.not('id', 'in', `(${someArray.join(',')})`)
//
// A literal list (`.in('id', ['a','b'])`) and a page-scoped list (the 50 ids
// on screen) are fine and are deliberately NOT flagged — the point is unbounded
// sets, not every use of .in().
//
// Note this gate cannot see the other half of the pattern: `.in('id', ids)`
// where `ids` was built by a pagination loop looks identical to a safe
// page-scoped list. Reviewing where an id array comes from is still a human job.
// ---------------------------------------------------------------------------

import { execSync } from 'node:child_process';
import fs from 'node:fs';

const PATTERN = /\.(not|in)\(\s*['"][a-z_]*id['"]\s*,[\s\S]*`\(\$\{/;

function trackedSourceFiles() {
  const out = execSync('git ls-files', { encoding: 'utf8' });
  return out
    .split('\n')
    .filter((f) => /\.(ts|tsx|js|mjs)$/.test(f))
    .filter((f) => !f.includes('node_modules/'))
    .filter((f) => !f.startsWith('scripts/check-'));
}

const violations = [];
for (const file of trackedSourceFiles()) {
  let src;
  try {
    src = fs.readFileSync(file, 'utf8');
  } catch {
    continue; // deleted between ls-files and read
  }
  src.split('\n').forEach((line, i) => {
    if (PATTERN.test(line)) {
      violations.push(`${file}:${i + 1}: ${line.trim().slice(0, 110)}`);
    }
  });
}

if (violations.length > 0) {
  console.error('Interpolated id list used as a PostgREST filter:\n');
  console.error(violations.join('\n'));
  console.error(
    '\nAn id array in the request URL breaks at ~1,000 ids (39KB -> HTTP 400) and' +
      '\nfails at the connection level past ~100KB. Move the predicate into an RPC.' +
      '\nA set-returning RPC is NOT exempt from the 1000-row cap — only a single-row' +
      '\njsonb aggregate escapes it. Verify through PostgREST, not the SQL editor.'
  );
  process.exit(1);
}

console.log(`OK: no interpolated id-list filters (${trackedSourceFiles().length} files scanned)`);
