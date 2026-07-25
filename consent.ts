// ---------------------------------------------------------------------------
// Barttech shared cookie-consent state + Google Consent Mode v2 signals.
//
// The rule this module encodes: under UK PECR (reg. 6) + UK GDPR, ANY cookie or
// storage access that is not strictly necessary needs the visitor's prior,
// informed, opt-in consent — and ADVERTISING consent is a SEPARATE decision from
// ANALYTICS consent. So:
//
//   1. Nothing but strictly-necessary storage may fire before a choice is made.
//   2. Rejecting must be as easy as accepting (ICO equal-prominence guidance —
//      an "Accept" button with only a "Manage preferences" link is a dark
//      pattern and has been enforced against). The banner UI must give
//      Accept / Reject equal weight; this module only holds the state.
//   3. Consent for analytics can NEVER be silently upgraded into consent for
//      marketing. See the storage-key note below.
//
// Deliberately framework-agnostic and UI-free: web-core is source-only and holds
// no React. The banner is a per-repo component (brand styling differs); it calls
// into this module for state, and into `adPlatforms.ts` for tag loading.
//
// BROWSER-ORIENTED but SSR-SAFE — every export no-ops (or returns null/false)
// when `window` is undefined, so a consumer can import it anywhere without a
// `typeof window` dance at the call site. Import as `@/web-core/consent`.
// ---------------------------------------------------------------------------

/**
 * The three buckets a visitor consents to independently.
 *
 * - `necessary` — session, auth, CSRF, cart, load balancing. Always on; needs no
 *   consent because the service cannot be delivered without it. It is NOT a
 *   loophole: analytics is not "necessary" under PECR, and neither is anything
 *   that profiles the visitor.
 * - `analytics` — GA4, Rybbit. Measurement only.
 * - `marketing` — advertising, conversion tracking and remarketing pixels
 *   (Google Ads, Meta, and anything added to `AD_PLATFORMS` later).
 */
export type ConsentCategory = "necessary" | "analytics" | "marketing";

/**
 * Bump this when the cookie policy materially changes (a new ad platform, a new
 * purpose, a new processor). `readConsent` treats a stored state from an older
 * version as "no choice made", which re-prompts the visitor — the only lawful
 * way to extend consent to a purpose they never agreed to.
 */
export const CONSENT_VERSION = 2;

/**
 * localStorage key holding the visitor's choice.
 *
 * **Why `_v2`, and why the old key is not read:** the estate's original banner
 * stored a binary string under `cookie_consent` (`"accepted"` / `"declined"`),
 * and berekindled used `cookie-consent` (hyphen) for the same thing. That copy
 * offered analytics cookies only — "we use cookies to improve your experience
 * and analyse site traffic". A visitor who clicked Accept consented to
 * MEASUREMENT and nothing else.
 *
 * Reading that old key and auto-granting `marketing` from it would therefore be
 * unlawful: consent must be specific and informed, and analytics-only consent
 * cannot be silently upgraded into advertising/remarketing consent. Existing
 * visitors must be re-prompted under the new key. That is the intended cost of
 * this change, not a bug to optimise away — do not add an old-key migration.
 *
 * (Old keys can be safely DELETED to clean up; just never read as a grant.)
 */
export const CONSENT_STORAGE_KEY = "cookie_consent_v2";

/** Legacy binary keys — for cleanup only. NEVER read one of these as a grant. */
export const LEGACY_CONSENT_KEYS = ["cookie_consent", "cookie-consent"] as const;

/** The visitor's recorded choice, as persisted. */
export interface ConsentState {
  /** Always `true` — strictly-necessary storage needs no consent. */
  necessary: boolean;
  /** GA4 / Rybbit measurement. */
  analytics: boolean;
  /** Ad platforms: conversion tracking + remarketing audiences. */
  marketing: boolean;
  /** {@link CONSENT_VERSION} at the time of the choice — drives re-prompting. */
  version: number;
  /** ISO timestamp of the choice. Your proof of consent if the ICO ever asks. */
  updatedAt: string;
}

