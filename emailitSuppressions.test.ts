import { test } from "node:test";
import assert from "node:assert/strict";
import { clearSelfRequestedSoftFailSuppression, isSoftFailSuppression, listEmailitSuppressions } from "./emailit";

// ---------------------------------------------------------------------------
// The harm this module can do is clearing the WRONG suppression — a hard
// bounce, a complaint, an unsubscribe — so most of these tests pin what is
// left alone, and that nothing is cleared without an audit row.
// ---------------------------------------------------------------------------

const realFetch = globalThis.fetch;
type Handler = (url: string, init: RequestInit) => Response;
function stubFetch(impl: Handler) {
  globalThis.fetch = ((url: string | URL, init: RequestInit) =>
    Promise.resolve(impl(String(url), init ?? {}))) as typeof fetch;
}
function restore() {
  globalThis.fetch = realFetch;
}
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

function fakeStore(claim: { allowed: boolean; why?: string } = { allowed: true }) {
  const calls: { fn: string; args: Record<string, unknown> }[] = [];
  return {
    calls,
    rpc(fn: string, args: Record<string, unknown>) {
      calls.push({ fn, args });
      if (fn === "claim_suppression_clear") return Promise.resolve({ data: { ...claim, id: "audit-1" }, error: null });
      return Promise.resolve({ data: null, error: null });
    },
  };
}

test("only a soft-fail reason is soft", () => {
  assert.equal(isSoftFailSuppression({ type: "recipient", reason: "too many soft fails" }), true);
  assert.equal(isSoftFailSuppression({ type: "recipient", reason: "too many hard fails" }), false);
  assert.equal(isSoftFailSuppression({ type: "recipient", reason: "too many bounces" }), false);
  assert.equal(isSoftFailSuppression({ type: "complaint", reason: "too many soft fails" }), false);
  assert.equal(isSoftFailSuppression({ type: "unsubscribe", reason: "soft fail" }), false);
  assert.equal(isSoftFailSuppression({ type: "recipient", reason: "" }), false);
  assert.equal(isSoftFailSuppression({ type: "recipient", reason: "something new" }), false);
  assert.equal(isSoftFailSuppression(null), false);
});

test("no suppression: nothing claimed, nothing deleted", async () => {
  const store = fakeStore();
  const methods: string[] = [];
  stubFetch((_u, init) => {
    methods.push(init.method ?? "GET");
    return json({ error: "Suppression not found" }, 404);
  });
  try {
    const r = await clearSelfRequestedSoftFailSuppression({ apiKey: "k", email: "a@b.com", source: "t", store });
    assert.equal(r.action, "none");
    assert.deepEqual(methods, ["GET"]);
    assert.equal(store.calls.length, 0);
  } finally {
    restore();
  }
});

test("hard fail is kept and never deleted", async () => {
  const store = fakeStore();
  const methods: string[] = [];
  stubFetch((_u, init) => {
    methods.push(init.method ?? "GET");
    return json({ id: "sup_1", email: "a@b.com", type: "recipient", reason: "too many hard fails" });
  });
  try {
    const r = await clearSelfRequestedSoftFailSuppression({ apiKey: "k", email: "a@b.com", source: "t", store });
    assert.equal(r.action, "kept");
    assert.ok(!methods.includes("DELETE"));
    assert.equal(store.calls.length, 0);
  } finally {
    restore();
  }
});

test("soft fail is claimed, deleted, re-checked and audited as cleared", async () => {
  const store = fakeStore();
  let deleted = false;
  const seen: string[] = [];
  stubFetch((url, init) => {
    seen.push(`${init.method ?? "GET"} ${new URL(url).pathname}`);
    if (init.method === "DELETE") {
      deleted = true;
      return json({}, 200);
    }
    return deleted
      ? json({ error: "Suppression not found" }, 404)
      : json({ id: "sup_1", email: "a@b.com", type: "recipient", reason: "too many soft fails" });
  });
  try {
    const r = await clearSelfRequestedSoftFailSuppression({ apiKey: "k", email: " A@B.com ", source: "t", ip: "1.2.3.4", store });
    assert.equal(r.action, "cleared");
    assert.deepEqual(seen, ["GET /v2/suppressions/a%40b.com", "DELETE /v2/suppressions/sup_1", "GET /v2/suppressions/a%40b.com"]);
    assert.equal(store.calls[0].fn, "claim_suppression_clear");
    assert.equal(store.calls[0].args.p_email, "a@b.com");
    assert.equal(store.calls[0].args.p_ip, "1.2.3.4");
    assert.equal(store.calls[1].fn, "finish_suppression_clear");
    assert.equal(store.calls[1].args.p_outcome, "cleared");
  } finally {
    restore();
  }
});

