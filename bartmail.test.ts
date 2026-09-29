import { test } from "node:test";
import assert from "node:assert/strict";
import {
  withMailProvider,
  assertTagWrites,
  settlePartialOptin,
  isBartmailPartialOptinError,
  BartmailPartialOptinError,
} from "./bartmail";

// ---------------------------------------------------------------------------
// bartmail.ts as a whole imports @supabase/supabase-js and every exported
// function beyond withMailProvider() talks to a real (or env-configured)
// Supabase project / BartMail HTTP API, so this suite only exercises the one
// pure, dependency-free piece: withMailProvider(). Importing bartmail.ts
// itself is safe under node:test — @supabase/supabase-js's createClient is
// only ever called lazily, inside getBartmailSupabase(), never at module
// scope — so this import does not touch the network or require env vars.
// ---------------------------------------------------------------------------

test("no custom_fields produces mail_provider from a gmail.com address", () => {
  const result = withMailProvider(undefined, "person@gmail.com");
  assert.deepEqual(result, { mail_provider: "gmail" });
});

test("no custom_fields produces mail_provider 'unknown' for a business domain", () => {
  const result = withMailProvider(undefined, "person@some-business.example");
  assert.deepEqual(result, { mail_provider: "unknown" });
});

test("a caller-supplied mail_provider is respected, not overwritten", () => {
  const result = withMailProvider({ mail_provider: "custom-value" }, "person@gmail.com");
  assert.deepEqual(result, { mail_provider: "custom-value" });
});

test("other keys in custom_fields are preserved alongside the derived mail_provider", () => {
  const result = withMailProvider({ scorecard_score: "87" }, "person@outlook.com");
  assert.deepEqual(result, { scorecard_score: "87", mail_provider: "outlook" });
});

test("other keys in custom_fields are preserved alongside a caller-supplied mail_provider", () => {
  const result = withMailProvider({ scorecard_score: "87", mail_provider: "manual" }, "person@outlook.com");
  assert.deepEqual(result, { scorecard_score: "87", mail_provider: "manual" });
});

test("an empty custom_fields object still gets mail_provider filled in", () => {
  const result = withMailProvider({}, "person@icloud.com");
  assert.deepEqual(result, { mail_provider: "apple" });
});

test("assertTagWrites: all ok does not throw", () => {
  assert.doesNotThrow(() => assertTagWrites([{ name: "a", error: null }, { name: "b", error: null }]));
  assert.doesNotThrow(() => assertTagWrites([]));
});

test("assertTagWrites: any failed tag throws and names it (no silent success)", () => {
  assert.throws(
    () => assertTagWrites([{ name: "brand-optin", error: null }, { name: "brand-buyer", error: { message: "permission denied" } }]),
    /BartMail tag write failed: brand-buyer \(permission denied\)/,
  );
});

test("assertTagWrites throws the TYPED partial error (contact saved)", () => {
  try {
    assertTagWrites([{ name: "x", error: { message: "boom" } }], "c1");
    assert.fail("should have thrown");
  } catch (err) {
    assert.ok(isBartmailPartialOptinError(err));
    assert.ok(err instanceof BartmailPartialOptinError);
    assert.equal(err.contactSaved, true);
    assert.equal(err.contactId, "c1");
    assert.deepEqual(err.failedTags, ["x"]);
  }
});

test("isBartmailPartialOptinError: plain errors and non-errors are not partial", () => {
  assert.equal(isBartmailPartialOptinError(new Error("BartMail contact insert failed: x")), false);
  assert.equal(isBartmailPartialOptinError(null), false);
  assert.equal(isBartmailPartialOptinError("BARTMAIL_PARTIAL_OPTIN"), false);
  // duck-typed on code: survives a second copy of the module in one bundle
  assert.equal(isBartmailPartialOptinError({ code: "BARTMAIL_PARTIAL_OPTIN" }), true);
});

const ctx = { brand: "b", contactId: "c1" };

test("settlePartialOptin: everything landed -> resolves, handler not called", async () => {
  let called = false;
  await settlePartialOptin([{ name: "b-optin", error: null }], null, ctx, () => { called = true; });
  assert.equal(called, false);
});

test("settlePartialOptin: tag failure with NO handler throws (webhook default: sender retries)", async () => {
  await assert.rejects(
    settlePartialOptin([{ name: "b-optin", error: null }, { name: "b-buyer", error: { message: "denied" } }], null, ctx),
    (err: unknown) =>
      isBartmailPartialOptinError(err) &&
      /BartMail tag write failed: b-buyer \(denied\)/.test((err as Error).message) &&
      /contact saved/.test((err as Error).message),
  );
});

test("settlePartialOptin: tag failure WITH handler resolves and hands over the typed error", async () => {
  let got: BartmailPartialOptinError | null = null;
  await settlePartialOptin([{ name: "b-optin", error: { message: "denied" } }], null, ctx, (e) => { got = e; });
  assert.ok(got);
  assert.deepEqual((got as unknown as BartmailPartialOptinError).failedTags, ["b-optin"]);
  assert.equal((got as unknown as BartmailPartialOptinError).contactId, "c1");
});

test("settlePartialOptin: suppression-lift failure alone is partial too", async () => {
  await assert.rejects(settlePartialOptin([], "rls", ctx), (err: unknown) =>
    isBartmailPartialOptinError(err) && (err as BartmailPartialOptinError).suppressionLiftFailed === true);
});

test("settlePartialOptin: a handler that throws never breaks the caller", async () => {
  await settlePartialOptin([{ name: "t", error: { message: "x" } }], null, ctx, () => { throw new Error("sentry down"); });
  await settlePartialOptin([{ name: "t", error: { message: "x" } }], null, ctx, async () => { throw new Error("async down"); });
});

test("settlePartialOptin: a non-function handler (e.g. spread from JSON) is ignored -> throws", async () => {
  await assert.rejects(
    settlePartialOptin([{ name: "t", error: { message: "x" } }], null, ctx, "x" as unknown as undefined),
    (err: unknown) => isBartmailPartialOptinError(err),
  );
});
