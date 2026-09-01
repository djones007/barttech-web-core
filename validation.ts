// ---------------------------------------------------------------------------
// Barttech shared request-validation guards for public POST routes
// (website security standard §4). The 32 KB body cap + email-format check were
// copy-pasted across brand repos; centralised here so the *mechanism* is shared.
//
// PER-ROUTE field-length RULES stay LOCAL to each route (name/agency/order-number
// limits genuinely differ per form) — pass the route's own limits map to
// `fieldLengthError`. Do NOT fold per-form maps in here (shared-modules standard:
// share the mechanism, not the divergent business rules).
//
// Node-runtime only (uses Buffer). This file is transpiled by each consumer's
// Next build via the @barttech/web-core submodule; import as `@/web-core/validation`.
// ---------------------------------------------------------------------------

/** Maximum accepted request body size, in bytes (32 KB). */
export const MAX_BODY_BYTES = 32 * 1024;
/** Alias for callers that named the cap `BODY_BYTE_CAP`. */
export const BODY_BYTE_CAP = MAX_BODY_BYTES;

/**
 * Exported for call sites that test the pattern directly rather than through
 * the guards below (one shared engine repo's route handlers do this). Prefer
 * `isValidEmail` / `isUuid` in new code — they also narrow the type and reject
 * non-strings, which a bare `.test()` on an `unknown` will not.
 */
export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Read a request body as text with a hard byte cap. Content-Length can be absent
 * or spoofed, so measure the actual decoded stream. Returns the raw string and a
 * `tooLarge` flag; the caller returns 413 when `tooLarge` is true.
 */
export async function readBodyWithCap(
  req: Request,
  maxBytes = MAX_BODY_BYTES
): Promise<{ raw: string; tooLarge: boolean }> {
  const raw = await req.text();
  return { raw, tooLarge: Buffer.byteLength(raw, "utf8") > maxBytes };
}

/** True if an already-read raw body string exceeds the byte cap. */
export function exceedsBodyCap(raw: string, maxBytes = MAX_BODY_BYTES): boolean {
  return Buffer.byteLength(raw, "utf8") > maxBytes;
}

/** Basic email validity: a string, ≤254 chars, matching the standard format regex. */
export function isValidEmail(email: unknown): email is string {
  return typeof email === "string" && email.length <= 254 && EMAIL_RE.test(email);
}

/** Strict UUID (v-agnostic) format check. */
export function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_RE.test(value);
}

/**
 * Enforce per-field maximum string lengths. Returns `"<field> exceeds maximum
 * length"` for the first offending field, or null if every field is within its
 * limit. Non-string / empty values are skipped (matches the original inline loops).
 */
