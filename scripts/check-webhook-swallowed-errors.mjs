#!/usr/bin/env node
// ---------------------------------------------------------------------------
// Webhook swallowed-error gate (WARN-ONLY unless --strict).
//
// WHY THIS EXISTS
// A webhook receiver that catches an error and then answers 2xx tells the
// provider "delivered". The provider stops retrying, and the failure exists
// nowhere except a console line. That is sometimes the right call (Shopify
// deletes a subscription after repeated non-2xx; an enrolment write that is
// not retry-safe must not be replayed) but it must be a DECISION that RAISES —
// an in-app alert, Sentry, a notify — never a silent fall-through. Surfaced by a
// receiver whose catch answered 200 on purpose: only the alert it raised made
// that safe.
//
// WHAT IT FLAGS
// For each webhook receiver (same detection as check-webhook-verification.mjs),
// parse the file with the TypeScript compiler and flag a `catch` block that
//   1. has no `throw`, and no call that reports the error (Sentry / capture* /
//      report* / notify* / raise* / alert* / console.error / logError), AND
//   2. the handler then answers 2xx: the catch itself returns a non-error
//      response, or it returns nothing and a later `return` in the same
//      function is a non-error response.
//
// WHAT IT DELIBERATELY DOES NOT FLAG
// A discarded Supabase mutation result. A 2026-09-30 calibration over all 16
// receivers flagged 4, every one a deliberate best-effort/cleanup write
// (webhook_logs inserts, webhook_events deletes, bookkeeping updates): 100%
// false positives. Only the catch-then-2xx shape is checked.
//
// ESCAPE
//     // webhook-200-ok: <why answering 2xx here is right, and what raises>
// The reason is required; a bare annotation is itself a finding.
//
// MODE
// Warn-only (exit 0) so it can be counted across the estate and annotated
// before anyone flips it. `--strict` exits 1 on findings. If `typescript`
// cannot be resolved from the repo (or this script's own repo) it prints a
// notice and exits 0 — a gate that cannot parse must say so, not pass silently
// by looking green: the notice is on stdout and names the reason.
//
// CONFIG (optional) — .webhook-auth-gate.json at the repo root, shared with
// check-webhook-verification.mjs:  { "roots": ["src/app", "app"], "ignore": [] }
// ---------------------------------------------------------------------------

import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const argv = process.argv.slice(2)
const strict = argv.includes('--strict')
const root = resolve(argv.find((a) => !a.startsWith('--')) || process.cwd())

function loadTypescript() {
  for (const base of [join(root, 'package.json'), fileURLToPath(import.meta.url)]) {
    try { return createRequire(base)('typescript') } catch { /* try the next place */ }
  }
  return null
}
const ts = loadTypescript()
if (!ts) {
  console.log('webhook-swallowed-errors: `typescript` could not be resolved from the repo or web-core — NOT CHECKED (this is not a pass).')
  process.exit(0)
}

let config = { roots: ['src/app', 'app'], ignore: [] }
const configPath = join(root, '.webhook-auth-gate.json')
if (existsSync(configPath)) {
  try { config = { ...config, ...JSON.parse(readFileSync(configPath, 'utf8')) } }
  catch { console.error(`webhook-swallowed-errors: ${configPath} is not valid JSON`); process.exit(2) }
}

const SIG_HEADERS = /['"`](?:stripe-signature|x-shopify-hmac-sha256|x-emailit-signature|x-hub-signature(?:-256)?|x-webhook-token|x-bartmail-signature|svix-signature|x-signature)['"`]/i
// A call that puts the failure somewhere a human or a monitor will see it.
const REPORTS = /(?:^|\.)(?:capture\w*|report\w*|notify\w*|raise\w*|alert\w*|logError|trackError|sentry\w*)$|^console\.error$|^Sentry\./i
const ERROR_RESPONSE = /status\s*:\s*[45]\d\d|\b[45]\d\d\s*\)|NextResponse\.error|Response\.error/
const RESPONSE_LIKE = /\b(?:NextResponse|Response)\b/

function walk(dir, out = []) {
  let entries
  try { entries = readdirSync(dir) } catch { return out }
  for (const e of entries) {
    if (e === 'node_modules' || e === '.next' || e === '.git' || e === 'dist') continue
    const p = join(dir, e)
    let st
    try { st = statSync(p) } catch { continue }
    if (st.isDirectory()) walk(p, out)
    else if (/^route\.(ts|js|tsx|mjs)$/.test(e)) out.push(p)
  }
  return out
}

function readWithinRoot(target) {
  const base = root + sep
  const resolved = resolve(root, target)
  if (!resolved.startsWith(base)) throw new Error(`refusing to read outside repo root: ${target}`)
  return readFileSync(resolved, 'utf8')
}

