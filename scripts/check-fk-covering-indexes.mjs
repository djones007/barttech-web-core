#!/usr/bin/env node
// ---------------------------------------------------------------------------
// Foreign-key covering-index gate.
//
// WHY THIS EXISTS
// Postgres creates an index for a PRIMARY KEY and for a UNIQUE constraint. It
// creates NOTHING for the referencing side of a FOREIGN KEY. Almost everyone
// assumes otherwise, because the constraint is declared right there in the
// CREATE TABLE and looks like it comes with its own machinery.
//
// It does not. Without a covering index on the referencing column:
//   * every ON DELETE / ON UPDATE check on the parent row full-scans the child
//   * every join or filter on that column full-scans the child
//
// This is silent. Nothing errors, no log line appears, and at a few thousand
// rows it is genuinely too fast to notice. It becomes a wall later, and the
// later it is noticed the bigger the table it has to be fixed on.
//
// THE INCIDENT
// An email-delivery table reached 1.7M rows carrying indexes on two columns
// only — the four foreign keys on it had none. Measured from pg_stat_statements
// at the point of discovery:
//
//     DELETE FROM <parent> WHERE id = $1
//       939 calls · 1268.8ms mean · 1,191 seconds of total database time
//     child table: 1,133 sequential scans, 1.25 BILLION rows read
//
// After adding one index the same lookup was an Index Only Scan: 3 buffers,
// 0.162ms. The fix was four lines. Finding it took a full audit, and it had been
// degrading for months while every dashboard stayed green — there is no error
// state for "correct, but scanning the whole table".
//
// A sweep the same day found the identical gap in three more databases: 130
// unindexed foreign keys in total. That is what makes this a gate rather than a
// fix — it was never one table's mistake, it was the default.
//
// NOTE ON SCOPE
// This replays migration files, so it only sees tables whose schema is in the
// repo. A table created outside the migration history is invisible to it — in
// the incident above, the worst-affected table predated its repo's migrations
// folder entirely. Pair this with a check that asks the live database.
//
// WHAT IT CHECKS
// Replays every file in supabase/migrations in filename order, tracking foreign
// keys and indexes as they are added and dropped, then reports any foreign key
// left without an index whose FIRST column is the referencing column. Leading
// column is what matters: an index on (a, b) covers a lookup on `a`, an index
// on (b, a) does not.
//
// Composite foreign keys are checked on their full leading-column prefix.
//
// DELIBERATE EXCEPTIONS
// A column you will genuinely never delete a parent of, or filter on, does not
// need the index — every index costs a write on every insert. Annotate it in
// the migration that creates the FK (on the line, or within the 3 lines above):
//
//     -- fk-index-ok: enum-like lookup table, rows are never deleted
//
// The reason is required. A bare annotation fails, for the same reason the
// gate exists: "it looked fine" is how the 1.25 billion row scan shipped.
//
// CONFIG (optional) — .fk-index-gate.json at the repo root:
//     { "migrationsDir": "supabase/migrations", "ignoreTables": ["legacy_*"] }
//
// Plain Node, no dependencies. Consumers fetch it from raw.githubusercontent in
// CI rather than embedding a copy, so tuning the rules fixes every repo at once.
// ---------------------------------------------------------------------------

import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const root = process.argv[2] || process.cwd()

let config = { migrationsDir: 'supabase/migrations', ignoreTables: [] }
const configPath = join(root, '.fk-index-gate.json')
if (existsSync(configPath)) {
  try { config = { ...config, ...JSON.parse(readFileSync(configPath, 'utf8')) } }
  catch { console.error(`fk-index-gate: ${configPath} is not valid JSON`); process.exit(2) }
}

const migrationsDir = join(root, config.migrationsDir)
if (!existsSync(migrationsDir)) {
  console.log(`fk-index-gate: no ${config.migrationsDir} directory — nothing to check.`)
  process.exit(0)
}

const ignore = (config.ignoreTables || []).map(p =>
  new RegExp('^' + p.replace(/[.*+?^${}()|[\]\\]/g, m => (m === '*' ? '.*' : '\\' + m)) + '$', 'i'))

// --- lexing helpers --------------------------------------------------------

