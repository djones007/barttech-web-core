// ---------------------------------------------------------------------------
// mailProviderDomains — the synchronous, no-network domain→provider map.
//
// Browser-safe: this file has NO imports at all — not even type-only ones,
// see the source-invariant test in mailProvider.test.ts — so client code
// (a client component doing purely-sync provider detection, with no MX
// fallback available) can import it directly with zero risk of dragging in
// Node's DNS module or any other server-only dependency along for the ride.
// `mailProvider.ts` imports MAIL_PROVIDER_DOMAINS and extractDomain from here
// for its own async MX-fallback path and re-exports this whole file, so the
// public surface is unchanged (golden rule 4).
//
// The MailProvider union is duplicated here as a local, unexported alias
// rather than imported from mailProviderNotice.ts purely to keep this file
// import-free — it is structurally identical, so TypeScript treats it as the
// same type as MailProvider everywhere it is used alongside it.
// ---------------------------------------------------------------------------

type MailProviderDomainResult = "gmail" | "outlook" | "apple" | "yahoo" | "unknown";

/**
 * Consumer email domains mapped to the provider whose webmail/app they use.
 * Sky and AOL mail both run on Yahoo's platform, hence the grouping.
 */
export const MAIL_PROVIDER_DOMAINS: Readonly<Record<string, MailProviderDomainResult>> = {
  "gmail.com": "gmail",
  "googlemail.com": "gmail",
  "outlook.com": "outlook",
  "outlook.co.uk": "outlook",
  "hotmail.com": "outlook",
  "hotmail.co.uk": "outlook",
  "live.com": "outlook",
  "live.co.uk": "outlook",
  "msn.com": "outlook",
  "icloud.com": "apple",
  "me.com": "apple",
  "mac.com": "apple",
  "yahoo.com": "yahoo",
  "yahoo.co.uk": "yahoo",
  "ymail.com": "yahoo",
  "rocketmail.com": "yahoo",
  "aol.com": "yahoo",
  "aol.co.uk": "yahoo",
  "sky.com": "yahoo",
};

/**
 * Lowercases and trims, splits on `@`. Returns null for anything that is not
 * a plausible `local@domain.tld` shape — no network, no RFC 5322 parsing.
 *
 * Exported (rather than file-private) only so `mailProvider.ts` can reuse the
 * same domain-extraction logic for its MX-fallback path — it is not intended
 * as a documented part of the public API the way MAIL_PROVIDER_DOMAINS and
 * detectMailProviderFromDomain are.
 */
export function extractDomain(email: string): string | null {
  const trimmed = email.trim().toLowerCase();
  const parts = trimmed.split("@");
  if (parts.length !== 2) return null;
  const [local, domain] = parts;
  if (!local || !domain) return null;
  if (/\s/.test(domain)) return null;
  if (!domain.includes(".") || domain.startsWith(".") || domain.endsWith(".")) return null;
  return domain;
}

/** Sync, no network. "unknown" for a malformed address or an unmapped domain. */
export function detectMailProviderFromDomain(email: string): MailProviderDomainResult {
  const domain = extractDomain(email);
  if (!domain) return "unknown";
  return MAIL_PROVIDER_DOMAINS[domain] ?? "unknown";
}