/** The part of {@link ConsentState} a banner actually decides. */
export interface ConsentChoice {
  analytics: boolean;
  marketing: boolean;
}

/**
 * Fired on every change, including changes made in ANOTHER TAB. `null` means the
 * stored choice was cleared (or was from an older policy version) — treat that
 * as "no consent yet" and re-show the banner, never as a grant.
 */
export type ConsentListener = (state: ConsentState | null) => void;

// --- gtag plumbing ---------------------------------------------------------
//
// web-core deliberately does NOT `declare global { interface Window { gtag } }`.
// Several consumers already declare `gtag`/`fbq` themselves; a second global
// augmentation with a different signature is a hard TS error ("subsequent
// property declarations must have the same type") and would break those repos
// the moment they mount this file. A local structural type + one cast keeps this
// module self-contained.

type GtagFn = (...args: unknown[]) => void;

interface ConsentWindow {
  dataLayer?: unknown[];
  gtag?: GtagFn;
}

/** The window, structurally typed — or null on the server. */
function consentWindow(): ConsentWindow | null {
  return typeof window === "undefined" ? null : (window as unknown as ConsentWindow);
}

/**
 * Return `window.gtag`, creating the standard stub if gtag.js has not loaded.
 *
 * The stub MUST push the raw `arguments` object, exactly as Google's snippet
 * does — gtag.js/GTM look for an `Arguments` object on the dataLayer when they
 * replay the queue, and a plain array is not reliably processed. This is what
 * lets `initConsentMode()` run in the document head BEFORE any Google script
 * exists: the calls queue on the dataLayer and are replayed in order the moment
 * gtag.js loads.
 */
function ensureGtag(w: ConsentWindow): GtagFn {
  const layer = (w.dataLayer = w.dataLayer ?? []);
  if (typeof w.gtag !== "function") {
    w.gtag = function gtagStub() {
      // eslint-disable-next-line prefer-rest-params
      layer.push(arguments);
    };
  }
  return w.gtag;
}

// --- state -----------------------------------------------------------------

const listeners = new Set<ConsentListener>();
let storageListenerAttached = false;

/** Parse a stored payload, rejecting anything malformed or from an old policy. */
function parseConsent(raw: string | null): ConsentState | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;

    const obj = parsed as Record<string, unknown>;
    // A stale-version record is NOT a grant — the policy it consented to no
    // longer exists, so the visitor gets asked again.
    if (obj.version !== CONSENT_VERSION) return null;

    return {
      necessary: true,
      analytics: obj.analytics === true,
      marketing: obj.marketing === true,
      version: CONSENT_VERSION,
      updatedAt: typeof obj.updatedAt === "string" ? obj.updatedAt : new Date(0).toISOString(),
    };
  } catch {
    // Corrupt JSON (a truncated write, a hand-edited value, a legacy binary
    // string like "accepted"). Treat as no choice — never as consent.
    return null;
  }
}

/**
 * The visitor's stored choice, or `null` if they have not chosen yet, the record
 * is corrupt, or it predates the current {@link CONSENT_VERSION}.
 *
 * `null` is the state in which a banner must be shown and NOTHING but
 * strictly-necessary storage may fire. Returns `null` on the server — never
 * render a consent-dependent tag during SSR; decide on the client after mount.
 */
export function readConsent(): ConsentState | null {
  if (typeof window === "undefined") return null;
  try {
    return parseConsent(window.localStorage.getItem(CONSENT_STORAGE_KEY));
  } catch {
    // localStorage throws in Safari private mode / when storage is disabled.
    return null;
  }
}

/**
 * Persist a choice, push the matching Consent Mode v2 update to Google, and
 * notify every {@link onConsentChange} subscriber.
 *
 * `necessary` is forced true, `version` and `updatedAt` are stamped here — the
 * timestamp is the record of WHEN consent was given, which is what a regulator
 * asks for. Returns the persisted state (also on the server, where it is simply
 * not stored, so a caller can rely on the return value).
 *
 * ```ts
 * // In the banner's Accept-all handler:
 * writeConsent({ analytics: true, marketing: true });
 * // …then load the tags for whatever is now consented:
 * loadAdPlatforms({ google_ads: process.env.NEXT_PUBLIC_GOOGLE_ADS_ID }, readConsent());
 * ```
 */
