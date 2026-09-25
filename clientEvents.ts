import { onConsentChange } from "./consent";

/**
 * Browser-side GA4 + Meta event helpers — the CLIENT half of consent-independent measurement.
 *
 * WHY THIS EXISTS. Every site in the estate was hand-writing the same two helpers: a GA4 `track()`
 * that calls `window.gtag("event", …)`, and a Meta `trackMeta()` that calls `window.fbq("track", …)`.
 * The copies drifted on the two details that decide whether the numbers are right:
 *
 *   1. **eventID dedupe.** When the same Meta event is sent from the server (Conversions API, see
 *      `metaCapi.ts` `sendLandingPageView`) AND from the browser pixel, Meta only counts it once if
 *      both carry the same event id. A copy that forgets `{ eventID }` double-counts every visitor
 *      who accepts cookies — silently, with no error.
 *   2. **Load-time events are lost without waiting for consent.** The pixel (`fbq`) only exists
 *      once advertising consent has loaded it. A ViewContent fired from a page's mount effect runs
 *      BEFORE the banner's own mount effect loads the pixel, and a first-time visitor clicks
 *      "Accept all" later still — so without `waitForConsent` a load-time event is never sent.
 *
 * WHAT THIS MODULE DOES NOT DO. It never loads a tag and never decides consent: the banner
 * (per-repo) and `consent.ts`/`adPlatforms.ts` own that. With no consent, `fbq` does not exist and
 * `trackMeta` no-ops, which is the lawful outcome. `window.gtag` is always the Consent Mode stub
 * installed by the head snippet, so GA4 calls queue and Consent Mode decides cookies vs a
 * cookieless ping.
 *
 * DOUBLE-COUNT RULES (the reason the helpers are shared rather than copied):
 *   - Purchase is NEVER sent from a site: the checkout sends it server-side (CAPI + GA4
 *     Measurement Protocol) from the payment webhook.
 *   - InitiateCheckout is NEVER sent from a site whose checkout sends it itself (an owned
 *     checkout does, browser + server). The site's buy link sends AddToCart only.
 *   - A browser event that also has a server twin MUST carry the server twin's event id.
 *
 * SSR-SAFE and framework-agnostic (golden rule 6): no React, no `declare global`, no tag ids.
 */

type Gtag = (...args: unknown[]) => void;
type Fbq = (...args: unknown[]) => void;

interface EventWindow {
  gtag?: Gtag;
  fbq?: Fbq;
}

function eventWindow(): EventWindow | null {
  if (typeof window === "undefined") return null;
  return window as unknown as EventWindow;
}

/** GA4 event. Queues on the Consent Mode stub if gtag.js has not loaded yet; no-ops on the server. */
export function track(event: string, params: Record<string, unknown> = {}): void {
  const w = eventWindow();
  if (!w || typeof w.gtag !== "function") return;
  w.gtag("event", event, params);
}

export interface TrackMetaOptions {
  /**
   * Fire later if the pixel is not loaded yet: once, right after the banner's mount effect (stored
   * consent), or when advertising consent is first given. Use it for events that happen on page
   * load (ViewContent). Leave it off for click events: if the pixel is not there at click time the
   * visitor has not consented, and a queued event would fire on a later, unrelated consent.
   */
  waitForConsent?: boolean;
  /** Share with the server-side (CAPI) twin of this event so Meta de-duplicates the pair. */
  eventId?: string;
}

/** Meta standard event via the pixel. No-ops without advertising consent (no `fbq`). */
export function trackMeta(event: string, params: Record<string, unknown> = {}, opts: TrackMetaOptions = {}): void {
  const w = eventWindow();
  if (!w) return;
  const fire = (): boolean => {
    const fbq = w.fbq;
    if (typeof fbq !== "function") return false;
    if (opts.eventId) fbq("track", event, params, { eventID: opts.eventId });
    else fbq("track", event, params);
    return true;
  };
  if (fire() || !opts.waitForConsent) return;
  // Stored consent: the banner's mount effect loads the pixel right after the caller's effect.
  setTimeout(() => {
    if (fire()) return;
    // No choice yet: fire once, if and when advertising consent is given.
    const unsubscribe = onConsentChange((state) => {
      if (!state?.marketing) return;
      // The banner's own consent listener loads the pixel; let it run first.
      setTimeout(() => {
        if (fire()) unsubscribe();
      }, 0);
    });
  }, 0);
}

/** A single product, described once, rendered into both platforms' standard-event shapes. */
export interface EventProduct {
  id: string;
  name: string;
  /** ISO 4217, upper case (GBP, USD). */
  currency: string;
  value: number;
  category?: string;
  quantity?: number;
}

/** GA4 ecommerce params (`view_item`, `add_to_cart`, `begin_checkout`). */
export function ga4ItemParams(p: EventProduct): Record<string, unknown> {
  const quantity = p.quantity ?? 1;
  return {
    currency: p.currency,
    value: p.value,
    items: [
      {
        item_id: p.id,
        item_name: p.name,
        ...(p.category ? { item_category: p.category } : {}),
        price: quantity > 0 ? p.value / quantity : p.value,
        quantity,
      },
    ],
  };
}

/** Meta standard-event params (`ViewContent`, `AddToCart`). */
export function metaProductParams(p: EventProduct): Record<string, unknown> {
  return {
    currency: p.currency,
    value: p.value,
    content_ids: [p.id],
    content_type: "product",
    content_name: p.name,
    num_items: p.quantity ?? 1,
  };
}
