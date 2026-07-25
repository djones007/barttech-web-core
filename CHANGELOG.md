# Changelog

All notable changes to this project are documented here. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) — grouped by date, newest first. Entries use **Added** (new features), **Changed** (behavior changes), **Fixed** (bug fixes), **Removed** (deleted features).

## [2026-07-25c] — consent.ts: CONSENT_MODE_HEAD_SNIPPET (the head-first ordering guarantee)

### Added
- `CONSENT_MODE_HEAD_SNIPPET` — the same Consent Mode v2 default as `initConsentMode()`, as a raw inline script string for the root layout's `<head>`, plus a replay of any stored choice. The storage key and version are interpolated from `CONSENT_STORAGE_KEY`/`CONSENT_VERSION`, so the snippet cannot drift from `readConsent()` — which is the whole point of it living here instead of being hand-copied into every consumer's root layout.
- **Why a string and not just the function:** `initConsentMode()` is module code and cannot run until the client bundle parses and the tree mounts. That is early enough only while every Google/Meta tag on the page is client-injected and consent-gated; the moment one `<Script src="…gtag/js">` is rendered server-side the ordering silently inverts, Google discards the late `default`, and remarketing audiences stop building — with no error anywhere. Emitting the default as a parser-blocking inline script makes the ordering a property of the HTML, which is the only version that can actually be verified. Consumers still call `initConsentMode()` on mount (idempotent): the snippet covers the pre-hydration window, the call covers everything after it.
- **Do not substitute `next/script` `strategy="beforeInteractive"`** for this. In the App Router an inline `beforeInteractive` script is not emitted as a `<script>` at all — Next wraps the body in `(self.__next_s=…).push(…)` and replays it from its own runtime, so what reaches the HTML is a queue entry rather than an executed consent default (verified in `next/dist/client/script.js`). Documented in the export's doc comment so it isn't "simplified" back later.

### Notes
- Purely additive; the export surface is unchanged for existing consumers.

## [2026-07-25b] — Add consent.ts (Consent Mode v2) + adPlatforms.ts (ad/remarketing registry)

