/**
 * Gift availability: mechanism only (no brand, host, secret or tag id).
 *
 * A checkout service exposes a public, non-secret endpoint
 *   GET <checkout origin>/api/gift/available?offer=<offer slug>  ->  { "available": boolean }
 * that is true only when the offer is live, gift-enabled and the brand's gift sending
 * switch is on. It sends no CORS headers, so call `fetchGiftAvailable` SERVER-SIDE only.
 * Any failure (bad input, timeout, non-200, bad JSON) resolves to `false`; it never throws.
 * The gift checkout link is `<origin>/<offer slug>?gift=1`.
 *
 * No React here (golden rule 6): the consuming app renders its own brand-styled section.
 */

export const GIFT_AVAILABLE_PATH = "/api/gift/available";
export const GIFT_AVAILABILITY_TIMEOUT_MS = 4000;
export const GIFT_AVAILABILITY_REVALIDATE_SECONDS = 60;

const SLUG_RE = /^[a-z0-9][a-z0-9._-]{0,99}$/i;

/** Returns the origin (`https://host[:port]`) for an https URL, or null if unusable. */
export function normaliseCheckoutOrigin(input: string | null | undefined): string | null {
  if (!input || typeof input !== "string") return null;
  let u: URL;
  try {
    u = new URL(input.trim());
  } catch {
    return null;
  }
  if (u.protocol !== "https:" || !u.hostname || u.username || u.password) return null;
  return u.origin;
}

/** True for a plain slug (letters, digits, dot, underscore, hyphen; no slashes or whitespace). */
export function isValidOfferSlug(slug: string | null | undefined): slug is string {
  return typeof slug === "string" && SLUG_RE.test(slug);
}

/** `<origin>/api/gift/available?offer=<slug>`, or null if origin or slug is invalid. */
export function giftAvailabilityUrl(checkoutOrigin: string | null | undefined, offerSlug: string | null | undefined): string | null {
  const origin = normaliseCheckoutOrigin(checkoutOrigin);
  if (!origin || !isValidOfferSlug(offerSlug)) return null;
  return `${origin}${GIFT_AVAILABLE_PATH}?offer=${encodeURIComponent(offerSlug)}`;
}

/** `<origin>/<slug>?gift=1` (plus any extra params), or null if origin or slug is invalid. */
export function giftCheckoutUrl(
  checkoutOrigin: string | null | undefined,
  offerSlug: string | null | undefined,
  extraParams?: Record<string, string | null | undefined>,
): string | null {
  const origin = normaliseCheckoutOrigin(checkoutOrigin);
  if (!origin || !isValidOfferSlug(offerSlug)) return null;
  const url = new URL(`${origin}/${encodeURIComponent(offerSlug)}`);
  url.searchParams.set("gift", "1");
  for (const [k, v] of Object.entries(extraParams ?? {})) {
    if (k === "gift" || v == null || v === "") continue;
    url.searchParams.set(k, v);
  }
  return url.toString();
}

export interface FetchGiftAvailableOptions {
  /** Injectable for tests. Defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** Default 4000. */
  timeoutMs?: number;
  /** Next.js cache hint, seconds. Default 60. */
  revalidateSeconds?: number;
}

/** Server-side. Resolves true only on a 200 with `{ available: true }`; otherwise false. Never throws. */
export async function fetchGiftAvailable(
  checkoutOrigin: string | null | undefined,
  offerSlug: string | null | undefined,
  opts: FetchGiftAvailableOptions = {},
): Promise<boolean> {
  const url = giftAvailabilityUrl(checkoutOrigin, offerSlug);
  if (!url) return false;
  const doFetch = opts.fetchImpl ?? (typeof fetch === "function" ? fetch : undefined);
  if (!doFetch) return false;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? GIFT_AVAILABILITY_TIMEOUT_MS);
  try {
    const res = await doFetch(url, {
      signal: controller.signal,
      headers: { accept: "application/json" },
      // Next.js extension; ignored by plain fetch.
      next: { revalidate: opts.revalidateSeconds ?? GIFT_AVAILABILITY_REVALIDATE_SECONDS },
    } as RequestInit);
    if (!res || res.status !== 200) return false;
    const body = (await res.json()) as { available?: unknown } | null;
    return body?.available === true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}
