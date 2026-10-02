import { test } from "node:test";
import assert from "node:assert/strict";
import {
  checkBuyerDeliverability,
  classifySuppression,
  clearComplaintSuppressionOnConsent,
  clearSelfRequestedSoftFailSuppression,
  deliverabilityState,
  isSoftFailSuppression,
  listEmailitSuppressions,
  sanitizeSuppressionNextUrl,
} from "./emailit";

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

test("list walk strips Emailit's broken sort=[object Object] from next_page_url", async () => {
  const seen: string[] = [];
  stubFetch((url) => {
    seen.push(url);
    return seen.length === 1
      ? json({ data: [{ id: "a", email: "a@b.com" }], next_page_url: "/v2/suppressions?sort=%5Bobject+Object%5D&limit=100&page=2" })
      : json({ data: [{ id: "b", email: "c@d.com" }], next_page_url: null });
  });
  try {
    const r = await listEmailitSuppressions("k");
    assert.equal(r.complete, true);
    const u = new URL(seen[1]);
    assert.equal(u.searchParams.get("sort"), null);
    assert.equal(u.searchParams.get("page"), "2");
    assert.equal(u.searchParams.get("limit"), "100");
  } finally {
    restore();
  }
});

test("sanitizeSuppressionNextUrl keeps a valid sort field", () => {
  assert.equal(sanitizeSuppressionNextUrl("/v2/suppressions?sort=created_at&page=3"), "/v2/suppressions?sort=created_at&page=3");
});

// ---------------------------------------------------------------------------
// The buyer's own address: classification, the success-page check, and the
// one-click complaint opt-in. The harm here is clearing something that must
// stay (a hard bounce), clearing without the click, or touching marketing.
// ---------------------------------------------------------------------------

const complaintRec = { id: "sup_c", email: "a@b.com", type: "complaint", reason: "recipient marked as spam" };
const hardRec = { id: "sup_h", email: "a@b.com", type: "recipient", reason: "too many hard fails" };
const softRec = { id: "sup_s", email: "a@b.com", type: "recipient", reason: "too many soft fails" };

test("classifySuppression separates soft, hard, complaint, unsubscribe and unknown", () => {
  assert.equal(classifySuppression(softRec), "soft");
  assert.equal(classifySuppression(hardRec), "hard");
  assert.equal(classifySuppression({ type: "recipient", reason: "too many bounces" }), "hard");
  assert.equal(classifySuppression(complaintRec), "complaint");
  assert.equal(classifySuppression({ type: "complaint", reason: "too many soft fails" }), "complaint");
  assert.equal(classifySuppression({ type: "unsubscribe", reason: "" }), "unsubscribe");
  assert.equal(classifySuppression({ type: "manual", reason: "added by hand" }), "unknown");
  assert.equal(classifySuppression({ type: "recipient", reason: "something new" }), "unknown");
  assert.equal(classifySuppression(null), "unknown");
});

test("deliverabilityState: the banner state for each record, and marketing can only add a bounce warning", () => {
  assert.equal(deliverabilityState(null).state, "ok");
  assert.equal(deliverabilityState(softRec).state, "ok");
  assert.equal(deliverabilityState(hardRec).state, "hard_bounce");
  assert.equal(deliverabilityState(complaintRec).state, "complaint");
  assert.equal(deliverabilityState({ type: "unsubscribe", reason: "" }).state, "unknown");
  assert.equal(deliverabilityState(null, ["bounce"]).state, "hard_bounce");
  // A marketing-side 'spam' alone never offers the complaint opt-in: only the provider's own block stops a receipt.
  assert.equal(deliverabilityState(null, ["spam"]).state, "ok");
  assert.equal(deliverabilityState(null, ["unsubscribe", "soft_bounce"]).state, "ok");
  // The provider's record wins over marketing's.
  assert.equal(deliverabilityState(softRec, ["bounce"]).state, "ok");
});

test("checkBuyerDeliverability: looks up only the one address, and fails soft", async () => {
  const urls: string[] = [];
  stubFetch((u) => {
    urls.push(u);
    return json(complaintRec);
  });
  try {
    assert.equal((await checkBuyerDeliverability({ apiKey: "k", email: "A@B.com" })).state, "complaint");
    assert.deepEqual(urls.map((u) => new URL(u).pathname), ["/v2/suppressions/a%40b.com"]);
    stubFetch(() => json({ error: "nf" }, 404));
    assert.equal((await checkBuyerDeliverability({ apiKey: "k", email: "a@b.com" })).state, "ok");
    stubFetch(() => json({ error: "boom" }, 500));
    assert.equal((await checkBuyerDeliverability({ apiKey: "k", email: "a@b.com" })).state, "unknown");
    stubFetch(() => {
      throw new Error("network down");
    });
    assert.equal((await checkBuyerDeliverability({ apiKey: "k", email: "a@b.com" })).state, "unknown");
    assert.equal((await checkBuyerDeliverability({ apiKey: "k", email: "not-an-email" })).state, "unknown");
  } finally {
    restore();
  }
});

test("checkBuyerDeliverability: marketing reasons may be a promise, awaited alongside the lookup; a rejecting promise is ignored", async () => {
  stubFetch(() => json({ error: "nf" }, 404));
  try {
    assert.equal((await checkBuyerDeliverability({ apiKey: "k", email: "a@b.com", bartmailReasons: Promise.resolve(["bounce"]) })).state, "hard_bounce");
    assert.equal((await checkBuyerDeliverability({ apiKey: "k", email: "a@b.com", bartmailReasons: Promise.reject(new Error("x")) })).state, "ok");
  } finally {
    restore();
  }
});

