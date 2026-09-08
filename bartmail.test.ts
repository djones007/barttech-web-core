import { test } from "node:test";
import assert from "node:assert/strict";
import { withMailProvider } from "./bartmail";

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
