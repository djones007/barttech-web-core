# Changelog

All notable changes to this project are documented here. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) — grouped by date, newest first. Entries use **Added** (new features), **Changed** (behavior changes), **Fixed** (bug fixes), **Removed** (deleted features).

## [2026-07-29] — bartmail.ts: `bartmailEvent` — contact timeline events for every repo

### Added
- `bartmailEvent(params)` — posts a non-email touchpoint to BartMail's `POST /api/contacts/event` (HMAC-SHA256 over the body with `CONTACT_EVENTS_SECRET`, same scheme as `bartmailPurchase`). Plus `BARTMAIL_EVENT_TYPES` and the `BartmailEventType` union, mirroring the route's fixed vocabulary.
- Why: `contact_events` shipped 2026-07-29 with exactly ONE producer — Cloud Plus's `send-email` Deno edge function, which hand-rolls WebCrypto signing because a Deno function can't import this module. Every Next.js repo in the estate had no path to the contact timeline at all, so the CDP could only ever show Cloud Plus quotes. This is that path.
- Returns `boolean`, never throws and never rejects: a timeline write must not be able to break the lead capture or checkout it hangs off. Callers still `await` it — an un-awaited promise dies when Vercel freezes the isolate on response, which is precisely the fire-and-forget failure mode that hid the 25–29 July optin outage for four days.
- A missing `CONTACT_EVENTS_SECRET` is a no-op returning `false`, not a throw, so a repo that hasn't been given the secret degrades to "no timeline" rather than 500s on every form. Same env var name as the route and the edge function — deliberately no second alias.
- `node:crypto` is imported lazily inside the function, matching `bartmailPurchase`. The optin path must stay free of it (see the module header) — do not hoist.

### Changed
- `ALLOWED_BARTMAIL` now also permits `https://bartmail.barttech.co.uk`, the canonical custom domain. Both hosts serve the same deployment; previously a consumer setting `BARTMAIL_URL` to the custom domain was silently rewritten to the `vercel.app` host, which worked but made the env var a lie. The allowlist (rather than a shape check) stays — it is the SSRF guard on where signed bodies may be sent.

## [2026-07-25h] — charts.ts: shared chart presentation for internal dashboards

### Added
- `charts.ts` — `SERIES_COLORS` (the slate→blue ramp lifted from command-center's `YEAR_FILLS`, the estate's only chart palette in real production use), `SIGNAL_COLORS`, `CHART_GRID`, `CHART_AXIS`, plus `asChartNumber`, `compactNumber`, `chartCurrency`, `chartPercent`.
- `asChartNumber` exists because recharts 3 widened its Tooltip/axis formatter value to `ValueType`, so a `(v: number) => …` callback no longer type-checks. Narrowing beats casting: a cast would silently hide a genuinely non-numeric series. Non-numeric returns `null`, so formatters render an em dash instead of NaN.

### Why only the constants, not a ChartCard
Command Centre already defines `ChartCard` **three times** (`orders-view`, `kpi-client`, `seasonality-view`) and two of them have already drifted — two wrap shadcn `Card`, one hand-rolls a `div`, and all three pick a different fixed height. So the duplication is real. But the card shell is ~15 lines of JSX coupled to each app's `Card` primitive and spacing, and this repo is deliberately React-free (same reason the cookie banner stays per-repo). The parts that actually drift and matter are the colours and formatting — those are here. Charts are for INTERNAL dashboards only; brand marketing sites follow their own per-brand palettes.

## [2026-07-25k] — docs: record barton-lms-engine as a submodule-less consumer

