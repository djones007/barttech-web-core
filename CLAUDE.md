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

1b. **A module that imports a package NOT every consumer installs breaks every consumer that bumps.** Consumers vendor this repo as source and typecheck it with their own `tsc`, so a missing dependency is a build failure in a repo that never imports the module. For a long time the only external import here was `@supabase/supabase-js`, which every consumer happens to have — that made this invisible. `safeHtml.ts` (`isomorphic-dompurify`) was the first exception and it broke the template's build on the very first bump; 10 of 19 consumers would have failed the next `web-core-propagate.sh` run. Two things follow:
   - **Consumers must exclude the mount path from `tsconfig.json`'s root file set** (`"exclude": ["node_modules", "src/web-core"]` — read `.gitmodules` for the path, it differs per repo). Same reasoning as the ESLint exclusion already in place: this repo gates itself in its own CI, and a consumer should not re-check source it cannot edit. It does **not** blind the consumer to its own misuse — an imported file is still type-analysed, so passing a wrong option type to a web-core function still fails. Verified 2026-08-08.
   - **Adding a new external import here is a cross-repo change.** Say so in the changelog, and check whether consumers that will bump actually have the package.

1c. **A dependency can be unusable in a specific consumer.** `isomorphic-dompurify` pulls in jsdom, which hit an ESM/CommonJS conflict on Next 16 + Turbopack + Vercel serverless that threw at **module-load** time — 500-ing every request to the route, not just ones with work to do. That consumer uses `sanitize-html` for its webhook and this module for its page components. So: a green build proves nothing for a `ƒ` (server-rendered on demand) route; load the live path and check for a 200 rather than a 500. **Checking for the auth redirect is NOT sufficient and this was learned the hard way** — a dashboard layout redirects before the page body runs, so a signed-out request never reaches the failing import. A help page 500'd for four days behind exactly that check. Auth-gated routes must be verified SIGNED IN.
1d. **Two sanitisers, on purpose.** `safeHtml.ts` (DOMPurify/jsdom) and `safeHtmlNoDom.ts` (sanitize-html) uphold the same contract — `safeHtmlNoDom.test.ts` asserts they agree byte-for-byte. Use **`renderSafeHtmlNoDom` in any serverless or edge runtime**; rule 1c explains why the jsdom one cannot run there. `renderSafeHtml` stays for consumers rendering published content whose exact output was verified against DOMPurify — swapping the engine under a live blog is a silent content edit, not a refactor. Do not "consolidate" them without migrating consumers one at a time and diffing real rendered output.
2. **`security.ts` is Node-runtime only** (imports Node `crypto`). Never import it from an Edge middleware/proxy — those keep a local WebCrypto helper.
3. **Fix once → propagate.** After committing + pushing a change here, the private propagate tooling bumps every consumer's submodule pointer and redeploys. Never `vercel --prod` a consumer to pick up a bump (a CLI snapshot has no `.git`, so a submodule-fetch step fails) — a git push is the only correct path.
4. **Keep the export surface backwards-compatible.** Consumers re-export this whole module; renaming/removing an export breaks every site at once. Add, don't break; deprecate before removing.
5. **Never add `import "server-only"` here — consumers add it in their own shim.** This module is consumed by non-Next code too, and `server-only` is in no consumer's `package.json` or lockfile; it resolves in a Next app **only because Next aliases it internally**. Adding it here would break every non-Next consumer. The guard belongs one level up, as the first line of each consuming repo's own shim.
6. **No React, ever.** This repo is framework-agnostic source. `consent.ts`/`adPlatforms.ts` own consent state, Consent Mode v2 signals, CSP host constants and tag loading — the cookie-banner **component** stays per-repo because brand styling differs. Related: **no tag IDs here** (public repo) — an ad/analytics id is always passed in by the consuming app from its own env var, and adding an ad platform is **one entry in `AD_PLATFORMS`**, never an estate-wide sweep. Never `declare global` for `gtag`/`fbq`: several consumers already declare those, and a second augmentation with a different signature is a hard TS error that breaks them on mount — use a local structural type + one cast (both modules do).

## Adding a new consumer

1. `git submodule add https://github.com/<owner>/barttech-web-core.git <mount-path>` (inside `src/` if the site's `@/*` maps to `./src/*`, else repo root).
2. Convert the site's `lib/security.ts` into a shim: `export * from "@/web-core/security"` (+ `export { timingSafeTokenEqual as <localName> }` aliases if the site's call sites use a different name, so route imports don't change; keep any brand-specific/edge helpers local).
3. **CI:** add `submodules: recursive` to the repo's `actions/checkout` step in `.github/workflows/ci.yml` (public submodule → no token). **Vercel** clones public submodules natively — no token or fetch script needed.
3b. **Exclude the mount path from the consumer's `tsconfig.json`** (`"exclude": [..., "<mount>"]`) as well as its ESLint config — see golden rule 1b. Without it, the consumer's `tsc` typechecks every module here, including ones importing packages it has no reason to install.
4. Record the new consumer and its module usage in the private consumer map (see above) and in the propagate tooling.
5. **Register the resources the module owns** in that repo's `.shared-resources.json` (table name, endpoint, API path → owning module + a `reason`). The CI shim gate matches on FILENAME and is blind to the same logic written inline in a normally-named file — which is how three repos each grew their own cron-heartbeat writer inside `lib/cron.ts`, two of which then drifted on a column with nothing noticing. `scripts/check-shared-module-inlining.mjs` catches that, but it is **opt-in and silent without a config**, so an unregistered resource is an unguarded one. Match the *operation*, not just the name — the first cron-heartbeat rule matched any mention of the table and flagged two legitimate readers; the module owned the write.

## Keeping This Skill Current

If you find anything in this file out of date during a run — a path, mechanism, or step that changed — fix it here before finishing. Verify against the live system rather than trusting stale text.
