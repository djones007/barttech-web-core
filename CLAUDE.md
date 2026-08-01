# barttech-web-core — shared web-helper submodule (`@barttech/web-core`)

The estate's single source of truth for cross-cutting web code (starting with
security primitives). Source-only, no build — mounted as a **git submodule** in
each consuming site and transpiled by that site's Next.js build. **Not a
deployable app — no Vercel project.**

## ⚠️ THIS REPO IS PUBLIC

`barttech-web-core` is a **public** GitHub repo (made public 2026-07-18 so consumers need no submodule auth token). **NEVER commit a secret, key, token value, DSN, `.env` value, customer data, brand name, internal repo name, domain, or any other estate-architecture detail here.** Only generic, non-sensitive security *mechanisms* belong in this repo — the security of these functions comes from the secret keys they operate on (which live in each app's own env vars), never from hiding this code. GitHub secret scanning + push protection **are NOT automatic — verify them**:
```bash
gh api repos/<owner>/<repo> --jq '.security_and_analysis'
```
and enable via `gh api -X PATCH` if either reads `disabled`. Do not disable them.

The consumer map (which repos mount this and how) is deliberately NOT
documented here — it lives in the private barttech-os root repo (`memory/`),
co-located with the propagate tooling.

## Golden rules

1. **Only genuinely-identical primitives belong here.** Brand-specific or product-specific logic (per-product tokens, per-brand config, business rules) stays in the consuming repo's own `lib/`, which re-exports this module and adds its own helpers. Do not force differing rules through one flag-riddled function.
2. **`security.ts` is Node-runtime only** (imports Node `crypto`). Never import it from an Edge middleware/proxy — those keep a local WebCrypto helper.
3. **Fix once → propagate.** After committing + pushing a change here, the private propagate tooling bumps every consumer's submodule pointer and redeploys. Never `vercel --prod` a consumer to pick up a bump (a CLI snapshot has no `.git`, so a submodule-fetch step fails) — a git push is the only correct path.
4. **Keep the export surface backwards-compatible.** Consumers re-export this whole module; renaming/removing an export breaks every site at once. Add, don't break; deprecate before removing.
5. **Never add `import "server-only"` here — consumers add it in their own shim.** This module is consumed by non-Next code too, and `server-only` is in no consumer's `package.json` or lockfile; it resolves in a Next app **only because Next aliases it internally**. Adding it here would break every non-Next consumer. The guard belongs one level up, as the first line of each consuming repo's own shim.
6. **No React, ever.** This repo is framework-agnostic source. `consent.ts`/`adPlatforms.ts` own consent state, Consent Mode v2 signals, CSP host constants and tag loading — the cookie-banner **component** stays per-repo because brand styling differs. Related: **no tag IDs here** (public repo) — an ad/analytics id is always passed in by the consuming app from its own env var, and adding an ad platform is **one entry in `AD_PLATFORMS`**, never an estate-wide sweep. Never `declare global` for `gtag`/`fbq`: several consumers already declare those, and a second augmentation with a different signature is a hard TS error that breaks them on mount — use a local structural type + one cast (both modules do).

## Adding a new consumer

1. `git submodule add https://github.com/<owner>/barttech-web-core.git <mount-path>` (inside `src/` if the site's `@/*` maps to `./src/*`, else repo root).
2. Convert the site's `lib/security.ts` into a shim: `export * from "@/web-core/security"` (+ `export { timingSafeTokenEqual as <localName> }` aliases if the site's call sites use a different name, so route imports don't change; keep any brand-specific/edge helpers local).
3. **CI:** add `submodules: recursive` to the repo's `actions/checkout` step in `.github/workflows/ci.yml` (public submodule → no token). **Vercel** clones public submodules natively — no token or fetch script needed.
4. Record the new consumer and its module usage in the private consumer map (see above) and in the propagate tooling.

## Keeping This Skill Current

If you find anything in this file out of date during a run — a path, mechanism, or step that changed — fix it here before finishing. Verify against the live system rather than trusting stale text.