/** Nodes under `node`, not descending into nested functions (their returns are not this handler's). */
function walkOwn(node, fn) {
  ts.forEachChild(node, (c) => {
    if (ts.isFunctionLike(c)) return
    fn(c)
    walkOwn(c, fn)
  })
}

function callName(call) {
  return call.expression.getText().replace(/\s+/g, '')
}

function escalates(block) {
  let yes = false
  const check = (n) => {
    if (ts.isThrowStatement(n)) yes = true
    else if (ts.isCallExpression(n) && REPORTS.test(callName(n))) yes = true
  }
  check(block)
  // Nested arrow callbacks inside the catch (e.g. `.catch(() => notify())`) still count: search everything.
  const all = (n) => { check(n); ts.forEachChild(n, all) }
  all(block)
  return yes
}

const isOk2xx = (retText) => RESPONSE_LIKE.test(retText) && !ERROR_RESPONSE.test(retText)

function enclosingFunction(n) {
  for (let p = n.parent; p; p = p.parent) if (ts.isFunctionLike(p)) return p
  return null
}

const files = []
for (const r of config.roots) {
  const d = join(root, r)
  if (existsSync(d)) files.push(...walk(d))
}
if (!files.length) { console.log('webhook-swallowed-errors: no App Router routes found — nothing to check.'); process.exit(0) }

const ignoreRe = (config.ignore || []).map((p) =>
  new RegExp(p.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*/g, '.*').replace(/(?<!\.)\*/g, '[^/]*')))

const findings = []
let checked = 0

for (const file of files) {
  const rel = relative(root, file).split(sep).join('/')
  if (/\/cron\//.test(rel)) continue
  if (ignoreRe.some((r) => r.test(rel))) continue
  const raw = readWithinRoot(file)
  const looksLikeReceiver = /\/(?:webhooks?|hooks?)\//.test(rel) || /webhook/i.test(rel) || SIG_HEADERS.test(raw)
  if (!looksLikeReceiver) continue
  checked++

  const ann = raw.match(/(?:\/\/|--)[^\S\n]*webhook-200-ok[^\S\n]*:[^\S\n]*(\S.*)/i)
  if (ann && ann[1].trim()) continue
  if (/(?:\/\/|--)[^\S\n]*webhook-200-ok[^\S\n]*:?[^\S\n]*$/im.test(raw)) {
    findings.push({ rel, line: 1, why: 'bare "webhook-200-ok" annotation with no reason — a reason is required' })
    continue
  }

  const sf = ts.createSourceFile(file, raw, ts.ScriptTarget.Latest, true, /\.tsx$/.test(file) ? ts.ScriptKind.TSX : ts.ScriptKind.TS)
  const visit = (n) => {
    if (ts.isTryStatement(n) && n.catchClause) {
      const block = n.catchClause.block
      if (!escalates(block)) {
        const own = []
        walkOwn(block, (c) => { if (ts.isReturnStatement(c)) own.push(c) })
        let why = null
        if (own.length) {
          if (own.some((r) => r.expression && isOk2xx(r.expression.getText()))) why = 'the catch answers 2xx and reports nothing'
        } else {
          const fn = enclosingFunction(n)
          if (fn && fn.body) {
            const later = []
            walkOwn(fn.body, (c) => { if (ts.isReturnStatement(c) && c.getStart() >= n.getEnd()) later.push(c) })
            if (later.some((r) => r.expression && isOk2xx(r.expression.getText()))) why = 'the catch swallows the error and the handler falls through to a 2xx'
          }
        }
        if (why) {
          const { line } = sf.getLineAndCharacterOfPosition(n.catchClause.getStart())
          findings.push({ rel, line: line + 1, why })
        }
      }
    }
    ts.forEachChild(n, visit)
  }
  visit(sf)
}

if (findings.length) {
  const out = strict ? console.error : console.log
  out(`\n${strict ? '✗' : '⚠'} ${findings.length} webhook catch block${findings.length === 1 ? '' : 's'} answer 2xx without reporting the error.\n`)
  out('  The provider stops retrying and the failure exists nowhere a human or monitor sees.')
  out('  Report it (Sentry / notify / CC bell), throw, or return 4xx/5xx — or, if 2xx is deliberate:')
  out('      // webhook-200-ok: <why 2xx is right here, and what raises>\n')
  for (const f of findings) out(`  ${f.rel}:${f.line}\n      ${f.why}`)
  if (strict) process.exit(1)
  console.log('\n(warn-only: exit 0. Pass --strict to fail.)')
} else {
  console.log(`✓ webhook-swallowed-errors: ${checked} webhook receiver(s), no catch answers 2xx silently.`)
}
