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

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
