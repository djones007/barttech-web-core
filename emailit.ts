// ---------------------------------------------------------------------------
// Emailit transactional SEND transport — the one implementation of "POST an
// email to Emailit and survive its rate limit".
//
// NOT a revival of the reverted audience-subscribe module (4bf03e2). That was
// removed because BartMail owns contacts and Emailit is delivery only; this
// module is delivery only. It must never grow an audience/contact operation.
//
// Why this exists (2026-07-30): five call sites across the estate had
// independently hand-written the same 429 retry after the 2026-07-29 incident
// (a bare unchecked fetch lost a real customer's quote email — see
// memory/feedback_emailit_rate_limit.md). All five waited exactly the
// `retry_after` Emailit returns, which is always 1 second — so concurrent
// callers blocked by the same per-second limit woke simultaneously and
// re-collided. That thundering herd is what exhausted BartMail's retry budget
// at only 500 sends/day. `retry_after` is treated here as a FLOOR under an
// exponential backoff with jitter, not as the whole wait.
//
// Emailit hard-caps sending at 2 messages/second per workspace, and several
// apps share one brand's key (BartMail bulk drains + checkout receipts +
// quote emails), so the cap is reachable in completely normal operation.
//
// Retry policy: 429, 5xx and thrown fetches (a dropped connection is as
// transient as a 429). 4xx other than 429 fails immediately — it will not get
// better on retry.
//
// ⚠️ Claim-then-send flows must NOT use this. If the caller marks something
// "sent" BEFORE calling (compare-and-swap idempotency, e.g. a quote-send route
// that reserves the send first), retrying a THROWN fetch is unsafe: the request may have reached
// Emailit, so a retry can double-send. Such flows may retry only confirmed
// 429s and must keep that logic local. This module is for callers where a
// duplicate delivery is merely annoying and a dropped one is the real failure.
//
// Framework-free, fetch-only — no Node imports, no Sentry (consumers layer
// their own reporting on the returned result). Works in Node and edge/Deno
// runtimes alike.
// ---------------------------------------------------------------------------

const DEFAULT_ENDPOINT = "https://api.emailit.com/v2/emails";
const DEFAULT_MAX_ATTEMPTS = 4;

export interface EmailitSendMessage {
  from: string;
  to: string | string[];
  subject: string;
  html: string;
  text?: string;
  reply_to?: string;
  /**
   * Per-message override of the SENDING DOMAIN's tracking defaults.
   *
   * Emailit rewrites every link in an email through the domain's tracking host
   * (e.g. link.example.com -> go.emailitmail.com) when `track_clicks` is on
   * for that domain. The certificate is valid, but the REDIRECT itself is what
   * makes Outlook/SafeLinks interrupt the reader with a warning — which on a
   * transactional email (a quote, an agreement, a receipt) costs a conversion
   * for no gain, since the destination is our own primary domain.
   *
   * So: marketing keeps click tracking, transactional turns it off with
   * `{ loads: true, clicks: false }`. Optional and absent by default, so every
   * existing caller keeps the domain default it has always used.
   */
  tracking?: boolean | { loads?: boolean; clicks?: boolean };
}

export interface EmailitSendOptions {
  /** Attempts including the first (default 4). */
  maxAttempts?: number;
  /** Override for the v1 endpoint or tests. Default v2. */
  endpoint?: string;
  /** Log prefix so a shared warning is attributable to its caller. */
  label?: string;
}

export interface EmailitSendResult {
  ok: boolean;
  /** Attempts actually made. */
  attempts: number;
  /** Last HTTP status, when a response was received at all. */
  status?: number;
  /** First 300 chars of the last error body — safe to put in an error report. */
  body?: string;
  /** Set when the final failure was a thrown fetch rather than an HTTP error. */
  transportError?: string;
}

function backoffMs(attempt: number, retryAfterSec: number | undefined): number {
  // retry_after is a floor, never the whole wait: it is always 1s, so waiting
  // exactly that re-synchronises every blocked caller onto the same instant.
  const floor = Math.max(0, retryAfterSec ?? 0) * 1000;
  const exponential = 550 * 2 ** (attempt - 1); // 550, 1100, 2200, ...
  return Math.max(floor, exponential) + Math.floor(Math.random() * 500);
}

/**
 * Send one transactional email via Emailit. Never throws — inspect the result.
 * Callers wanting a boolean can use `(await sendEmailitEmail(...)).ok`.
 */

/**
 * Minimal HTML → plain text for the multipart alternative.
 *
 * Deliberately not a parser and deliberately dependency-free: this only has to
 * produce a readable fallback of our own templates, and anything pulled in here
 * is carried by every consumer of this module. Strips script/style outright
 * (their contents are never readable text), unwraps links as "text (url)" so a
 * text-only reader still gets the destination, turns block tags into breaks,
 * and decodes the entities our templates actually emit. `&amp;` is decoded LAST
 * so `&amp;lt;` cannot double-decode into a tag.
 */
