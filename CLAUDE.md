# barttech-web-core — shared web-helper submodule (`@barttech/web-core`)

The estate's single source of truth for cross-cutting web code (starting with
security primitives). Source-only, no build — mounted as a **git submodule** in
each brand site and transpiled by that site's Next.js build, exactly like
`barton-lms-engine`. **Not a deployable app — no Vercel project.**

## ⚠️ THIS REPO IS PUBLIC

`barttech-web-core` is a **public** GitHub repo (made public 2026-07-18 so consumers need no submodule auth token). **NEVER commit a secret, key, token value, DSN, `.env`, or anything brand-identifying/sensitive here.** Only generic, non-sensitive security *mechanisms* — the security of these functions comes from the secret keys they operate on (which live in each app's env vars), never from hiding this code. GitHub secret scanning + push protection **are NOT automatic — verify them.** This file previously claimed they were auto-enabled on public repos; on 2026-07-25 both were found **disabled** on this repo, i.e. it had been public since 2026-07-18 with no push protection at all. Enabled that day. Check with:
```bash
gh api repos/djones007/<repo> --jq '.security_and_analysis'
```
and enable via `gh api -X PATCH` if either reads `disabled`. Do not disable them.

## Golden rules

1. **Only genuinely-identical primitives belong here.** Brand-specific logic (per-product tokens, per-brand config, business rules) stays in the consuming repo's own `lib/`, which re-exports this module and adds its own helpers. Do not force differing rules through one flag-riddled function.
2. **`security.ts` is Node-runtime only** (imports Node `crypto`). Never import it from an Edge middleware/proxy — those keep a local WebCrypto helper.
3. **Fix once → propagate.** After committing + pushing a change here, run `tools/web-core-propagate.sh` from the Barttech OS root to bump every consumer's submodule pointer and redeploy. Never `vercel --prod` a consumer to pick up a bump (a CLI snapshot has no `.git`, so `fetch-submodules.sh` fails) — the git push is the only correct path.
4. **Keep the export surface backwards-compatible.** Consumers re-export this whole module; renaming/removing an export breaks every site at once. Add, don't break; deprecate before removing.
5. **Never add `import "server-only"` here — consumers add it in their own shim.** This module is
   consumed by non-Next code too, and `server-only` is in no consumer's `package.json` or lockfile;
   it resolves in a Next app **only because Next aliases it internally**. Adding it here would break
   every non-Next consumer, and a security review WILL periodically flag its absence in
   `bartmail.ts`/`audit.ts`/`reoon.ts` as a missing guard — it is not. The guard belongs one level
   up, as the first line of each repo's `lib/bartmail.ts` shim (rolled out estate-wide 2026-07-31;
   `dominic-jones-website` had it first, `graph.ts` documents the same reasoning inline). If you are
   about to "fix" this, you are about to break 14 builds.
6. **No React, ever.** This repo is framework-agnostic source. `consent.ts`/`adPlatforms.ts` own consent state, Consent Mode v2 signals, CSP host constants and tag loading — the cookie-banner **component** stays per-repo because brand styling differs. Related: **no tag IDs here** (public repo) — a `AW-…`/pixel id is always passed in by the consuming app from its own env var, and adding an ad platform is **one entry in `AD_PLATFORMS`**, never an estate-wide sweep. Never `declare global` for `gtag`/`fbq`: several consumers already declare those, and a second augmentation with a different signature is a hard TS error that breaks them on mount — use a local structural type + one cast (both modules do).

## Consumers (keep this list current — it drives the propagate script)

Modules: **sec** = security.ts, **val** = validation.ts, **bm** = bartmail.ts, **up** = uploads.ts, **aud** = audit.ts, **con** = consent.ts, **ads** = adPlatforms.ts, **em** = emailit.ts (transactional send transport, added 2026-07-30 — send-only, NOT the reverted audience-subscribe module), **gr** = graph.ts, **reo** = reoon.ts (email verification).

