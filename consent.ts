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
// WHERE THE CHOICE IS STORED — a first-party COOKIE scoped to the registrable
// domain, mirrored into localStorage. This is not a storage preference, it is a
// conversion fix: localStorage is per-ORIGIN, so a visitor who accepted on the
// brand site and then clicked through to `checkout.<brand>.com` was asked AGAIN,
// mid-purchase, because the checkout literally could not read the choice. A
// cookie with `Domain=<brand>.com` is readable by the apex and every subdomain
// under it, so the same company, the same data controller and the same site
// carry one consent — the checkout shows no banner when a choice already exists.
//
// The one thing this must never become is "hide the banner on checkout hosts".
// Suppressing a banner because you assume consent you cannot read is unlawful;
// the fix is to make the record READABLE, then let the normal `readConsent()`
// logic decide. See {@link CONSENT_STORAGE_KEY} for the cross-domain limit.
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
 * Name of the cookie holding the visitor's choice — and the localStorage key of
 * the mirror. One name for both stores, so nothing has to be kept in sync.
 *
 * **The cookie is the source of truth; localStorage is a mirror.** The cookie is
 * written with `Domain=<registrable domain>` (see {@link CONSENT_COOKIE_MAX_AGE_SECONDS}
 * for the rest of the attributes), which makes one choice readable across the
 * apex and every subdomain of the same site — `<brand>.com` and
 * `checkout.<brand>.com` share it. localStorage cannot do that: it is keyed by
 * ORIGIN, so the checkout subdomain sees an empty store and re-prompts a visitor
 * who already decided, in the middle of paying. The mirror stays because
 * cookies are blocked far more often than localStorage is, and because a
 * `storage` event is still the only cross-tab signal available (see
 * {@link onConsentChange}).
 *
 * **What consent CANNOT carry across.** A cookie's `Domain` may only be the
 * host's own registrable domain or a parent of it — never another site. So a
 * SHARED, multi-tenant checkout served from its own registrable domain (rather
 * than from `checkout.<brand>.com`) is a different site to the browser and must
 * show its own banner: there is no lawful or technical way to inherit the brand
 * site's choice there. Since a multi-tenant checkout resolves the tenant from
 * the request host, the SAME product behaves differently on the two hosts —
 * banner-free on the brand's own subdomain, banner-showing on the shared domain.
 * That is correct, not a bug; do not "fix" it by assuming consent.
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

/**
 * Legacy binary localStorage keys — for cleanup only. NEVER read one of these as
 * a grant. (They were only ever localStorage; there is no legacy cookie to tidy.)
 */
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

// --- cookie storage --------------------------------------------------------
//
// Everything in this section is best-effort and MUST NOT throw: a browser with
// cookies blocked, a sandboxed iframe, or a `file://` page all make
// `document.cookie` unusable, and none of that may be allowed to break a banner
// the visitor has to interact with to use the site.

/**
 * How long the consent cookie lives: **12 months**.
 *
 * Chosen deliberately. There is no statutory expiry in PECR/UK GDPR, but the
 * regulators' consistent position is that consent must be refreshed at
 * "appropriate intervals" (the ICO's cookie guidance; the CNIL puts a number on
 * it — 6 months minimum, 13 months as the outer limit for the cookie itself).
 * 12 months is the interval the industry settled on inside that window: long
 * enough that a returning customer is not re-interrogated every visit, short
 * enough that consent is never treated as permanent. {@link CONSENT_VERSION}
 * handles the other refresh trigger — a policy change re-prompts immediately,
 * regardless of how much of this window is left.
 *
 * Two browser caps sit UNDER this and cannot be raised, which is why the
 * localStorage mirror and a well-behaved banner still matter:
 * - Chrome clamps any cookie to 400 days.
 * - Safari's ITP caps ALL script-writable storage (`document.cookie` **and**
 *   localStorage) to 7 days of no interaction with the site, so some Safari
 *   visitors will be asked again after a week no matter what is set here.
 */
export const CONSENT_COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 365;

/** Resolved once per page: the cookie `Domain`, or null for a host-only cookie. */
let cookieDomain: string | null | undefined;
/** Guard so a blocked-cookie browser doesn't re-attempt migration on every read. */
let migrationAttempted = false;

/** Is this hostname an IP literal? Those can never carry a `Domain` attribute. */
function isIpLiteral(hostname: string): boolean {
  // IPv6 arrives bracketed (`[::1]`) or, defensively, bare — either way it has
  // a colon, which no DNS hostname does.
  return hostname.includes(":") || /^\d{1,3}(\.\d{1,3}){3}$/.test(hostname);
}