export function writeConsent(choice: ConsentChoice): ConsentState {
  const state: ConsentState = {
    necessary: true,
    analytics: choice.analytics === true,
    marketing: choice.marketing === true,
    version: CONSENT_VERSION,
    updatedAt: new Date().toISOString(),
  };

  if (typeof window === "undefined") return state;

  try {
    window.localStorage.setItem(CONSENT_STORAGE_KEY, JSON.stringify(state));
  } catch {
    // Storage disabled: the choice still applies to THIS page view (the signals
    // below are pushed either way), it just won't survive a reload.
  }

  // Tell Google before telling the app — so any tag a listener loads starts up
  // with the correct consent already in effect.
  updateConsentMode(state);
  notify(state);

  return state;
}

/**
 * Has the visitor consented to this category? `necessary` is always true.
 * Anything gated on `marketing` must call this (or be handed a state) — never
 * assume, and never fall back to "true" when the state is missing.
 */
export function hasConsent(category: ConsentCategory): boolean {
  if (category === "necessary") return true;
  const state = readConsent();
  if (!state) return false;
  return category === "analytics" ? state.analytics : state.marketing;
}

/** Push a state to every subscriber; one throwing listener can't stop the rest. */
function notify(state: ConsentState | null): void {
  for (const listener of listeners) {
    try {
      listener(state);
    } catch (err) {
      console.error("[consent] listener failed:", err instanceof Error ? err.message : String(err));
    }
  }
}

/**
 * Subscribe to consent changes. Returns an unsubscribe function — call it in
 * your effect's cleanup, or the listener leaks across route changes.
 *
 * Fires for changes made in ANY tab: the `storage` event only fires in OTHER
 * tabs, so a visitor who withdraws consent in one tab must stop being tracked in
 * the others. Same-tab changes are delivered directly by {@link writeConsent}.
 *
 * The callback is NOT invoked on subscribe — read the current state with
 * {@link readConsent} first if you need it. No-op (returns a no-op unsubscribe)
 * on the server.
 *
 * ```ts
 * useEffect(() => onConsentChange((state) => {
 *   if (state?.marketing) loadAdPlatforms(adIds, state);
 * }), []);
 * ```
 */
export function onConsentChange(cb: ConsentListener): () => void {
  if (typeof window === "undefined") return () => {};

  listeners.add(cb);

  if (!storageListenerAttached) {
    window.addEventListener("storage", handleStorage);
    storageListenerAttached = true;
  }

  return () => {
    listeners.delete(cb);
    if (listeners.size === 0 && storageListenerAttached) {
      window.removeEventListener("storage", handleStorage);
      storageListenerAttached = false;
    }
  };
}

/** Cross-tab bridge: another tab wrote (or cleared) the consent key. */
function handleStorage(event: StorageEvent): void {
  if (event.key !== CONSENT_STORAGE_KEY) return;
  const state = parseConsent(event.newValue);
  // Mirror the other tab's decision into Google's signals in THIS tab too,
  // otherwise a withdrawal only takes effect where it was clicked.
  if (state) updateConsentMode(state);
  else denyConsentMode();
  notify(state);
}

// --- Google Consent Mode v2 ------------------------------------------------

/**
 * Push the Consent Mode v2 **default** — everything denied — plus
 * `wait_for_update`, then immediately replay any stored choice.
 *
 * **This MUST run before any gtag.js / Google Ads / GTM script tag loads.** Put
 * it in the document head, above every analytics and advertising script (in
 * Next.js: a `<Script strategy="beforeInteractive">` or an inline head script in
 * the root layout). If a Google tag initialises first, it has already fired with
 * unconsented storage and Google IGNORES a late default — the whole mechanism
 * is order-dependent and there is no error when you get it wrong.
 *
 * **This is what makes remarketing work — it is not compliance overhead.**
 * Without Consent Mode v2 signals, Google will not build or populate
 * remarketing/Customer Match audiences from UK/EEA traffic at all, and
 * conversion modelling is switched off: you get less data with no Consent Mode
 * than you get with it set to denied. Sites that "skip the cookie stuff to keep
 * the pixel simple" end up with empty audience lists and unattributed
 * conversions.
 *
 * `wait_for_update: 500` tells Google to hold tags for 500ms so an async consent
 * read can land before anything fires. `ads_data_redaction` strips ad
 * identifiers from any request made while `ad_storage` is denied (it
 * self-disables once granted), and `url_passthrough` carries `gclid` through
 * navigations without a cookie, so a click still attributes when consent is
 * refused.
 *
 * Safe and idempotent to call more than once, and a no-op on the server.
 */
