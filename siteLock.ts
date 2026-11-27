// ---------------------------------------------------------------------------
// Signed site-lock cookie token (framework-agnostic, EDGE-SAFE).
//
// A "site lock" is a shared-password gate put in front of a whole site (an
// archive/pause page, a private preview). The visitor enters the password once
// and the app sets a cookie. The cookie value MUST NOT be a constant: httpOnly
// and secure stop page JavaScript touching it, but nothing stops a client
// sending the header itself, so a cookie whose value is the literal "1" is a
// password written down in the check that validates it.
//
// Here the value is hex(HMAC-SHA256(key = password, message = marker)). It is
// unforgeable without the password, and because it derives FROM the password,
// rotating the password invalidates every cookie already issued. Changing
// `marker` (bump its version suffix) forces every cookie to be re-earned
// without changing the password.
//
// WEBCRYPTO ONLY. This module uses `crypto.subtle` and a pure-JS constant-time
// compare, and imports nothing — so the same code can ISSUE the cookie in a
// Node server action and VERIFY it in an Edge middleware/proxy. Do not import
// ./security here (it pulls in Node `crypto`, which the Edge runtime lacks).
//
// Not a data-protection boundary on its own: it gates access to a site, with
// one shared password. Fails closed everywhere: an empty password or missing
// cookie never validates.
// ---------------------------------------------------------------------------

/** Default marker. Callers may pass their own (e.g. to separate two sites sharing a password). */
export const DEFAULT_SITE_LOCK_MARKER = "site-unlock-v1";

/** 30 days — a site lock is a temporary gate, not a permanent credential. */
export const SITE_LOCK_COOKIE_MAX_AGE_SEC = 60 * 60 * 24 * 30;

/**
 * The one valid cookie value for a given site password (and marker).
 * Returns "" when no password is configured, so callers fail closed.
 */
export async function siteLockToken(
  password: string | undefined,
  marker: string = DEFAULT_SITE_LOCK_MARKER,
): Promise<string> {
  if (!password) return "";
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(password),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(marker));
  return Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Constant-time string compare in pure JS (no Node `crypto`, so it runs on the
 * Edge). Length is compared first; both values are fixed-length hex here, so
 * length leaks nothing.
 */
export function constantTimeStringEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

/**
 * Does this cookie value prove the visitor knew the site password?
 * Fails closed on a missing cookie or a missing/empty password.
 */
export async function isValidSiteLockToken(
  cookieValue: string | undefined,
  password: string | undefined,
  marker: string = DEFAULT_SITE_LOCK_MARKER,
): Promise<boolean> {
  if (!cookieValue || !password) return false;
  const expected = await siteLockToken(password, marker);
  if (!expected) return false;
  return constantTimeStringEqual(cookieValue, expected);
}

/**
 * Check a typed password against the configured one and, if right, return the
 * token to set as the cookie. `token` is "" on failure. Whitespace around the
 * typed value is trimmed. Fails closed when no password is configured.
 */
export async function checkSiteLockPassword(
  typed: string,
  password: string | undefined,
  marker: string = DEFAULT_SITE_LOCK_MARKER,
): Promise<{ correct: boolean; token: string }> {
  if (!password) return { correct: false, token: "" };
  const expected = await siteLockToken(password, marker);
  const correct = constantTimeStringEqual(await siteLockToken(typed.trim(), marker), expected);
  return { correct, token: correct ? expected : "" };
}