export function fieldLengthError(
  body: Record<string, unknown>,
  limits: Record<string, number>
): string | null {
  for (const [field, max] of Object.entries(limits)) {
    const val = body[field];
    if (val && typeof val === "string" && val.length > max) {
      return `${field} exceeds maximum length`;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Parse-with-cap dialect. These are DISTINCT primitives, not duplicates of the
// above: `readBodyWithCap` returns the RAW text + a flag (use it when you must
// verify an HMAC over the raw bytes BEFORE JSON.parse — webhook routes);
// `readBodyWithSizeLimit` reads, caps, AND parses to a typed body with a
// structured error (use it when you just want the parsed JSON safely).
// `checkFieldLengths` is the `{error,status}`-returning sibling of
// `fieldLengthError` (which returns a string) — callers pick the return shape
// their route already uses. Typed against the web-standard `Request` so web-core
// stays framework-agnostic (a Next.js `NextRequest` is a valid `Request`).
// ---------------------------------------------------------------------------

/**
 * Read the body with a hard byte cap AND parse it as JSON. Returns `{ body: T }`
 * on success or `{ error, status }` on any failure (too large / empty / invalid
 * JSON) — narrow with `if ("error" in result)`. Measures the actual stream
 * (Content-Length can be spoofed).
 */
export async function readBodyWithSizeLimit<T>(
  req: Request,
  maxBytes = MAX_BODY_BYTES
): Promise<{ body: T } | { error: string; status: number }> {
  if (!req.body) return { error: "Empty request body", status: 400 };

  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) return { error: "Request too large", status: 413 };
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const merged = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return { body: JSON.parse(new TextDecoder().decode(merged)) as T };
  } catch {
    return { error: "Invalid request body", status: 400 };
  }
}

/**
 * @deprecated Prefer `readBodyWithSizeLimit` — it enforces the cap against the
 * real stream, not the spoofable Content-Length header. Kept for routes that
 * split body reading separately. Returns an error object if the declared
 * content-length exceeds the cap, else null.
 */
export function checkBodySize(req: Request): { error: string; status: number } | null {
  const contentLength = req.headers.get("content-length");
  if (contentLength && parseInt(contentLength, 10) > MAX_BODY_BYTES) {
    return { error: "Request too large", status: 400 };
  }
  return null;
}

/**
 * Reject a state-changing request that another site caused the browser to make.
 *
 * Returns an error object for a cross-site request, else null. Apply it to
 * handlers that MUTATE (POST/PATCH/DELETE); a read-only GET does not need it
 * and applying it there breaks ordinary links and bookmarks.
 *
 * Why this rather than a CSRF token: a token needs somewhere to live, a way to
 * reach every form, and a rotation story. This needs none of that, and for a
 * cookie-authenticated JSON API it closes the same hole.
 *
 * `Sec-Fetch-Site` is the primary signal — the browser sets it and page script
 * cannot forge it. The values mean:
 *   same-origin  our own page          allow
 *   same-site    another subdomain     allow
 *   none         typed, bookmarked     allow (no initiating site)
 *   cross-site   another site made it  REJECT
 *
 * `Origin` is the fallback for clients that omit Sec-Fetch-Site. An absent
 * Origin is allowed: server-to-server callers and curl send neither header, and
 * they are not the threat — CSRF requires a browser holding the victim's
 * cookies, and every browser sends at least one of the two.
 *
 * NOT a replacement for authentication or for SameSite cookies. It is the third
 * layer, and it is the one that still holds if a cookie is ever widened to
 * SameSite=None for an embed or a payment return.
 */
export function crossSiteRequestError(req: Request): { error: string; status: number } | null {
  const site = req.headers.get("sec-fetch-site");
  if (site) {
    return site === "cross-site" ? { error: "Cross-site request refused", status: 403 } : null;
  }

  const origin = req.headers.get("origin");
  if (!origin) return null;

  let originHost: string;
  try {
    originHost = new URL(origin).host;
  } catch {
    // An Origin header that is not a URL is not something a browser sends.
    return { error: "Cross-site request refused", status: 403 };
  }

  // Compare against the forwarded host first: behind a proxy, req.url carries
  // the internal host and would never match the browser's Origin.
  const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host");
  const expected = host ?? (() => { try { return new URL(req.url).host; } catch { return null; } })();
  if (!expected) return null;

  return originHost === expected ? null : { error: "Cross-site request refused", status: 403 };
}

/**
 * Field-length check returning a `{ error, status }` object (the sibling of
 * `fieldLengthError`, which returns a string). First offending field wins; null
 * if all within bounds. Fields absent from `body` are skipped.
 */
export function checkFieldLengths(
  body: Record<string, unknown>,
  maxLengths: Record<string, number>
): { error: string; status: number } | null {
  for (const [field, max] of Object.entries(maxLengths)) {
    const val = body[field];
    if (val && typeof val === "string" && val.length > max) {
      return { error: `${field} exceeds maximum length`, status: 400 };
    }
  }
  return null;
}

/** Common field-length limits — extend per-route as needed, don't loosen these defaults. */
export const DEFAULT_MAX_LENGTHS: Record<string, number> = {
  name: 100,
  first_name: 50,
  last_name: 50,
  email: 254,
  phone: 20,
  company: 200,
  message: 5000,
  referrer: 2000,
  sourcePage: 2000,
  utm_source: 200,
  utm_medium: 200,
  utm_campaign: 200,
  utm_content: 200,
  utm_term: 200,
};

/**
 * Local-part prefix and domain of the optin-health monitor's sentinel
 * addresses (`<user>+optin-health-<brand>@<domain>`), read from env rather
 * than hardcoded — this repo is public, and an owner's personal email domain
 * is exactly the estate-identifying detail that must never live in source
 * here (see this repo's CLAUDE.md). Each consumer already sets env per-repo;
 * unset means `isOptinHealthSentinel` matches nothing, never everything — a
 * missing config value must fail closed (skip nothing) rather than open.
 */
const OPTIN_HEALTH_SENTINEL_USER = process.env.OPTIN_HEALTH_SENTINEL_USER ?? "";
const OPTIN_HEALTH_SENTINEL_DOMAIN = process.env.OPTIN_HEALTH_SENTINEL_DOMAIN ?? "";

/** Escape a literal string for safe interpolation into a `RegExp` source. */
function escapeRegExpLiteral(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * True when an address is one of the optin-health monitor's sentinels
 * (`<user>+optin-health-<brand>@<domain>`, where `<user>` and `<domain>` are
 * `OPTIN_HEALTH_SENTINEL_USER` / `OPTIN_HEALTH_SENTINEL_DOMAIN`).
 *
 * The monitor deliberately POSTs through each brand's REAL optin route every 6
 * hours, so it exercises the genuine write path — that is the whole point of it.
 * The side effect is that any route which emails the site owner on a new signup
 * emails them about a fake one four times a day, and those notifications are
 * indistinguishable from a real lead at a glance. Worse than noise: it trains
 * you to ignore them.
 *
 * Routes should skip **notification email only** for these addresses — never the
 * contact write, which is the thing being tested. Introduced 2026-07-29 after the
 * monitor started generating false-positive "sign-up" notifications on more than
 * one consumer's site.
 */
export function isOptinHealthSentinel(email: string | null | undefined): boolean {
  if (!email || !OPTIN_HEALTH_SENTINEL_USER || !OPTIN_HEALTH_SENTINEL_DOMAIN) return false;
  const user = escapeRegExpLiteral(OPTIN_HEALTH_SENTINEL_USER);
  const domain = escapeRegExpLiteral(OPTIN_HEALTH_SENTINEL_DOMAIN);
  const re = new RegExp(`^${user}\\+optin-health-[a-z0-9-]+@${domain}$`, "i");
  return re.test(email.trim());
}
