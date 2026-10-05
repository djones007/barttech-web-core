/**
 * Server twin of a CLICK-driven Meta event (AddToCart, InitiateCheckout, Lead, ...).
 * Pure: no "server-only", no network, so it is unit-tested. `sendClickEvent` in
 * metaCapi.ts is the thin sender that uses it.
 *
 * THE STANDARD (Dom, 2026-10-05): every Meta conversion event the browser pixel
 * fires has a server-side twin carrying the SAME event id, because the pixel only
 * exists after advertising consent and so only counts people who accepted. Purchase
 * and InitiateCheckout already follow this (the checkout sends both from the server);
 * ViewContent follows it (`sendLandingPageView`); AddToCart did not, which is why the
 * Still Room's AddToCart volume was a consent-filtered fraction of the real clicks.
 *
 * Why only CLICK events are allowed through this door. `ViewContent` / `PageView`
 * are events a server can emit with no human behind them: a crawler's page load made
 * ViewContent ~20x inflated and poisoned a live campaign (2026-09-08). A click is
 * different (a crawler does not click), so a request to this endpoint is evidence a
 * person acted. The allowlist below is therefore the safety property, not a
 * convenience: adding a page-load event here would rebuild that incident.
 *
 * Browser half: `trackMetaTwin` in clientEvents.ts (generates the id, fires the
 * pixel with it if consented, and ALWAYS beacons this body to the site's route).
 */

/** Events a visitor causes by clicking. Never ViewContent / PageView / anything fired on load. */
export const CLICK_EVENTS = ["AddToCart", "InitiateCheckout", "Lead", "Contact", "Schedule"] as const;
export type ClickEventName = (typeof CLICK_EVENTS)[number];

export interface ClickEventBody {
  event: ClickEventName;
  eventId: string;
  sourceUrl: string;
  currency?: string;
  value?: number;
  contentName?: string;
  contentIds?: string[];
}

export type ClickEventParse = { ok: true; body: ClickEventBody } | { ok: false; reason: string };

const ID_RE = /^[A-Za-z0-9_-]{16,64}$/;

export function parseClickEventBody(raw: unknown): ClickEventParse {
  if (!raw || typeof raw !== "object") return { ok: false, reason: "body is not an object" };
  const r = raw as Record<string, unknown>;
  if (typeof r.event !== "string" || !(CLICK_EVENTS as readonly string[]).includes(r.event)) {
    return { ok: false, reason: "event is not a click event (ViewContent/PageView are never accepted here)" };
  }
  if (typeof r.eventId !== "string" || !ID_RE.test(r.eventId)) return { ok: false, reason: "eventId missing or malformed (the browser pixel's id is required for dedupe)" };
  if (typeof r.sourceUrl !== "string" || r.sourceUrl.length > 500 || !/^https?:\/\//i.test(r.sourceUrl)) return { ok: false, reason: "sourceUrl missing or not http(s)" };
  const body: ClickEventBody = { event: r.event as ClickEventName, eventId: r.eventId, sourceUrl: r.sourceUrl };
  if (r.currency !== undefined) {
    if (typeof r.currency !== "string" || !/^[A-Z]{3}$/.test(r.currency)) return { ok: false, reason: "currency is not ISO 4217 upper case" };
    body.currency = r.currency;
  }
  if (r.value !== undefined) {
    if (typeof r.value !== "number" || !Number.isFinite(r.value) || r.value < 0 || r.value > 10000) return { ok: false, reason: "value out of range" };
    body.value = r.value;
  }
  if (typeof r.contentName === "string") body.contentName = r.contentName.slice(0, 120);
  if (Array.isArray(r.contentIds)) body.contentIds = r.contentIds.filter((x): x is string => typeof x === "string").slice(0, 10).map((x) => x.slice(0, 60));
  return { ok: true, body };
}

/**
 * The request must come from one of the site's own pages: a forged POST from
 * elsewhere (no Origin/Referer, or another host) is refused. Fails CLOSED: an absent
 * header is not a pass, because a browser always sends Origin on a cross-origin POST
 * and Referer or Origin on a same-origin one.
 */
export function isFromAllowedHost(hdrs: { get(name: string): string | null }, allowedHosts: readonly string[]): boolean {
  const src = hdrs.get("origin") ?? hdrs.get("referer");
  if (!src) return false;
  try {
    const host = new URL(src).hostname.toLowerCase();
    return allowedHosts.some((h) => host === h.toLowerCase() || host === `www.${h.toLowerCase()}`);
  } catch {
    return false;
  }
}

/** fbclid from the page URL the click happened on, so the server event is attributable even with no pixel. */
export function fbclidFromUrl(url: string): string | undefined {
  try {
    return new URL(url).searchParams.get("fbclid") ?? undefined;
  } catch {
    return undefined;
  }
}
