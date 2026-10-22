import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  isCapiConfigured,
  newEventId,
  capiUserDataFromRequest,
  sendCAPIEvent,
  sendCAPIEventResult,
  sendLandingPageView,
  sendClickEvent,
} from "./metaCapi";

// metaCapi.ts carries no `import "server-only"` (golden rule 5; consumers guard in their shim), so it runs
// under node --test. fetch is replaced per test; env vars are saved and restored.

const ENV_KEYS = ["META_PIXEL_ID", "NEXT_PUBLIC_META_PIXEL_ID", "META_CAPI_TOKEN"] as const;
const savedEnv: Record<string, string | undefined> = {};
const realFetch = globalThis.fetch;
const realError = console.error;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Sent = { url: string; body: { access_token: string; test_event_code?: string; data: Array<Record<string, any>> } };
let calls: Sent[] = [];
let errors: string[] = [];

function mockFetch(res: () => Response | Promise<Response>) {
  globalThis.fetch = (async (url: unknown, init?: { body?: string }) => {
    calls.push({ url: String(url), body: JSON.parse(init?.body ?? "{}") });
    return res();
  }) as typeof fetch;
}
const ok = () => new Response(JSON.stringify({ events_received: 1, fbtrace_id: "TRACE" }), { status: 200 });

beforeEach(() => {
  for (const k of ENV_KEYS) { savedEnv[k] = process.env[k]; delete process.env[k]; }
  calls = [];
  errors = [];
  console.error = (...a: unknown[]) => { errors.push(a.join(" ")); };
  mockFetch(ok);
});
afterEach(() => {
  for (const k of ENV_KEYS) { if (savedEnv[k] === undefined) delete process.env[k]; else process.env[k] = savedEnv[k]; }
  globalThis.fetch = realFetch;
  console.error = realError;
});

const CREDS = { pixelId: "111", accessToken: "tok-secret" };
const base = { eventName: "Purchase", eventId: "evt-1", sourceUrl: "https://example.com/x" };
const HUMAN = { "user-agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Version/17.0 Mobile/15E148 Safari/604.1" };
const hdrs = (h: Record<string, string>) => ({ get: (n: string) => h[n.toLowerCase()] ?? null });

test("isCapiConfigured: env needs BOTH pixel and token; explicit creds replace env", () => {
  assert.equal(isCapiConfigured(), false);
  process.env.META_PIXEL_ID = "p";
  assert.equal(isCapiConfigured(), false);
  process.env.META_CAPI_TOKEN = "t";
  assert.equal(isCapiConfigured(), true);
  assert.equal(isCapiConfigured({ pixelId: "", accessToken: "t" }), false);
  assert.equal(isCapiConfigured(CREDS), true);
});

test("isCapiConfigured accepts the public pixel id as a fallback", () => {
  process.env.NEXT_PUBLIC_META_PIXEL_ID = "pub";
  process.env.META_CAPI_TOKEN = "t";
  assert.equal(isCapiConfigured(), true);
});

test("newEventId is unique and non-empty", () => {
  assert.notEqual(newEventId(), newEventId());
  assert.ok(newEventId().length >= 16);
});

test("not configured: no request is made", async () => {
  const r = await sendCAPIEventResult(base);
  assert.deepEqual(r, { ok: false, status: 0, error: "not configured" });
  assert.equal(calls.length, 0);
});

test("eventTime (6401fde): passed through as given, floored to an integer seconds value", async () => {
  await sendCAPIEvent({ ...base, eventTime: 1_700_000_000.9 }, CREDS);
  assert.equal(calls[0].body.data[0].event_time, 1_700_000_000);
});

test("eventTime omitted or non-finite falls back to now, and the send still happens", async () => {
  const before = Math.floor(Date.now() / 1000);
  await sendCAPIEvent(base, CREDS);
  await sendCAPIEvent({ ...base, eventTime: Number.NaN }, CREDS);
  await sendCAPIEvent({ ...base, eventTime: Infinity }, CREDS);
  assert.equal(calls.length, 3);
  for (const c of calls) {
    const t = c.body.data[0].event_time;
    assert.ok(Number.isInteger(t) && t >= before && t <= before + 5, `event_time ${t}`);
  }
});

test("payload: endpoint, event fields, custom_data, token in body, test_event_code", async () => {
  await sendCAPIEvent(
    { ...base, currency: "GBP", value: 37, orderId: "o-9", customData: { content_name: "Guide" }, testEventCode: "TEST1", fbc: "fb.1.1.abc", fbp: "fb.1.2.def", clientIp: "1.2.3.4", clientUserAgent: "UA" },
    CREDS
  );
  const c = calls[0];
  assert.equal(c.url, "https://graph.facebook.com/v21.0/111/events");
  assert.equal(c.body.access_token, "tok-secret");
  assert.equal(c.body.test_event_code, "TEST1");
  const ev = c.body.data[0];
  assert.equal(ev.event_name, "Purchase");
  assert.equal(ev.event_id, "evt-1");
  assert.equal(ev.action_source, "website");
  assert.equal(ev.event_source_url, "https://example.com/x");
  assert.deepEqual(ev.custom_data, { content_name: "Guide", currency: "GBP", value: 37, order_id: "o-9" });
  assert.equal(ev.user_data.fbc, "fb.1.1.abc");
  assert.equal(ev.user_data.fbp, "fb.1.2.def");
  assert.equal(ev.user_data.client_ip_address, "1.2.3.4");
  assert.equal(ev.user_data.client_user_agent, "UA");
});

