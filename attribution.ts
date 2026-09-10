/**
 * attribution — where a visitor came from, captured once and kept.
 * ---------------------------------------------------------------------------
 * THE ONE IMPLEMENTATION of UTM + click-id capture and storage for every
 * estate site. Framework-agnostic on purpose: no React, no Next. A repo wraps
 * these in its own hook/component (three lines) rather than owning a copy of
 * the rules.
 *
 * WHY IT MOVED HERE (2026-09-10). This logic existed TWICE, in two consumer
 * repos, and a third site was about to get a copy. That third site had already
 * written its own weaker version inside a single page component: five UTM keys,
 * sessionStorage only, no click ids at all. So a site whose traffic is bought
 * could not attribute a sale to an ad even in principle, while the rule set
 * that would have fixed it sat finished in a sibling repo. That is the
 * "a rule that lives in two places is enforced in neither" failure.
 *
 * Every rule below is preserved from the older of the two implementations,
 * along with the incident that produced it. Do not simplify one without
 * reading its comment.
 *
 * WHAT IS NEW HERE: `fbclid`. Meta's click id is kept as its OWN field, never
 * folded into `gclid`. They are different platforms with different attribution
 * windows and different consumers, and a single "clickId" field would make it
 * impossible to tell which network to credit.
 *
 * SSR-SAFE, like `consent.ts`: every export no-ops or returns an empty value
 * when there is no `window`.
 */

import { hasConsent } from "./consent";

export interface UtmParams {
  utm_source?: string;
  utm_medium?: string;
  utm_campaign?: string;
  utm_content?: string;
  utm_term?: string;
}

export interface ClickIds {
  /** Google: `gclid`, or `gbraid`/`wbraid` on iOS app/web campaigns. */
  gclid?: string;
  /** Meta: `fbclid`. Kept separate from gclid — different network, different window. */
  fbclid?: string;
}

export interface Attribution extends ClickIds {
  utm: UtmParams;
  /** True when this touch was paid — see `isPaidTouch`. */
  paid: boolean;
}

const UTM_KEYS = ["utm_source", "utm_medium", "utm_campaign", "utm_content", "utm_term"] as const;

/**
 * Google's auto-tagging click identifiers. `gclid` is the standard one; `gbraid`
 * and `wbraid` replace it on iOS app/web campaigns where Google can't set a
 * gclid. Bing's `msclkid` is deliberately NOT here — we don't run Bing yet, and
 * an unused field in the leads table is a thing people trust and shouldn't.
 */
const GOOGLE_CLICK_ID_KEYS = ["gclid", "gbraid", "wbraid"] as const;

/** Media that mean "we paid for this visit". Compared lowercased. */
const PAID_MEDIUMS = new Set(["cpc", "ppc", "paid", "paidsearch", "paid_search", "display", "cpm", "paid-social"]);

const MAX_VALUE_LENGTH = 200;

/**
 * 90 days, matching Google Ads' default conversion window. The store used to be
 * sessionStorage, which is per-TAB and dies on tab close — so a visitor who
 * clicked an ad, closed the tab and came back an hour later arrived with no
 * attribution at all, while Google's own gclid cookie still credited the ad.
 * That is exactly what happened on 2026-09-01: the ad platform reported two
 * conversions and our own lead store recorded neither as paid.
 */
const TTL_MS = 90 * 24 * 60 * 60 * 1000;

interface StoredAttribution extends ClickIds {
  utm: UtmParams;
  paid: boolean;
  /** Capture time in ms since epoch, used for the TTL. */
  ts: number;
}

/**
 * Storage key. Per-site so two brands on one browser cannot inherit each
 * other's campaign, and configurable so a repo that already has a populated
 * store keeps it across the migration rather than silently starting empty.
 */
export interface AttributionOptions {
  storageKey?: string;
  /** A per-tab store written before consent is granted. See `writeStored`. */
  legacySessionKey?: string;
}

const DEFAULT_STORAGE_KEY = "bt_attribution";

function keyOf(opts?: AttributionOptions): string {
  return opts?.storageKey ?? DEFAULT_STORAGE_KEY;
}

function hasWindow(): boolean {
  return typeof window !== "undefined";
}

function parseRecord(raw: string | null): StoredAttribution | null {
  if (!raw) return null;
  const parsed = JSON.parse(raw) as StoredAttribution;
  if (!parsed || typeof parsed.ts !== "number") return null;
  if (Date.now() - parsed.ts >= TTL_MS) return null;
  return parsed;
}