/**
 * Candidate cookie domains for a hostname, **broadest first**.
 *
 * Single-label hosts (`localhost`), IP literals and bare TLDs yield nothing —
 * those get a host-only cookie (no `Domain` attribute), which is exactly right.
 * `checkout.<brand>.com` yields `<brand>.com` then `checkout.<brand>.com`;
 * `<brand>.co.uk` yields `co.uk` then `<brand>.co.uk`.
 *
 * Note that `co.uk` is deliberately still OFFERED. This function does not know
 * about public suffixes and must not pretend to — the browser is the authority,
 * and {@link resolveCookieDomain} asks it. See there.
 */
function cookieDomainCandidates(hostname: string): string[] {
  const host = hostname.toLowerCase().replace(/\.+$/, "");
  if (!host || isIpLiteral(host)) return [];

  const labels = host.split(".");
  const candidates: string[] = [];
  // Stop at two labels: a single label is a TLD, and no browser accepts one.
  for (let i = labels.length - 2; i >= 0; i--) candidates.push(labels.slice(i).join("."));
  return candidates;
}

/**
 * `Secure` on HTTPS, omitted on plain HTTP.
 *
 * Not a weakening: a `Secure` cookie set over `http://` is DISCARDED, so
 * hard-coding the flag would silently disable consent storage on every local
 * dev server and leave the banner re-appearing on each page. Production is
 * HTTPS everywhere (HSTS is in the estate's security standard), so production
 * always gets `Secure`. `http://localhost` is treated as a trustworthy origin by
 * browsers, so its host-only cookie works without the flag.
 */
function cookieSecureFlag(): string {
  return typeof window !== "undefined" && window.location?.protocol === "https:" ? "; Secure" : "";
}

/**
 * Write one cookie. `domain` null = host-only. `maxAge` 0 deletes it.
 *
 * `SameSite=Lax` because the record is read by first-party page scripts only and
 * must survive an ordinary top-level navigation from an ad or an email — which
 * `Strict` would break for exactly the visitor we care about (arriving from a
 * Google Ads click, straight into the funnel). `Path=/` so every route sees it.
 * NOT `HttpOnly`: the banner and the head snippet are client-side and have to
 * read it, and there is no server round-trip in this design to set it any other
 * way. Nothing secret is stored here — it is the visitor's own choice.
 */
function writeRawCookie(name: string, value: string, domain: string | null, maxAge: number): void {
  if (typeof document === "undefined") return;
  const parts = [`${name}=${value}`, "Path=/", `Max-Age=${maxAge}`, "SameSite=Lax"];
  if (domain) parts.push(`Domain=${domain}`);
  try {
    document.cookie = parts.join("; ") + cookieSecureFlag();
  } catch {
    // Cookies disabled / sandboxed document — the caller falls back to the mirror.
  }
}

/** Read one cookie's raw (still URL-encoded) value, or null. */
function readRawCookie(name: string): string | null {
  if (typeof document === "undefined") return null;
  let jar = "";
  try {
    jar = document.cookie || "";
  } catch {
    return null;
  }
  const prefix = `${name}=`;
  for (const part of jar.split(";")) {
    const entry = part.trim();
    if (entry.startsWith(prefix)) return entry.slice(prefix.length);
  }
  return null;
}

/**
 * The broadest domain the BROWSER actually accepts for this host — found by
 * attempt-and-verify, not by parsing.
 *
 * **Why not just strip the first label.** `checkout.<brand>.com` → `<brand>.com`
 * is right; `<brand>.co.uk` → `co.uk` is a public suffix, which browsers reject
 * outright (and which would be wrong even if they didn't — it would offer the
 * cookie to every other `.co.uk` site). Getting that right by rule needs the
 * Public Suffix List: ~9,000 entries, updated continuously, that would have to
 * be shipped and refreshed in every consumer bundle. So instead: write a probe
 * cookie at each candidate from broadest to narrowest, read it back, and keep
 * the first one that STUCK. The browser's own PSL does the work, no data ships,
 * and it stays correct when the list changes.
 *
 * The probe name is randomised per resolution so a leftover probe from an
 * earlier page load can never be mistaken for a successful write. Falls back to
 * null (host-only cookie) when nothing sticks — `localhost`, an IP literal, a
 * cookie-blocking browser. Cached for the page's lifetime; the hostname cannot
 * change without a navigation.
 */