test("no custom_data key when there is none; identity is hashed, never sent raw", async () => {
  await sendCAPIEvent({ ...base, email: "Person@Example.com" }, CREDS);
  const ev = calls[0].body.data[0];
  assert.equal("custom_data" in ev, false);
  assert.ok(!JSON.stringify(ev.user_data).includes("example.com"), "raw email must not be sent");
  assert.ok(Object.keys(ev.user_data).some((k) => k === "em"), "hashed em present");
});

test("env credentials are used when none are passed; explicit creds ignore env", async () => {
  process.env.META_PIXEL_ID = "envpix";
  process.env.META_CAPI_TOKEN = "envtok";
  await sendCAPIEvent(base);
  assert.match(calls[0].url, /\/envpix\/events$/);
  await sendCAPIEvent(base, CREDS);
  assert.match(calls[1].url, /\/111\/events$/);
  assert.equal(calls[1].body.access_token, "tok-secret");
});

test("success surfaces events_received and fbtrace_id", async () => {
  const r = await sendCAPIEventResult(base, CREDS);
  assert.deepEqual(r, { ok: true, status: 200, eventsReceived: 1, fbtraceId: "TRACE" });
});

test("a 2xx with an unreadable body is still an accepted send", async () => {
  mockFetch(() => new Response("not json", { status: 200 }));
  const r = await sendCAPIEventResult(base, CREDS);
  assert.equal(r.ok, true);
  assert.equal(r.eventsReceived, undefined);
});

test("rejection logs status + numeric code/type ONLY, never Meta's message or the token", async () => {
  mockFetch(() => new Response(JSON.stringify({ error: { code: 190, type: "OAuthException", error_subcode: 463, message: "Session for user@example.com expired", error_user_msg: "secret words" } }), { status: 400 }));
  const r = await sendCAPIEventResult(base, CREDS);
  assert.equal(r.ok, false);
  assert.equal(r.status, 400);
  assert.equal(r.error, "HTTP 400 code=190 type=OAuthException subcode=463");
  const logged = errors.join("\n");
  assert.match(logged, /code=190 type=OAuthException subcode=463/);
  assert.ok(!/user@example\.com|secret words|tok-secret|expired/.test(logged + JSON.stringify(r)), "no message, PII or token in logs/result");
});

test("an unparseable error body is reported as such, not printed", async () => {
  mockFetch(() => new Response("<html>oops user@example.com</html>", { status: 502 }));
  const r = await sendCAPIEventResult(base, CREDS);
  assert.equal(r.status, 502);
  assert.match(r.error!, /unparseable error body/);
  assert.ok(!errors.join("").includes("user@example.com"));
});

test("a network failure never throws and reports status 0", async () => {
  mockFetch(() => { throw new Error("socket hang up"); });
  const r = await sendCAPIEventResult(base, CREDS);
  assert.equal(r.ok, false);
  assert.equal(r.status, 0);
  assert.match(r.error!, /^network: socket hang up/);
  assert.equal(await sendCAPIEvent(base, CREDS), false);
});

test("capiUserDataFromRequest: first x-forwarded-for hop, UA, fbc from fbclid, cookies win", () => {
  const u = capiUserDataFromRequest(hdrs({ "x-forwarded-for": "9.9.9.9, 10.0.0.1", "user-agent": "UA/1", cookie: "_fbp=fb.1.5.zzz" }), { fbclid: "CLICK" });
  assert.equal(u.clientIp, "9.9.9.9");
  assert.equal(u.clientUserAgent, "UA/1");
  assert.equal(u.fbp, "fb.1.5.zzz");
  assert.match(u.fbc!, /^fb\.1\.\d+\.CLICK$/);
  const c = capiUserDataFromRequest(hdrs({ cookie: "_fbc=fb.1.7.fromcookie; _fbp=x" }), { fbclid: ["A", "B"] });
  assert.equal(c.fbc, "fb.1.7.fromcookie");
  assert.deepEqual(capiUserDataFromRequest(hdrs({})), { clientIp: undefined, clientUserAgent: undefined, fbc: undefined, fbp: undefined });
  assert.equal(capiUserDataFromRequest(hdrs({ "x-real-ip": "5.5.5.5" })).clientIp, "5.5.5.5");
});

test("sendLandingPageView: sends a ViewContent for a person; refuses a crawler and an unconfigured pixel", async () => {
  const sent = await sendLandingPageView({ hdrs: hdrs(HUMAN), url: "https://example.com/p", contentName: "Page", credentials: CREDS });
  assert.equal(sent, true);
  assert.equal(calls[0].body.data[0].event_name, "ViewContent");
  assert.deepEqual(calls[0].body.data[0].custom_data, { content_name: "Page", content_type: "product_group" });

  calls = [];
  assert.equal(await sendLandingPageView({ hdrs: hdrs({ "user-agent": "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)" }), url: "https://example.com/p", contentName: "Page", credentials: CREDS }), false);
  assert.equal(await sendLandingPageView({ hdrs: hdrs(HUMAN), url: "https://example.com/p", contentName: "Page" }), false);
  assert.equal(calls.length, 0, "no request for a bot or an unconfigured pixel");
});

test("sendClickEvent: a body that fails the gate is refused with a reason and nothing is sent", async () => {
  const r = await sendClickEvent({ hdrs: hdrs(HUMAN), raw: { not: "an event" }, allowedHosts: ["example.com"], credentials: CREDS });
  assert.equal(r.sent, false);
  assert.ok(r.reason);
  assert.equal(calls.length, 0);
});
