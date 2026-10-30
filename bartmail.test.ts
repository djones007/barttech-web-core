import { test } from "node:test";
import assert from "node:assert/strict";
import {
  withMailProvider,
  assertTagWrites,
  settlePartialOptin,
  isBartmailPartialOptinError,
  BartmailPartialOptinError,
  getBartmailSuppressionReasons,
  bartmailMarkRefunded,
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

// A chainable stand-in for the BartMail client: records which tables were touched and with what verb.
function fakeClient(tables: Record<string, unknown>) {
  const touched: string[] = [];
  const client = {
    from(table: string) {
      touched.push(`from:${table}`);
      const q: Record<string, unknown> = {};
      const chain = () => q;
      for (const m of ["select", "eq"]) q[m] = chain;
      q.maybeSingle = () => Promise.resolve({ data: tables[table] ?? null, error: null });
      q.then = (res: (v: unknown) => unknown) => Promise.resolve({ data: tables[table] ?? [], error: null }).then(res);
      for (const w of ["insert", "update", "upsert", "delete"]) q[w] = () => { touched.push(`WRITE:${w}:${table}`); return q; };
      return q;
    },
  };
  return { client: client as never, touched };
}

test("getBartmailSuppressionReasons: returns the reasons for the one address, reads only", async () => {
  const { client, touched } = fakeClient({ brands: { id: "b1", tenant_id: "t1" }, contacts: { id: "c1" }, contact_suppressions: [{ reason: "bounce" }, { reason: "unsubscribe" }] });
  assert.deepEqual(await getBartmailSuppressionReasons(" A@B.com ", "nutty-orange", { client }), ["bounce", "unsubscribe"]);
  assert.ok(touched.every((t) => t.startsWith("from:")), "no write verb is ever used");
});

test("getBartmailSuppressionReasons: unknown brand, unknown contact, bad input and errors are an empty list", async () => {
  assert.deepEqual(await getBartmailSuppressionReasons("a@b.com", "x", { client: fakeClient({}).client }), []);
  assert.deepEqual(await getBartmailSuppressionReasons("a@b.com", "x", { client: fakeClient({ brands: { id: "b", tenant_id: "t" } }).client }), []);
  assert.deepEqual(await getBartmailSuppressionReasons("not-an-email", "x", { client: fakeClient({}).client }), []);
  const boom = { from() { throw new Error("down"); } } as never;
  assert.deepEqual(await getBartmailSuppressionReasons("a@b.com", "x", { client: boom }), []);
});

// ---------------------------------------------------------------------------
// bartmailEvent: occurredAt / dedupeKey / source, and reading the reply.
// ---------------------------------------------------------------------------
import {
  buildBartmailEventBody,
  readBartmailEventReply,
  bartmailEvent,
  bartmailEventResult,
  BARTMAIL_EVENT_TYPES,
} from "./bartmail";

test("event body: occurredAt, dedupeKey and source are sent in the receiver's field names", () => {
  const r = buildBartmailEventBody(
    {
      email: "  Person@Example.COM ",
      brand: "acme",
      event_type: "game_finished",
      occurredAt: new Date("2026-10-01T12:00:00Z"),
      dedupeKey: "games:party_finished:11111111-1111-1111-1111-111111111111:22222222-2222-2222-2222-222222222222",
      source: "games",
      metadata: { mode: "solo", hints_used: 0, empty: "", nothing: null },
    },
    "evt-1",
  );
  assert.ok("body" in r);
  if (!("body" in r)) return;
  assert.equal(r.body.email, "person@example.com");
  assert.equal(r.body.occurred_at, "2026-10-01T12:00:00.000Z");
  assert.equal(r.body.dedupe_key, "games:party_finished:11111111-1111-1111-1111-111111111111:22222222-2222-2222-2222-222222222222");
  assert.equal(r.body.source, "games");
  assert.equal(r.body.event_id, "evt-1");
  // zero is kept, empty string and null are dropped
  assert.deepEqual(r.body.metadata, { mode: "solo", hints_used: 0 });
});

test("event body: the new fields are optional, so an old caller sends exactly what it sent before", () => {
  const r = buildBartmailEventBody({ email: "a@b.co", brand: "acme", event_type: "note" }, "evt-2");
  assert.ok("body" in r);
  if (!("body" in r)) return;
  assert.deepEqual(Object.keys(r.body).sort(), ["brand", "email", "event_id", "event_type", "metadata"]);
});

test("event body: an invalid occurredAt is dropped, never sent as 'Invalid Date'", () => {
  const r = buildBartmailEventBody({ email: "a@b.co", brand: "acme", event_type: "note", occurredAt: "not a date" }, "e");
  assert.ok("body" in r && !("occurred_at" in r.body));
});

test("event body: a bad dedupeKey or source is refused, not silently stripped", () => {
  assert.ok("error" in buildBartmailEventBody({ email: "a@b.co", brand: "acme", event_type: "note", dedupeKey: "has spaces" }, "e"));
  assert.ok("error" in buildBartmailEventBody({ email: "a@b.co", brand: "acme", event_type: "note", dedupeKey: "x".repeat(201) }, "e"));
  assert.ok("error" in buildBartmailEventBody({ email: "a@b.co", brand: "acme", event_type: "note", source: "Games!" }, "e"));
  assert.ok("error" in buildBartmailEventBody({ email: "", brand: "acme", event_type: "note" }, "e"));
});

test("reply: duplicate is ok (the event is recorded), skipped carries the reason", () => {
  assert.deepEqual(readBartmailEventReply(200, { ok: true, duplicate: true }), { ok: true, duplicate: true, skipped: null, status: 200, error: null });
  assert.deepEqual(readBartmailEventReply(200, { ok: true, skipped: "contact_not_found" }), { ok: true, duplicate: false, skipped: "contact_not_found", status: 200, error: null });
  const bad = readBartmailEventReply(400, { error: "Unknown event_type" });
  assert.equal(bad.ok, false);
  assert.equal(bad.error, "400 Unknown event_type");
});

test("bartmailEvent: a network failure returns false and never throws", async () => {
  const prevSecret = process.env.CONTACT_EVENTS_SECRET;
  const prevFetch = globalThis.fetch;
  process.env.CONTACT_EVENTS_SECRET = "test-secret";
  globalThis.fetch = (async () => {
    throw new Error("ECONNRESET");
  }) as typeof fetch;
  try {
    assert.equal(await bartmailEvent({ email: "a@b.co", brand: "acme", event_type: "note" }), false);
    const r = await bartmailEventResult({ email: "a@b.co", brand: "acme", event_type: "note" });
    assert.equal(r.ok, false);
    assert.equal(r.status, 0);
    assert.match(r.error ?? "", /ECONNRESET/);
  } finally {
    globalThis.fetch = prevFetch;
    if (prevSecret === undefined) delete process.env.CONTACT_EVENTS_SECRET;
    else process.env.CONTACT_EVENTS_SECRET = prevSecret;
  }
});

test("bartmailEvent: a duplicate reply is true; the request is signed both ways and carries the dedupe key", async () => {
  const prevSecret = process.env.CONTACT_EVENTS_SECRET;
  const prevFetch = globalThis.fetch;
  process.env.CONTACT_EVENTS_SECRET = "test-secret";
  let seen: { headers: Record<string, string>; body: string } | null = null;
  globalThis.fetch = (async (_url: unknown, init?: { headers?: Record<string, string>; body?: string }) => {
    seen = { headers: init?.headers ?? {}, body: String(init?.body) };
    return new Response(JSON.stringify({ ok: true, duplicate: true }), { status: 200 });
  }) as typeof fetch;
  try {
    assert.equal(await bartmailEvent({ email: "a@b.co", brand: "acme", event_type: "game_started", dedupeKey: "games:x:1", source: "games" }), true);
    assert.ok(seen);
    const s = seen as unknown as { headers: Record<string, string>; body: string };
    assert.match(s.headers["x-bartmail-signature"], /^sha256=[0-9a-f]{64}$/);
    assert.ok(Object.keys(s.headers).some((h) => h.startsWith("x-signed-")));
    assert.equal(JSON.parse(s.body).dedupe_key, "games:x:1");
  } finally {
    globalThis.fetch = prevFetch;
    if (prevSecret === undefined) delete process.env.CONTACT_EVENTS_SECRET;
    else process.env.CONTACT_EVENTS_SECRET = prevSecret;
  }
});

test("bartmailEvent: no secret is false, not a throw", async () => {
  const prev = process.env.CONTACT_EVENTS_SECRET;
  delete process.env.CONTACT_EVENTS_SECRET;
  try {
    assert.equal(await bartmailEvent({ email: "a@b.co", brand: "acme", event_type: "note" }), false);
  } finally {
    if (prev !== undefined) process.env.CONTACT_EVENTS_SECRET = prev;
  }
});

test("event types: unique, lower-case slugs", () => {
  assert.equal(new Set(BARTMAIL_EVENT_TYPES).size, BARTMAIL_EVENT_TYPES.length);
  for (const t of BARTMAIL_EVENT_TYPES) assert.match(t, /^[a-z][a-z0-9_]{1,62}$/);
});

function fakePurchases(result: { data: { id: string }[] | null; error: { message: string } | null }) {
  const calls: unknown[][] = [];
  const chain = {
    update: (v: unknown) => (calls.push(["update", v]), chain),
    eq: (k: string, v: unknown) => (calls.push(["eq", k, v]), chain),
    is: (k: string, v: unknown) => (calls.push(["is", k, v]), chain),
    select: () => Promise.resolve(result),
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { calls, db: { from: () => chain } as any };
}

test("bartmailMarkRefunded stamps only an unstamped row for that payment", async () => {
  const f = fakePurchases({ data: [{ id: "p1" }], error: null });
  const r = await bartmailMarkRefunded("pi_1", { at: "2026-10-30T00:00:00Z", db: f.db });
  assert.deepEqual(r, { ok: true, updated: 1 });
  assert.deepEqual(f.calls, [["update", { refunded_at: "2026-10-30T00:00:00Z" }], ["eq", "stripe_session_id", "pi_1"], ["is", "refunded_at", null]]);
});

test("bartmailMarkRefunded: no matching row is a normal answer", async () => {
  assert.deepEqual(await bartmailMarkRefunded("pi_2", { db: fakePurchases({ data: [], error: null }).db }), { ok: true, updated: 0 });
});

test("bartmailMarkRefunded reports a database error", async () => {
  assert.deepEqual(await bartmailMarkRefunded("pi_3", { db: fakePurchases({ data: null, error: { message: "boom" } }).db }), { ok: false, updated: 0, error: "boom" });
});
