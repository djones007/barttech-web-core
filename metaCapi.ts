import "server-only";
import { randomUUID } from "node:crypto";
import { isAutomatedRequest } from "./requestSignals";
import { hashedCapiIdentity } from "./metaCapiUserData";
import { fbclidFromUrl, isFromAllowedHost, parseClickEventBody } from "./metaClickEvent";

// Re-exported so the existing import surface is unchanged (golden rule 4) and so
// the gate below and its tests name the same function.
export { isAutomatedRequest };

/**
 * Meta Conversions API (CAPI) — server-side Meta events.
 *
 * STANDARD: always send Meta events server-side through CAPI. The browser pixel
 * is the secondary path, never the only one.
 *
 * Why. A consent-gated pixel loads only after the visitor accepts cookies, so
 * every decliner (and every ad-blocker user) is a visit Meta never sees. On a paid
 * landing page that reads as a phantom bounce — clicks that never become
 * landing-page views — and the delivery system responds by deprioritising the ads.
 * Server events are consent-independent, blocker-independent and complete.
 *
 * What this module sends and does NOT send. It never sets a cookie and never
 * touches the browser. It sends `client_ip_address`, `client_user_agent`, `fbc`
 * (derived from the `fbclid` on an ad click, or the `_fbc` cookie), `fbp` when the
 * `_fbp` cookie exists, and — for purchase/lead events only — SHA-256 hashes of
 * whatever identity the caller passes (email, first/last name, phone, country,
 * external id), normalised per Meta's spec in `metaCapiUserData.ts`. IP + UA is personal data; the consuming site owns the
 * lawful basis for sending it, and the events carry no cookie and no identifier
 * the visitor did not already send.
 *
 * Dedup. Send the SAME `eventId` from server and browser for the same event and
 * Meta dedupes them within 48h. A site that fires the pixel's own `PageView`
 * should therefore send a server `ViewContent` (different event, no overlap) OR
 * pass this module's eventId into `fbq('track', ..., {eventID})`. Never send a
 * server `PageView` without sharing the id — it double-counts every consenting
 * visitor.
 *
 * Logging. Meta echoes request context back inside `error.message`, and the
 * request body carries hashed PII and the access token. On failure this logs the
 * HTTP status and Meta's numeric code/type ONLY — never the message, never the
 * body. Failures are swallowed after logging: a tracking write must never fail
 * the page or the payment that called it.
 *
 * Consumers import via a local shim (`lib/meta-capi.ts` → `export * from
 * "@/web-core/metaCapi"`). Change it HERE and propagate.
 */

const GRAPH_API_VERSION = "v21.0";

/**
 * Env-first, falling back across the estate's three prefixes exactly as
 * `graph.ts` does. `META_PIXEL_ID` is the server name; `NEXT_PUBLIC_META_PIXEL_ID`
 * is the browser one and is accepted as a fallback so a site with only the public
 * id set still sends server events for the same pixel.
 */
function pixelId(): string {
  return (
    process.env.META_PIXEL_ID ??
    process.env.NEXT_PUBLIC_META_PIXEL_ID ??
    ""
  );
}
function capiToken(): string {
  return process.env.META_CAPI_TOKEN ?? "";
}

/**
 * An explicit pixel + token, for a caller that cannot use the env vars above.
 *
 * A single-brand site has one pixel and reads it from the environment. A
 * MULTI-TENANT app does not: it serves many brands from one deployment and
 * holds each brand's pixel id and CAPI token in its own database, resolved per
 * request. Without this, such an app has no way to use this module and writes
 * its own `fetch` to the events edge instead — which is precisely how the
 * error-logging rule below gets lost, because it is the least obvious of the
 * things this module does.
 *
 * Pass this and the env vars are not consulted at all.
 */
export interface CAPICredentials {
  /** Meta pixel id the event belongs to. */
  pixelId: string;
  /** CAPI access token for that pixel. */
  accessToken: string;
}

/**
 * True when CAPI events can be sent — from `creds` if given, otherwise from the
 * environment. Cheap; safe to call per request.
 */
export function isCapiConfigured(creds?: CAPICredentials): boolean {
  if (creds) return Boolean(creds.pixelId && creds.accessToken);
  return Boolean(pixelId() && capiToken());
}

