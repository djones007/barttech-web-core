// ---------------------------------------------------------------------------
// Reoon email verification — THE single rule for OPTIN-TIME gating.
//
// SCOPE: one address, checked live while someone is submitting a form, to
// decide "do we accept this signup?". That is the only question this module
// answers. See the note at the bottom about the other question.
//
// WHY THIS EXISTS
// Before 2026-07-29 three routes asked that question and gave three different
// answers:
//
//   chillingscreams-website     blocklist: invalid, disposable, unsafe
//   nuttyorange-games-website   blocklist: invalid, disposable, unsafe
//   cloud-plus-v2/api/contact   allowlist: only `safe`/`valid` reach the ESP
//
// So a **spamtrap** address was accepted outright by Chilling Screams and Nutty
// Orange. Spamtraps are the single most damaging thing to put on a list — they
// exist to catch senders who don't clean their data — and Nutty Orange is
// already dealing with a Microsoft IP-pool demotion. The blocked set below is
// the union of every rule that was in production, so no brand is looser than it
// was and two are correctly stricter.
//
// FAIL OPEN, ALWAYS. No API key, an HTTP error, a timeout, a malformed
// response — every one of those returns `valid: true`. A verification outage
// must never block a genuine signup; the cost of one bad address is far lower
// than the cost of silently rejecting real leads while nobody notices.
//
// CREDIT LIMIT: the Reoon account has a HARD 4,300 checks/day cap, shared by
// everything in the estate. Never add a call to a high-volume or looping path,
// and never verify an address that is already a known contact. See
// memory/feedback_reoon.md.
// ---------------------------------------------------------------------------

const REOON_VERIFY_URL = "https://emailverifier.reoon.com/api/v1/verify";
const REOON_TIMEOUT_MS = 8000;

/**
 * Statuses that mean "do not accept this address". The union of every rule that
 * was in production before consolidation — widening any brand's blocklist,
 * narrowing none.
 *
 * `unknown` is deliberately NOT here: it means Reoon could not determine the
 * answer, which is a verification failure, not evidence of a bad address.
 * Treating it as bad would throw away real leads on the verifier's bad day.
 */
export const REOON_BLOCKED_STATUSES = ["invalid", "disposable", "spamtrap", "unsafe"] as const;

/**
 * Statuses that positively confirm a good address. Use this — not `!blocked` —
 * when the decision is "should this go to the ESP?", where the safe default is
 * to hold back anything unproven. cloud-plus-v2's contact route works this way
 * and must keep working this way: it is protecting Emailit list quality, a
 * stricter question than "is this person allowed to submit the form?".
 */
export const REOON_GOOD_STATUSES = ["safe", "valid"] as const;

export interface ReoonResult {
  /** false ONLY on a confirmed-bad classification. True on every failure path. */
  valid: boolean;
  /**
   * Reoon's classification, or a marker for why there isn't one:
   * `skipped` (no API key), `reoon_error` (non-2xx), `timeout` (threw/timed out).
   */
  status: string;
}

/** True when Reoon positively classified the address as good. */
export function isConfirmedGood(status: string): boolean {
  return (REOON_GOOD_STATUSES as readonly string[]).includes(status);
}

/** True when Reoon positively classified the address as bad. */
export function isBlocked(status: string): boolean {
  return (REOON_BLOCKED_STATUSES as readonly string[]).includes(status);
}

/**
 * Reoon's verification depth. `quick` is a syntax/domain/MX check; `power` also
 * probes the mailbox — slower, more credits, and the only one that can return
 * `safe`. This is an API parameter, not a policy knob: it changes how hard Reoon
 * looks, never what we do with the answer. cloud-plus-v2's contact form uses
 * `power` because its B2B leads are individually worth the credits; the
 * high-volume consumer forms use `quick`. Mind the 4,300/day account cap.
 *
 * Note the two modes name a good address differently — `power` returns `safe`,
 * `quick` returns `valid` — which is why REOON_GOOD_STATUSES holds both.
 */
export type ReoonMode = "quick" | "power";

/**
 * Verify one address. Never throws. See the header for the fail-open contract
 * and the daily credit limit.
 */
export async function verifyEmail(email: string, mode: ReoonMode = "quick"): Promise<ReoonResult> {
  const key = process.env.REOON_API_KEY;
  if (!key) return { valid: true, status: "skipped" };

  try {
    const url = `${REOON_VERIFY_URL}?email=${encodeURIComponent(email)}&key=${key}&mode=${mode}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(REOON_TIMEOUT_MS) });
    if (!res.ok) return { valid: true, status: "reoon_error" };
    const data = (await res.json()) as { status?: string };
    const status = (data.status ?? "unknown").toLowerCase();
    return { valid: !isBlocked(status), status };
  } catch {
    return { valid: true, status: "timeout" };
  }
}

// ---------------------------------------------------------------------------
// NOT IN SCOPE: the post-hoc sweep
//
// `bartmail/src/lib/reoon.ts` also talks to Reoon, and was deliberately NOT
// folded in here. It answers a different question — "should we STOP emailing a
// contact we already have?" — using the bulk task API (cheaper per address,
// power mode) and Reoon's richer boolean fields rather than a single `status`.
// Its rule is correctly stricter in some places and looser in others, because
// suppressing an existing contact and refusing a new signup are not the same
// decision: it already blocks spamtraps, and it deliberately KEEPS catch-all,
// unknown and role accounts (info@ is a normal B2B optin for Cloud Plus).
//
// Merging the two would mean one flag-riddled function serving two policies —
// exactly what CLAUDE.md golden rule 1 forbids. Leave it where it is.
// ---------------------------------------------------------------------------
