# @barttech/web-core

Shared web helpers for the Barttech estate — the **single source of truth** for
cross-cutting code that was previously copy-pasted into every brand site (and
drifted out of sync). Fix once here, propagate to every consumer.

This is a **source-only** repo — nothing here is built or published. It is mounted
into each consuming site as a **git submodule** and transpiled by that site's
Next.js build, exactly like `barton-lms-engine`.

It does now carry a dev-only toolchain (`tsconfig.json`, `eslint.config.mjs`, and
devDependencies) purely so it can check **itself** in CI — `npm run lint` and
`npm run typecheck`, both `noEmit`. None of that reaches consumers: they never
install this package's dependencies, and `node_modules/` is gitignored, so the
submodule checkout in `src/web-core` stays source-only exactly as before.

**Why it has its own CI (added 2026-07-25):** before this, web-core was linted only
as a side effect of being vendored into 9 consuming repos. That meant a lint error
introduced here turned 9 builds red simultaneously, against files none of those
repos may edit — a fix made in a consumer's copy is lost on the next pointer bump.
The gate belongs where the source lives. Consumers now exclude `src/web-core/**`
from their own lint.

## What lives here

| File | Exports |
|------|---------|
| `security.ts` | `escHtml`, `timingSafeTokenEqual`, `verifyHmacSignature`, `isSafePathSegment`, `safeRedirectPath`, `isHoneypotTripped` |
| `validation.ts` | `MAX_BODY_BYTES` / `BODY_BYTE_CAP`, `readBodyWithCap`, `exceedsBodyCap`, `isValidEmail`, `isUuid`, `fieldLengthError` (per-form field maps stay LOCAL to each route) |
| `bartmail.ts` | `bartmailOptin`, `bartmailPurchase`, `bartmailVerify` — the canonical BartMail lead-write path (brand passed by caller). Imports `@supabase/supabase-js` (resolved from each consumer's node_modules). Excludes: barttech-website's bespoke REST variant, command-center's read-only client factory, the LMS engine's own copy. |
| `uploads.ts` | `UPLOAD_LIMITS`, `IMAGE_MIME_TYPES`, `DOCUMENT_MIME_TYPES`, `sniffMimeType`, `safeUploadFilename`, `validateUpload` — server-side upload validation. Never trusts the client-declared MIME type or the extension; sniffs magic bytes. Sanitises filenames for storage keys (path-traversal guard). |
| `audit.ts` | `AUDIT_ACTIONS`, `AuditAction`, `writeAuditLog`, `requestAuditContext` — append-only audit log of privileged actions, written to the app's own Supabase `audit_log` table. `writeAuditLog` never throws, and **must be awaited** (an un-awaited call is killed when a serverless function returns). |
| `consent.ts` | `ConsentCategory`, `ConsentState`, `ConsentChoice`, `ConsentListener`, `CONSENT_VERSION`, `CONSENT_STORAGE_KEY`, `LEGACY_CONSENT_KEYS`, `readConsent`, `writeConsent`, `hasConsent`, `onConsentChange`, `initConsentMode`, `updateConsentMode`, `grantAll`, `denyAll`, `clearConsent` — three-category (necessary/analytics/marketing) cookie consent state + **Google Consent Mode v2** signals. Browser-oriented but SSR-safe (every export no-ops server-side). `initConsentMode()` **must run before any gtag/ads script loads**. No React here — the banner UI stays per-repo. |
| `adPlatforms.ts` | `AdPlatform`, `AdPlatformCsp`, `AdPlatformConfig`, `AD_PLATFORMS` (`google_ads`, `meta`), `AD_CSP_HOSTS`, `ANALYTICS_CSP_HOSTS`, `loadAdPlatforms`, `eligibleAdPlatforms` — the ad/remarketing registry. **Adding a platform is one entry in `AD_PLATFORMS`**, not an estate-wide sweep. Tag ids are always passed in from the consuming app's env vars — never hardcoded here (public repo). |

**Only genuinely-identical primitives belong here.** Brand-specific security
logic (e.g. a per-product upsell token) stays in that repo's own
`lib/security.ts`, which re-exports this module and adds its own helpers.

`security.ts` imports Node `crypto` — **Node runtime only**. Never import it from
an Edge middleware/proxy; those use WebCrypto in a local helper.

`consent.ts` and `adPlatforms.ts` are the opposite: browser-oriented, and every
export no-ops when `window` is undefined so they can be imported anywhere. They
contain **no React** — web-core is framework-agnostic source, so the cookie
banner itself stays a per-repo component (brand styling differs) and calls into
these modules for state, signals and tag loading.

## How it's consumed

Mounted inside the site so the existing `@/*` path alias resolves it:

- `ownerfoundry-website` → `src/web-core` → `import { timingSafeTokenEqual } from "@/web-core/security"`
- `be-more-boundless` → `web-core` → same import path

Each site's local `lib/security.ts` is a thin shim that re-exports this module
(`export * from "@/web-core/security"`) plus any site-specific helpers, so route
imports (`@/lib/security`) never had to change during migration.

The site's `scripts/fetch-submodules.sh` runs `git submodule update --init
--recursive` before `next build`, which fetches this submodule using
`GITHUB_GIT_TOKEN` (already set in each site's Vercel env). No per-site build
changes are needed to add this second submodule.

## Fixing / updating

1. Edit the helper here, commit, push to `main`.
2. Run `tools/web-core-propagate.sh` from the Barttech OS root. It bumps each
   consumer's submodule pointer to this repo's latest `main`, commits, and pushes
   — Vercel auto-deploys each on push. Sites already up to date are skipped.

Do **not** run `vercel --prod` to deploy a consumer after a bump: a CLI deploy
ships a source snapshot with no `.git`, so `fetch-submodules.sh` fails. The git
push is the only path that fetches the private submodule correctly.

## Not a deployable app

This repo has no Vercel project — it is a library. It is not deployed on its own.