// Blank comments and string literals so their contents can never match. Kept
// byte-for-byte the same length so annotation line numbers stay accurate.
function blank(sql) {
  let out = ''
  for (let i = 0; i < sql.length;) {
    const two = sql.slice(i, i + 2)
    if (two === '--') {
      const end = sql.indexOf('\n', i); const stop = end === -1 ? sql.length : end
      out += ' '.repeat(stop - i); i = stop
    } else if (two === '/*') {
      const end = sql.indexOf('*/', i + 2); const stop = end === -1 ? sql.length : end + 2
      out += sql.slice(i, stop).replace(/[^\n]/g, ' '); i = stop
    } else if (sql[i] === "'" || sql[i] === '"') {
      const q = sql[i]; let j = i + 1
      while (j < sql.length && sql[j] !== q) j += sql[j] === '\\' ? 2 : 1
      const stop = Math.min(j + 1, sql.length)
      out += sql.slice(i, stop).replace(/[^\n]/g, ' '); i = stop
    } else if (sql.startsWith('$$', i)) {
      const end = sql.indexOf('$$', i + 2); const stop = end === -1 ? sql.length : end + 2
      out += sql.slice(i, stop).replace(/[^\n]/g, ' '); i = stop
    } else { out += sql[i]; i++ }
  }
  return out
}

