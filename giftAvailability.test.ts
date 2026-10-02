import { test } from "node:test";
import assert from "node:assert/strict";
import {
  fetchGiftAvailable,
  giftAvailabilityUrl,
  giftCheckoutUrl,
  isValidOfferSlug,
  normaliseCheckoutOrigin,
} from "./giftAvailability";

const O = "https://checkout.example.test";
const resp = (status: number, body: unknown) => (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;

test("origin must be https and is reduced to its origin", () => {
  assert.equal(normaliseCheckoutOrigin("https://a.example.test/path?x=1"), "https://a.example.test");
  assert.equal(normaliseCheckoutOrigin("http://a.example.test"), null);
  assert.equal(normaliseCheckoutOrigin("https://u:p@a.example.test"), null);
  assert.equal(normaliseCheckoutOrigin("nonsense"), null);
  assert.equal(normaliseCheckoutOrigin(undefined), null);
});

test("slug shape", () => {
  assert.ok(isValidOfferSlug("my-offer_1"));
  for (const bad of ["", "a/b", "a b", "../x", "-x", "a?b=1", undefined, null]) assert.equal(isValidOfferSlug(bad as string), false);
});

test("urls", () => {
  assert.equal(giftAvailabilityUrl(O, "offer-a"), `${O}/api/gift/available?offer=offer-a`);
  assert.equal(giftAvailabilityUrl("http://x.test", "offer-a"), null);
  assert.equal(giftAvailabilityUrl(O, "a/b"), null);
  assert.equal(giftCheckoutUrl(O, "offer-a"), `${O}/offer-a?gift=1`);
  assert.equal(giftCheckoutUrl(O, "offer-a", { ref: "x", gift: "0", empty: "" }), `${O}/offer-a?gift=1&ref=x`);
  assert.equal(giftCheckoutUrl(O, "bad slug"), null);
});

test("fetch: true only for 200 + available:true", async () => {
  assert.equal(await fetchGiftAvailable(O, "offer-a", { fetchImpl: resp(200, { available: true }) }), true);
  assert.equal(await fetchGiftAvailable(O, "offer-a", { fetchImpl: resp(200, { available: false }) }), false);
  assert.equal(await fetchGiftAvailable(O, "offer-a", { fetchImpl: resp(200, { available: "true" }) }), false);
  assert.equal(await fetchGiftAvailable(O, "offer-a", { fetchImpl: resp(404, { available: true }) }), false);
  assert.equal(await fetchGiftAvailable(O, "offer-a", { fetchImpl: resp(200, null) }), false);
});

test("fetch: failures never throw", async () => {
  const boom = (async () => { throw new Error("network"); }) as unknown as typeof fetch;
  assert.equal(await fetchGiftAvailable(O, "offer-a", { fetchImpl: boom }), false);
  const badJson = (async () => new Response("not json", { status: 200 })) as unknown as typeof fetch;
  assert.equal(await fetchGiftAvailable(O, "offer-a", { fetchImpl: badJson }), false);
  assert.equal(await fetchGiftAvailable("", "offer-a", { fetchImpl: boom }), false);
});

test("fetch: times out and does not call with invalid input", async () => {
  const hang = ((_u: string, init: RequestInit) =>
    new Promise((_r, rej) => init.signal!.addEventListener("abort", () => rej(new Error("aborted"))))) as unknown as typeof fetch;
  assert.equal(await fetchGiftAvailable(O, "offer-a", { fetchImpl: hang, timeoutMs: 20 }), false);
  let called = false;
  const spy = (async () => { called = true; return new Response("{}"); }) as unknown as typeof fetch;
  await fetchGiftAvailable("http://insecure.test", "offer-a", { fetchImpl: spy });
  await fetchGiftAvailable(O, "a/b", { fetchImpl: spy });
  assert.equal(called, false);
});

test("fetch: requests the availability URL", async () => {
  let seen = "";
  const f = (async (u: string) => { seen = u; return new Response(JSON.stringify({ available: true })); }) as unknown as typeof fetch;
  await fetchGiftAvailable(O, "offer-a", { fetchImpl: f });
  assert.equal(seen, `${O}/api/gift/available?offer=offer-a`);
});