test("checkBuyerDeliverability: a lookup slower than the budget is unknown, not a hang", async () => {
  globalThis.fetch = ((_u: string | URL, init: RequestInit) =>
    new Promise((_res, rej) => {
      init.signal?.addEventListener("abort", () => rej(new Error("aborted")));
    })) as typeof fetch;
  // AbortSignal.timeout's timer is unref'd, and this fake fetch holds no handle of its own, so on Node 22 the loop
  // empties before the abort fires and node:test cancels the file. A real server always has live handles.
  const keepAlive = setInterval(() => {}, 1000);
  try {
    const t0 = Date.now();
    const r = await checkBuyerDeliverability({ apiKey: "k", email: "a@b.com", timeoutMs: 30 });
    assert.equal(r.state, "unknown");
    assert.ok(Date.now() - t0 < 1000);
  } finally {
    clearInterval(keepAlive);
    restore();
  }
});

test("complaint opt-in: deletes the complaint record, audited with the order, re-checked", async () => {
  const store = fakeStore();
  let deleted = false;
  const seen: string[] = [];
  stubFetch((url, init) => {
    seen.push(`${init.method ?? "GET"} ${new URL(url).pathname}`);
    if (init.method === "DELETE") {
      deleted = true;
      return json({}, 200);
    }
    return deleted ? json({ error: "nf" }, 404) : json(complaintRec);
  });
  try {
    const r = await clearComplaintSuppressionOnConsent({ apiKey: "k", email: "a@b.com", source: "checkout:success-optin", orderRef: "ord_123", explicitBuyerConsent: true, ip: "1.2.3.4", store });
    assert.equal(r.action, "cleared");
    assert.ok(seen.includes("DELETE /v2/suppressions/sup_c"));
    assert.equal(store.calls[0].fn, "claim_suppression_clear");
    assert.equal(store.calls[0].args.p_source, "checkout:success-optin:order:ord_123");
    assert.equal(store.calls[1].args.p_outcome, "cleared");
  } finally {
    restore();
  }
});

test("complaint opt-in: refused without the explicit flag or without an order, and never touches the provider", async () => {
  const store = fakeStore();
  let calls = 0;
  stubFetch(() => {
    calls++;
    return json(complaintRec);
  });
  try {
    const noFlag = await clearComplaintSuppressionOnConsent({ apiKey: "k", email: "a@b.com", source: "t", orderRef: "o1", store } as never);
    assert.equal(noFlag.action, "error");
    const noOrder = await clearComplaintSuppressionOnConsent({ apiKey: "k", email: "a@b.com", source: "t", orderRef: " ", explicitBuyerConsent: true, store });
    assert.equal(noOrder.action, "error");
    assert.equal(calls, 0);
    assert.equal(store.calls.length, 0);
  } finally {
    restore();
  }
});

test("complaint opt-in: a hard bounce, an unsubscribe and an unknown record are never deleted", async () => {
  for (const rec of [hardRec, { id: "sup_u", email: "a@b.com", type: "unsubscribe", reason: "" }, { id: "sup_x", email: "a@b.com", type: "manual", reason: "x" }, softRec]) {
    const store = fakeStore();
    const methods: string[] = [];
    stubFetch((_u, init) => {
      methods.push(init.method ?? "GET");
      return json(rec);
    });
    try {
      const r = await clearComplaintSuppressionOnConsent({ apiKey: "k", email: "a@b.com", source: "t", orderRef: "o1", explicitBuyerConsent: true, store });
      assert.equal(r.action, "kept", rec.reason);
      assert.ok(!methods.includes("DELETE"));
      assert.equal(store.calls.length, 0);
    } finally {
      restore();
    }
  }
});

test("complaint opt-in: a hard record under the complaint is left in place", async () => {
  const store = fakeStore();
  let deleted = 0;
  stubFetch((_u, init) => {
    if (init.method === "DELETE") {
      deleted++;
      return json({}, 200);
    }
    return deleted === 0 ? json(complaintRec) : json(hardRec);
  });
  try {
    const r = await clearComplaintSuppressionOnConsent({ apiKey: "k", email: "a@b.com", source: "t", orderRef: "o1", explicitBuyerConsent: true, store });
    assert.equal(r.action, "kept");
    assert.equal(deleted, 1);
    assert.equal(store.calls[1].args.p_outcome, "kept");
  } finally {
    restore();
  }
});

test("complaint opt-in: no audit store, or a throttled claim, deletes nothing", async () => {
  for (const store of [null, fakeStore({ allowed: false, why: "address_limit" })]) {
    const methods: string[] = [];
    stubFetch((_u, init) => {
      methods.push(init.method ?? "GET");
      return json(complaintRec);
    });
    try {
      const r = await clearComplaintSuppressionOnConsent({ apiKey: "k", email: "a@b.com", source: "t", orderRef: "o1", explicitBuyerConsent: true, store });
      assert.ok(r.action === "error" || r.action === "throttled");
      assert.ok(!methods.includes("DELETE"));
    } finally {
      restore();
    }
  }
});

test("the original soft-fail clear still refuses to delete a complaint (allowKinds default is soft only)", async () => {
  const store = fakeStore();
  const methods: string[] = [];
  stubFetch((_u, init) => {
    methods.push(init.method ?? "GET");
    return json(complaintRec);
  });
  try {
    const r = await clearSelfRequestedSoftFailSuppression({ apiKey: "k", email: "a@b.com", source: "t", store });
    assert.equal(r.action, "kept");
    assert.ok(!methods.includes("DELETE"));
  } finally {
    restore();
  }
});
