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
   * Per-message override of the sending domain's tracking defaults.
   *
   * With click tracking enabled on a domain, the provider rewrites every link in
   * the message to point at its own tracking host and redirect from there. The
   * tracking host's certificate is valid, but some mail clients and link
   * scanners interrupt the reader with a warning on any redirect through an
   * unfamiliar host — which costs a click on a transactional message whose
   * destination is already a first-party domain.
   *
   * So: keep click tracking for marketing, disable it per-message for
   * transactional with `{ loads: true, clicks: false }`. Open tracking is
   * unaffected, and a first-party page load is the better open signal anyway
   * since a redirect can be tripped by a scanner.
   *
   * Optional and absent by default, so every existing caller keeps the domain
   * default it has always used.
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

// ---------------------------------------------------------------------------
// SEND PACING — claim a slot before an Emailit send.
//
// Emailit's rate limit is MESSAGES PER SECOND PER WORKSPACE, not per app and
// not a concurrency limit. Every sender sharing a workspace shares that one
// budget, so an app that sends "only a handful of transactional emails" still
// competes with whatever else is sending at that moment.
//
// This exists because of a real, diagnosed loss. A double-opt-in confirmation
// email was sent while a 24,000-recipient broadcast was mid-flight through the
// same workspace at ~100 messages/minute. The broadcast paced itself through
// this slot mechanism; the transactional send did not, exhausted all four
// retry attempts against 429s, and was lost. The entrant never received the
// only email that could activate their entry, and nothing in the product could
// tell that apart from an entrant who simply had not clicked yet.
//
// The lesson is the counter-intuitive one: LOW-VOLUME TRANSACTIONAL MAIL NEEDS
// THIS MORE THAN BULK MAIL DOES, not less. Bulk mail is retried and its
// failures are counted; a lost confirmation, password reset or receipt is
// usually a silent, single, unrecoverable event.
//
// COST OF PACING, MEASURED (not estimated): the underlying RPC advances the
// workspace's `next_send_at` by one interval from `GREATEST(next_send_at,
// now())`, so an idle queue hands out the very next slot rather than a place
// behind an existing backlog. Across 3,500 slot claims taken during that same
// 24k broadcast at full rate, the gap between claiming a slot and that slot
// falling due averaged BELOW ZERO — the queue never ran ahead of wall clock,
// because senders claim one slot per message immediately before sending rather
// than reserving batches in advance. At a 5/sec workspace rate the practical
// cost to a transactional send is ~200ms, one slot.
//
// That conclusion depends on nobody batch-claiming slots ahead of time. A
// sender that reserved thousands up front would push `next_send_at` hours into
// the future and every transactional send would queue behind it. If you add
// such a sender, this comment stops being true — give transactional mail its
// own path before you do.
//
// FAILS OPEN, ALWAYS. If the RPC errors the send proceeds unpaced rather than
// being blocked: a rate limiter that can stop mail entirely is worse than the
// 429 it prevents. The failure is logged loudly and reported in the return
// value so callers can count it.
// ---------------------------------------------------------------------------

/**
 * The subset of a Supabase client this needs. Declared structurally so this
 * module keeps its zero runtime imports — it is mounted in repos that have no
 * Supabase dependency at all, and a real client satisfies this shape as-is.
 */
export interface SendSlotStore {
  rpc(
    fn: string,
    args: Record<string, unknown>
  ): PromiseLike<{ data: unknown; error: { message: string } | null }>;
  from(table: string): {
    insert(row: Record<string, unknown>): PromiseLike<unknown>;
  };
}

export interface ClaimSendSlotOptions {
  store: SendSlotStore;
  /** BartMail `brands.id`. The RPC resolves it to the owning workspace itself. */
  brandId: string;
  /**
   * The WORKSPACE's messages/sec (`emailit_workspaces.send_rate`), not the
   * brand's. Several brands can share one workspace; using a brand-level rate
   * lets two brands each run a full independent cadence and jointly break the
   * real limit.
   */
  sendRatePerSec: number;
  /**
   * Fraction of the nominal rate actually used. Defaults to
   * DEFAULT_SEND_RATE_SAFETY_FACTOR. Pass the workspace's own
   * `send_rate_safety_factor` when you have it.
   */
  safetyFactor?: number | null;
  /** Log prefix, e.g. "email:acme-brand". */
  label?: string;
  /**
   * Write a `send_rate_diagnostics` row (assigned slot vs actual fire time).
   * Defaults true — it is the only ground truth for tuning the safety factor,
   * and it is fire-and-forget so it cannot delay or fail a send.
   */
  recordDiagnostics?: boolean;
}

export interface ClaimSendSlotResult {
  /** False when the slot could not be claimed and the send should proceed unpaced. */
  paced: boolean;
  waitedMs: number;
}

/**
 * Exactly-at-cap, 0.8 and 0.5 all produced live 429s under concurrency before
 * the diagnostics table existed to show why. 0.33 ran clean; 0.6 has been the
 * standing value since 2026-07-09. Do not raise it without watching
 * `send_rate_diagnostics` and error reporting afterwards.
 *
 * Kept identical to the value the bulk sender uses. Two senders sharing one
 * workspace budget must derive the same interval, or the safer one simply
 * yields its slots to the other.
 */
export const DEFAULT_SEND_RATE_SAFETY_FACTOR = 0.6;

/**
 * Claim and wait for this send's slot. Await it immediately before the send.
 *
 * Never throws.
 */
export async function claimEmailitSendSlot(
  opts: ClaimSendSlotOptions
): Promise<ClaimSendSlotResult> {
  const label = opts.label ?? "emailit";
  const factor =
    typeof opts.safetyFactor === "number" && opts.safetyFactor > 0
      ? opts.safetyFactor
      : DEFAULT_SEND_RATE_SAFETY_FACTOR;
  const effectiveRate = (opts.sendRatePerSec || 2) * factor;
  const intervalMs = Math.max(1, Math.round(1000 / effectiveRate));

  let slotIso: string | null = null;
  try {
    const { data, error } = await opts.store.rpc("claim_send_slot", {
      p_brand_id: opts.brandId,
      p_interval_ms: intervalMs,
    });
    if (error) {
      console.error(`[${label}] claim_send_slot failed, sending unpaced:`, error.message);
      return { paced: false, waitedMs: 0 };
    }
    slotIso = typeof data === "string" ? data : null;
  } catch (err) {
    console.error(
      `[${label}] claim_send_slot threw, sending unpaced:`,
      err instanceof Error ? err.message : String(err)
    );
    return { paced: false, waitedMs: 0 };
  }

  if (!slotIso) return { paced: false, waitedMs: 0 };

  const slotMs = new Date(slotIso).getTime();
  if (!Number.isFinite(slotMs)) return { paced: false, waitedMs: 0 };

  const waitMs = slotMs - Date.now();
  if (waitMs > 0) await new Promise((r) => setTimeout(r, waitMs));

  if (opts.recordDiagnostics !== false) {
    const firedAt = new Date();
    try {
      // Fire-and-forget: a diagnostics write must never delay or fail a send.
      void Promise.resolve(
        opts.store.from("send_rate_diagnostics").insert({
          brand_id: opts.brandId,
          assigned_slot_at: new Date(slotMs).toISOString(),
          actual_fire_at: firedAt.toISOString(),
          delta_ms: firedAt.getTime() - slotMs,
        })
      ).then(
        () => {},
        () => {}
      );
    } catch {
      // Ignored by design.
    }
  }

  return { paced: true, waitedMs: Math.max(0, waitMs) };
}
