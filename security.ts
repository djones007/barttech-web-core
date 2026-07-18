import { timingSafeEqual, createHmac } from "crypto";

// ---------------------------------------------------------------------------
// Barttech shared security helpers — THE single source of truth for the estate.
//
// This file is the canonical implementation (memory/reference_website_security_
// standard.md items 11, 12, 15, 18). It is mounted into each brand site as a git
// submodule (`src/web-core` or `web-core`) and imported via `@/web-core/security`,
// so a fix here reaches every consumer after `tools/web-core-propagate.sh`.
//
// NODE RUNTIME ONLY — imports Node `crypto`. Never import this from the Edge
// middleware/proxy; those use WebCrypto in their own local helper.
//
// Rule: brand-SPECIFIC security logic (e.g. a per-product upsell token) stays in
// that repo's own `lib/security.ts`, which re-exports this module and adds its
// own helpers. Only genuinely-identical primitives live here.
// ---------------------------------------------------------------------------

/** HTML-escape a string before interpolating it into an HTML/email template. */
export function escHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Constant-time comparison for tokens / shared secrets (admin credentials,
 * health-check bearer tokens, webhook auth, Stripe client_secrets). Never use
 * `===` for these — timing differences leak the secret one byte at a time.
 * Length-checks first (so the buffers are the same size before timingSafeEqual),
 * accepts a null/undefined provided value, and catches any Buffer error,
 * returning false rather than throwing.
 */
export function timingSafeTokenEqual(a: string | null | undefined, b: string): boolean {
  if (!a || a.length !== b.length) return false;
  try {
    return timingSafeEqual(Buffer.from(a), Buffer.from(b));
  } catch {
    return false;
  }
}

/**
 * Verifies an inbound webhook's `sha256=<hmac>` signature over the RAW body
 * (read the body as text BEFORE JSON.parse). Returns true if the signature
 * matches any of the provided secrets (some providers issue per-workspace
 * secrets — try each). Pass an empty/undefined secret list to skip
 * verification during provisioning only — never in production.
 */
export function verifyHmacSignature(
  rawBody: string,
  signatureHeader: string | null,
  secrets: (string | undefined)[]
): boolean {
  if (!signatureHeader) return false;
  const validSecrets = secrets.filter((s): s is string => Boolean(s));
  if (validSecrets.length === 0) return false;

  return validSecrets.some((secret) => {
    const expected = `sha256=${createHmac("sha256", secret).update(rawBody).digest("hex")}`;
    return timingSafeTokenEqual(signatureHeader, expected);
  });
}

/**
 * Guards against path traversal when a URL param/slug is turned into a file
 * path. Returns true if the slug is safe to use as-is.
 */
export function isSafePathSegment(slug: string): boolean {
  return !slug.includes("..") && !slug.includes("/") && !slug.includes("\\");
}

/**
 * Guards against open-redirect attacks on a `next`/`redirect`/`returnTo`
 * query param. Returns a same-site relative path, falling back to `/`.
 */
export function safeRedirectPath(next: string | null): string {
  if (!next) return "/";
  return next.startsWith("/") && !next.startsWith("//") ? next : "/";
}

/**
 * Simple honeypot check for public forms — a hidden field real users never
 * fill in. Bots that auto-fill every field trip it. Silent-reject (return 200)
 * rather than 4xx so bots don't learn the field name.
 */
export function isHoneypotTripped(body: Record<string, unknown>, fieldName = "website"): boolean {
  const val = body[fieldName];
  return typeof val === "string" && val.trim().length > 0;
}
