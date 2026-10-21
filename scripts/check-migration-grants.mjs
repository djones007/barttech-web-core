#!/usr/bin/env node
// ---------------------------------------------------------------------------
// Migration table-grant gate.
//
// WHY THIS EXISTS
// From 2026-10-30 Supabase stops giving a table created in the `public` schema
// any automatic Data API grants. Before that date every new table silently
// inherited broad grants to anon / authenticated / service_role, so a migration
// that never mentioned GRANT still produced a table the app could read and
// write. After it, the same migration produces a table that exists, has the
// right columns, passes every schema check — and returns
//
//     permission denied for table <name>        (Postgres 42501)
//
// to supabase-js / PostgREST, including from the service_role client that
// server-side code assumes can do anything. Nothing fails at migrate time.
// The failure surfaces at the first real request, usually in production, and
// usually on a write path whose error is swallowed into a log line.
//
// The estate rule already says every table migration carries explicit GRANTs.
// A written rule did not stop it being forgotten before; this makes it a gate.
//
// WHAT IT CHECKS
// Replays every .sql file in supabase/migrations in filename order. For every
// `CREATE [UNLOGGED] TABLE [IF NOT EXISTS] <name>` that lands in `public`
// (schema-qualified `public.<name>`, or unqualified — Supabase migrations run
// with `public` first on the search_path), it requires a grant to
// `service_role` covering that table, found in the SAME file or a LATER one:
//
//   GRANT <privs> ON [TABLE] public.<name> [, ...] TO ... service_role ...
//   GRANT <privs> ON ALL TABLES IN SCHEMA public TO ... service_role ...
//       (must come AFTER the CREATE — it only covers tables that exist)
//   ALTER DEFAULT PRIVILEGES ... IN SCHEMA public GRANT ... ON TABLES
//       TO ... service_role ...
//       (in the same file, or a later one)
//
// `service_role` is the required minimum because it is the role every
// server-side client uses: a table with no service_role grant is unreachable
// from the app entirely. anon / authenticated grants are a per-table design
// decision and are not enforced here.
//
// Skipped: other schemas, TEMP tables, `PARTITION OF` children (reached through
// the parent's grants), and tables a later migration drops. A RENAME carries
// the obligation to the new name; a grant on either name satisfies it.
//
// GRANDFATHERING — ENFORCE_FROM_DATE
// Every table created before the gate existed is out of scope. Enforcement is
// decided per FILE from its filename prefix (the same prefix shapes
// check-migration-prefixes.mjs recognises):
//
//   * Date-style prefixes — `YYYYMMDD[_|letter]` (`20261021_x.sql`,
//     `20261021b_x.sql`) or a 14-digit CLI timestamp `YYYYMMDDHHMMSS_x.sql`:
//     enforced when the date part is >= ENFORCE_FROM_DATE. No config needed.
//
//   * Sequential prefixes — `0001_x.sql`, `0546_x.sql`: a counter carries no
//     date, and the commit date is not usable either (CI checks out shallow,
//     so every file looks added "today"). These are enforced from the number
//     set in `enforceFromSequence` in the config file below — set it once to
//     (highest existing prefix + 1). Until it is set, sequential files are NOT
//     checked and the gate says so on every run, rather than passing quietly.
//
//   * No numeric prefix: not checked, and counted in the summary.
//
// ENFORCE_FROM_DATE is the date this gate shipped (2026-10-21). Migrations
// already in a repo on that date are grandfathered; anything authored from it
// on must carry its grants. Do NOT move it later to make a failure go away —
// that silently ungates every repo at once. Fix the migration, or annotate.
//
// To audit a whole history regardless of cutoff:  --all
//
// DELIBERATE EXCEPTIONS
// A table genuinely meant to be unreachable through the Data API (reached only
// via SECURITY DEFINER functions, say) is annotated in the migration that
// creates it, on the CREATE line or within the 3 lines above:
//
//     -- grants-ok: only read via security-definer rpc, no Data API access
//
// The reason is required. A bare annotation fails the gate.
//
// CONFIG (optional) — .migration-grants-gate.json at the repo root:
//     { "migrationsDir": "supabase/migrations",
//       "enforceFromSequence": 546,
//       "ignoreTables": ["legacy_*"] }
//
// LIMITS
// It reads SQL text. A grant issued dynamically (EXECUTE format(...) inside a
// DO block) or applied outside migrations (dashboard, MCP) is invisible to it —
// annotate those. Pair with a live check against information_schema.
//
// Exit codes: 0 = every in-scope table has a service_role grant.
//             1 = at least one does not (or a bare annotation was found).
//             2 = config file is not valid JSON.
//
// Usage: node check-migration-grants.mjs [rootDir] [--all]   (default: cwd)
//
// Plain Node, no dependencies. Consumers fetch it from raw.githubusercontent in
// CI rather than embedding a copy, so tuning the rules fixes every repo at once.
// ---------------------------------------------------------------------------

