# @barttech/web-core

Shared web helpers for the Barttech estate — the **single source of truth** for
cross-cutting code that was previously copy-pasted into every brand site (and
drifted out of sync). Fix once here, propagate to every consumer.

This is a **source-only** repo — no build, no `node_modules`, no tsconfig. It is
mounted into each consuming site as a **git submodule** and transpiled by that
site's Next.js build, exactly like `barton-lms-engine`.

## What lives here

| File | Exports |
|------|---------|
| `security.ts` | `escHtml`, `timingSafeTokenEqual`, `verifyHmacSignature`, `isSafePathSegment`, `safeRedirectPath`, `isHoneypotTripped` |
| `validation.ts` | `MAX_BODY_BYTES` / `BODY_BYTE_CAP`, `readBodyWithCap`, `exceedsBodyCap`, `isValidEmail`, `isUuid`, `fieldLengthError` (per-form field maps stay LOCAL to each route) |
| `bartmail.ts` | `bartmailOptin`, `bartmailPurchase`, `bartmailVerify` — the canonical BartMail lead-write path (brand passed by caller). Imports `@supabase/supabase-js` (resolved from each consumer's node_modules). Excludes: barttech-website's bespoke REST variant, command-center's read-only client factory, the LMS engine's own copy. |

**Only genuinely-identical primitives belong here.** Brand-specific security
logic (e.g. a per-product upsell token) stays in that repo's own
`lib/security.ts`, which re-exports this module and adds its own helpers.

`security.ts` imports Node `crypto` — **Node runtime only**. Never import it from
an Edge middleware/proxy; those use WebCrypto in a local helper.

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
