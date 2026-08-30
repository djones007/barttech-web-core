#!/usr/bin/env node
// ---------------------------------------------------------------------------
// Webhook authentication gate.
//
// WHY THIS EXISTS
// A webhook endpoint is a public, unauthenticated URL that performs privileged
// writes: marking an order paid, granting course access, recording a bounce.
// The ONLY thing separating a real provider event from anyone with curl is the
// signature check. Miss it and the endpoint does exactly what it was built to
// do, for anybody — no error, no anomaly, no failed test.
//
// Every provider signs, and every SDK ships the verifier. The failure is never
// "we could not verify", it is "nobody noticed this one did not".
//
// WHAT IT CHECKS
// For each webhook receiver — an App Router route whose path contains
// `webhook`/`hook`, or any route that reads a known signature header — require
// BOTH:
//
//   1. a verification call: Stripe `constructEvent`, an HMAC compared with
//      `timingSafeEqual`/`timingSafeTokenEqual`, or a `verify*Signature` helper
//   2. a rejection: a 400/401/403 response in the same file
//
// Requiring the rejection matters as much as the call. A verifier whose result
// is computed and then not acted on reads as secure and is not.
//
// IT ALSO REJECTS FAIL-OPEN VERIFICATION — the trapdoor variant. A route that
// skips the check when no secret is configured is secure only for as long as
// the secret stays configured; it converts a config gap into an auth bypass,
// silently, with a console.warn as the only trace. One route in this estate
// shipped exactly that, and the same shape had already cost six weeks of a dead
// integration elsewhere. A missing secret must be an OUTAGE (503), which is
// loud, not a bypass, which is not. Flagged pattern: a `secrets.length === 0` /
// `!secret` branch that warns and continues rather than returning.
//
// DELIBERATE EXCEPTIONS
// Some senders genuinely cannot sign — they only fetch a URL you configure, so
// a shared secret in the query string is the strongest control available. That
// is a real design decision, not an oversight, and it needs saying out loud:
//
//     // webhook-auth-ok: this vendor's webhook config is a single URL box with
//     // no header field, so a shared secret in the query string compared with
//     // timingSafeTokenEqual is the strongest control it can support
//
// The reason is required. A bare annotation fails — this gate exists because
// "it looked fine" is how an unauthenticated writer ships.
//
// CONFIG (optional) — .webhook-auth-gate.json at the repo root:
//     { "roots": ["src/app", "app"], "ignore": ["**/cron/**"] }
//
// Plain Node, no dependencies.
// ---------------------------------------------------------------------------

import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'

const root = process.argv[2] || process.cwd()

let config = { roots: ['src/app', 'app'], ignore: [] }
const configPath = join(root, '.webhook-auth-gate.json')
if (existsSync(configPath)) {
  try { config = { ...config, ...JSON.parse(readFileSync(configPath, 'utf8')) } }
  catch { console.error(`webhook-auth-gate: ${configPath} is not valid JSON`); process.exit(2) }
}

// Headers that mean "a provider is signing this request".
const SIG_HEADERS = /['"`](?:stripe-signature|x-shopify-hmac-sha256|x-emailit-signature|x-hub-signature(?:-256)?|x-webhook-token|x-bartmail-signature|svix-signature|x-signature)['"`]/i

// Evidence the signature is actually checked.
// Deliberately covers the naming variants actually in use rather than a tidy
// short list: `timingSafeEqualStr` and `verifySignedBody` are both real helpers
// here, and a stricter regex reported two correctly-verified money endpoints as
// unauthenticated during testing. A gate's false positives train people to
// suppress it, which is worse than the hole it watches for.
const VERIFIERS = /\b(?:constructEvent|timingSafeEqual[A-Za-z0-9_]*|timingSafeTokenEqual|verify[A-Za-z0-9_]*(?:Signature|Signed|Sig|Hmac|HMAC|Webhook|Token)[A-Za-z0-9_]*)\s*\(/

// Evidence an unverified request is turned away.
const REJECTS = /status:\s*(?:400|401|403)\b|NextResponse\.json\([^)]*\b(?:401|403|400)\b|new Response\([^)]*\b(?:401|403|400)\b/

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

// Blank comments and strings so their contents cannot satisfy a check — but
// keep the ORIGINAL for annotation lookup and for reading header names.
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, m => m.replace(/[^\n]/g, ' '))
            .replace(/(^|[^:])\/\/[^\n]*/g, (m, p) => p + ' '.repeat(m.length - p.length))
}

