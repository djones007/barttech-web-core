// ---------------------------------------------------------------------------
// Emailit (ESP) — the shared TRANSPORT for direct audience calls.
//
// SCOPE, and what this deliberately does not do
// This shares the *mechanism*: the retry, the rate-limit handling, and the
// "409 = already subscribed = success" rule. It does NOT try to be one
// subscribe function for every caller, because the estate genuinely uses two
// different Emailit endpoints with different auth:
//
//   * `POST /v{n}/audiences/{id}/subscribers`  — Bearer API key (Cloud Plus,
//     Nutty Orange, Owner Foundry)
//   * `POST /v1/audiences/subscribe/{token}`   — public token, no key at all
//     (Chilling Screams' waitlist)
//
// Forcing those through one flag-riddled function is what golden rule 1 exists
// to prevent, so each keeps its own thin wrapper below and they share the part
// that actually matters.
//
// WHY THE RETRY MATTERS
// Emailit rate-limits at ~2 messages/second and answers a breach with 429 plus
// a `retry_after`. Several call sites never inspected the response at all — a
// 429 resolved normally, the surrounding code carried on, and the subscribe
// simply never happened. That is the same class of failure that dropped a
// customer's quote email on 2026-07-29. Check the response, honour the API's
// own `retry_after`, and surface a final failure to the caller.
//
// NOT for broadcasts or sequence sends. Those go through BartMail's
// `claim_send_slot()` gate with per-brand `emailit_send_rate` /
// `emailit_daily_cap` settings — never hardcode a rate, and never route a bulk
// send through here. See memory/feedback_bartmail_send_rates.md.
// ---------------------------------------------------------------------------

const MAX_ATTEMPTS = 3;

export interface EmailitResult {
  ok: boolean;
  status: number;
  /** Response body on failure, truncated. Undefined when ok. */
  error?: string;
}

function retryable(status: number): boolean {
  return status === 429 || status >= 500;
}

async function waitFor(body: string, attempt: number): Promise<void> {
  let ms = 500 * 2 ** attempt;
  try {
    // Emailit returns the wait it wants in the body, not a Retry-After header.
    // Guessing shorter than it asked just earns another 429.
    const parsed = JSON.parse(body) as { retry_after?: number };
    if (typeof parsed.retry_after === "number" && parsed.retry_after > 0) {
      ms = Math.ceil(parsed.retry_after * 1000) + 250;
    }
  } catch {
    // Non-JSON body — fall back to the exponential default.
  }
  await new Promise((r) => setTimeout(r, Math.min(ms, 10_000)));
}

/**
 * POST to Emailit with retry. Returns a result rather than throwing, so the
 * caller decides whether a failure is fatal (a blocking optin) or merely worth
 * logging (a best-effort secondary subscribe).
 *
 * `okStatuses` lets a caller treat a non-2xx as success — pass `[409]` for
 * subscribe endpoints, where "already subscribed" is the desired end state and
 * not an error worth reporting.
 */
export async function emailitPost(
  url: string,
  init: { headers?: Record<string, string>; body: unknown },
  opts: { okStatuses?: number[] } = {}
): Promise<EmailitResult> {
  const okStatuses = opts.okStatuses ?? [];

  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(init.headers ?? {}) },
        body: JSON.stringify(init.body),
      });

      if (res.ok || okStatuses.includes(res.status)) return { ok: true, status: res.status };

      const body = (await res.text()).slice(0, 500);
      if (!retryable(res.status) || attempt >= MAX_ATTEMPTS - 1) {
        return { ok: false, status: res.status, error: body };
      }
      await waitFor(body, attempt);
    } catch (err) {
      // Transport failure — as transient as a 429, so retry rather than drop.
      if (attempt >= MAX_ATTEMPTS - 1) {
        return { ok: false, status: 0, error: err instanceof Error ? err.message : String(err) };
      }
      await waitFor("", attempt);
    }
  }
}

/**
 * Subscribe to an audience using a Bearer API key. 409 (already subscribed) is
 * success — re-submitting a form must not read as an error.
 *
 * `payload` passes through verbatim so each caller supplies whatever its form
 * collects (first_name, custom_fields, …). `apiVersion` differs by brand:
 * Nutty Orange is on v2, Cloud Plus on v1.
 */
export async function subscribeToAudience(
  audienceId: string,
  apiKey: string,
  payload: Record<string, unknown>,
  apiVersion: "v1" | "v2" = "v2"
): Promise<EmailitResult> {
  return emailitPost(
    `https://api.emailit.com/${apiVersion}/audiences/${audienceId}/subscribers`,
    { headers: { Authorization: `Bearer ${apiKey}` }, body: payload },
    { okStatuses: [409] }
  );
}

/**
 * Subscribe via Emailit's PUBLIC token endpoint — no API key. The token itself
 * is the credential, so it belongs in an env var and must never be logged or
 * put in a URL that gets recorded. Used by Chilling Screams' waitlist.
 */
export async function subscribeViaToken(
  token: string,
  payload: Record<string, unknown>
): Promise<EmailitResult> {
  return emailitPost(
    `https://api.emailit.com/v1/audiences/subscribe/${token}`,
    { body: payload },
    { okStatuses: [409] }
  );
}