export interface CAPIEventData {
  eventName: string;
  /** Share this with the browser pixel for the same event to dedupe. */
  eventId: string;
  /**
   * Unix SECONDS the event actually happened. Omit for a live event and it is
   * stamped "now" at send time. Set it on a BACKFILL — an order reconciled from
   * a payment provider hours after the sale — so Meta attributes it to the
   * purchase time, not the sync time; otherwise every backfilled event lands in
   * the wrong attribution window and the wrong hour of the day. Passed through
   * as given (floored to an integer): Meta itself rejects anything older than 7
   * days or in the future, and the caller owns that validation. A non-finite
   * value falls back to "now" rather than failing the send.
   */
  eventTime?: number;
  sourceUrl: string;
  email?: string;
  firstName?: string;
  lastName?: string;
  /** Any format; normalised to digits-with-country-code before hashing. */
  phone?: string;
  /** Country-code digits applied to a national-format `phone` (leading trunk 0). */
  phoneCountryCode?: string;
  /** ISO 3166-1 alpha-2 of the person, e.g. the site's own country. */
  country?: string;
  /** The person's id in the caller's own system (lead/customer id). Hashed. */
  externalId?: string;
  /** Meta click id — `fb.1.<ts>.<fbclid>`; use `fbcFromRequest()` to derive it. */
  fbc?: string;
  /** Meta browser id from the `_fbp` cookie — absent for consent decliners. */
  fbp?: string;
  clientIp?: string;
  clientUserAgent?: string;
  currency?: string;
  value?: number;
  orderId?: string;
  /** Free-form custom_data (content_name, content_ids…). Never put PII here. */
  customData?: Record<string, string | number>;
  /** Events Manager "Test events" code — routes the event to the test tab. */
  testEventCode?: string;
}

/** Stable, unguessable event id. */
export function newEventId(): string {
  return randomUUID();
}

/**
 * Build `user_data` from an incoming request: IP and UA from headers, `fbc` from
 * the `fbclid` query param (an ad click) or the `_fbc` cookie, `fbp` from the
 * `_fbp` cookie. Works in server components and route handlers alike — pass the
 * result of `await headers()` and the parsed searchParams.
 *
 * `fbclid` is the one that matters for attribution: it arrives on every paid
 * click whether or not the visitor consents, so a server event carrying it is
 * attributable to the ad even when the pixel never ran.
 */
export function capiUserDataFromRequest(
  hdrs: { get(name: string): string | null },
  searchParams?: Record<string, string | string[] | undefined>
): Pick<CAPIEventData, "clientIp" | "clientUserAgent" | "fbc" | "fbp"> {
  // First hop of x-forwarded-for is the client; Vercel also sets x-real-ip.
  const fwd = hdrs.get("x-forwarded-for") ?? "";
  const clientIp = (fwd.split(",")[0] || hdrs.get("x-real-ip") || "").trim() || undefined;
  const clientUserAgent = hdrs.get("user-agent") ?? undefined;

  const cookies = Object.fromEntries(
    (hdrs.get("cookie") ?? "")
      .split(";")
      .map((c) => c.trim().split("="))
      .filter((kv) => kv.length === 2 && kv[0])
      .map(([k, v]) => [k, decodeURIComponent(v ?? "")])
  );

  const raw = searchParams?.fbclid;
  const fbclid = Array.isArray(raw) ? raw[0] : raw;
  // Meta's documented format: fb.<subdomainIndex>.<creationTimeMs>.<fbclid>
  const fbc = cookies._fbc || (fbclid ? `fb.1.${Date.now()}.${fbclid}` : undefined);
  const fbp = cookies._fbp || undefined;

  return { clientIp, clientUserAgent, fbc, fbp };
}

/**
 * Send one event. Resolves whether or not Meta accepted it; the boolean says
 * which. Never throws — see the module note on why.
 *
 * `creds` overrides the environment entirely; omit it on a single-brand site.
 */
export async function sendCAPIEvent(
  data: CAPIEventData,
  creds?: CAPICredentials
): Promise<boolean> {
  return (await sendCAPIEventResult(data, creds)).ok;
}

