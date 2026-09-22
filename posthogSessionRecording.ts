// ---------------------------------------------------------------------------
// Client-side defaults for PostHog session replay (`session_recording` +
// `enable_recording_console_log` on `posthog.init()`).
//
// WHY THIS EXISTS
// PostHog session replay is enabled at the PROJECT level for the estate's one
// shared project (Command Centre project bad60428-3c90-4030-ae09-c3fadd64225e
// — see `bartmail.ts`/checkout consumers for the "one project, `brand` super-
// property" architecture). Until 2026-09-22 every one of the 12+
// `posthog.init()` call sites across the estate passed only `api_host`,
// `person_profiles` and `capture_pageview` — no `session_recording` block and
// no `enable_recording_console_log` anywhere — so rrweb's own defaults
// applied and nobody had actually chosen them. On the checkout domain that
// meant 100% of sessions recorded, browser console output captured into the
// replay, and no server-side masking override: customer name/email/company,
// order contents and console output were all sitting in session replays
// nobody had decided to keep unmasked. Estate issue
// 8e6fb948-935c-467b-bf9d-759d031bdb72.
//
// The PROJECT-level fix (URL blocklist for payment/admin routes, console
// recording opt-in turned off, project masking config) was made directly via
// the PostHog API and is NOT part of this module — this repo holds no
// PostHog credentials and never will (golden rule: no tag IDs/keys in this
// PUBLIC repo). What belongs here is the CLIENT-side default every
// `posthog.init()` call should carry too, as defence in depth: a project
// setting can be changed back by anyone with dashboard access and a consumer
// that never sets its own default silently reverts to rrweb's factory
// settings the moment it does.
//
// WHAT THIS MODULE IS NOT
// It does not call `posthog.init()` and does not import `posthog-js` — this
// repo is consumed by non-Next code too, and posthog-js is not a
// dependency every consumer of web-core installs (golden rule 1b: an import
// this module does not need is a build break in a repo that never touches
// PostHog). Every export here is a plain literal object with primitive
// field types, spread into the caller's own `posthog.init()` options.
//
// MASKING MATCHES THE PROJECT SETTING, DELIBERATELY. `maskAllInputs: true`
// here is the same value set at the project level
// (`session_recording_masking_config: { maskAllInputs: true }`). The two are
// meant to agree: the posthog-js SDK warns once when a client-side
// `session_recording` masking option differs from the project's, and setting
// both to `true` is the only value that avoids the warning while staying
// safe if the project setting is ever weakened by mistake.
//
// THE `maskTextSelector` CONVENTION. `maskAllInputs` only masks `<input>`/
// `<textarea>` VALUES — it does nothing for PII rendered as plain text (an
// order summary's customer name, an admin table's email column). rrweb masks
// non-input text via a CSS selector, not a data attribute scan, so this
// module publishes ONE selector and ONE convention: mark a PII-bearing
// element with the `data-ph-mask` attribute and it is masked in every
// consumer that spreads these defaults. A per-repo selector name would drift
// the moment two sites picked different attribute names — exactly the
// "identical primitive, one place" reasoning the rest of this repo already
// applies to CSP hosts and consent state.
//
// ROLLOUT IS DELIBERATELY NOT DONE HERE. This module ships the shared
// default; wiring it into each of the 12+ `posthog.init()` call sites is a
// separate estate-wide sweep (several of those repos were mid-change when
// this shipped) — see the estate issue for the consumer list and line
// numbers.
// ---------------------------------------------------------------------------

/**
 * Attribute a consumer adds to any element whose TEXT content is PII and
 * should never reach a session replay — a rendered customer name, email,
 * company, or order line, as opposed to an `<input>` value (already covered
 * by `maskAllInputs`).
 *
 * Usage in markup: `<span data-ph-mask>{customer.email}</span>`. This string
 * is a CSS attribute selector, so it is used directly as
 * `session_recording.maskTextSelector` — never re-typed by a consumer.
 */
export const POSTHOG_PII_MASK_SELECTOR = "[data-ph-mask]";

/**
 * The `session_recording` block every `posthog.init()` call should spread
 * in. Mirrors the project-level `session_recording_masking_config` so the
 * SDK never has to reconcile two disagreeing masking settings.
 *
 * `maskAllInputs: true` — every input value is masked except `hidden` and
 * `file` inputs (posthog-js's own carve-out; block those separately with
 * `ph-no-capture` if they ever hold sensitive data). This is the rrweb/
 * posthog-js DEFAULT already, but is set explicitly here rather than left
 * implicit — an implicit default is exactly what let 12+ call sites go
 * without ever having chosen a masking policy at all.
 *
 * `maskTextSelector` — see {@link POSTHOG_PII_MASK_SELECTOR}.
 */
export const POSTHOG_SESSION_RECORDING_DEFAULTS: {
  maskAllInputs: true;
  maskTextSelector: string;
} = {
  maskAllInputs: true,
  maskTextSelector: POSTHOG_PII_MASK_SELECTOR,
};

/**
 * Every top-level `posthog.init()` option this module takes a position on.
 * Spread this FIRST so a call-site override (there should not be one) still
 * wins:
 *
 * ```ts
 * posthog.init(POSTHOG_KEY, {
 *   ...POSTHOG_CLIENT_DEFAULTS,
 *   api_host: POSTHOG_HOST,
 *   person_profiles: "identified_only",
 *   capture_pageview: false,
 * });
 * ```
 *
 * `enable_recording_console_log: false` — belt-and-braces alongside the
 * project-level `capture_console_log_opt_in: false` (set 2026-09-22). The
 * client option is `undefined` by default, which FALLS BACK to the remote
 * project setting — so this is not redundant, it is the second of two
 * independent places the estate's incident showed needed an explicit
 * choice rather than an inherited default.
 */
export const POSTHOG_CLIENT_DEFAULTS: {
  enable_recording_console_log: false;
  session_recording: typeof POSTHOG_SESSION_RECORDING_DEFAULTS;
} = {
  enable_recording_console_log: false,
  session_recording: POSTHOG_SESSION_RECORDING_DEFAULTS,
};