const files = []
for (const r of config.roots) {
  const d = join(root, r)
  if (existsSync(d)) files.push(...walk(d))
}
if (!files.length) { console.log('webhook-auth-gate: no App Router routes found — nothing to check.'); process.exit(0) }

const ignoreRe = (config.ignore || []).map(p =>
  new RegExp(p.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*/g, '.*').replace(/(?<!\.)\*/g, '[^/]*')))

const problems = []
let checked = 0

for (const file of files) {
  const rel = relative(root, file).split(sep).join('/')
  // A cron route that RETRIES deliveries is not a receiver — it is outbound.
  if (/\/cron\//.test(rel)) continue
  if (ignoreRe.some(r => r.test(rel))) continue

  const raw = readFileSync(file, 'utf8')
  const src = stripComments(raw)

  const looksLikeReceiver = /\/(?:webhooks?|hooks?)\//.test(rel) || /webhook/i.test(rel) || SIG_HEADERS.test(src)
  if (!looksLikeReceiver) continue

  // A route that only re-exports a shared handler is verified by that handler.
  const isThinReexport = /export\s+const\s+(?:POST|GET)\s*=\s*[A-Za-z0-9_]+\s*\(/.test(src) && raw.split('\n').filter(l => l.trim()).length <= 12
  if (isThinReexport) continue

  checked++

  // [^\S\n]* not \s* — \s matches newline, so `\s*(.+)` on a BARE annotation
  // swallowed the line break and captured the NEXT line as the reason, letting
  // an empty suppression through. Caught by the gate's own test suite.
  const ann = raw.match(/(?:\/\/|--)[^\S\n]*webhook-auth-ok[^\S\n]*:[^\S\n]*(\S.*)/i)
  if (ann && ann[1].trim()) continue
  if (raw.match(/(?:\/\/|--)[^\S\n]*webhook-auth-ok[^\S\n]*:?[^\S\n]*$/im)) {
    problems.push({ rel, why: 'bare "webhook-auth-ok" annotation with no reason — a reason is required' })
    continue
  }

  if (!VERIFIERS.test(src)) {
    problems.push({ rel, why: 'no signature/HMAC verification — this endpoint is public and performs privileged writes' })
    continue
  }
  if (!REJECTS.test(src)) {
    problems.push({ rel, why: 'verification is computed but nothing returns 400/401/403 — the result is not acted on' })
    continue
  }

  // FAIL-OPEN. Two earlier versions of this check were wrong in opposite
  // directions, and both were caught by running it over the real estate:
  //
  //   1. Matching the branch STRUCTURE (`secrets.length === 0` … console.warn …
  //      no return) was too brittle to fire on the very route that prompted
  //      this gate.
  //   2. Matching any warn containing "skip" fired on FOUR healthy routes —
  //      skipping an oversized attachment, a duplicate delivery, a purchase log
  //      for an unknown contact, a non-commissionable affiliate. None had
  //      anything to do with verification.
  //
  // So the message must mention BOTH the skipping AND what is being skipped:
  // verification, a signature, an HMAC, a secret. "duplicate delivery,
  // skipping" no longer matches; "No workspace webhook secret configured —
  // skipping HMAC verification" still does. A false positive here is not a
  // cosmetic problem — it teaches people to suppress the gate.
  const SKIPPING = /\b(?:skip\w*|unverified|without|bypass\w*|not? verif\w*)\b/i
  const WHAT = /\b(?:verif\w*|signature|hmac|secret|signing)\b/i
  for (const call of src.match(/console\.(?:warn|log|info)\([^;]{0,400}/gi) || []) {
    if (SKIPPING.test(call) && WHAT.test(call)) {
      problems.push({ rel, why: 'FAIL-OPEN: warns that it is skipping verification instead of refusing — a config gap becomes an auth bypass. Return 503 when the secret is missing.' })
      break
    }
  }
}

if (problems.length) {
  console.error(`\n✗ ${problems.length} webhook receiver${problems.length === 1 ? '' : 's'} with an authentication problem.\n`)
  console.error('  A webhook URL is public. The signature check is the only thing between a')
  console.error('  real provider event and anyone with curl.\n')
  for (const p of problems) console.error(`  ${p.rel}\n      ${p.why}`)
  console.error('\n  If the sender genuinely cannot sign, say so on the route, with a reason:')
  console.error('      // webhook-auth-ok: <what the sender can actually do, and the control used>\n')
  process.exit(1)
}

console.log(`✓ webhook-auth-gate: all ${checked} webhook receiver(s) verify and reject.`)