/** What Meta said about one send. `status` is 0 when no request was made. */
export interface CAPISendResult {
  ok: boolean;
  status: number;
  /** Meta's `events_received` on success — the proof it took the event. */
  eventsReceived?: number;
  /** Meta's `fbtrace_id`, for quoting to Meta support. Not sensitive. */
  fbtraceId?: string;
  /** Status + numeric code/type only, never Meta's message (see module note). */
  error?: string;
}

/**
 * `sendCAPIEvent` with Meta's answer, for a caller that records the outcome
 * (an audit row, a verification script). Same payload, same logging rule, and
 * it never throws either.
 */
export async function sendCAPIEventResult(
  data: CAPIEventData,
  creds?: CAPICredentials
): Promise<CAPISendResult> {
  const id = creds ? creds.pixelId : pixelId();
  const token = creds ? creds.accessToken : capiToken();
  if (!token || !id) return { ok: false, status: 0, error: "not configured" };

  const userData: Record<string, string> = hashedCapiIdentity({
    email: data.email,
    firstName: data.firstName,
    lastName: data.lastName,
    phone: data.phone,
    phoneCountryCode: data.phoneCountryCode,
    country: data.country,
    externalId: data.externalId,
  });
  if (data.fbc) userData.fbc = data.fbc;
  if (data.fbp) userData.fbp = data.fbp;
  if (data.clientIp) userData.client_ip_address = data.clientIp;
  if (data.clientUserAgent) userData.client_user_agent = data.clientUserAgent;

  const customData: Record<string, string | number> = { ...(data.customData ?? {}) };
  if (data.currency) customData.currency = data.currency;
  if (data.value !== undefined) customData.value = data.value;
  if (data.orderId) customData.order_id = data.orderId;

  const payload: Record<string, unknown> = {
    data: [
      {
        event_name: data.eventName,
        event_time: Math.floor(
          data.eventTime !== undefined && Number.isFinite(data.eventTime)
            ? data.eventTime
            : Date.now() / 1000
        ),
        event_id: data.eventId,
        event_source_url: data.sourceUrl,
        action_source: "website",
        user_data: userData,
        ...(Object.keys(customData).length > 0 ? { custom_data: customData } : {}),
      },
    ],
    access_token: token,
  };
  if (data.testEventCode) payload.test_event_code = data.testEventCode;

  try {
    const res = await fetch(`https://graph.facebook.com/${GRAPH_API_VERSION}/${id}/events`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      let detail = "(unparseable error body)";
      try {
        const e = (JSON.parse(await res.text()) as { error?: Record<string, unknown> })?.error ?? {};
        // Codes and types only. Never `message`, never `error_user_msg`.
        detail = `code=${e.code ?? "?"} type=${e.type ?? "?"} subcode=${e.error_subcode ?? "-"}`;
      } catch {
        /* a body we cannot parse is one we must not print */
      }
      console.error(`[CAPI] ${data.eventName} rejected: HTTP ${res.status} ${detail}`);
      return { ok: false, status: res.status, error: `HTTP ${res.status} ${detail}` };
    }
    let eventsReceived: number | undefined;
    let fbtraceId: string | undefined;
    try {
      const b = (await res.json()) as { events_received?: number; fbtrace_id?: string };
      eventsReceived = typeof b.events_received === "number" ? b.events_received : undefined;
      fbtraceId = typeof b.fbtrace_id === "string" ? b.fbtrace_id : undefined;
    } catch {
      /* a 2xx with an unreadable body is still an accepted send */
    }
    return { ok: true, status: res.status, eventsReceived, fbtraceId };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[CAPI] send failed:", msg);
    return { ok: false, status: 0, error: `network: ${msg.slice(0, 120)}` };
  }
}