test("a hard record underneath the soft one is left in place", async () => {
  const store = fakeStore();
  let deleted = 0;
  stubFetch((_u, init) => {
    if (init.method === "DELETE") {
      deleted++;
      return json({}, 200);
    }
    return deleted === 0
      ? json({ id: "sup_soft", email: "a@b.com", type: "recipient", reason: "too many soft fails" })
      : json({ id: "sup_hard", email: "a@b.com", type: "recipient", reason: "too many hard fails" });
  });
  try {
    const r = await clearSelfRequestedSoftFailSuppression({ apiKey: "k", email: "a@b.com", source: "t", store });
    assert.equal(r.action, "kept");
    assert.equal(deleted, 1);
    assert.equal(store.calls[1].args.p_outcome, "kept");
  } finally {
    restore();
  }
});

test("throttled claim deletes nothing", async () => {
  const store = fakeStore({ allowed: false, why: "address_limit" });
  const methods: string[] = [];
  stubFetch((_u, init) => {
    methods.push(init.method ?? "GET");
    return json({ id: "sup_1", email: "a@b.com", type: "recipient", reason: "too many soft fails" });
  });
  try {
    const r = await clearSelfRequestedSoftFailSuppression({ apiKey: "k", email: "a@b.com", source: "t", store });
    assert.equal(r.action, "throttled");
    assert.ok(!methods.includes("DELETE"));
  } finally {
    restore();
  }
});

test("no audit store means nothing is cleared", async () => {
  const methods: string[] = [];
  stubFetch((_u, init) => {
    methods.push(init.method ?? "GET");
    return json({ id: "sup_1", email: "a@b.com", type: "recipient", reason: "too many soft fails" });
  });
  try {
    const r = await clearSelfRequestedSoftFailSuppression({ apiKey: "k", email: "a@b.com", source: "t", store: null });
    assert.equal(r.action, "error");
    assert.ok(!methods.includes("DELETE"));
  } finally {
    restore();
  }
});

test("a failing claim RPC is fail-closed", async () => {
  const methods: string[] = [];
  stubFetch((_u, init) => {
    methods.push(init.method ?? "GET");
    return json({ id: "sup_1", email: "a@b.com", type: "recipient", reason: "too many soft fails" });
  });
  const store = { rpc: () => Promise.resolve({ data: null, error: { message: "db down" } }) };
  try {
    const r = await clearSelfRequestedSoftFailSuppression({ apiKey: "k", email: "a@b.com", source: "t", store });
    assert.equal(r.action, "error");
    assert.ok(!methods.includes("DELETE"));
  } finally {
    restore();
  }
});

test("list walk follows relative next_page_url and reports completeness", async () => {
  let page = 0;
  stubFetch((url) => {
    page++;
    const u = new URL(url);
    assert.equal(u.origin, "https://api.emailit.com");
    return page === 1
      ? json({ data: [{ id: "a", email: "a@b.com" }], next_page_url: "/v2/suppressions?page=2&limit=100" })
      : json({ data: [{ id: "b", email: "c@d.com" }], next_page_url: null });
  });
  try {
    const r = await listEmailitSuppressions("k");
    assert.equal(r.complete, true);
    assert.equal(r.records.length, 2);
    assert.equal(r.requests, 2);
  } finally {
    restore();
  }
});

test("list walk with a dead page is incomplete, not short", async () => {
  stubFetch(() => json({ error: "nope" }, 401));
  try {
    const r = await listEmailitSuppressions("k");
    assert.equal(r.ok, false);
    assert.equal(r.complete, false);
  } finally {
    restore();
  }
});