function resolveCookieDomain(): string | null {
  if (cookieDomain !== undefined) return cookieDomain;

  cookieDomain = null;
  if (typeof window === "undefined" || typeof document === "undefined") return cookieDomain;

  const probe = `__bt_cd_${Math.random().toString(36).slice(2, 10)}`;
  for (const candidate of cookieDomainCandidates(window.location?.hostname ?? "")) {
    writeRawCookie(probe, "1", candidate, 60);
    const stuck = readRawCookie(probe) === "1";
    // Always tidy up: on a rejected candidate this is a no-op, on an accepted
    // one it stops a stray probe cookie riding along on every request.
    writeRawCookie(probe, "", candidate, 0);
    if (stuck) {
      cookieDomain = candidate;
      break;
    }
  }

  return cookieDomain;
}

/**
 * Delete the consent cookie at EVERY scope it could have been written to —
 * host-only plus every candidate domain, not just the currently-resolved one.
 *
 * This is the important one. A cookie left behind at a broader scope after a
 * visitor clicks Reject would keep granting consent on every other subdomain,
 * and would be invisible from the host that "cleared" it — the worst failure
 * this module could have. It also runs before each write, so a host-only copy
 * from an earlier visit can never shadow the domain-scoped one (two cookies of
 * the same name with the same path have an unspecified order in
 * `document.cookie`, so the only safe answer is to never have two).
 */
function deleteConsentCookieEverywhere(): void {
  if (typeof window === "undefined") return;
  writeRawCookie(CONSENT_STORAGE_KEY, "", null, 0);
  for (const candidate of cookieDomainCandidates(window.location?.hostname ?? "")) {
    writeRawCookie(CONSENT_STORAGE_KEY, "", candidate, 0);
  }
}

/** The choice as stored in the cookie, or null. Never throws. */
function readConsentCookie(): ConsentState | null {
  const raw = readRawCookie(CONSENT_STORAGE_KEY);
  if (raw === null) return null;
  let decoded = raw;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    // A malformed `%` sequence — hand-edited or truncated. `parseConsent` will
    // reject it, which is the correct outcome: no choice, not a grant.
  }
  return parseConsent(decoded);
}

/**
 * Persist the choice to the domain-scoped cookie. Returns whether it stuck, so
 * the caller can tell a real write from a cookie-blocked browser. Never throws.
 *
 * The JSON is URL-encoded because a cookie value may not contain `;`, `,` or
 * whitespace — and the payload is JSON, which contains all three.
 */