/**
 * The landing-page helper: a server-side `ViewContent` for a page a paid click
 * lands on. Call from the page's server component inside `after()` so it runs
 * once the response is sent and never delays the render:
 *
 *   import { after } from "next/server";
 *   after(() => sendLandingPageView({ hdrs, searchParams, url, contentName }));
 *
 * `ViewContent`, not `PageView`, on purpose: the browser pixel already fires
 * `PageView` for consenting visitors and shares no event id with the server, so a
 * server `PageView` would double-count them. `ViewContent` is a standard event,
 * can be an ad set's optimisation goal (`CONTENT_VIEW`), and the pixel never
 * fires it on these pages. Note that Meta's "landing page views" metric is
 * pixel-derived and is NOT populated by this — optimise on CONTENT_VIEW instead.
 *
 * AUTOMATED REQUESTS ARE REFUSED HERE, NOT AT THE CALL SITE. This function is
 * called from a server render, so it runs for crawlers, link-scrapers and
 * prefetches as well as people — and on 2026-09-08 that inflated the event
 * roughly twentyfold on a live campaign optimising on it (see
 * `isAutomatedRequest`). Putting the check in the page would mean every future
 * page has to remember it, and one of them would not. Returns `false` when it
 * skips, the same as any other not-sent outcome; callers fire this inside
 * `after()` and ignore the result, and the honest signal that it is working is
 * the event volume on the pixel, not a log line per crawler.
 */
export async function sendLandingPageView(args: {
  hdrs: { get(name: string): string | null };
  searchParams?: Record<string, string | string[] | undefined>;
  url: string;
  contentName: string;
  eventId?: string;
  /** Per-brand pixel + token; omit on a single-brand site to use the env vars. */
  credentials?: CAPICredentials;
}): Promise<boolean> {
  if (isAutomatedRequest(args.hdrs)) return false;
  if (!isCapiConfigured(args.credentials)) return false;
  return sendCAPIEvent(
    {
      eventName: "ViewContent",
      eventId: args.eventId ?? newEventId(),
      sourceUrl: args.url,
      ...capiUserDataFromRequest(args.hdrs, args.searchParams),
      customData: { content_name: args.contentName, content_type: "product_group" },
    },
    args.credentials
  );
}

/**
 * The server twin of a click-driven browser event (AddToCart, InitiateCheckout,
 * Lead...). Call from the site's route handler inside `after()`:
 *
 *   after(() => sendClickEvent({ hdrs: req.headers, raw: await req.json(), allowedHosts: ["example.com"] }));
 *
 * Body shape and the click-event allowlist: `metaClickEvent.ts`. The browser sends the
 * SAME eventId it gave the pixel (`trackMetaTwin` in clientEvents.ts), so Meta counts a
 * consenting visitor once and counts a decliner (who has no pixel) via this call alone.
 *
 * Refuses, in order, and returns { sent: false, reason }: an automated request
 * (same `isAutomatedRequest` filter as ViewContent), a request that is not from the
 * site's own pages (fails closed on a missing Origin/Referer), a body that is not an
 * allowed click event with a valid shared id, an unconfigured pixel/token. Never throws.
 */
export async function sendClickEvent(args: {
  hdrs: { get(name: string): string | null };
  raw: unknown;
  allowedHosts: readonly string[];
  credentials?: CAPICredentials;
}): Promise<{ sent: boolean; reason?: string }> {
  if (isAutomatedRequest(args.hdrs)) return { sent: false, reason: "automated request" };
  if (!isFromAllowedHost(args.hdrs, args.allowedHosts)) return { sent: false, reason: "origin not allowed" };
  const parsed = parseClickEventBody(args.raw);
  if (!parsed.ok) return { sent: false, reason: parsed.reason };
  if (!isCapiConfigured(args.credentials)) return { sent: false, reason: "capi not configured" };
  const b = parsed.body;
  const fbclid = fbclidFromUrl(b.sourceUrl);
  const ok = await sendCAPIEvent(
    {
      eventName: b.event,
      eventId: b.eventId,
      sourceUrl: b.sourceUrl,
      ...capiUserDataFromRequest(args.hdrs, fbclid ? { fbclid } : undefined),
      currency: b.currency,
      value: b.value,
      customData: {
        ...(b.contentName ? { content_name: b.contentName } : {}),
        ...(b.contentIds && b.contentIds.length ? { content_ids: b.contentIds.join(",") } : {}),
        content_type: "product",
      },
    },
    args.credentials
  );
  return ok ? { sent: true } : { sent: false, reason: "meta rejected or network error" };
}
