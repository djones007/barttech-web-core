import { test } from "node:test";
import assert from "node:assert/strict";
import { ownAddressBanner, runComplaintOptIn, type OwnAddressDeps } from "./ownAddress";

function deps(over: Partial<OwnAddressDeps> & { state?: "ok" | "hard_bounce" | "complaint" | "unknown"; claim?: boolean; clearAs?: string }) {
  const calls: string[] = [];
  const d: OwnAddressDeps = {
    async check() {
      calls.push("check");
      return { state: over.state ?? "complaint" };
    },
    async claimOnce() {
      calls.push("claim");
      return over.claim ?? true;
    },
    async clear() {
      calls.push("clear");
      return (over.clearAs === "kept" ? { action: "kept", reason: "r", suppressionId: "s" } : over.clearAs === "throttled" ? { action: "throttled", why: "w" } : over.clearAs === "error" ? { action: "error", error: "e" } : { action: "cleared", suppressionId: "s", reason: "r" }) as never;
    },
    async resend() {
      calls.push("resend");
      return true;
    },
    async audit(o) {
      calls.push(`audit:${o}`);
    },
    ...Object.fromEntries(Object.entries(over).filter(([k]) => ["check", "claimOnce", "clear", "resend", "audit"].includes(k))),
  };
  return { d, calls };
}

test("banner: ok, soft-fail and unknown show nothing; a hard bounce warns; a complaint offers the opt-in", () => {
  assert.equal(ownAddressBanner({ state: "ok" }, "a@b.com"), null);
  assert.equal(ownAddressBanner({ state: "unknown" }, "a@b.com"), null);
  const hb = ownAddressBanner({ state: "hard_bounce" }, "a@b.com")!;
  assert.match(hb.message, /Our emails to a@b\.com have bounced before, so this address may not receive your ticket\. Check for a typo, or use "Wrong address\? Fix it here"/);
  assert.equal(hb.optIn, null);
  const c = ownAddressBanner({ state: "complaint" }, "a@b.com")!;
  assert.match(c.message, /This address once marked one of our emails as spam, so we're blocked from emailing it\./);
  assert.equal(c.optIn?.label, "Yes, send my ticket and game emails to this address");
  assert.match(c.optIn!.hint, /not spam/i);
});

test("opt-in: checks, claims, clears, then resends, in that order, once", async () => {
  const { d, calls } = deps({});
  const r = await runComplaintOptIn(d);
  assert.equal(r.outcome, "cleared_and_resent");
  assert.deepEqual(calls, ["check", "claim", "clear", "resend", "audit:cleared_and_resent"]);
});

test("opt-in: an address that is not (still) a complaint is never claimed, cleared or mailed", async () => {
  for (const state of ["ok", "hard_bounce", "unknown"] as const) {
    const { d, calls } = deps({ state });
    const r = await runComplaintOptIn(d);
    assert.equal(r.outcome, "not_a_complaint");
    assert.deepEqual(calls, ["check", "audit:not_a_complaint"], state);
  }
});

test("opt-in: the second click for the same order does nothing", async () => {
  const { d, calls } = deps({ claim: false });
  const r = await runComplaintOptIn(d);
  assert.equal(r.outcome, "already_used");
  assert.ok(!calls.includes("clear") && !calls.includes("resend"));
});

test("opt-in: a kept, throttled or errored clear never resends", async () => {
  for (const clear of ["kept", "throttled", "error"]) {
    const { d, calls } = deps({ clearAs: clear });
    const r = await runComplaintOptIn(d);
    assert.equal(r.ok, false, clear);
    assert.ok(!calls.includes("resend"), clear);
  }
});

test("opt-in: a failed resend still reports the clear, and nothing throws", async () => {
  const { d } = deps({ resend: async () => false });
  assert.equal((await runComplaintOptIn(d)).outcome, "cleared_resend_failed");
  const boom = deps({ check: async () => { throw new Error("down"); } });
  assert.equal((await runComplaintOptIn(boom.d)).outcome, "error");
  const auditBoom = deps({ audit: async () => { throw new Error("audit down"); } });
  assert.equal((await runComplaintOptIn(auditBoom.d)).outcome, "cleared_and_resent");
});

test("the deps have no marketing member: nothing but these five calls can ever happen", () => {
  const { d } = deps({});
  assert.deepEqual(Object.keys(d).sort(), ["audit", "check", "claimOnce", "clear", "resend"]);
});
