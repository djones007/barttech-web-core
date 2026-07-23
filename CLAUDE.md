# barttech-web-core — shared web-helper submodule (`@barttech/web-core`)

The estate's single source of truth for cross-cutting web code (starting with
security primitives). Source-only, no build — mounted as a **git submodule** in
each brand site and transpiled by that site's Next.js build, exactly like
`barton-lms-engine`. **Not a deployable app — no Vercel project.**

## ⚠️ THIS REPO IS PUBLIC

`barttech-web-core` is a **public** GitHub repo (made public 2026-07-18 so consumers need no submodule auth token). **NEVER commit a secret, key, token value, DSN, `.env`, or anything brand-identifying/sensitive here.** Only generic, non-sensitive security *mechanisms* — the security of these functions comes from the secret keys they operate on (which live in each app's env vars), never from hiding this code. GitHub secret scanning + push protection are auto-enabled on public repos; do not disable them.

## Golden rules

1. **Only genuinely-identical primitives belong here.** Brand-specific logic (per-product tokens, per-brand config, business rules) stays in the consuming repo's own `lib/`, which re-exports this module and adds its own helpers. Do not force differing rules through one flag-riddled function.
2. **`security.ts` is Node-runtime only** (imports Node `crypto`). Never import it from an Edge middleware/proxy — those keep a local WebCrypto helper.
3. **Fix once → propagate.** After committing + pushing a change here, run `tools/web-core-propagate.sh` from the Barttech OS root to bump every consumer's submodule pointer and redeploy. Never `vercel --prod` a consumer to pick up a bump (a CLI snapshot has no `.git`, so `fetch-submodules.sh` fails) — the git push is the only correct path.
4. **Keep the export surface backwards-compatible.** Consumers re-export this whole module; renaming/removing an export breaks every site at once. Add, don't break; deprecate before removing.

## Consumers (keep this list current — it drives the propagate script)

Modules: **sec** = security.ts, **val** = validation.ts, **bm** = bartmail.ts.

| Site | Mount path | Branch | Uses | Notes |
|------|-----------|--------|------|-------|
| ownerfoundry-website | `src/web-core` | main | sec, bm | LMS private-submodule plumbing (predates public) |
| be-more-boundless | `web-core` | main | sec, bm | + local `signUpsellToken`/`verifyUpsellToken`; bartmail.ts is a verbatim copy of this repo's former canonical |
| chillingscreams-website | `web-core` | main | sec, bm | canary for public-submodule rollout |
| cloud-plus-v2 | `src/web-core` | main | sec, val, bm | canonical security-reference repo; bartmail canary |
| command-center | `src/web-core` | **master** | sec | read-only `supabase/bartmail.ts` factory NOT folded (different purpose) |
| bartmail | `src/web-core` | main | sec | alias `timingSafeEqualStr`; local `verifyEmailitSignature` |
| chillingscreams-games | `web-core` | main | sec | alias `timingSafeStringEqual` |
| nuttyorange-games-website | `web-core` | main | sec, val, bm | `registration-token.ts` (Edge) stays local, NOT via web-core |
| compare-it-support | `web-core` | main | bm | mounted for bartmail |
| berekindled | `web-core` | main | bm | mounted for bartmail |
| checkout-engine | `src/web-core` | main | sec, val, bm | the ORIGIN web-core's security.ts was copied from — now consumes it (closed the two-canonical-copies gap). `isTestModeToken` lives in web-core for this repo. |
| dominic-jones-website | `web-core` | main | bm | shim keeps `import "server-only"`; uses `getBartmailClient` (web-core exports it as an alias); source of the `applyOptinTags`/`custom_fields` logic now in the canonical |
| barttech-next-template | `src/web-core` | main | sec, val, bm | THE SCAFFOLD — every new site inherits web-core from day one. No Vercel project (propagate script skips the deploy wait). New sites must `git submodule update --init` on clone — see the template's README/CLAUDE.md. |

**bartmail.ts NOT folded (deliberate — the only two left):** barttech-website's (bespoke REST variant, no `@supabase` dep, minimal corporate site), command-center's read-only client factory (14-line, different purpose). Every other repo's bartmail.ts is now a shim over this module.

**Gotcha for OF/BMB (the two using `scripts/fetch-submodules.sh` for the private LMS submodule):** Vercel can restore a build cache that predates a web-core pointer bump, leaving `web-core/` EMPTY after `git submodule update --init` (it thinks it's already initialised) → every `@/web-core/*` import breaks, even with CI green. Their `fetch-submodules.sh` now has an empty-submodule-worktree guard (purge `.git/modules/<sub>` + `--force` re-init). Keep those two scripts in sync.

Each site's `security.ts` is a shim: `export * from "@/web-core/security"` (+ name aliases and/or brand-specific helpers). Route code imports `@/lib/security` and never needs to know about the submodule. **Mount is `src/web-core` when the site's `@/*` maps to `./src/*`, else `web-core` at repo root.**

## Adding a new consumer

1. `cd repos/<site> && git submodule add https://github.com/djones007/barttech-web-core.git <mount-path>` (inside `src/` if the site's `@/*` maps to `./src/*`, else repo root).
2. Convert the site's `lib/security.ts` into a shim: `export * from "@/web-core/security"` (+ `export { timingSafeTokenEqual as <localName> }` aliases if the site's call sites use a different name, so route imports don't change; keep any brand-specific/edge helpers local).
3. **CI:** add `submodules: recursive` to the repo's `actions/checkout` step in `.github/workflows/ci.yml` (public submodule → no token). **Vercel** clones public submodules natively — no `GITHUB_GIT_TOKEN` or `fetch-submodules.sh` needed. (OF/BMB predate this and still use the LMS private-submodule plumbing; it keeps working, just isn't required for a public submodule.)
4. Add the site to the table above and to `tools/web-core-propagate.sh`.

## Keeping This Skill Current

If you find anything in this file out of date during a run — a path, consumer, or step that changed — fix it here before finishing. Verify against the live system rather than trusting stale text.
