import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_SITE_LOCK_MARKER,
  SITE_LOCK_COOKIE_MAX_AGE_SEC,
  checkSiteLockPassword,
  constantTimeStringEqual,
  isValidSiteLockToken,
  siteLockToken,
} from "./siteLock";

test("token is 64-char hex and deterministic", async () => {
  const a = await siteLockToken("hunter2");
  assert.match(a, /^[0-9a-f]{64}$/);
  assert.equal(a, await siteLockToken("hunter2"));
});

test("token matches a known HMAC-SHA256 vector", async () => {
  const { createHmac } = await import("node:crypto");
  const want = createHmac("sha256", "pw").update(DEFAULT_SITE_LOCK_MARKER).digest("hex");
  assert.equal(await siteLockToken("pw"), want);
});

test("different password or marker gives a different token", async () => {
  const base = await siteLockToken("pw");
  assert.notEqual(base, await siteLockToken("pw2"));
  assert.notEqual(base, await siteLockToken("pw", "other-v1"));
});

test("empty or missing password yields empty token (fail closed)", async () => {
  assert.equal(await siteLockToken(""), "");
  assert.equal(await siteLockToken(undefined), "");
});

test("isValidSiteLockToken accepts only the real token", async () => {
  const t = await siteLockToken("pw");
  assert.equal(await isValidSiteLockToken(t, "pw"), true);
  assert.equal(await isValidSiteLockToken("1", "pw"), false);
  assert.equal(await isValidSiteLockToken(t, "other"), false);
  assert.equal(await isValidSiteLockToken(t, "pw", "other-v1"), false);
});

test("isValidSiteLockToken fails closed on missing inputs", async () => {
  const t = await siteLockToken("pw");
  assert.equal(await isValidSiteLockToken(undefined, "pw"), false);
  assert.equal(await isValidSiteLockToken("", "pw"), false);
  assert.equal(await isValidSiteLockToken(t, undefined), false);
  assert.equal(await isValidSiteLockToken(t, ""), false);
});

test("constantTimeStringEqual", () => {
  assert.equal(constantTimeStringEqual("abc", "abc"), true);
  assert.equal(constantTimeStringEqual("abc", "abd"), false);
  assert.equal(constantTimeStringEqual("abc", "abcd"), false);
});

test("checkSiteLockPassword trims, issues a verifiable token, fails closed", async () => {
  const ok = await checkSiteLockPassword("  pw \n", "pw");
  assert.equal(ok.correct, true);
  assert.equal(await isValidSiteLockToken(ok.token, "pw"), true);
  const bad = await checkSiteLockPassword("nope", "pw");
  assert.deepEqual(bad, { correct: false, token: "" });
  assert.deepEqual(await checkSiteLockPassword("", ""), { correct: false, token: "" });
  assert.deepEqual(await checkSiteLockPassword("x", undefined), { correct: false, token: "" });
});

test("max age is 30 days", () => {
  assert.equal(SITE_LOCK_COOKIE_MAX_AGE_SEC, 2592000);
});