function readStored(opts?: AttributionOptions): StoredAttribution | null {
  if (!hasWindow()) return null;
  const key = keyOf(opts);
  try {
    // The 90-day store first, then the session-scoped mirror. The mirror is what
    // carries a visitor who has not accepted marketing cookies through their
    // current journey — see `writeStored`.
    const persisted = parseRecord(localStorage.getItem(key));
    if (persisted) return persisted;
    if (localStorage.getItem(key)) {
      // Present but expired — drop it so a stale campaign can't be credited forever.
      localStorage.removeItem(key);
    }

    const session = parseRecord(sessionStorage.getItem(key));
    if (session) return session;

    // One-time migration: visitors mid-journey when this shipped still have
    // their UTMs in the old per-tab store. Better to inherit them than to
    // silently lose attribution on the deploy.
    const legacyKey = opts?.legacySessionKey;
    if (legacyKey) {
      const legacy = sessionStorage.getItem(legacyKey);
      if (legacy) {
        const utm = JSON.parse(legacy) as UtmParams;
        return { utm, paid: isPaidTouch(utm, {}), ts: Date.now() };
      }
    }
  } catch {
    /* private mode, disabled storage, or corrupt JSON — attribution is never
       worth throwing over. */
  }
  return null;
}

/**
 * Persist the touch.
 *
 * The 90-day localStorage copy is marketing measurement that outlives the visit,
 * so it is gated on `marketing` consent — the same gate the ad tags go through.
 * Writing a 90-day identifier for ad attribution before the visitor has agreed
 * to it is exactly what PECR is about.
 *
 * The sessionStorage mirror is written unconditionally and is what makes this a
 * strict improvement rather than a trade: it is per-tab and dies with the tab,
 * which is all the previous implementations ever did, and it covers the common
 * journey (ad -> landing page -> form/checkout, one tab, one sitting) for a
 * visitor who never touches the banner. Accepting marketing later promotes the
 * session copy into the durable one — see `promoteStoredAttribution`.
 */
function writeStored(record: StoredAttribution, opts?: AttributionOptions): void {
  if (!hasWindow()) return;
  const key = keyOf(opts);
  const serialised = JSON.stringify(record);
  try {
    sessionStorage.setItem(key, serialised);
  } catch {
    /* ignore */
  }
  try {
    if (hasConsent("marketing")) localStorage.setItem(key, serialised);
  } catch {
    /* ignore */
  }
}

/**
 * Copy whatever the current session holds into the 90-day store. Call it when
 * the visitor accepts marketing cookies AFTER landing, which is the normal
 * order of events: the banner is on the landing page, the ad's UTMs are already
 * in the URL, and the accept click arrives seconds later.
 */
export function promoteStoredAttribution(opts?: AttributionOptions): void {
  if (!hasWindow()) return;
  try {
    if (!hasConsent("marketing")) return;
    const record = readStored(opts);
    if (record) localStorage.setItem(keyOf(opts), JSON.stringify(record));
  } catch {
    /* ignore */
  }
}

function isPaidTouch(utm: UtmParams, ids: ClickIds): boolean {
  if (ids.gclid || ids.fbclid) return true;
  const medium = utm.utm_medium?.toLowerCase().trim();
  return !!medium && PAID_MEDIUMS.has(medium);
}

/** Reads UTMs and click ids out of the current URL. */
function captureFromUrl(): { utm: UtmParams; ids: ClickIds; hasAny: boolean } {
  const params = new URLSearchParams(window.location.search);
  const utm: UtmParams = {};
  const ids: ClickIds = {};
  let hasAny = false;

  for (const key of UTM_KEYS) {
    const val = params.get(key);
    if (val) {
      utm[key] = val.slice(0, MAX_VALUE_LENGTH);
      hasAny = true;
    }
  }

  for (const key of GOOGLE_CLICK_ID_KEYS) {
    const val = params.get(key);
    if (val) {
      ids.gclid = val.slice(0, MAX_VALUE_LENGTH);
      hasAny = true;
      break;
    }
  }

  const fbclid = params.get("fbclid");
  if (fbclid) {
    ids.fbclid = fbclid.slice(0, MAX_VALUE_LENGTH);
    hasAny = true;
  }

  return { utm, ids, hasAny };
}

