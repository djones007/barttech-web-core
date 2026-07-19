# Changelog

All notable changes to this project are documented here. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) — grouped by date, newest first. Entries use **Added** (new features), **Changed** (behavior changes), **Fixed** (bug fixes), **Removed** (deleted features).

## [2026-07-19] — bartmail.ts: add applyOptinTags (consent) + custom_fields (superset)

### Added
- `applyOptinTags?: boolean` (default **true**) to `BartmailOptinParams` — when false, `bartmailOptin` stores the contact but SKIPS the default `${brand}-optin`/`${brand}-${form_type}` tags and does NOT clear brand suppression (for a form whose opt-in checkbox was left unticked — the visitor did not consent to marketing). Default true = byte-identical behaviour for the 7 existing consumers.
- `custom_fields?: Record<string,string>` — stored on insert, merged (not overwritten) on re-optin. Ported verbatim from dominic-jones-website's production implementation.

### Why
- checkout-engine and dominic-jones-website both carried this consent capability locally, blocking them from adopting the shared module. Adding it (backwards-compatible) makes the canonical a true superset so both can fold. BartMail's contacts table already has a `custom_fields` column.

## [2026-07-19] — security.ts: add isTestModeToken (superset for checkout-engine)

### Added
- `isTestModeToken(token)` to `security.ts` — the Stripe TEST-mode gate (constant-time compares a `CHECKOUT_TEST_TOKEN`), restoring the one export checkout-engine's original `security.ts` had that web-core lacked. web-core is now a true superset of the checkout-engine origin (it was already safer on `escHtml` [+`'`] and `timingSafeTokenEqual` [null/undefined + try/catch]), so checkout-engine can adopt the shared module without losing anything. Returns false when `CHECKOUT_TEST_TOKEN` is unset — inert in every other consumer.

## [2026-07-19] — Add bartmail.ts (canonical BartMail lead-write path)

### Added
- `bartmail.ts` — `bartmailOptin`, `bartmailPurchase`, `bartmailVerify`, copied verbatim from the long-standing canonical `be-more-boundless/lib/bartmail.ts` (verified brand-agnostic — brand is a caller parameter, no hardcoded values). Imports `@supabase/supabase-js` (resolved from each consumer's node_modules; web-core stays dependency-free). Carries the SSRF allowlist on `BARTMAIL_URL`. Node-runtime only. Consumers whose local `bartmailOptin` was verified byte-identical shim to this. **Deliberately NOT folded:** barttech-website (bespoke REST variant with `bartmailHealthPing`), command-center (14-line read-only client factory), and the LMS engine's own copy (private submodule) — different shapes/purposes.

## [2026-07-19] — Add validation.ts (shared request-validation guards)

### Added
- `validation.ts` — `MAX_BODY_BYTES`/`BODY_BYTE_CAP` (32 KB), `readBodyWithCap`, `exceedsBodyCap`, `isValidEmail`, `isUuid`, `fieldLengthError`. Union of the per-repo copies from nuttyorange-games-website + cloud-plus-v2 (both used `Buffer.byteLength`, no divergent semantics). Per-form field-length maps stay local to each route. Consumers: nuttyorange-games-website, cloud-plus-v2 (their local `validation.ts` becomes a re-export shim).

## [2026-07-18] — Initial scaffold + security.ts pilot

### Added
- Repo created as the estate's shared web-helper submodule (`@barttech/web-core`), mirroring the `barton-lms-engine` submodule pattern. Source-only, no build.
- `security.ts` — canonical security primitives (`escHtml` [full superset: `& < > " '`], `timingSafeTokenEqual` [length-guard + try/catch, accepts null/undefined], `verifyHmacSignature`, `isSafePathSegment`, `safeRedirectPath`, `isHoneypotTripped`). Consolidated from `checkout-engine/src/lib/security.ts` and the per-site copies.
- Pilot consumers: `ownerfoundry-website` (mounted `src/web-core`) and `be-more-boundless` (mounted `web-core`). Each site's local `lib/security.ts` now re-exports this module; BMB additionally keeps its brand-specific `signUpsellToken`/`verifyUpsellToken` locally.