import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'

// The date this gate shipped. See GRANDFATHERING above before touching it.
export const ENFORCE_FROM_DATE = '20261021'

const args = process.argv.slice(2)
const auditAll = args.includes('--all')
const root = args.find(a => !a.startsWith('--')) || process.cwd()

let config = { migrationsDir: 'supabase/migrations', ignoreTables: [], enforceFromSequence: null }
const configPath = join(root, '.migration-grants-gate.json')
if (existsSync(configPath)) {
  try { config = { ...config, ...JSON.parse(readFileSync(configPath, 'utf8')) } }
  catch { console.error(`migration-grants-gate: ${configPath} is not valid JSON`); process.exit(2) }
}

const migrationsDir = join(root, config.migrationsDir)
if (!existsSync(migrationsDir)) {
  console.log(`✓ migration-grants-gate: no ${config.migrationsDir} directory — nothing to check.`)
  process.exit(0)
}

// Defense-in-depth, same idiom as the rest of scripts/: file names come from
// this script's own directory read, but refuse to read outside the tree anyway.
function readWithin(dir, name) {
  const base = resolve(dir) + sep
  const full = resolve(dir, name)
  if (!full.startsWith(base)) throw new Error(`refusing to read outside migrations dir: ${name}`)
  return readFileSync(full, 'utf8')
}

const ignore = (config.ignoreTables || []).map(p =>
  new RegExp('^' + p.replace(/[.*+?^${}()|[\]\\]/g, m => (m === '*' ? '.*' : '\\' + m)) + '$', 'i'))

const seqFrom = config.enforceFromSequence == null ? null : Number(config.enforceFromSequence)
if (seqFrom != null && !Number.isFinite(seqFrom)) {
  console.error('migration-grants-gate: enforceFromSequence must be a number'); process.exit(2)
}

// --- scope ------------------------------------------------------------------

// 'date' | 'sequential' | 'none', and whether this file is enforced.
function fileScope(file) {
  const m = file.match(/^(\d+)([a-z])?_/)
  if (!m) return { kind: 'none', enforced: auditAll }
  const digits = m[1]
  if (digits.length === 8 || digits.length === 14) {
    return { kind: 'date', enforced: auditAll || digits.slice(0, 8) >= ENFORCE_FROM_DATE }
  }
  return { kind: 'sequential', enforced: auditAll || (seqFrom != null && Number(digits) >= seqFrom) }
}

// --- lexing -----------------------------------------------------------------

// Blank comments, string literals and dollar-quoted bodies so their contents
// can never match. Same length out as in, so line numbers stay accurate.
// Double-quoted IDENTIFIERS are kept — they are table names, not data.
function blank(sql) {
  let out = ''
  for (let i = 0; i < sql.length;) {
    const two = sql.slice(i, i + 2)
    let stop = -1
    if (two === '--') {
      const end = sql.indexOf('\n', i); stop = end === -1 ? sql.length : end
    } else if (two === '/*') {
      const end = sql.indexOf('*/', i + 2); stop = end === -1 ? sql.length : end + 2
    } else if (sql[i] === "'") {
      let j = i + 1
      while (j < sql.length) {
        if (sql[j] === "'" && sql[j + 1] === "'") { j += 2; continue }
        if (sql[j] === "'") break
        j++
      }
      stop = Math.min(j + 1, sql.length)
    } else if (sql[i] === '$') {
      const tag = sql.slice(i).match(/^\$[a-z_0-9]*\$/i)
      if (tag) {
        const end = sql.indexOf(tag[0], i + tag[0].length)
        stop = end === -1 ? sql.length : end + tag[0].length
      }
    }
    if (stop === -1) { out += sql[i]; i++; continue }
    out += sql.slice(i, stop).replace(/[^\n]/g, ' ')
    i = stop
  }
  return out
}

