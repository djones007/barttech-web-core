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
// "sent" BEFORE calling (compare-and-swap idempotency, e.g. cloud-plus-v2's
// quote send), retrying a THROWN fetch is unsafe: the request may have reached
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
export async function sendEmailitEmail(
  apiKey: string,
  msg: EmailitSendMessage,
  opts?: EmailitSendOptions
): Promise<EmailitSendResult> {
  const maxAttempts = opts?.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const endpoint = opts?.endpoint ?? DEFAULT_ENDPOINT;
  const label = opts?.label ?? "emailit";

  let last: EmailitSendResult = { ok: false, attempts: 0 };

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let res: Response;
    try {
      res = await fetch(endpoint, {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify(msg),
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