| Site | Mount path | Branch | Uses | Notes |
|------|-----------|--------|------|-------|
| ownerfoundry-website | `src/web-core` | main | sec, bm, em, gr | LMS private-submodule plumbing (predates public). `emailit.ts` shim keeps the Sentry escalation local (web-core carries no Sentry dep) |
| competition-engine | `src/web-core` | main | sec, val, bm, con, ads, em, reo | Was missing from this table AND `web-core-propagate.sh` until 2026-07-30 — a real consumer silently skipped by every propagate run. `lib/email.ts` wraps `em` with a BartMail brand lookup; sends via the v1 endpoint (passed explicitly, web-core defaults to v2) |
| support-engine | `src/web-core` | main | (audit modules) | Also missing from the propagate list until 2026-07-30 |
| lead-engine | `src/web-core` | main | sec, val, bm, up, aud, con, ads, reo | Added to `web-core-propagate.sh` on 2026-07-30 the evening it was scaffolded, but **missing from this table until 2026-07-31** — the inverse of the competition-engine case above and the same drift either way: the script and this list have to be updated in the same commit or one of them lies. The widest consumer surface of any repo — eight modules, all thin shims under `src/lib/`. `suppression.ts` and `pipeline.ts` are lead-engine's own logic and only *mention* web-core in comments; they are not shims |
| be-more-boundless | `web-core` | main | sec, bm | + local `signUpsellToken`/`verifyUpsellToken`; bartmail.ts is a verbatim copy of this repo's former canonical |
| chillingscreams-website | `web-core` | main | sec, bm, reo | canary for public-submodule rollout |
| cloud-plus-v2 | `src/web-core` | main | sec, val, bm | canonical security-reference repo; bartmail canary |
| command-center | `src/web-core` | **master** | sec | read-only `supabase/bartmail.ts` factory NOT folded (different purpose) |
| bartmail | `src/web-core` | main | sec | alias `timingSafeEqualStr`; local `verifyEmailitSignature` |
| chillingscreams-games | `web-core` | main | sec | alias `timingSafeStringEqual` |
| nuttyorange-games-website | `web-core` | main | sec, val, bm, reo | `registration-token.ts` (Edge) stays local, NOT via web-core |
| compare-it-support | `web-core` | main | bm | mounted for bartmail |
| berekindled | `web-core` | main | bm | mounted for bartmail |
| checkout-engine | `src/web-core` | main | sec, val, bm, em | the ORIGIN web-core's security.ts was copied from — now consumes it (closed the two-canonical-copies gap). `isTestModeToken` lives in web-core for this repo. `lib/email.ts` wraps `em` (brand config resolution local, transport shared). |
| dominic-jones-website | `web-core` | main | bm | shim keeps `import "server-only"`; uses `getBartmailClient` (web-core exports it as an alias); source of the `applyOptinTags`/`custom_fields` logic now in the canonical |
| barttech-next-template | `src/web-core` | main | sec, val, bm | THE SCAFFOLD — every new site inherits web-core from day one. No Vercel project (propagate script skips the deploy wait). New sites must `git submodule update --init` on clone — see the template's README/CLAUDE.md. |
| barttech-website | `web-core` | main | bm, con, ads | `lib/bartmail.ts` folded 2026-07-29 (was the last bespoke variant); its shim adds a local SSRF guard + `bartmailHealthPing`. `web-core/audit.ts` stays excluded in `tsconfig.json`. |
| barton-lms-engine | **none — host alias** | main | val, bm | **Consumer without a submodule.** It is itself a submodule (of OF + BMB), so mounting web-core inside it would mean NESTED submodules. Instead its route handlers import `@/web-core/*`, resolved by whichever **host** compiles it — the same mechanism it already uses for its own `@/lms/*` files. Consequence: **any host mounting the LMS engine must also mount web-core.** Nothing to bump here; it always gets whatever the host has, so it can never drift. Adopted 2026-07-25, replacing a duplicate `bartmail.ts` + `validation.ts`. |

