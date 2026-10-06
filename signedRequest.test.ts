import { test } from "node:test";
import assert from "node:assert/strict";
import {
  signRequestBody,
  verifySignedRequest,
  SIGNED_TIMESTAMP_HEADER as TS,
  SIGNED_SIGNATURE_HEADER as SIG,
  DEFAULT_TOLERANCE_SEC,
} from "./signedRequest";

const secret = "s3cret";
const body = JSON.stringify({ email: "a@b.co", event_type: "note", event_id: "e1" });
const now = 1_800_000_000;

function check(over: Partial<Parameters<typeof verifySignedRequest>[0]> = {}) {
  const h = signRequestBody({ rawBody: body, secret, nowSec: now });
  return verifySignedRequest({
    rawBody: body,
    secret,
    timestamp: h[TS],
    signature: h[SIG],
    nowSec: now,
    ...over,
  });
}

test("a freshly signed request verifies", () => {
  assert.deepEqual(check(), { ok: true });
});

test("signature is v1=<64 hex> and timestamp is integer seconds", () => {
  const h = signRequestBody({ rawBody: body, secret, nowSec: now });
  assert.match(h[SIG], /^v1=[0-9a-f]{64}$/);
  assert.equal(h[TS], String(now));
});

test("expires outside the window, in the past or the future, but not at the edge", () => {
  assert.deepEqual(check({ nowSec: now + DEFAULT_TOLERANCE_SEC }), { ok: true });
  assert.deepEqual(check({ nowSec: now + DEFAULT_TOLERANCE_SEC + 1 }), { ok: false, reason: "stale" });
  assert.deepEqual(check({ nowSec: now - DEFAULT_TOLERANCE_SEC - 1 }), { ok: false, reason: "stale" });
});

test("tampered body is rejected", () => {
  assert.deepEqual(check({ rawBody: body.replace("note", "order_placed") }), {
    ok: false,
    reason: "bad_signature",
  });
});

test("altered timestamp is rejected: it is part of the signed string", () => {
  assert.deepEqual(check({ timestamp: String(now + 10) }), { ok: false, reason: "bad_signature" });
});

test("a body-only signature cannot be passed off as v1, and the wrong secret fails", () => {
  assert.deepEqual(check({ secret: "other" }), { ok: false, reason: "bad_signature" });
  assert.deepEqual(check({ signature: "sha256=abc" }), { ok: false, reason: "malformed" });
});

test("replay: the same signed request verifies inside the window (receiver must dedupe on event_id) and dies after it", () => {
  const h = signRequestBody({ rawBody: body, secret, nowSec: now });
  const again = (at: number) =>
    verifySignedRequest({ rawBody: body, secret, timestamp: h[TS], signature: h[SIG], nowSec: at });
  assert.equal(again(now + 60).ok, true);
  assert.deepEqual(again(now + 3600), { ok: false, reason: "stale" });
});

test("missing and malformed inputs never throw", () => {
  assert.deepEqual(check({ timestamp: null }), { ok: false, reason: "missing" });
  assert.deepEqual(check({ signature: undefined }), { ok: false, reason: "missing" });
  assert.deepEqual(check({ timestamp: "12abc" }), { ok: false, reason: "malformed" });
  assert.deepEqual(check({ secret: "" }), { ok: false, reason: "bad_signature" });
});