const norm = n => String(n || '').replace(/"/g, '').replace(/^[a-z_][a-z0-9_]*\./i, '').toLowerCase()
// An index body can be an EXPRESSION rather than a bare column. `((payload->>'status'))`
// normalises down to the fragment `(payload->>`, and interpolating that into a
// RegExp throws SyntaxError and takes the whole gate down with it — a crashed gate
// reports nothing about the FKs it never got to. Escape before building the pattern;
// bare column names contain no metacharacters, so this is a no-op for them.
const reEscape = n => String(n).replace(/[.*+?^${}()|[\]\\]/g, m => '\\' + m)
const cols = s => s.split(',').map(c => norm(c.trim().split(/\s+/)[0])).filter(Boolean)

// Extract the balanced-paren body starting at the '(' at or after `from`.
function parenBody(sql, from) {
  const start = sql.indexOf('(', from)
  if (start === -1) return null
  let depth = 0
  for (let i = start; i < sql.length; i++) {
    if (sql[i] === '(') depth++
    else if (sql[i] === ')') { depth--; if (depth === 0) return { body: sql.slice(start + 1, i), end: i } }
  }
  return null
}

// Split on commas that sit at paren depth 0.
function topLevelSplit(body) {
  const parts = []; let depth = 0, cur = ''
  for (const ch of body) {
    if (ch === '(') depth++
    else if (ch === ')') depth--
    if (ch === ',' && depth === 0) { parts.push(cur); cur = '' } else cur += ch
  }
  if (cur.trim()) parts.push(cur)
  return parts
}

// --- replay ----------------------------------------------------------------

const fks = new Map()      // "table.col" -> {table, colsKey, file, line}
const indexes = new Map()  // indexName -> {table, colsKey}
const inherent = new Set() // "table|a,b" from PK/UNIQUE (constraint-backed indexes)
const annotated = new Map()

function addIndexCols(table, columns, name) {
  if (!columns.length) return
  const key = `${table}|${columns.join(',')}`
  if (name) indexes.set(norm(name), { table, colsKey: key }); else inherent.add(key)
}

// Does anything cover `table` on the leading columns `columns`?
function covered(table, columns) {
  const want = columns.join(',')
  for (const key of inherent) {
    const [t, c] = key.split('|')
    if (t === table && (c === want || c.startsWith(want + ','))) return true
  }
  for (const { table: t, colsKey } of indexes.values()) {
    const c = colsKey.split('|')[1]
    if (t === table && (c === want || c.startsWith(want + ','))) return true
  }
  return false
}

const files = readdirSync(migrationsDir).filter(f => f.toLowerCase().endsWith('.sql')).sort()
if (!files.length) { console.log('fk-index-gate: no .sql migrations found — nothing to check.'); process.exit(0) }

for (const file of files) {
  const raw = readFileSync(join(migrationsDir, file), 'utf8')
  const sql = blank(raw)
  const rawLines = raw.split('\n')
  const lineAt = idx => sql.slice(0, idx).split('\n').length

  // annotations: "-- fk-index-ok: <reason>" — record the lines they cover
  rawLines.forEach((text, i) => {
    const m = text.match(/--\s*fk-index-ok\s*:\s*(.+)$/i)
    if (m && m[1].trim()) for (let d = 0; d <= 3; d++) annotated.set(`${file}:${i + 1 + d}`, m[1].trim())
    else if (text.match(/--\s*fk-index-ok\s*:?\s*$/i)) {
      console.error(`✗ ${file}:${i + 1}  bare "fk-index-ok" annotation with no reason — a reason is required.`)
      process.exitCode = 1
    }
  })

  // CREATE TABLE
  const ctRe = /create\s+table\s+(?:if\s+not\s+exists\s+)?([a-z0-9_."]+)/gi
  let m
  while ((m = ctRe.exec(sql))) {
    const table = norm(m[1])
    const p = parenBody(sql, ctRe.lastIndex)
    if (!p) continue
    for (const part of topLevelSplit(p.body)) {
      const t = part.trim(); if (!t) continue
      const lower = t.toLowerCase()
      let cm
      if ((cm = lower.match(/foreign\s+key\s*\(([^)]*)\)/))) {
        const c = cols(t.slice(cm.index + cm[0].indexOf('(') + 1, cm.index + cm[0].length - 1))
        if (c.length) fks.set(`${table}.${c.join(',')}`, { table, colsKey: c.join(','), file, line: lineAt(p.end) })
      } else if ((cm = lower.match(/^\s*(?:constraint\s+\S+\s+)?(?:primary\s+key|unique)\s*\(([^)]*)\)/))) {
        addIndexCols(table, cols(cm[1]), null)
      } else if (/^[a-z_"]/i.test(t)) {
        const col = norm(t.split(/\s+/)[0])
        if (/\breferences\b/.test(lower)) fks.set(`${table}.${col}`, { table, colsKey: col, file, line: lineAt(p.end) })
        if (/\b(primary\s+key|unique)\b/.test(lower)) addIndexCols(table, [col], null)
      }
    }
  }

  // ALTER TABLE ... — each action clause is evaluated on its own. Splitting on
  // top-level commas matters: `ADD COLUMN a text, ADD COLUMN b uuid REFERENCES x`
  // is one statement, and a naive scan credits the REFERENCES to column `a`.
  const atRe = /alter\s+table\s+(?:if\s+exists\s+)?(?:only\s+)?([a-z0-9_."]+)([\s\S]*?);/gi
  while ((m = atRe.exec(sql))) {
    let table = norm(m[1]); const line = lineAt(m.index)
    for (const clause of topLevelSplit(m[2])) {
      const t = clause.trim(); if (!t) continue
      let cm
      if ((cm = t.match(/^add\s+(?:constraint\s+\S+\s+)?foreign\s+key\s*\(([^)]*)\)/i))) {
        const c = cols(cm[1])
        if (c.length) fks.set(`${table}.${c.join(',')}`, { table, colsKey: c.join(','), file, line })
      } else if ((cm = t.match(/^add\s+(?:column\s+)?(?:if\s+not\s+exists\s+)?([a-z0-9_"]+)\s+([\s\S]*)$/i))
                 && !/^(constraint|primary|unique|foreign|check|exclude)$/i.test(cm[1])) {
        const col = norm(cm[1])
        if (/\breferences\b/i.test(cm[2])) fks.set(`${table}.${col}`, { table, colsKey: col, file, line })
        if (/\b(primary\s+key|unique)\b/i.test(cm[2])) addIndexCols(table, [col], null)
      } else if ((cm = t.match(/^add\s+(?:constraint\s+\S+\s+)?(?:primary\s+key|unique)\s*\(([^)]*)\)/i))) {
        addIndexCols(table, cols(cm[1]), null)
      } else if ((cm = t.match(/^drop\s+column\s+(?:if\s+exists\s+)?([a-z0-9_"]+)/i))) {
        fks.delete(`${table}.${norm(cm[1])}`)
      } else if ((cm = t.match(/^drop\s+constraint\s+(?:if\s+exists\s+)?([a-z0-9_"]+)/i))) {
        // An FK dropped by name: we do not track constraint names, so re-check
        // happens naturally if it is re-added. Nothing to do.
      } else if ((cm = t.match(/^rename\s+to\s+([a-z0-9_."]+)/i))) {
        // Follow the rename so later migrations' indexes are credited correctly.
        const to = norm(cm[1])
        for (const [k, v] of [...fks]) if (v.table === table) {
          fks.delete(k); v.table = to; fks.set(`${to}.${v.colsKey}`, v)
        }
        for (const [k, v] of [...indexes]) if (v.table === table) {
          indexes.set(k, { table: to, colsKey: `${to}|${v.colsKey.split('|')[1]}` })
        }
        for (const key of [...inherent]) {
          const [tt, cc] = key.split('|')
          if (tt === table) { inherent.delete(key); inherent.add(`${to}|${cc}`) }
        }
        table = to
      } else if ((cm = t.match(/^rename\s+(?:column\s+)?([a-z0-9_"]+)\s+to\s+([a-z0-9_"]+)/i))) {
        const from = norm(cm[1]), to = norm(cm[2])
        const v = fks.get(`${table}.${from}`)
        if (v) { fks.delete(`${table}.${from}`); v.colsKey = to; fks.set(`${table}.${to}`, v) }
      }
    }
  }

  // CREATE INDEX
  const ciRe = /create\s+(unique\s+)?index\s+(?:concurrently\s+)?(?:if\s+not\s+exists\s+)?([a-z0-9_."]+)\s+on\s+(?:only\s+)?([a-z0-9_."]+)(?:\s+using\s+\w+)?\s*\(/gi
  while ((m = ciRe.exec(sql))) {
    const p = parenBody(sql, m.index + m[0].length - 1)
    if (!p) continue
    const columns = topLevelSplit(p.body).map(c => norm(c.trim().split(/\s+/)[0])).filter(Boolean)

    // A partial index covers only the rows matching its predicate, so as a rule
    // it cannot serve a foreign key. The ONE exception is the common sparse-FK
    // idiom `WHERE <col> IS NOT NULL`: the FK check is `WHERE col = $1`, and `=`
    // is strict, so that predicate implies IS NOT NULL and Postgres proves the
    // implication. Verified on the live databases — both such indexes produced
    // `Index Only Scan` for the FK-shaped lookup. Any other predicate leaves
    // rows unindexed and is not accepted.
    const tail = sql.slice(p.end + 1, p.end + 300)
    const where = tail.match(/^\s*where\s+([\s\S]*?)(?:;|$)/i)
    if (where) {
      const pred = where[1].trim().replace(/^\(+|\)+$/g, '').trim().toLowerCase()
      const sparse = new RegExp(`^${reEscape(columns[0])}\\s+is\\s+not\\s+null$`, 'i')
      if (!sparse.test(pred)) continue
    }
    addIndexCols(norm(m[3]), columns, m[2])
  }

  // DROP INDEX / DROP TABLE
  let dm
  const diRe = /drop\s+index\s+(?:concurrently\s+)?(?:if\s+exists\s+)?([a-z0-9_.",\s]+?)\s*;/gi
  while ((dm = diRe.exec(sql))) for (const n of dm[1].split(',')) indexes.delete(norm(n.trim()))
  const dtRe = /drop\s+table\s+(?:if\s+exists\s+)?([a-z0-9_."]+)/gi
  while ((dm = dtRe.exec(sql))) {
    const t = norm(dm[1])
    for (const k of [...fks.keys()]) if (fks.get(k).table === t) fks.delete(k)
    for (const [k, v] of [...indexes]) if (v.table === t) indexes.delete(k)
  }
}

// --- report ----------------------------------------------------------------

const missing = []
for (const fk of fks.values()) {
  if (ignore.some(r => r.test(fk.table))) continue
  if (covered(fk.table, fk.colsKey.split(','))) continue
  if (annotated.has(`${fk.file}:${fk.line}`)) continue
  missing.push(fk)
}

if (missing.length) {
  console.error(`\n✗ ${missing.length} foreign key${missing.length === 1 ? '' : 's'} with no covering index.\n`)
  console.error('  Postgres does not index the referencing side of a foreign key. Without one,')
  console.error('  every parent delete and every join on this column scans the whole child table.\n')
  for (const fk of missing) {
    const c = fk.colsKey.split(',')
    console.error(`  ${fk.file}:${fk.line}  ${fk.table}(${fk.colsKey})`)
    console.error(`      CREATE INDEX IF NOT EXISTS idx_${fk.table}_${c.join('_')} ON public.${fk.table} (${c.join(', ')});`)
  }
  console.error('\n  On a table that already has significant rows, apply it live with')
  console.error('  CREATE INDEX CONCURRENTLY so writes are not blocked.')
  console.error('\n  If an index is genuinely not wanted, annotate the FK in its migration:')
  console.error('      -- fk-index-ok: <why this column never needs one>\n')
  process.exit(1)
}

console.log(`✓ fk-index-gate: all ${fks.size} foreign keys across ${files.length} migrations have a covering index.`)