**bartmail.ts NOT folded — one left:** command-center's read-only client factory (14-line, different purpose). Every other repo's bartmail.ts is a shim over this module.

**emailit.ts — two call sites deliberately NOT folded (2026-07-30):**
- **cloud-plus-v2's quote-send route** (`api/admin/quotes/[id]/send`): its claim-then-send idempotency depends on retrying ONLY confirmed 429s and never a thrown fetch (which may have reached Emailit → a retry can double-send). The shared module retries transport failures, so folding it would break that guarantee. The route's own comment says the same.
- **cloud-plus-v2's `supabase/functions/send-email` Deno edge function**: separate deploy pipeline (`supabase functions deploy`, not Vercel), and Supabase's bundler following a relative import out of `supabase/functions/` is unverified. The module itself is Deno-compatible (fetch-only), so folding is possible if someone wants to verify a deploy — until then the local copy stands, minus jitter.
- **bartmail** keeps its own `dispatchWithRetry()` deliberately: its send path is inseparable from `claimSendSlot()` pacing, `email_events` reservation rows and queue deferral. Fixes to backoff *policy* should be considered in both places.

barttech-website was the other one until **2026-07-29**, kept bespoke (REST-only, no `@supabase` dep) so a minimal corporate site stayed dependency-light. Folded because the cost of the copy finally showed: it silently dropped every UTM/referrer/`source_page` value its own form captured, and had neither the `quote_url` nor the `custom_fields` NOT NULL fix landed here that same day. A copy fails quietly — it keeps working while missing every later fix. The Supabase client is server-only, so the dependency costs the browser bundle nothing. **Its shim keeps two local exports:** an SSRF guard wrapping `bartmailOptin` (checks `BARTMAIL_SUPABASE_URL` really is a `*.supabase.co` host before a service-role key is sent to it — this module has no such check) and `bartmailHealthPing`. Lifting that guard into this module is the obvious next step but would throw on any consumer whose production env value doesn't match, so it needs all 13 live values audited first.

**Gotcha for OF/BMB (the two using `scripts/fetch-submodules.sh` for the private LMS submodule):** Vercel can restore a build cache that predates a web-core pointer bump, leaving `web-core/` EMPTY after `git submodule update --init` (it thinks it's already initialised) → every `@/web-core/*` import breaks, even with CI green. Their `fetch-submodules.sh` now has an empty-submodule-worktree guard (purge `.git/modules/<sub>` + `--force` re-init). Keep those two scripts in sync.

Each site's `security.ts` is a shim: `export * from "@/web-core/security"` (+ name aliases and/or brand-specific helpers). Route code imports `@/lib/security` and never needs to know about the submodule. **Mount is `src/web-core` when the site's `@/*` maps to `./src/*`, else `web-core` at repo root.**

## Adding a new consumer

1. `cd repos/<site> && git submodule add https://github.com/djones007/barttech-web-core.git <mount-path>` (inside `src/` if the site's `@/*` maps to `./src/*`, else repo root).
2. Convert the site's `lib/security.ts` into a shim: `export * from "@/web-core/security"` (+ `export { timingSafeTokenEqual as <localName> }` aliases if the site's call sites use a different name, so route imports don't change; keep any brand-specific/edge helpers local).
3. **CI:** add `submodules: recursive` to the repo's `actions/checkout` step in `.github/workflows/ci.yml` (public submodule → no token). **Vercel** clones public submodules natively — no `GITHUB_GIT_TOKEN` or `fetch-submodules.sh` needed. (OF/BMB predate this and still use the LMS private-submodule plumbing; it keeps working, just isn't required for a public submodule.)
4. Add the site to the table above and to `tools/web-core-propagate.sh`.

## Keeping This Skill Current

If you find anything in this file out of date during a run — a path, consumer, or step that changed — fix it here before finishing. Verify against the live system rather than trusting stale text.
