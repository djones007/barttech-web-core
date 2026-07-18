# Changelog

All notable changes to this project are documented here. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) — grouped by date, newest first. Entries use **Added** (new features), **Changed** (behavior changes), **Fixed** (bug fixes), **Removed** (deleted features).

## [2026-07-18] — Initial scaffold + security.ts pilot

### Added
- Repo created as the estate's shared web-helper submodule (`@barttech/web-core`), mirroring the `barton-lms-engine` submodule pattern. Source-only, no build.
- `security.ts` — canonical security primitives (`escHtml` [full superset: `& < > " '`], `timingSafeTokenEqual` [length-guard + try/catch, accepts null/undefined], `verifyHmacSignature`, `isSafePathSegment`, `safeRedirectPath`, `isHoneypotTripped`). Consolidated from `checkout-engine/src/lib/security.ts` and the per-site copies.
- Pilot consumers: `ownerfoundry-website` (mounted `src/web-core`) and `be-more-boundless` (mounted `web-core`). Each site's local `lib/security.ts` now re-exports this module; BMB additionally keeps its brand-specific `signUpsellToken`/`verifyUpsellToken` locally.