const IDENT = '(?:"[^"]+"|[a-z_][a-z0-9_$]*)'
const QNAME = `${IDENT}(?:\\s*\\.\\s*${IDENT})?`
const unq = s => s.trim().replace(/^"|"$/g, '')

// -> { schema, table } with schema defaulting to public; names lower-cased
// unless quoted (Postgres folds unquoted identifiers).
function parseName(raw) {
  const parts = raw.split(/\s*\.\s*/).map(p => (p.startsWith('"') ? unq(p) : p.toLowerCase()))
  return parts.length === 2 ? { schema: parts[0], table: parts[1] } : { schema: 'public', table: parts[0] }
}

const hasServiceRole = roles => /(^|[\s,])"?service_role"?(\s|,|$)/i.test(roles)

// --- replay -----------------------------------------------------------------

const files = readdirSync(migrationsDir).filter(f => f.toLowerCase().endsWith('.sql')).sort()
if (!files.length) {
  console.log('✓ migration-grants-gate: no .sql migrations found — nothing to check.')
  process.exit(0)
}

const pending = new Map()   // table -> { file, line }
const annotated = new Set() // "file:line"
const scopeCounts = { date: 0, sequential: 0, none: 0, enforced: 0 }
let checkedTables = 0

for (const file of files) {
  const raw = readWithin(migrationsDir, file)
  const sql = blank(raw)
  const lineAt = idx => sql.slice(0, idx).split('\n').length
  const scope = fileScope(file)
  scopeCounts[scope.kind]++
  if (scope.enforced) scopeCounts.enforced++

  raw.split('\n').forEach((text, i) => {
    const m = text.match(/--\s*grants-ok\b\s*:?\s*(.*)$/i)
    if (!m) return
    if (m[1].trim()) { for (let d = 0; d <= 3; d++) annotated.add(`${file}:${i + 1 + d}`) }
    else {
      console.error(`✗ ${file}:${i + 1}  bare "grants-ok" annotation with no reason — a reason is required.`)
      process.exitCode = 1
    }
  })

  // Collect every event in this file with its position, then apply in order.
  const events = []
  let m

  const ctRe = new RegExp(`\\bcreate\\s+(?:(global|local)\\s+)?(temp|temporary|unlogged\\s+)?\\s*table\\s+(?:if\\s+not\\s+exists\\s+)?(${QNAME})`, 'gi')
  while ((m = ctRe.exec(sql))) {
    if (m[2] && /temp/i.test(m[2])) continue
    const after = sql.slice(ctRe.lastIndex, ctRe.lastIndex + 400)
    if (/^\s*partition\s+of\b/i.test(after)) continue
    events.push({ pos: m.index, kind: 'create', name: parseName(m[3]) })
  }

  const grRe = /\bgrant\s+([^;]*?)\s+on\s+([^;]*?)\s+to\s+([^;]*?)(?:\bwith\s+grant\s+option\b)?\s*;/gi
  while ((m = grRe.exec(sql))) {
    if (!hasServiceRole(m[3])) continue
    const target = m[2].trim()
    // A grant inside ALTER DEFAULT PRIVILEGES is handled below.
    const before = sql.slice(Math.max(0, m.index - 300), m.index)
    if (/alter\s+default\s+privileges[^;]*$/i.test(before)) continue
    let am
    if ((am = target.match(/^all\s+tables\s+in\s+schema\s+([\s\S]+)$/i))) {
      const schemas = am[1].split(',').map(s => parseName(s.trim()).table)
      if (schemas.includes('public')) events.push({ pos: m.index, kind: 'grantAll' })
      continue
    }
    if (/^(function|functions|procedure|routine|sequence|all\s+(functions|sequences|routines|procedures)|schema|type|domain|database|language|large\s+object|foreign|tablespace)\b/i.test(target)) continue
    const list = target.replace(/^table\s+/i, '')
    for (const part of list.split(',')) {
      const n = part.trim(); if (!n) continue
      const name = parseName(n)
      events.push({ pos: m.index, kind: 'grant', name })
    }
  }

  const adpRe = /\balter\s+default\s+privileges\b([^;]*?)\bgrant\b([^;]*?)\bon\s+tables\s+to\s+([^;]*?);/gi
  while ((m = adpRe.exec(sql))) {
    if (!hasServiceRole(m[3])) continue
    const sch = m[1].match(/\bin\s+schema\s+([\s\S]+?)\s*$/i)
    if (sch && !sch[1].split(',').map(s => parseName(s.trim()).table).includes('public')) continue
    events.push({ pos: m.index, kind: 'adp' })
  }

  const dtRe = new RegExp(`\\bdrop\\s+table\\s+(?:if\\s+exists\\s+)?(${QNAME}(?:\\s*,\\s*${QNAME})*)`, 'gi')
  while ((m = dtRe.exec(sql))) {
    for (const n of m[1].split(',')) events.push({ pos: m.index, kind: 'drop', name: parseName(n.trim()) })
  }

  const rnRe = new RegExp(`\\balter\\s+table\\s+(?:if\\s+exists\\s+)?(?:only\\s+)?(${QNAME})\\s+rename\\s+to\\s+(${IDENT})`, 'gi')
  while ((m = rnRe.exec(sql))) {
    events.push({ pos: m.index, kind: 'rename', name: parseName(m[1]), to: parseName(m[2]).table })
  }

  events.sort((a, b) => a.pos - b.pos)
  let adpInFile = false
  for (const ev of events) {
    if (ev.kind === 'adp') {
      // Default privileges: covers every table created later in this file, and
      // (per the gate's contract) anything still pending from earlier files.
      adpInFile = true
      pending.clear()
    } else if (ev.kind === 'grantAll') {
      pending.clear()
    } else if (ev.kind === 'create') {
      if (ev.name.schema !== 'public') continue
      const t = ev.name.table
      if (!scope.enforced || adpInFile) continue
      if (ignore.some(r => r.test(t))) continue
      const line = lineAt(ev.pos)
      if (annotated.has(`${file}:${line}`)) continue
      checkedTables++
      pending.set(t, { file, line })
    } else if (ev.kind === 'grant') {
      if (ev.name.schema === 'public') pending.delete(ev.name.table)
    } else if (ev.kind === 'drop') {
      if (ev.name.schema === 'public') pending.delete(ev.name.table)
    } else if (ev.kind === 'rename') {
      if (ev.name.schema !== 'public') continue
      const p = pending.get(ev.name.table)
      if (p) { pending.delete(ev.name.table); pending.set(ev.to, p) }
    }
  }
}