### Changed
- `CLAUDE.md` — consumer table records `barton-lms-engine` as a consumer *without* a submodule (it imports `@/web-core/*` through its host's path alias, because it is itself a submodule and nesting would compound the OF/BMB stale-cache bug).

Docs only, no code change. Logged because `a45c15b` was pushed as its own commit and the changelog rule has no size exemption.

## [2026-07-25j] — validation: export `EMAIL_RE` / `UUID_RE`

### Added
- `validation.ts` — `EMAIL_RE` and `UUID_RE` are now exported. Purely additive; no existing export changed. The doc comment steers new code to `isValidEmail`/`isUuid` instead, since those also narrow the type and reject non-strings.

### Why
`barton-lms-engine` tests these patterns directly in four route handlers (`UUID_RE.test(lessonId)`) rather than going through the guards. Exporting them lets that repo drop its own duplicate `validation.ts` — whose regexes were already byte-identical to these — and consume this module instead. Adding an export was the least invasive option: the alternative was rewriting those call sites, which changes behaviour rather than just wiring.

## [2026-07-25i] — bartmail: the optin path no longer pulls in `node:crypto`

### Changed
- `bartmail.ts` — `node:crypto` is no longer imported at module scope. It is imported lazily **inside** `bartmailPurchase`, the only function that uses it (HMAC-signing the purchase webhook body), and only when `BARTMAIL_PURCHASES_SECRET` is actually set. The header and the call site both carry a "do not hoist this back" note.

### Why
Importing this module dragged `node:crypto` into the graph for every consumer, even though almost all of them only ever call `bartmailOptin`. That module-scope import was one of **two** blockers stopping `barton-lms-engine` from consuming this module: it deliberately carries a hand-maintained partial copy of `bartmailOptin` in order to stay free of `node:crypto`, and that copy silently misses every fix made here to suppression and consent handling. This removes that blocker.

The second blocker still stands — `barton-lms-engine` is itself a submodule of `barton-lms`, `ownerfoundry-website` and `be-more-boundless`, so consuming web-core there would mean nested submodules, compounding the empty-worktree/stale-cache bug those repos already carry `fetch-submodules.sh` workarounds for. Folding it in is therefore still a separate decision, not an automatic follow-on.

Behaviour is unchanged. With no signing secret the signature was `undefined` before and is `undefined` now, and the import never executes. `tsc --noEmit` and `eslint` both clean.

## [2026-07-25h] — adPlatforms: document that the `next.config.ts` import works

### Changed
- `adPlatforms.ts` — the `AD_CSP_HOSTS` doc block now shows the exact `next.config.ts` import line and states plainly that a relative `.ts` import from `next.config.ts` **works**, so the hostnames must never be copied inline again.

### Why
On 2026-07-25 two consumer repos replaced the import with hand-copied host lists, on the belief that Next's `next-config-ts` loader emits relative imports as bare `require()` calls that cannot resolve a `.ts` file. That is not true on Next 16.2.11 — the loader bundles them. Eleven other consumers had been importing this module from `next.config.ts` in production the entire time. Re-verified on both with a full `npm run build` **and** a served `content-security-policy` header check before reverting them to the import.

That second hand-maintained copy is not a cosmetic issue: it is the exact mechanism by which `ad.doubleclick.net` reached live headers on some sites and not others. The rule is now written where the data lives — if an import ever genuinely fails to resolve, fix the resolution; never fork the list.

## [2026-07-25g] — Dependabot for the dev toolchain

### Added
- `.github/dependabot.yml` — grouped monthly npm + github-actions updates (limit 5 each), matching the estate baseline. This repo ships no runtime dependencies; the npm block covers only the dev-only toolchain that lets web-core check itself. Without it that toolchain would silently rot, which matters more here than in a normal app — a stale checker on the estate's shared module is a blind spot in 11 repos at once.
- Same major holds as the rest of the estate (`typescript`, `eslint`, `@eslint/*`), though for a slightly different reason: web-core deliberately does not use `eslint-config-next`, so the `eslint-plugin-react` breakage does not apply — but it uses `typescript-eslint` directly, and that is the package that hard-refuses TS 7.
- No `vercel.json` `ignoreCommand` needed: this repo has no Vercel project (it is a submodule library, not a deployable app), so Dependabot branches cannot trigger a preview build.

## [2026-07-25f] — web-core gets its own lint + typecheck CI

### Added
- `.github/workflows/ci.yml` — one job running `npm ci` → `npm run lint` → `npm run typecheck` on push and PR (`if: always()` on typecheck so a lint failure never hides a type error). This repo is public, so its Actions minutes are free.
- `tsconfig.json` (noEmit, `strict`, `noUnusedLocals`/`noUnusedParameters`) and `eslint.config.mjs` (plain `typescript-eslint`, deliberately NOT `eslint-config-next` — this library ships no React). `@typescript-eslint/no-explicit-any` is an **error** here rather than a warning: an implicit any in a module consumed by 9+ repos becomes an untyped value in all of them.
- Dev-only devDependencies + `lint`/`typecheck` scripts. Consumers never install these; `node_modules/` stays gitignored, so the submodule checkout remains source-only.

### Why
Until now web-core was linted only as a **side effect** of being vendored into consuming repos. A lint error introduced here reddened 9 builds at once, against files none of those repos is permitted to edit — a fix made in a consumer copy is discarded on the next submodule pointer bump. The gate now sits where the source lives, and consumers exclude `src/web-core/**` from their own lint. Both checks passed clean on the first run across all 2,220 lines, so the gate ships strict with no baseline.

## [2026-07-25e] — consent.ts: consent travels across a brand's subdomains (cookie-backed)

### Changed
- **The consent record now lives in a cookie scoped to the registrable domain**, with `localStorage` kept as a mirror. `localStorage` is per-origin, so a buyer who accepted on `<brand>.com` was invisible to `checkout.<brand>.com` and got a **second banner mid-purchase** — friction at the worst possible moment, and a re-prompt caused by blindness rather than by law. A `Domain=.<brand>.com` cookie is readable by both, same controller and same site, so the choice carries lawfully and the checkout shows no banner at all.
- **Domain resolved by attempt-and-verify, not by parsing.** Stripping the first label gets `checkout.<brand>.com` → `<brand>.com` right but turns `<brand>.co.uk` into the public suffix `co.uk`, which browsers reject. Instead each candidate is written and read back, keeping the broadest that actually sticks — no public-suffix list, no per-app config, correct on apex domains, `.co.uk`, subdomains, IP literals and `localhost`.
- Cookie attributes: `SameSite=Lax` (must survive a top-level navigation from an ad click or an email — `Strict` would break exactly the visitor we care about), `Secure` off-localhost, `Path=/`, 12-month `Max-Age`, and deliberately **not** `HttpOnly` — the banner and the head snippet are client-side and must read it, and nothing secret is stored (it is the visitor's own choice).
- `CONSENT_MODE_HEAD_SNIPPET` now reads the **cookie first**, falling back to the mirror. This is the point of the change: on `checkout.<brand>.com` the cookie is the only place the grant exists, and replaying it before `wait_for_update` expires is what stops the first checkout pageview — the conversion event itself — being *modelled* instead of *measured*.

### Fixed
- `clearConsent()` now calls `deleteConsentCookieEverywhere()` **before** touching the mirror. It previously cleared `localStorage` only, which — once the cookie became the source of truth — would have left a visitor who clicked **Reject all** still consented, on every sibling subdomain, invisibly from the host that "cleared" it. The module's own comments already called this out as the worst failure it could have; the deletion helper existed but was never wired up.

### Notes
- **Does not carry to `assuredcheckout.com`** — a different registrable domain from any brand site, so consent cannot and must not travel there. That host still shows a banner. checkout-engine resolves tenants by host, so behaviour differs between `checkout.<brand>.com` and the generic domain by design.
- `onConsentChange` still does not fire across subdomains (`storage` is origin-scoped and never fires for cookie writes). The consent itself travels; a live in-page callback in an already-open tab on another subdomain does not. Documented on the export rather than papered over — Consent Mode's own signal is what actually gates Google there.
- Cookies are blocked more often than `localStorage`, so every cookie path fails soft to the mirror and no storage failure can break a banner.

## [2026-07-25d] — adPlatforms.ts: add ad.doubleclick.net to the Google Ads CSP hosts

### Fixed
- `AD_PLATFORMS.google_ads.csp` now allowlists `https://ad.doubleclick.net` in **both** `connectSrc` and `imgSrc`. The Google Ads tag posts cross-domain conversion measurement to `https://ad.doubleclick.net/ccm/s/collect`, which is a different host from `googleads.g.doubleclick.net` and appears in no vendor doc. Caught in a real browser while wiring the first consumer (`barttech-next-template`, local prod build): `Refused to connect to 'https://ad.doubleclick.net/ccm/s/collect…'`.
- **Why it survives a casual test:** the call only fires once the `_gcl_au` linker cookie exists, so a clean-profile first load passes and a returning visitor gets the violation. `tsc`, the build and `curl -I` all stay green either way — this is only ever visible in a browser console, which is exactly the failure mode the `imgSrc` comment in this file warns about.
- Confirmed working in the same session with the host added: `googleads.g.doubleclick.net/pagead/viewthroughconversion`, `www.google.com/ccm/collect`, `www.google.com/rmkt/collect` and the `pagead/1p-user-list` remarketing beacon on **both** `www.google.com` and `www.google.co.uk` all fire un-blocked, as does Meta's `facebook.com/tr` PageView.

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
