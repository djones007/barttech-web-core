// ---------------------------------------------------------------------------
// mailProvider — inbox-provider detection and the estate's single copy of
// post-submit deliverability notice copy ("check your spam folder" style
// messaging shown after a form, optin, or download).
//
// WHAT THIS OWNS
// Two things that belong together because one feeds the other: (1) turning an
// email address into a MailProvider (gmail/outlook/apple/yahoo/unknown), by
// consumer domain first and a raced MX lookup as a fallback for custom/business
// domains; and (2) the exact wording and steps shown to someone who just
// submitted a form, phrased per provider.
//
// WHY THIS IS SHARED, NOT JUST A NICETY
// This copy had drifted into five different phrasings across sites before this
// existed. Worse than inconsistent tone: a "mark as not spam" / "move to
// Primary" / "add to contacts" action taken by the recipient is one of the
// strongest positive reputation signals a mailbox provider accepts about a
// sending domain. Steering someone to the RIGHT action for THEIR provider
// (a Promotions-tab drag for Gmail, Safe senders for Outlook, Not Junk for
// iCloud/Yahoo) is a deliverability lever as much as it is UX copy, so it
// deserves one canonical, kept-current source rather than five independent
// guesses that drift apart.
//
// This module owns detection + copy only. Rendering stays per-consumer — this
// repo ships no React (see CLAUDE.md golden rule 6) — so each site's own
// component calls mailProviderNotice() and lays the result out with its own
// styling.
//
// node:dns is imported lazily, inside the async detection function only, so
// this module stays safe to import from a client component that never calls
// detectMailProvider.
// ---------------------------------------------------------------------------

export type MailProvider = "gmail" | "outlook" | "apple" | "yahoo" | "unknown";

export const MAIL_PROVIDERS: readonly MailProvider[] = ["gmail", "outlook", "apple", "yahoo", "unknown"];

/** For safely parsing a `?p=` query param into a MailProvider. */
export function isMailProvider(x: unknown): x is MailProvider {
  return typeof x === "string" && (MAIL_PROVIDERS as readonly string[]).includes(x);
}

/**
 * Consumer email domains mapped to the provider whose webmail/app they use.
 * Sky and AOL mail both run on Yahoo's platform, hence the grouping.
 */