export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, "")
    .replace(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, (_m, href, label) => {
      const text = String(label).replace(/<[^>]+>/g, "").trim();
      if (!text) return String(href);
      return text === href ? text : `${text} (${href})`;
    })
    .replace(/<br\s*\/?>/gi, "\n")
    // Cells become " | " so a DATA table (quote line items, order summaries)
    // reads as "Managed IT support | 2 | £299.00" instead of one run-on string.
    // HTML email also uses tables for LAYOUT, though, where that separator is
    // pure noise — the cleanup pass below strips it wherever it ends up at a
    // line edge, which is exactly what a single-cell layout row produces.
    .replace(/<\/(td|th)>/gi, " | ")
    .replace(/<\/(p|div|h[1-6]|li|tr|table|blockquote)>/gi, "\n\n")
    .replace(/<li\b[^>]*>/gi, "- ")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&rarr;/gi, "\u2192")
    .replace(/&larr;/gi, "\u2190")
    .replace(/&middot;/gi, "\u00b7")
    .replace(/&bull;/gi, "\u2022")
    .replace(/&copy;/gi, "\u00a9")
    .replace(/&reg;/gi, "\u00ae")
    .replace(/&trade;/gi, "\u2122")
    .replace(/&times;/gi, "\u00d7")
    .replace(/&mdash;/gi, "\u2014")
    .replace(/&ndash;/gi, "\u2013")
    .replace(/&hellip;/gi, "\u2026")
    .replace(/&lsquo;/gi, "\u2018")
    .replace(/&rsquo;/gi, "\u2019")
    .replace(/&ldquo;/gi, "\u201c")
    .replace(/&rdquo;/gi, "\u201d")
    .replace(/&pound;/gi, "\u00a3")
    .replace(/&euro;/gi, "\u20ac")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_m, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_m, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&amp;/gi, "&")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    // Table-cell cleanup, after tags are gone and whitespace is normalised.
    // A layout table (one cell per row) leaves a dangling " | " at a line edge;
    // an empty spacer cell leaves " | | ". Neither is meaningful text.
    .replace(/\|(\s*\|)+/g, "|")
    .replace(/^[ \t]*\|[ \t]*/gm, "")
    .replace(/[ \t]*\|[ \t]*$/gm, "")
    // Leading indentation is an artefact of the source markup, never meaningful
    // in the text part — and stripping a removed cell separator leaves one.
    .replace(/^[ \t]+/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export async function sendEmailitEmail(
  apiKey: string,
  msg: EmailitSendMessage,
  opts?: EmailitSendOptions
): Promise<EmailitSendResult> {
  const maxAttempts = opts?.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const endpoint = opts?.endpoint ?? DEFAULT_ENDPOINT;
  const label = opts?.label ?? "emailit";

  // EVERY send is multipart/alternative. `text` is optional on the message type
  // for callers' convenience, but omitting it must NOT produce an HTML-only
  // email: that scores worse with every major filter, is unreadable in
  // plain-text clients, and is worse for screen readers. Derived here rather
  // than left to each caller because "optional and usually forgotten" is
  // exactly how the estate ended up sending HTML-only mail for its entire life
  // (found 2026-07-31 — every BartMail send, every brand).
  const payload: EmailitSendMessage =
    msg.text && msg.text.trim() ? msg : { ...msg, text: htmlToText(msg.html) };

  let last: EmailitSendResult = { ok: false, attempts: 0 };

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let res: Response;
    try {
      res = await fetch(endpoint, {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      last = { ok: false, attempts: attempt, transportError: message };
      if (attempt === maxAttempts) break;
      const waitMs = backoffMs(attempt, undefined);
      console.warn(`[${label}] transport error (${message}); retrying in ${waitMs}ms`);
      await new Promise((r) => setTimeout(r, waitMs));
      continue;
    }

    if (res.ok) return { ok: true, attempts: attempt, status: res.status };

    const body = (await res.text().catch(() => "")).slice(0, 300);
    last = { ok: false, attempts: attempt, status: res.status, body };

    const retryable = res.status === 429 || res.status >= 500;
    if (!retryable || attempt === maxAttempts) break;

    let retryAfterSec: number | undefined;
    try {
      const parsed = JSON.parse(body) as { retry_after?: number };
      if (typeof parsed.retry_after === "number" && parsed.retry_after > 0) {
        retryAfterSec = parsed.retry_after;
      }
    } catch {
      // Non-JSON error body — exponential backoff alone.
    }
    const waitMs = backoffMs(attempt, retryAfterSec);
    console.warn(`[${label}] Emailit ${res.status}; retrying in ${waitMs}ms`);
    await new Promise((r) => setTimeout(r, waitMs));
  }

  console.error(
    `[${label}] Emailit send failed after ${last.attempts} attempt(s):`,
    last.status ?? last.transportError,
    last.body ?? ""
  );
  return last;
}