export function initConsentMode(): void {
  const w = consentWindow();
  if (!w) return;

  const gtag = ensureGtag(w);

  gtag("consent", "default", {
    ad_storage: "denied",
    ad_user_data: "denied",
    ad_personalization: "denied",
    analytics_storage: "denied",
    // Not consent-gated, but stated explicitly so Google isn't guessing.
    functionality_storage: "granted",
    security_storage: "granted",
    wait_for_update: 500,
  });

  gtag("set", "ads_data_redaction", true);
  gtag("set", "url_passthrough", true);

  // A returning visitor already decided. Replay it now, inside the
  // wait_for_update window, or their granted consent arrives too late to matter.
  const stored = readConsent();
  if (stored) updateConsentMode(stored);
}

/**
 * Push a Consent Mode v2 **update** reflecting the visitor's choice. Call it on
 * every change (`writeConsent` already does this for you).
 *
 * The two ad-specific signals matter and are not interchangeable with
 * `ad_storage`: `ad_user_data` covers sending user data to Google for ads
 * purposes, `ad_personalization` covers using it for remarketing. Both are
 * mandatory for EEA/UK traffic since March 2024 — omit them and Google treats
 * the traffic as unconsented no matter what `ad_storage` says.
 */
export function updateConsentMode(state: ConsentState): void {
  const w = consentWindow();
  if (!w) return;

  const granted = (ok: boolean) => (ok ? "granted" : "denied");

  ensureGtag(w)("consent", "update", {
    ad_storage: granted(state.marketing),
    ad_user_data: granted(state.marketing),
    ad_personalization: granted(state.marketing),
    analytics_storage: granted(state.analytics),
  });
}

/** Push an explicit all-denied update (used when a stored choice is cleared). */
function denyConsentMode(): void {
  updateConsentMode({
    necessary: true,
    analytics: false,
    marketing: false,
    version: CONSENT_VERSION,
    updatedAt: new Date().toISOString(),
  });
}

// --- helpers ---------------------------------------------------------------

/** Accept-all: analytics + marketing. Wire to the banner's "Accept" button. */
export function grantAll(): ConsentState {
  return writeConsent({ analytics: true, marketing: true });
}

/**
 * Reject-all: everything but strictly-necessary denied. Wire to "Reject" — which
 * must be as prominent and as few clicks as "Accept" (ICO equal prominence).
 *
 * Note this WRITES a decision rather than clearing the key: a recorded refusal
 * stops the banner re-appearing on every page and is itself evidence that the
 * visitor was asked and said no.
 */
export function denyAll(): ConsentState {
  return writeConsent({ analytics: false, marketing: false });
}

/**
 * Forget the stored choice so the banner shows again (a "change my cookie
 * settings" link, or a policy change mid-session). Also pushes an all-denied
 * update, so tags already running stop receiving consent immediately — note that
 * a tag already LOADED into the page stays loaded until the next navigation;
 * Consent Mode stops it storing/sending, which is the mechanism Google supports.
 */
export function clearConsent(): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(CONSENT_STORAGE_KEY);
    // Tidy up the pre-v2 binary keys while we're here (cleanup only — these are
    // never read as a grant; see CONSENT_STORAGE_KEY).
    for (const key of LEGACY_CONSENT_KEYS) window.localStorage.removeItem(key);
  } catch {
    // Storage disabled — nothing to clear.
  }
  denyConsentMode();
  notify(null);
}