/**
 * Decides whether a freshly captured touch should replace what's already stored.
 *
 * The rule is "a paid touch is sticky": once we've recorded that this visitor
 * arrived from an ad, a later unpaid touch must not overwrite it. Google Ads
 * credits the last AD click within 90 days, so this keeps our own tables
 * agreeing with the number in the Ads UI instead of contradicting it.
 *
 * This is load-bearing, not belt-and-braces. On 2026-09-01 a visitor clicked a
 * paid ad, read a blog post, and clicked an in-article CTA whose href hard-coded
 * `utm_source=blog&utm_medium=organic`. The old "overwrite whenever the URL has
 * new UTMs" rule took that internal link at face value and the lead was filed as
 * organic. Internal links no longer inject those params, but any link that grows
 * UTMs later would reintroduce the bug, so the store defends itself too.
 */
function shouldReplace(stored: StoredAttribution | null, incomingPaid: boolean): boolean {
  if (!stored) return true;
  if (incomingPaid) return true;
  // An unpaid touch may replace another unpaid touch (last non-direct click
  // wins) but never a paid one.
  return !stored.paid;
}

/**
 * Merge the current URL's attribution into the store and return the effective
 * record. Safe to call from several places on one page — it is idempotent
 * within a render pass, because a second call captures the same URL and, finding
 * the stored record equivalent, writes the same thing.
 *
 * Capture must NOT depend on a form being on the page. An ad lands the visitor
 * on a content page; the form or checkout is a click later. Mount the caller on
 * every route (a root provider), or the landing page captures nothing at all.
 */
export function captureAttribution(opts?: AttributionOptions): Attribution {
  if (!hasWindow()) return { utm: {}, paid: false };

  const stored = readStored(opts);
  const { utm, ids, hasAny } = captureFromUrl();

  if (!hasAny) {
    return {
      utm: stored?.utm ?? {},
      gclid: stored?.gclid,
      fbclid: stored?.fbclid,
      paid: stored?.paid ?? false,
    };
  }

  // A capture carrying neither `utm_source`, `utm_medium` nor a click id is not
  // claiming to be a traffic source — it is an internal link annotating which
  // page sent the visitor onward (a blog CTA does exactly this). Merge the
  // campaign detail in and leave the real source alone. Without this, every
  // internal link that wants to name itself has to either lie about the source
  // or go unattributed.
  const isSourceClaim = !!(utm.utm_source || utm.utm_medium || ids.gclid || ids.fbclid);
  if (!isSourceClaim && stored) {
    const merged: StoredAttribution = { ...stored, utm: { ...stored.utm, ...utm } };
    writeStored(merged, opts);
    return { utm: merged.utm, gclid: merged.gclid, fbclid: merged.fbclid, paid: merged.paid };
  }

  const incomingPaid = isPaidTouch(utm, ids);
  if (!shouldReplace(stored, incomingPaid)) {
    return { utm: stored!.utm, gclid: stored!.gclid, fbclid: stored!.fbclid, paid: stored!.paid };
  }

  const record: StoredAttribution = { utm, ...ids, paid: incomingPaid, ts: Date.now() };
  writeStored(record, opts);
  return { utm, ...ids, paid: incomingPaid };
}

/** Persisted UTMs, for use outside a component. Empty object when nothing stored. */
export function getStoredUtmParams(opts?: AttributionOptions): UtmParams {
  return readStored(opts)?.utm ?? {};
}

/** Persisted click ids, for use outside a component. */
export function getStoredClickIds(opts?: AttributionOptions): ClickIds {
  const stored = readStored(opts);
  return { gclid: stored?.gclid, fbclid: stored?.fbclid };
}

/**
 * The stored attribution as URL query params, for forwarding onto an OFF-SITE
 * checkout (a hosted payment page) so the processor's order record can be
 * joined back to the ad that produced it.
 *
 * ONLY for links leaving our domain. An INTERNAL link must never carry
 * `utm_source`/`utm_medium` — that re-attributed a paid lead on 2026-09-01.
 * See the UTM standard.
 */
export function attributionQueryString(opts?: AttributionOptions): string {
  const stored = readStored(opts);
  if (!stored) return "";
  const params = new URLSearchParams();
  for (const key of UTM_KEYS) {
    const val = stored.utm[key];
    if (val) params.set(key, val);
  }
  if (stored.gclid) params.set("gclid", stored.gclid);
  if (stored.fbclid) params.set("fbclid", stored.fbclid);
  return params.toString();
}