### Added
- `consent.ts` — `ConsentCategory` (`necessary`/`analytics`/`marketing`), `ConsentState`, `ConsentChoice`, `ConsentListener`, `CONSENT_VERSION`, `CONSENT_STORAGE_KEY`, `LEGACY_CONSENT_KEYS`, `readConsent`, `writeConsent`, `hasConsent`, `onConsentChange`, `initConsentMode`, `updateConsentMode`, `grantAll`, `denyAll`, `clearConsent`. Encodes UK PECR/GDPR: advertising consent is a **separate opt-in** from analytics, nothing but strictly-necessary may fire before a choice, and rejecting must be as easy as accepting (ICO equal prominence — the banner UI's job, but documented here). State is versioned + timestamped, so a policy change re-prompts; a stale-version or corrupt record reads as "no choice", never as a grant. `onConsentChange` fires across tabs via the `storage` event (a withdrawal in one tab must stop tracking in the others). Every export is SSR-safe.
- **Google Consent Mode v2** in `consent.ts` — `initConsentMode()` pushes `default` with `ad_storage`/`ad_user_data`/`ad_personalization`/`analytics_storage` all `denied` plus `wait_for_update: 500`, `ads_data_redaction` and `url_passthrough`, then replays any stored choice inside the wait window. **Must run before any gtag/ads script loads** — Google ignores a late `default` and there is no error when you get it wrong. This is what makes remarketing *work*, not compliance overhead: without Consent Mode v2, Google will not build remarketing/Customer Match audiences from UK/EEA traffic at all and conversion modelling is off — less data than running it denied.
- `adPlatforms.ts` — `AdPlatform`/`AdPlatformCsp`/`AdPlatformConfig`, `AD_PLATFORMS` (`google_ads`: gtag `AW-` config + `conversion_linker`; `meta`: fbq init + PageView), `AD_CSP_HOSTS`, `ANALYTICS_CSP_HOSTS`, `loadAdPlatforms`, `eligibleAdPlatforms`. **Adding a future ad platform is one entry in the registry** — the banner, CSP builder and loader all read `AD_PLATFORMS` — with a commented TikTok/LinkedIn/Reddit skeleton in place. Each platform declares its consent gate, per-directive CSP hosts, an `idPattern` (defence in depth: a malformed env value is never interpolated into a script URL) and an idempotent `load(id)`. `loadAdPlatforms` no-ops on the server, on a null/unconsented state, on an unknown key and on a repeat call — a double `fbq` init double-counts every PageView.
- `AD_CSP_HOSTS`/`ANALYTICS_CSP_HOSTS` are split into `scriptSrc`/`connectSrc`/**`imgSrc`** so a consumer builds its whole CSP from these constants instead of hand-maintaining hostnames. `imgSrc` is the usual omission: Meta's `tr?id=` beacon and Google's `ga-audiences`/conversion pings are `<img>` loads, so allowlisting only script/connect leaves the tag "working" with an audience that never fills. Carries the GA4 wildcard fix from earlier today plus the `region1.google-analytics.com` vs `region1.analytics.google.com` trap that cost the estate its GA4 data across 7 repos until 2026-07-25.
- **No tag IDs and no React in either file** — this repo is public and framework-agnostic. IDs come from the consuming app's env vars; the cookie-banner component stays per-repo (brand styling differs).

### Notes
- `CONSENT_STORAGE_KEY` is `cookie_consent_v2`. The old binary keys (`cookie_consent`, and `cookie-consent` in berekindled) are **deliberately not migrated**: that banner offered analytics cookies only, so reading it to auto-grant `marketing` would be unlawful — analytics-only consent cannot be silently upgraded to advertising consent. Existing visitors must re-consent; `clearConsent()` deletes the legacy keys but nothing ever reads them as a grant.
- Neither module `declare global`s `gtag`/`fbq` — several consumers already do, and a second augmentation with a different signature is a hard TS error. Both use a local structural type + one cast.
- No consumer wired up yet (additive; the export surface is unchanged for existing consumers). Type-checked against `barttech-next-template` (`tsc --noEmit`, clean) plus a runtime smoke test of the consent/injection paths.

## [2026-07-25] — Add uploads.ts (magic-byte upload validation) + audit.ts (privileged-action audit log)

### Added
- `uploads.ts` — `UPLOAD_LIMITS` (image/document/avatar/video size ceilings), `IMAGE_MIME_TYPES`, `DOCUMENT_MIME_TYPES`, `sniffMimeType`, `safeUploadFilename`, `validateUpload`. Encodes the rule that a route must NEVER trust `file.type` or the filename extension — both are attacker-controlled — and must decide from the magic bytes (JPEG/PNG/GIF/WebP/AVIF/PDF/ZIP; unrecognised = reject). `safeUploadFilename` is the path-traversal guard for storage keys (strips directory components + leading dots, collapses to `[a-zA-Z0-9._-]`, caps at 100 chars preserving the extension). `validateUpload` never throws — size → sniff → allowlist → extension, returning `{ok:false,error,status}` (413/415) instead. One reconciliation is permitted: docx/xlsx are ZIP containers, so a genuine one sniffs as `application/zip` and is accepted only when the declared type is that exact OOXML type AND it is on the route's allowlist. Typed against the web-standard `File` so web-core stays framework-agnostic.
- `audit.ts` — `AUDIT_ACTIONS` (stable `domain.verb` slugs), `AuditAction` (the slug union, widened with `(string & {})` so apps can add their own), `writeAuditLog`, `requestAuditContext`. Appends one row per privileged action (deletion, role change, refund, export, admin action) to the app's own Supabase `audit_log` table via `SUPABASE_URL`/`NEXT_PUBLIC_SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` (the key has no public fallback), client built lazily per call. **Never throws** — an audit-write failure must not break the action being audited; it logs `err.message` only, and no-ops with a `console.warn` when the env vars are absent. **Must be awaited** by callers: an un-awaited call is killed the moment a serverless function returns (website security standard §20), so the row silently vanishes — the exact failure this module exists to prevent. `metadata` is for small non-sensitive context only, never secrets, tokens or full request bodies.
- No consumer wired up yet (both modules are additive; the export surface is unchanged for existing consumers).

## [2026-07-19] — bartmail.ts: export the client factory (getBartmailSupabase / getBartmailClient)

### Added
- Exported the internal BartMail Supabase client factory as `getBartmailSupabase`, plus a `getBartmailClient` alias — so consumers needing the raw client for other server-side work (dominic-jones-website's durable rate limiter) can adopt the shared module. Unblocks folding dominic-jones-website's bartmail.ts.

## [2026-07-19] — validation.ts: add parse-with-cap dialect (superset for checkout-engine)

### Added
- `readBodyWithSizeLimit<T>(req)` — reads, caps, AND JSON-parses to a typed body with `{error,status}` returns. Distinct from `readBodyWithCap` (raw text + bool, for HMAC-over-raw-body routes) — both are legitimate, kept as separate primitives.
- `checkFieldLengths(body, limits)` — the `{error,status}`-returning sibling of `fieldLengthError` (string-returning). `checkBodySize(req)` (deprecated header check). `DEFAULT_MAX_LENGTHS` (common field-length map).
- All typed against the web-standard `Request` (a Next `NextRequest` is a valid `Request`) so web-core stays framework-agnostic. Union of checkout-engine's validation dialect with the existing one so checkout-engine can fold its `validation.ts`.

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
