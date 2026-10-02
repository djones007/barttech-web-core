import { test } from "node:test";
import assert from "node:assert/strict";
import {
  PREPAID_GENERIC_MESSAGE,
  PREPAID_RATE_LIMITED_MESSAGE,
  PREPAID_UNAVAILABLE_MESSAGE,
  isPlausiblePrepaidCode,
  redeemPrepaidCode,
  tidyPrepaidInput,
} from "./prepaidRedeem";

const TOKEN = "t".repeat(40);
const base = { checkoutHost: "checkout.example.com", token: TOKEN, code: "ABCD-EFGH-JKMN", email: "a@example.com" };
const reply = (status: number, body: unknown) => (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;

test("tidy and plausibility", () => {
  assert.equal(tidyPrepaidInput(" abcd efgh!jkmn "), "ABCDEFGHJKMN");
  assert.ok(isPlausiblePrepaidCode("ABCD-EFGH-JKMN"));
  assert.ok(!isPlausiblePrepaidCode("ABC"));
});

test("a good redemption returns where to send the buyer", async () => {
  let seen: { url: string; init: RequestInit } | null = null;
  const fetchImpl = (async (url: string, init: RequestInit) => {
    seen = { url, init };
    return new Response(
      JSON.stringify({ ok: true, retry: false, productName: "P", fulfilment: "game_licence", successUrl: "https://checkout.example.com/success?x", accessUrl: "https://play.example.com/account", test: false }),
    );
  }) as unknown as typeof fetch;
  const r = await redeemPrepaidCode({ ...base, clientIp: "203.0.113.9", fetchImpl });
  assert.ok(r.ok);
  if (r.ok) assert.equal(r.accessUrl, "https://play.example.com/account");
  assert.equal(seen!.url, "https://checkout.example.com/api/prepaid/redeem");
  const h = seen!.init.headers as Record<string, string>;
  assert.equal(h.Authorization, `Bearer ${TOKEN}`);
  assert.equal(JSON.parse(String(seen!.init.body)).ip, "203.0.113.9");
  assert.equal(seen!.init.redirect, "error");
});

test("every refusal reads the same; rate limiting and outages are told apart", async () => {
  const rej = await redeemPrepaidCode({ ...base, fetchImpl: reply(400, { ok: false, error: "invalid" }) });
  assert.deepEqual(rej, { ok: false, kind: "rejected", message: PREPAID_GENERIC_MESSAGE });
  const rl = await redeemPrepaidCode({ ...base, fetchImpl: reply(429, { ok: false, error: "rate_limited" }) });
  assert.deepEqual(rl, { ok: false, kind: "rate_limited", message: PREPAID_RATE_LIMITED_MESSAGE });
  const down = await redeemPrepaidCode({ ...base, fetchImpl: reply(500, { ok: false, error: "server" }) });
  assert.deepEqual(down, { ok: false, kind: "unreachable", message: PREPAID_UNAVAILABLE_MESSAGE });
  const bad = await redeemPrepaidCode({ ...base, fetchImpl: reply(401, {}) });
  assert.equal(bad.ok === false && bad.kind, "misconfigured");
  const boom = await redeemPrepaidCode({
    ...base,
    fetchImpl: (async () => {
      throw new Error("net");
    }) as unknown as typeof fetch,
  });
  assert.equal(boom.ok === false && boom.kind, "unreachable");
});

test("misconfiguration and junk never reach the network", async () => {
  let calls = 0;
  const fetchImpl = (async () => {
    calls++;
    return new Response("{}");
  }) as unknown as typeof fetch;
  assert.equal((await redeemPrepaidCode({ ...base, token: "short", fetchImpl })).ok, false);
  assert.equal((await redeemPrepaidCode({ ...base, checkoutHost: "https://evil.example.com/x", fetchImpl })).ok, false);
  assert.equal((await redeemPrepaidCode({ ...base, checkoutHost: "a.com/path", fetchImpl })).ok, false);
  const junk = await redeemPrepaidCode({ ...base, code: "x", fetchImpl });
  assert.equal(junk.ok === false && junk.kind, "rejected");
  assert.equal(calls, 0);
});

test("an ok response without a success URL is not a success", async () => {
  const r = await redeemPrepaidCode({ ...base, fetchImpl: reply(200, { ok: true }) });
  assert.equal(r.ok, false);
});
