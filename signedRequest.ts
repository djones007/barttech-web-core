import { createHmac, timingSafeEqual } from "crypto";

// ---------------------------------------------------------------------------
// Signed-timestamp scheme for server-to-server producer requests.
//
// A body-only HMAC proves who sent a request but not WHEN: a captured signed
// body replays forever. This module signs `"{timestamp}.{rawBody}"` instead and
// lets the receiver reject anything outside a tolerance window. Replay inside
// the window is closed separately, by the receiver deduping on an event id the
// producer puts in the (signed) body.
//
// Wire format (additive; a legacy body-only signature header may be sent
// alongside, so a new producer still works against a receiver that predates
// this scheme):
//   x-signed-timestamp:  unix seconds, integer
//   x-signed-signature:  "v1=" + hex(HMAC-SHA256(secret, `${timestamp}.${rawBody}`))
//
// NODE RUNTIME ONLY (imports Node `crypto`) — same constraint as ./security.
// Runtimes without Node crypto (e.g. Deno edge functions) re-implement the
// same two lines with WebCrypto; the format above is the contract.
// ---------------------------------------------------------------------------

export const SIGNED_TIMESTAMP_HEADER = "x-signed-timestamp";
export const SIGNED_SIGNATURE_HEADER = "x-signed-signature";
export const SIGNATURE_VERSION = "v1";
/** ±5 minutes. Shared with the receiver so the two cannot drift. */
export const DEFAULT_TOLERANCE_SEC = 300;

export interface SignedRequestHeaders {
  [SIGNED_TIMESTAMP_HEADER]: string;
  [SIGNED_SIGNATURE_HEADER]: string;
}

function digest(secret: string, timestamp: string, rawBody: string): string {
  return createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest("hex");
}

/** Sign a raw request body. `nowSec` is injectable for tests. */
export function signRequestBody(params: {
  rawBody: string;
  secret: string;
  nowSec?: number;
}): SignedRequestHeaders {
  const ts = String(Math.floor(params.nowSec ?? Date.now() / 1000));
  return {
    [SIGNED_TIMESTAMP_HEADER]: ts,
    [SIGNED_SIGNATURE_HEADER]: `${SIGNATURE_VERSION}=${digest(params.secret, ts, params.rawBody)}`,
  };
}

export type SignedRequestFailure =
  | "missing" // one or both headers absent (caller decides if that is "legacy")
  | "malformed" // timestamp not an integer, or signature not "v1=<hex>"
  | "stale" // outside the tolerance window (past OR future)
  | "bad_signature"; // body tampered, wrong secret, or timestamp altered

export type SignedRequestResult = { ok: true } | { ok: false; reason: SignedRequestFailure };

/**
 * Verify a signed request. Checks the signature BEFORE the window so a caller
 * probing with a stale-but-forged request learns nothing about the clock, and
 * compares in constant time. Never throws.
 */
export function verifySignedRequest(params: {
  rawBody: string;
  secret: string;
  timestamp: string | null | undefined;
  signature: string | null | undefined;
  nowSec?: number;
  toleranceSec?: number;
}): SignedRequestResult {
  const { rawBody, secret, timestamp, signature } = params;
  if (!timestamp || !signature) return { ok: false, reason: "missing" };
  if (!secret) return { ok: false, reason: "bad_signature" };
  if (!/^\d{1,12}$/.test(timestamp) || !signature.startsWith(`${SIGNATURE_VERSION}=`)) {
    return { ok: false, reason: "malformed" };
  }

  const expected = `${SIGNATURE_VERSION}=${digest(secret, timestamp, rawBody)}`;
  let match = false;
  try {
    const a = Buffer.from(signature);
    const b = Buffer.from(expected);
    match = a.length === b.length && timingSafeEqual(a, b);
  } catch {
    match = false;
  }
  if (!match) return { ok: false, reason: "bad_signature" };

  const now = Math.floor(params.nowSec ?? Date.now() / 1000);
  const tolerance = params.toleranceSec ?? DEFAULT_TOLERANCE_SEC;
  if (Math.abs(now - Number(timestamp)) > tolerance) return { ok: false, reason: "stale" };
  return { ok: true };
}
