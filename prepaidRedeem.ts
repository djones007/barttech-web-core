// ---------------------------------------------------------------------------
// Prepaid-code redemption: the thin, generic CLIENT for a site that wants a "Redeem a code" box. Mechanism only (this repo is
// public): no brand, no host, no secret lives here. A consuming site already knows who the buyer is (signed in) or has just asked
// for their email; it passes its checkout host and the shared service token from ITS OWN env, and gets back where to send the
// buyer next. All the rules (is the code real, unused, in date, rate-limited, atomic single use, fulfilment) live in the checkout
// app that owns the codes; this module only asks it, and words the answer.
//
// Server-side only (it carries a credential): call it from a route handler, never from a browser. Pure apart from the injected fetch.
// ---------------------------------------------------------------------------

/** The path the checkout app serves the redemption on. */
export const PREPAID_REDEEM_PATH = "/api/prepaid/redeem";

/** What someone typed or pasted, tidied for display: upper case, only A-Z, 0-9 and dashes, 40 characters at most. */
export function tidyPrepaidInput(raw: string): string {
  return (raw ?? "").toUpperCase().replace(/\s+/g, "").replace(/[^A-Z0-9-]/g, "").slice(0, 40);
}

/** Worth sending to the checkout app at all (it re-checks everything). */
export function isPlausiblePrepaidCode(raw: string): boolean {
  const k = (raw ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  return k.length >= 8 && k.length <= 40;
}

/** The words for every failure that is not a rate limit: deliberately the same for a code that does not exist and one that is spent. */
export const PREPAID_GENERIC_MESSAGE = "That code can't be used. Check it matches your card and try again.";
export const PREPAID_RATE_LIMITED_MESSAGE = "Too many attempts. Please wait an hour and try again.";
export const PREPAID_UNAVAILABLE_MESSAGE = "We couldn't check that code just now. Please try again in a moment.";

export type PrepaidRedeemOutcome =
  | { ok: true; retry: boolean; productName: string; fulfilment: string; successUrl: string; accessUrl: string | null; test: boolean }
  | { ok: false; kind: "rejected" | "rate_limited" | "unreachable" | "misconfigured"; message: string };

export interface PrepaidRedeemOptions {
  /** The checkout host that owns the codes, hostname only (no scheme, no path). */
  checkoutHost: string;
  /** The shared service token (from the caller's env). At least 32 characters. */
  token: string;
  code: string;
  /** The buyer's email: the caller has proved it (a signed-in session) or the buyer just typed it. */
  email: string;
  /** The end user's IP, so the checkout app's guessing limit bites the right person. */
  clientIp?: string;
  firstName?: string;
  timeoutMs?: number;
  /** Injected for tests. */
  fetchImpl?: typeof fetch;
}

const HOST_RE = /^[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?$/i;

/**
 * Ask the checkout app to redeem a code. Never throws. A caller maps the outcome: `ok` -> send the buyer to `accessUrl` (where the
 * product is reached) or `successUrl` (their order page); otherwise show `message`.
 */
export async function redeemPrepaidCode(o: PrepaidRedeemOptions): Promise<PrepaidRedeemOutcome> {
  if (!HOST_RE.test(o.checkoutHost ?? "") || (o.token ?? "").length < 32) {
    return { ok: false, kind: "misconfigured", message: PREPAID_UNAVAILABLE_MESSAGE };
  }
  if (!isPlausiblePrepaidCode(o.code)) return { ok: false, kind: "rejected", message: PREPAID_GENERIC_MESSAGE };
  const f = o.fetchImpl ?? fetch;
  try {
    const res = await f(`https://${o.checkoutHost}${PREPAID_REDEEM_PATH}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${o.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ code: o.code, email: o.email, ...(o.clientIp ? { ip: o.clientIp } : {}), ...(o.firstName ? { firstName: o.firstName } : {}) }),
      signal: AbortSignal.timeout(o.timeoutMs ?? 20_000),
      redirect: "error",
      cache: "no-store",
    });
    const d = (await res.json().catch(() => ({}))) as {
      ok?: unknown;
      retry?: unknown;
      productName?: unknown;
      fulfilment?: unknown;
      successUrl?: unknown;
      accessUrl?: unknown;
      test?: unknown;
      error?: unknown;
    };
    if (res.ok && d.ok === true && typeof d.successUrl === "string") {
      return {
        ok: true,
        retry: d.retry === true,
        productName: typeof d.productName === "string" ? d.productName : "",
        fulfilment: typeof d.fulfilment === "string" ? d.fulfilment : "",
        successUrl: d.successUrl,
        accessUrl: typeof d.accessUrl === "string" ? d.accessUrl : null,
        test: d.test === true,
      };
    }
    if (res.status === 429 || d.error === "rate_limited") return { ok: false, kind: "rate_limited", message: PREPAID_RATE_LIMITED_MESSAGE };
    if (res.status === 401 || res.status === 404) return { ok: false, kind: "misconfigured", message: PREPAID_UNAVAILABLE_MESSAGE };
    if (res.status >= 500 || d.error === "server") return { ok: false, kind: "unreachable", message: PREPAID_UNAVAILABLE_MESSAGE };
    return { ok: false, kind: "rejected", message: PREPAID_GENERIC_MESSAGE };
  } catch {
    return { ok: false, kind: "unreachable", message: PREPAID_UNAVAILABLE_MESSAGE };
  }
}