// --- report -----------------------------------------------------------------

const scopeNote = []
if (scopeCounts.sequential && seqFrom == null && !auditAll) {
  scopeNote.push(`  ! ${scopeCounts.sequential} sequentially-numbered migration(s) are NOT checked — set "enforceFromSequence"`,
    `    in .migration-grants-gate.json to (highest existing prefix + 1) to gate new ones.`)
}
if (scopeCounts.none && !auditAll) scopeNote.push(`  ! ${scopeCounts.none} migration(s) with no numeric prefix are not checked.`)

if (pending.size) {
  console.error(`\n✗ ${pending.size} table${pending.size === 1 ? '' : 's'} created in public with no GRANT to service_role.\n`)
  console.error('  From 2026-10-30 Supabase gives new public tables no automatic Data API grants.')
  console.error('  Without one, supabase-js / PostgREST return "permission denied" — even with the')
  console.error('  service_role key.\n')
  for (const [t, p] of pending) {
    console.error(`  ${p.file}:${p.line}  public.${t}`)
    console.error(`      GRANT SELECT, INSERT, UPDATE, DELETE ON public.${t} TO service_role;`)
  }
  console.error('\n  Add anon / authenticated grants only if the table is meant to be reached by them.')
  console.error('  If the table is deliberately unreachable through the Data API, annotate its CREATE:')
  console.error('      -- grants-ok: <why no service_role grant is needed>\n')
  for (const l of scopeNote) console.error(l)
  process.exit(1)
}

console.log(`✓ migration-grants-gate: ${checkedTables} in-scope public table(s) across ${scopeCounts.enforced} of ${files.length} migrations have a service_role grant` +
  (auditAll ? ' (--all: cutoff ignored).' : ` (cutoff ${ENFORCE_FROM_DATE}).`))
for (const l of scopeNote) console.log(l)
