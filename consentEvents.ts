// ---------------------------------------------------------------------------
// consentEvents — browser-side trigger for the consent accept-rate metric.
//
// WHY THIS EXISTS. Every PostHog/GA4/Rybbit number the estate has is gated
// behind the SAME cookie banner it is trying to measure, so nothing anywhere
// reports the banner's own accept rate — the denominator on every one of
// those numbers. Fixed 2026-09-26: the banner posts three consent-independent
// aggregate events (`consent_shown` / `consent_accept` / `consent_reject`,
// see `pageEvents.ts`'s vocabulary) to the SAME server-side event store that
// already survives a rejected banner (`campaign_page_events`), because this
// event fires from the click itself, never from a tag that consent gates.
//
// NO NODE IMPORTS — client components import this file directly, same rule
// as `mailProviderNotice.ts`/`mailProviderEvents.ts`/`consent.ts`. No-ops
// entirely on the server.
//
// THIS FILE MUST NOT CARRY THE `PAGE_EVENTS_TOKEN`. That is a server secret
// used by `pageEvents.ts`'s `trackServerEvent()`, which runs in the
// CONSUMER'S OWN route handler. This module only fetches whatever URL the
// caller gives it — normally the consumer's own same-origin API route (e.g.
// `/api/consent-event`), which holds the token server-side and calls
// `trackServerEvent()` itself. Never point this at `PAGE_EVENTS_URL`
// directly from the browser.
//
// DELIBERATELY AGGREGATE-ONLY, same guarantee as pageEvents.ts: the payload
// carries a fixed choice string and nothing else. No visitor id, no cookie
// value, no timestamp of prior visits. Adding one would turn a consent-free
// signal into one that needs consent.
// ---------------------------------------------------------------------------

/** The three consent-banner moments worth counting. Maps 1:1 to a `PageEventName` on the server. */
export type ConsentEventChoice = "shown" | "accept" | "reject";

/**
 * Post one consent-banner event to the consumer's own same-origin endpoint.
 * Never throws, never blocks the caller, and prefers `navigator.sendBeacon`
 * (survives the page unloading, which `accept`/`reject` never do but a
 * `shown` fired right before a bounce sometimes does).
 *
 * ```ts
 * // In the banner's mount effect, right before making it visible:
 * trackConsentEvent("/api/consent-event", "shown");
 * // In the Accept/Reject handlers, alongside writeConsent():
 * trackConsentEvent("/api/consent-event", "accept");
 * ```
 */
export function trackConsentEvent(url: string, choice: ConsentEventChoice): void {
  if (typeof window === "undefined" || !url) return;

  try {
    const body = JSON.stringify({ choice });
    if (typeof navigator !== "undefined" && typeof navigator.sendBeacon === "function") {
      const sent = navigator.sendBeacon(url, new Blob([body], { type: "application/json" }));
      if (sent) return;
      // sendBeacon can refuse (queue full, disabled) — fall through to fetch.
    }
    void fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
      keepalive: true,
      cache: "no-store",
    }).catch(() => {
      // Silent by design — a missed consent-rate row is never worth breaking
      // the banner over.
    });
  } catch {
    // Never let a telemetry call break the banner.
  }
}
