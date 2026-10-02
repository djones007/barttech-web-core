// ---------------------------------------------------------------------------
// The buyer's own-address banner and its one-click opt-in, as pure logic over injected I/O, so the
// copy and the safety rules live ONCE and every app's success page behaves the same.
//
//   ownAddressBanner()      the calm plain-English banner for a deliverability state (emailit.ts)
//   runComplaintOptIn()     what a click on "Yes, send my game pass and game emails to this address" does
//
// The safety rules, each pinned by ownAddress.test.ts:
//   * Nothing is looked up or cleared for an address the caller did not take from the buyer's own
//     order or session (the caller passes the deps already bound to that address).
//   * The complaint record is cleared only inside runComplaintOptIn, which the app calls only from
//     the handler of the buyer's explicit click; it re-checks the state first (a complaint, still).
//   * At most ONCE per order: `claimOnce` is an atomic claim in the app's own store; a second click
//     does nothing.
//   * Transactional only. The deps have no marketing member at all: no tag, no list, no suppression
//     write is expressible here (a tag write can start a sequence that sends email).
//   * Resend only after a successful clear; the result says what happened and is never an exception.
// ---------------------------------------------------------------------------

import type { BuyerDeliverability, ClearSelfRequestedResult } from "./emailit";

export type OwnAddressBannerKind = "hard_bounce" | "complaint";

export interface OwnAddressBanner {
  kind: OwnAddressBannerKind;
  message: string;
  /** Present only for a complaint: the explicit opt-in. */
  optIn: { label: string; hint: string } | null;
}

/** The generic note shown when there is no specific banner (also when the check failed or timed out). */
export const OWN_ADDRESS_GENERIC_NOTE = "If for any reason the email doesn't arrive, keep these details: they get you in.";

/**
 * Soft-fail and ok show nothing; unknown shows nothing here (the page shows its generic note and the download).
 * Wording is calm and says what to do. `email` is the buyer's own address from their order.
 */
export function ownAddressBanner(d: BuyerDeliverability, email: string): OwnAddressBanner | null {
  if (d.state === "hard_bounce") {
    return {
      kind: "hard_bounce",
      message: `Our emails to ${email} have bounced before, so this address may not receive your game pass. Check for a typo, or use "Wrong address? Fix it here". You can still download your game pass below.`,
      optIn: null,
    };
  }
  if (d.state === "complaint") {
    return {
      kind: "complaint",
      message: "This address once marked one of our emails as spam, so we're blocked from emailing it. You can still download your game pass below.",
      optIn: {
        label: "Yes, send my game pass and game emails to this address",
        hint: "Check your spam folder and mark us as \"not spam\" so they reach your inbox. This is only for emails about this order. It does not sign you up to anything.",
      },
    };
  }
  return null;
}

export interface OwnAddressDeps {
  /** A fresh look at the buyer's own address. */
  check(): Promise<BuyerDeliverability>;
  /** Atomically claim the one opt-in this order gets. Resolves true only for the first caller. */
  claimOnce(): Promise<boolean>;
  /** The audited provider clear (clearComplaintSuppressionOnConsent bound to this address and order). */
  clear(): Promise<ClearSelfRequestedResult>;
  /** Re-send the game pass / delivery email to the same address. Resolves whether it was sent. */
  resend(): Promise<boolean>;
  /** An audit row for the outcome. Must not throw. */
  audit(outcome: string, detail?: Record<string, unknown>): Promise<void>;
}

export type OptInOutcome = "cleared_and_resent" | "cleared_resend_failed" | "not_a_complaint" | "already_used" | "kept" | "throttled" | "error";

export interface OptInResult {
  ok: boolean;
  outcome: OptInOutcome;
  /** Buyer-facing, plain English. */
  message: string;
}

const MSG: Record<OptInOutcome, string> = {
  cleared_and_resent: "Done. We've sent your game pass again. Check your spam folder too and mark us as \"not spam\".",
  cleared_resend_failed: "Done, you can receive our emails again. We could not send the game pass just now, so please download it below.",
  not_a_complaint: "There is nothing to change for this address.",
  already_used: "We've already done this once for this order. Please download your game pass below.",
  kept: "We could not change this for this address. Please download your game pass below, or use \"Wrong address? Fix it here\".",
  throttled: "Please try again a little later. You can download your game pass below in the meantime.",
  error: "We could not do that just now. Please download your game pass below.",
};

/**
 * The click handler's work. Re-checks, claims the single use, clears, then re-sends. Never throws.
 * The order of the steps is the safety: nothing is claimed unless the address is (still) a complaint,
 * nothing is cleared unless the claim won, nothing is sent unless the clear worked.
 */
export async function runComplaintOptIn(deps: OwnAddressDeps): Promise<OptInResult> {
  const done = async (outcome: OptInOutcome, ok: boolean, detail?: Record<string, unknown>): Promise<OptInResult> => {
    try {
      await deps.audit(outcome, detail);
    } catch {
      /* an audit failure never changes the result */
    }
    return { ok, outcome, message: MSG[outcome] };
  };
  try {
    const now = await deps.check();
    if (now.state !== "complaint") return await done("not_a_complaint", false, { state: now.state });
    if (!(await deps.claimOnce())) return await done("already_used", false);
    const cleared = await deps.clear();
    if (cleared.action === "throttled") return await done("throttled", false);
    if (cleared.action === "kept") return await done("kept", false);
    if (cleared.action !== "cleared") return await done("error", false, { clear: cleared.action });
    const sent = await deps.resend().catch(() => false);
    return await done(sent ? "cleared_and_resent" : "cleared_resend_failed", true);
  } catch {
    return await done("error", false);
  }
}
