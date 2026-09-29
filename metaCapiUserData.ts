import { createHash } from "node:crypto";

/**
 * Meta Conversions API `user_data` normalisation and hashing — the pure half of
 * `metaCapi.ts`, split out so it can be unit-tested (metaCapi imports
 * `server-only`, which cannot resolve in the node:test build).
 *
 * Meta's customer-information spec, in the parts this file implements:
 *   em          trim + lower-case, then SHA-256
 *   fn / ln     trim + lower-case, then SHA-256 (Latin letters recommended)
 *   ph          digits only, INCLUDING the country code, no leading `+` or `00`,
 *               then SHA-256. A national number with a leading trunk `0` is not
 *               a valid match key — it must be rewritten to the country code.
 *   country     ISO 3166-1 alpha-2, lower-case, then SHA-256
 *   external_id any stable id of the person in the advertiser's own system;
 *               hashing is recommended, so it is hashed here
 *
 * An empty value after normalisation is dropped, never hashed: the SHA-256 of
 * an empty string is a real hash Meta would try to match on.
 *
 * `fbc`, `fbp`, `client_ip_address` and `client_user_agent` are NOT hashed —
 * Meta's spec forbids it — and pass through untouched.
 */

export function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/** Lower-cased and trimmed. Used for em, fn, ln. */
export function normaliseText(value: string | undefined | null): string {
  return (value ?? "").trim().toLowerCase();
}

/**
 * A phone number as Meta wants it before hashing: digits only, with the
 * country code. `defaultCountryCode` (digits, e.g. the dialling code of the
 * site's own country) is applied to a national number that starts with a
 * single trunk `0`. A number already in international form (`+` or `00`) keeps
 * its own code. Returns "" when nothing usable remains.
 */
export function normalisePhone(raw: string | undefined | null, defaultCountryCode?: string): string {
  const s = (raw ?? "").trim();
  if (!s) return "";
  const international = s.startsWith("+");
  let digits = s.replace(/\D/g, "");
  if (!digits) return "";
  if (!international && digits.startsWith("00")) return digits.slice(2);
  if (international) return digits;
  const cc = (defaultCountryCode ?? "").replace(/\D/g, "");
  if (digits.startsWith("0") && cc) digits = cc + digits.replace(/^0+/, "");
  return digits;
}

/** ISO 3166-1 alpha-2, lower-case; "" if not exactly two letters. */
export function normaliseCountry(value: string | undefined | null): string {
  const v = normaliseText(value);
  return /^[a-z]{2}$/.test(v) ? v : "";
}

export interface CapiIdentityInput {
  email?: string;
  firstName?: string;
  lastName?: string;
  phone?: string;
  /** Digits of the country code applied to a national-format `phone`. */
  phoneCountryCode?: string;
  /** ISO 3166-1 alpha-2. */
  country?: string;
  /** The person's id in the advertiser's own system. */
  externalId?: string;
}

/** The hashed identity fields of `user_data`, per Meta's spec. Pure. */
export function hashedCapiIdentity(input: CapiIdentityInput): Record<string, string> {
  const out: Record<string, string> = {};
  const em = normaliseText(input.email);
  if (em) out.em = sha256Hex(em);
  const fn = normaliseText(input.firstName);
  if (fn) out.fn = sha256Hex(fn);
  const ln = normaliseText(input.lastName);
  if (ln) out.ln = sha256Hex(ln);
  const ph = normalisePhone(input.phone, input.phoneCountryCode);
  if (ph) out.ph = sha256Hex(ph);
  const country = normaliseCountry(input.country);
  if (country) out.country = sha256Hex(country);
  const ext = (input.externalId ?? "").trim();
  if (ext) out.external_id = sha256Hex(ext);
  return out;
}

/**
 * `fbc` rebuilt from a STORED click id, for an event sent long after the click
 * (a lead that turns into a sale weeks later). Meta's format is
 * `fb.<subdomainIndex>.<creationTimeMs>.<fbclid>`, and creationTime should be
 * when the click happened — so pass the time the click id was first captured,
 * not "now". Returns undefined for a missing id or an unusable time.
 */
export function fbcFromStoredClick(fbclid: string | undefined | null, clickedAtMs: number): string | undefined {
  const id = (fbclid ?? "").trim();
  if (!id || !Number.isFinite(clickedAtMs) || clickedAtMs <= 0) return undefined;
  return `fb.1.${Math.floor(clickedAtMs)}.${id}`;
}