export const MAIL_PROVIDER_DOMAINS: Readonly<Record<string, MailProvider>> = {
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
 */
function extractDomain(email: string): string | null {
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
export function detectMailProviderFromDomain(email: string): MailProvider {
  const domain = extractDomain(email);
  if (!domain) return "unknown";
  return MAIL_PROVIDER_DOMAINS[domain] ?? "unknown";
}

function hasSuffix(host: string, suffixes: readonly string[]): boolean {
  return suffixes.some((s) => host === s || host.endsWith("." + s));
}

/**
 * Pure. For a custom/business domain, its MX hosts reveal which platform
 * actually delivers its mail even though the domain itself is not in
 * MAIL_PROVIDER_DOMAINS. Suffix match, case-insensitive, trailing dot ignored.
 */
export function providerFromMxHosts(hosts: string[]): MailProvider {
  for (const raw of hosts) {
    const host = raw.trim().toLowerCase().replace(/\.$/, "");
    if (!host) continue;
    if (hasSuffix(host, ["google.com", "googlemail.com"])) return "gmail";
    if (hasSuffix(host, ["outlook.com", "office365.com", "hotmail.com"])) return "outlook";
    if (hasSuffix(host, ["icloud.com", "apple.com"])) return "apple";
    if (hasSuffix(host, ["yahoodns.net", "yahoo.com", "aol.com"])) return "yahoo";
  }
  return "unknown";
}

// ---------------------------------------------------------------------------
// MX lookup, with an in-memory cache so a repeated lookup for the same domain
// (a busy signup form on one business domain) costs nothing after the first.
// Deliberately NOT shared across processes/serverless invocations — this is a
// courtesy cache, not a source of truth, and every path that populates it can
// re-derive the same answer from scratch.
// ---------------------------------------------------------------------------

interface CacheEntry {
  provider: MailProvider;
  expires: number;
}

const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const CACHE_MAX_ENTRIES = 2000;
const mxProviderCache = new Map<string, CacheEntry>();

/** For tests. Not needed in production — the TTL and cap handle themselves. */
export function clearMailProviderCache(): void {
  mxProviderCache.clear();
}

function cacheGet(domain: string): MailProvider | undefined {
  const entry = mxProviderCache.get(domain);
  if (!entry) return undefined;
  if (entry.expires <= Date.now()) {
    mxProviderCache.delete(domain);
    return undefined;
  }
  return entry.provider;
}

/**
 * Only called with a REAL answer (a completed MX lookup, even one with zero
 * records or an unmatched host) — never with "unknown" standing in for a
 * timeout or a DNS error. Caching those would pin a domain to "unknown" for a
 * full day off the back of one transient resolver hiccup.
 */
function cacheSet(domain: string, provider: MailProvider): void {
  if (mxProviderCache.size >= CACHE_MAX_ENTRIES && !mxProviderCache.has(domain)) {
    const oldestKey = mxProviderCache.keys().next().value;
    if (oldestKey !== undefined) mxProviderCache.delete(oldestKey);
  }
  mxProviderCache.set(domain, { provider, expires: Date.now() + CACHE_TTL_MS });
}

const DEFAULT_TIMEOUT_MS = 1500;

export interface DetectMailProviderOptions {
  /** Default 1500. The lookup races this and loses to "unknown" if it fires first. */
  timeoutMs?: number;
  /** Injectable for tests. Defaults to node:dns's resolveMx, imported lazily. */
  resolveMx?: (domain: string) => Promise<Array<{ exchange: string; priority: number }>>;
}

async function defaultResolveMx(domain: string): Promise<Array<{ exchange: string; priority: number }>> {
  const dns = await import("node:dns");
  return dns.promises.resolveMx(domain);
}

/**
 * Domain map first (no network, no cache needed). Falls back to a raced MX
 * lookup for anything unmapped — typically a custom/business domain. Never
 * throws: any error, a timeout, or an empty MX result all resolve to
 * "unknown". A timeout or a thrown error is deliberately NOT cached (see
 * cacheSet); a completed lookup is, even when its answer is "unknown".
 */
export async function detectMailProvider(
  email: string,
  opts: DetectMailProviderOptions = {},
): Promise<MailProvider> {
  const domain = extractDomain(email);
  if (!domain) return "unknown";

  const fromDomain = MAIL_PROVIDER_DOMAINS[domain];
  if (fromDomain) return fromDomain;

  const cached = cacheGet(domain);
  if (cached !== undefined) return cached;

  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const resolveMx = opts.resolveMx ?? defaultResolveMx;

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), timeoutMs);
  });

  try {
    const raced = await Promise.race([resolveMx(domain), timedOut]);
    if (raced === "timeout") return "unknown"; // transient — not cached
    const provider = providerFromMxHosts(raced.map((r) => r.exchange));
    cacheSet(domain, provider); // a real answer, cached even when "unknown"
    return provider;
  } catch {
    return "unknown"; // transient — not cached
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Post-submit deliverability notice copy. THE ONLY PLACE THIS COPY LIVES —
// see the file header for why that matters beyond consistency.
// ---------------------------------------------------------------------------

export type NoticeMode = "asset" | "link" | "confirm";

interface ProviderCopy {
  label: string | null;
  body: string;
  /** May contain a literal "{sender}" placeholder, filled in verbatim. */
  steps: string[];
}

const PROVIDER_COPY: Readonly<Record<MailProvider, ProviderCopy>> = {
  gmail: {
    label: "Gmail",
    body: "Gmail sometimes files new senders under Promotions or Spam.",
    steps: [
      "Check the Promotions tab, then Spam.",
      "If it is there, drag it to Primary.",
      "Add {sender} to your contacts so the next one lands in your inbox.",
    ],
  },
  outlook: {
    label: "Outlook",
    body: "Outlook sometimes files new senders under Junk Email or the Other tab.",
    steps: [
      "Check Junk Email, then the Other tab.",
      "If it is there, right-click it, choose Junk, then Never block sender.",
      "Add {sender} to your Safe senders list.",
    ],
  },
  apple: {
    label: "iCloud Mail",
    body: "iCloud Mail sometimes files new senders under Junk.",
    steps: ["Check the Junk folder.", "If it is there, tap Not Junk.", "Add {sender} to your contacts."],
  },
  yahoo: {
    label: "Yahoo Mail",
    body: "Yahoo sometimes files new senders under Spam.",
    steps: ["Check the Spam folder.", "If it is there, mark it Not Spam.", "Add {sender} to your contacts."],
  },
  unknown: {
    label: null,
    body: "New senders sometimes land in spam or junk.",
    steps: [
      "Check your spam or junk folder.",
      "If it is there, mark it as not spam.",
      "Add {sender} to your contacts so the next one lands in your inbox.",
    ],
  },
};

/** "a minute" / "a couple of minutes" / "5 minutes" — natural at 1, 2, and 5+. */
function minutesPhrase(minutes: number): string {
  if (minutes <= 1) return "a minute";
  if (minutes === 2) return "a couple of minutes";
  return `${minutes} minutes`;
}

function noticeHeading(mode: NoticeMode, minutes: number): string {
  if (mode === "confirm") return "Can't see the confirmation email? Here is where to look.";
  if (mode === "link") return "Can't see the email with your link? Here is where to look.";
  return `Not there in ${minutesPhrase(minutes)}? Here is where to look.`;
}

export interface MailProviderNoticeInput {
  provider: MailProvider;
  /** The brand's from-address. Merged into the steps verbatim. */
  sender: string;
  mode: NoticeMode;
  /** Default 2. Only affects the heading in "asset" mode. */
  minutes?: number;
}

export interface MailProviderNoticeResult {
  providerLabel: string | null;
  heading: string;
  body: string;
  steps: string[];
}

export function mailProviderNotice(input: MailProviderNoticeInput): MailProviderNoticeResult {
  const { provider, sender, mode } = input;
  const minutes = input.minutes ?? 2;
  const copy = PROVIDER_COPY[provider];
  return {
    providerLabel: copy.label,
    heading: noticeHeading(mode, minutes),
    body: copy.body,
    steps: copy.steps.map((s) => s.split("{sender}").join(sender)),
  };
}

/** Keeps the redirect param name in one place. */
export const MAIL_PROVIDER_PARAM = "p";

export function mailProviderQueryParam(provider: MailProvider): string {
  return `${MAIL_PROVIDER_PARAM}=${provider}`;
}