function writeConsentCookie(state: ConsentState): boolean {
  if (typeof document === "undefined") return false;
  const domain = resolveCookieDomain();
  deleteConsentCookieEverywhere();
  writeRawCookie(
    CONSENT_STORAGE_KEY,
    encodeURIComponent(JSON.stringify(state)),
    domain,
    CONSENT_COOKIE_MAX_AGE_SECONDS
  );
  return readConsentCookie() !== null;
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
 * **Cookie first, localStorage second.** The cookie is the cross-subdomain
 * record; the localStorage mirror only wins when there is no cookie — a visitor
 * who chose before this module moved to cookies, or one whose cookie write was
 * blocked. A mirror-only record is MIGRATED into the cookie here (once per page,
 * best-effort), so the next hop to `checkout.<brand>.com` reads it without ever
 * re-asking. That makes this read mildly side-effecting, deliberately: the
 * alternative is re-prompting every existing visitor for a choice they already
 * lawfully made under the same policy version.
 *
 * `null` is the state in which a banner must be shown and NOTHING but
 * strictly-necessary storage may fire. Returns `null` on the server — never
 * render a consent-dependent tag during SSR; decide on the client after mount.
 */
export function readConsent(): ConsentState | null {
  if (typeof window === "undefined") return null;

  const fromCookie = readConsentCookie();
  if (fromCookie) return fromCookie;

  let fromMirror: ConsentState | null = null;
  try {
    fromMirror = parseConsent(window.localStorage.getItem(CONSENT_STORAGE_KEY));
  } catch {
    // localStorage throws in Safari private mode / when storage is disabled.
    return null;
  }
  if (!fromMirror) return null;

  if (!migrationAttempted) {
    migrationAttempted = true;
    writeConsentCookie(fromMirror);
  }
  return fromMirror;
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

  // Cookie first — it is the record every subdomain of this site can read, and
  // the one the checkout depends on to not re-ask mid-purchase.
  writeConsentCookie(state);

  try {
    // The mirror. Kept written even when the cookie succeeded: it is what the
    // `storage` event fires on (the only cross-tab signal available), what
    // pre-cookie consumer code still reads, and the fallback for a browser that
    // blocks cookies but allows localStorage.
    window.localStorage.setItem(CONSENT_STORAGE_KEY, JSON.stringify(state));
  } catch {
    // Storage disabled: the choice still applies to THIS page view (the signals
    // below are pushed either way), it just won't survive a reload.
  }
  // A choice was just made; nothing left to migrate.
  migrationAttempted = true;

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
 * **Known limitation — does NOT fire across subdomains.** The `storage` event is
 * scoped to one origin and does not fire at all for cookie writes, so a change
 * made on `<brand>.com` will not notify an already-open `checkout.<brand>.com`
 * tab (or vice versa). The consent itself still travels — the cookie is
 * domain-scoped, so the other tab picks it up on its next read/navigation — but
 * a live in-page callback will not run. Do not rely on this for withdrawal
 * taking effect instantly in an already-open tab on another subdomain; Consent
 * Mode's own signal is what actually gates Google there.
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
 * The same Consent Mode v2 default as {@link initConsentMode}, as a raw inline
 * script for the document `<head>`.
 *
 * **Why this exists as a string.** `initConsentMode()` is module code: in a
 * Next.js app it cannot execute until the client bundle has been parsed and the
 * component tree has mounted. That is early enough only while every Google/Meta
 * tag on the page is itself consent-gated and client-injected — one
 * `<Script src="…gtag/js">` rendered server-side into the HTML and the ordering
 * silently inverts, Google discards the late default, and the site is back to
 * unconsented storage with no error anywhere. Putting the default in the head as
 * a parser-blocking inline script makes the ordering a property of the HTML
 * itself rather than of component mount order, which is the only version of this
 * you can actually verify (view source, or a browser network waterfall).
 *
 * Render it first inside the root layout's `<head>`:
 *
 * ```tsx
 * <head>
 *   <script dangerouslySetInnerHTML={{ __html: CONSENT_MODE_HEAD_SNIPPET }} />
 * </head>
 * ```
 *
 * Do NOT reach for `next/script` with `strategy="beforeInteractive"` here: in
 * the App Router an inline `beforeInteractive` script is not emitted as a plain
 * `<script>` at all — Next wraps the body in `(self.__next_s=…).push(…)` and
 * replays it from its own runtime, so what lands in the HTML is a queue entry,
 * not an executed consent default.
 *
 * It replays a stored choice too, so a returning visitor's grant is in effect
 * before the first tag rather than 500ms later. The storage key and version are
 * interpolated from the constants above — they cannot drift from
 * {@link readConsent}, which is the entire reason this lives here rather than
 * being hand-copied into four root layouts. Still call {@link initConsentMode}
 * from the app as well (it is idempotent): this snippet covers the pre-hydration
 * window, that call covers everything after it.
 */
export const CONSENT_MODE_HEAD_SNIPPET = `
window.dataLayer=window.dataLayer||[];
function gtag(){dataLayer.push(arguments);}
gtag('consent','default',{ad_storage:'denied',ad_user_data:'denied',ad_personalization:'denied',analytics_storage:'denied',functionality_storage:'granted',security_storage:'granted',wait_for_update:500});
gtag('set','ads_data_redaction',true);
gtag('set','url_passthrough',true);
try{
  var k=${JSON.stringify(CONSENT_STORAGE_KEY)};
  var raw=null;
  /* Cookie FIRST: it is the source of truth and, unlike localStorage, it is
     readable across the brand's subdomains. On checkout.<brand>.com this is the
     ONLY place the grant exists, and replaying it here — before wait_for_update
     expires — is what stops the first checkout pageview being modelled instead
     of measured. Falls back to the localStorage mirror when cookies are blocked. */
  var m=document.cookie.match(new RegExp('(?:^|; *)'+k+'=([^;]*)'));
  if(m){try{raw=decodeURIComponent(m[1]);}catch(e){raw=m[1];}}
  if(!raw){try{raw=window.localStorage.getItem(k);}catch(e){}}
  var s=JSON.parse(raw||'null');
  if(s&&s.version===${CONSENT_VERSION}){
    gtag('consent','update',{ad_storage:s.marketing?'granted':'denied',ad_user_data:s.marketing?'granted':'denied',ad_personalization:s.marketing?'granted':'denied',analytics_storage:s.analytics?'granted':'denied'});
  }
}catch(e){}
`.trim();

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
  // Cookie FIRST, and at every domain scope. The cookie is the source of truth
  // (readConsent prefers it), so clearing only the localStorage mirror would
  // leave the visitor still consented — and consented on every sibling
  // subdomain, invisibly from whichever host ran this. See
  // deleteConsentCookieEverywhere.
  deleteConsentCookieEverywhere();
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
