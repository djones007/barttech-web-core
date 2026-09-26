import "server-only";
import { isAutomatedRequest } from "./requestSignals";
import { device } from "./device";

/**
 * Consent-independent funnel logging for campaign/marketing pages.
 *
 * WHY THIS EXISTS. Client-side analytics on the estate's sites loads only
 * after a visitor taps a consent button — `if (!consent?.analytics) return
 * null` is a common `components/analytics.tsx` shape. When a site-wide
 * cookie banner was shrunk to fit a smaller share of a phone viewport,
 * consent taps collapsed and every recorded session went with them: one
 * landing page's session count fell to roughly 0.5% of its real visitors
 * while paid traffic kept arriving at 100+ clicks a day. Behind a consent
 * gate, a session count measures consent TAPS, not traffic.
 *
 * The banner change was right — the old one sat on the hero CTA and was
 * costing conversions. The mistake was having no measurement that did not
 * depend on it. This is that measurement: posted from the server, from the
 * same crawler-gated moments that already send Meta CAPI (`metaCapi.ts`), so
 * consent cannot suppress it.
 *
 * DELIBERATELY AGGREGATE-ONLY. No IP, no user agent string, no visitor id, no
 * cookie — nothing joinable to a person. That is the whole point: storing
 * nothing on the device means no PECR consent is owed, and holding no
 * identifier means there is no personal data here. Do not "improve" this by
 * adding a visitor id; that would turn a consent-free signal into one that
 * needs consent, which is the exact problem it exists to route around.
 *
 * ALWAYS CALL INSIDE `after()`. It must never sit between a visitor and their
 * page or their checkout redirect. It swallows every error by design — a
 * telemetry write is never worth breaking a page for.
 *
 * `site` is a caller parameter, never a constant here — this module has no
 * idea which brand is calling it, and never should.
 *
 * EVENT VOCABULARY is deliberately a small closed set, kept in sync with the
 * receiving endpoint's own allowlist (never widen one without the other):
 *   - `landing`       — a visit to a page worth counting. Every funnel has one.
 *   - `reserve_click` — a mid-funnel reservation/intent click. Ignore if your
 *                        funnel has no such step.
 *   - `lead_submit`    — a lead-capture form POST succeeded server-side.
 *   - `landing_owner`  — a companion marker for a `landing` already recorded on
 *                        this same page view, sent once the CLIENT learns the
 *                        visitor already owns/holds the thing the page is
 *                        selling (a game licence, a paid product). Fired from
 *                        `after()` a beat later than the `landing` it pairs
 *                        with, because ownership needs a signed-in session
 *                        check the server can't make at initial render. A
 *                        split-test report subtracts `landing_owner` rows from
 *                        `landing` for the same variant, since an owner never
 *                        generates a fresh order for that test. Tag it with the
 *                        SAME `experiment`/`variant` as the landing it pairs
 *                        with (re-derive the sticky assignment for the same
 *                        visitor key — same experiment key, same request
 *                        address/UA — rather than trusting a client-supplied
 *                        variant). Never fire this without a live experiment on
 *                        the page: there is nothing to exclude if no test is
 *                        running.
 *
 * SPLIT TESTS: pass `experiment` (from `experiments.ts`) on a tested page's
 * `landing`, its buy click's `reserve_click`, and any `landing_owner`
 * companion. The receiving endpoint stores experiment / variant /
 * experiment_forced; the vocabulary above does not change.
 */
const TIMEOUT_MS = 2000;

export type PageEventName = "landing" | "reserve_click" | "lead_submit" | "landing_owner";

/**
 * Loose on purpose: a Next.js page's `searchParams` gives
 * `string | string[] | undefined`, while a route handler's
 * `Object.fromEntries(...)` gives plain strings. Accepting both means neither
 * call site has to normalise, and `first()` below collapses a repeated param
 * (`?utm_source=a&utm_source=b`) to its first value rather than "a,b".
 */
type SearchParamsLike = Record<string, string | string[] | undefined>;

type TrackServerEventArgs = {
  /** The brand/site sending this — e.g. its public hostname. Never a constant here. */
  site: string;
  event: PageEventName;
  path: string;
  headers: Headers;
  searchParams?: SearchParamsLike;
  /** Brand-specific context (e.g. a product/game slug). Optional, passed through as-is. */
  game?: string | null;
  currency?: string | null;
  /**
   * The split-test assignment this event belongs to (see `experiments.ts`).
   * A variant id is not an identifier: many visitors share it, so the row
   * stays aggregate-only. `forced` marks a QA view (`?v=`) for exclusion.
   */
  experiment?: { key: string; variant: string; forced?: boolean } | null;
};

function first(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) return value[0] ?? null;
  return value ?? null;
}

/** Host only — a full referrer URL can carry a query string, and query strings carry identifiers. */
function referrerHost(headers: Headers, site: string): string | null {
  const referer = headers.get("referer");
  if (!referer) return null;
  try {
    const host = new URL(referer).hostname;
    return host === site ? null : host; // internal navigation is not a referrer
  } catch {
    return null;
  }
}

/**
 * Post one aggregate, no-identifier event to the shared ingest endpoint
 * (`PAGE_EVENTS_URL`) — a token-gated `POST` on the estate's internal ops app.
 * Never throws; unconfigured (local dev, preview with no token) is simply
 * off, never an error.
 */
export async function trackServerEvent({
  site,
  event,
  path,
  headers,
  searchParams = {},
  game = null,
  currency = null,
  experiment = null,
}: TrackServerEventArgs): Promise<void> {
  const url = process.env.PAGE_EVENTS_URL;
  const token = process.env.PAGE_EVENTS_TOKEN;
  // Unconfigured (local dev, preview) is simply off — never an error.
  if (!url || !token) return;

  // Crawlers, link scrapers and prefetches are not visits. Uses the SAME gate
  // Meta CAPI sends already use — never a second copy of that rule, which is
  // what let a server-side ViewContent run at 300+/hour before this gate
  // existed. See requestSignals.ts.
  //
  // `lead_submit` and `landing_owner` are posted from a route handler answering
  // the CALLER'S OWN `fetch()` (a form submit; a client-side ownership check),
  // never a page navigation, so both are gated as a "form submit": a real
  // browser fetch is `sec-fetch-mode: cors`, which the page-visit rule would
  // read as automated and drop — which is exactly what happened to every
  // `lead_submit` until 2026-09-25. Bots are still caught by the user-agent/
  // prefetch rules regardless.
  const isRouteHandlerFetch = event === "lead_submit" || event === "landing_owner";
  if (isAutomatedRequest(headers, { formSubmit: isRouteHandlerFetch })) return;

  try {
    await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        site,
        path,
        event,
        game,
        currency,
        utm_source: first(searchParams.utm_source),
        utm_medium: first(searchParams.utm_medium),
        utm_campaign: first(searchParams.utm_campaign),
        referrer_host: referrerHost(headers, site),
        device: device(headers),
        country: headers.get("x-vercel-ip-country"),
        // Absent (not null) when there is no experiment, so a receiver that
        // predates these fields sees exactly the payload it always did.
        ...(experiment
          ? {
              experiment: experiment.key,
              variant: experiment.variant,
              experiment_forced: experiment.forced === true,
            }
          : {}),
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
      cache: "no-store",
    });
  } catch {
    // Silent by design. A missing analytics row is a smaller problem than a
    // 500 on a page that is taking money.
  }
}
