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

| Site | Mount path | Import |
|------|-----------|--------|
| ownerfoundry-website | `src/web-core` | `@/web-core/security` |
| be-more-boundless | `web-core` | `@/web-core/security` |

Each site's `lib/security.ts` is a shim: `export * from "@/web-core/security"` (+ any brand-specific helpers). Route code imports `@/lib/security` and never needs to know about the submodule.

## Adding a new consumer

1. `cd repos/<site> && git submodule add https://github.com/djones007/barttech-web-core.git <mount-path>` (inside `src/` if the site's `@/*` maps to `./src/*`, else repo root).
2. Convert the site's `lib/security.ts` into a shim: `export * from "@/web-core/security"` (+ `export { timingSafeTokenEqual as <localName> }` aliases if the site's call sites use a different name, so route imports don't change; keep any brand-specific/edge helpers local).
3. **CI:** add `submodules: recursive` to the repo's `actions/checkout` step in `.github/workflows/ci.yml` (public submodule → no token). **Vercel** clones public submodules natively — no `GITHUB_GIT_TOKEN` or `fetch-submodules.sh` needed. (OF/BMB predate this and still use the LMS private-submodule plumbing; it keeps working, just isn't required for a public submodule.)
4. Add the site to the table above and to `tools/web-core-propagate.sh`.

## Keeping This Skill Current

If you find anything in this file out of date during a run — a path, consumer, or step that changed — fix it here before finishing. Verify against the live system rather than trusting stale text.
