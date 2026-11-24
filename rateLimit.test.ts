import { test } from "node:test";
import assert from "node:assert/strict";
import { createMemoryWindow, createRateLimiter, type RpcFn } from "./rateLimit";

function clock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}

test("sliding window: allows up to max, refuses the next, recovers as hits age out", () => {
  const c = clock();
  const w = createMemoryWindow({ now: c.now });
  for (let i = 0; i < 3; i++) assert.equal(w.hit("k", 3, 60), true);
  assert.equal(w.hit("k", 3, 60), false);
  c.advance(59_000);
  assert.equal(w.hit("k", 3, 60), false);
  c.advance(1_001);
  assert.equal(w.hit("k", 3, 60), true);
});

test("sliding window: a burst straddling a fixed-window boundary is NOT doubled", () => {
  const c = clock();
  const w = createMemoryWindow({ now: c.now });
  for (let i = 0; i < 5; i++) assert.equal(w.hit("k", 5, 60), true);
  c.advance(59_000); // a fixed window rolling at 60s would allow 5 more here
  assert.equal(w.hit("k", 5, 60), false);
});

test("sliding window: refused hits are not recorded (no permanent lockout)", () => {
  const c = clock();
  const w = createMemoryWindow({ now: c.now });
  w.hit("k", 1, 60);
  for (let i = 0; i < 50; i++) assert.equal(w.hit("k", 1, 60), false);
  c.advance(60_001);
  assert.equal(w.hit("k", 1, 60), true);
});

test("memory is pruned: idle keys are dropped", () => {
  const c = clock();
  const w = createMemoryWindow({ now: c.now });
  for (let i = 0; i < 100; i++) w.hit(`ip${i}`, 5, 60);
  assert.equal(w.size(), 100);
  c.advance(120_000);
  w.hit("fresh", 5, 60);
  assert.equal(w.size(), 1);
});

test("memory is capped: maxKeys evicts the oldest", () => {
  const c = clock();
  const w = createMemoryWindow({ maxKeys: 10, now: c.now });
  for (let i = 0; i < 50; i++) {
    c.advance(1);
    w.hit(`ip${i}`, 5, 60);
  }
  assert.equal(w.size(), 10);
});

test("rpc: its verdict is authoritative once the memory window allows", async () => {
  const calls: unknown[] = [];
  const rpc: RpcFn = async (fn, args) => {
    calls.push([fn, args]);
    return { data: false, error: null };
  };
  const l = createRateLimiter({ rpc, bucketPrefix: "site:" });
  assert.equal(await l.check("1.2.3.4:/api/optin", 10, 60), false);
  assert.deepEqual(calls[0], ["hit_rate_limit", { p_bucket: "site:1.2.3.4:/api/optin", p_max: 10, p_window_secs: 60 }]);
});

test("rpc: true allows", async () => {
  const l = createRateLimiter({ rpc: async () => ({ data: true, error: null }) });
  assert.equal(await l.check("k", 10, 60), true);
});

test("memory window sheds a flood before any rpc call is made", async () => {
  let n = 0;
  const l = createRateLimiter({ rpc: async () => (n++, { data: true, error: null }) });
  for (let i = 0; i < 3; i++) await l.check("k", 3, 60);
  assert.equal(await l.check("k", 3, 60), false);
  assert.equal(n, 3);
});

const failing: Array<[string, RpcFn]> = [
  ["error object", async () => ({ data: null, error: { message: "boom" } })],
  ["throw", async () => { throw new Error("network"); }],
  ["non-boolean data", async () => ({ data: "yes", error: null })],
  ["null data", async () => ({ data: null, error: null })],
];

for (const [name, rpc] of failing) {
  test(`failure (${name}): default "memory" mode allows within the in-memory cap and reports`, async () => {
    const errs: unknown[] = [];
    const l = createRateLimiter({ rpc, onError: (e) => errs.push(e) });
    assert.equal(await l.check("k", 2, 60), true);
    assert.equal(await l.check("k", 2, 60), true);
    assert.equal(await l.check("k", 2, 60), false, "the in-memory cap still applies during an outage");
    assert.equal(errs.length, 2);
  });
  test(`failure (${name}): "allow" never blocks, "deny" always blocks`, async () => {
    assert.equal(await createRateLimiter({ rpc, onRpcFailure: "allow" }).check("k", 5, 60), true);
    assert.equal(await createRateLimiter({ rpc, onRpcFailure: "deny" }).check("k", 5, 60), false);
  });
}

test("failure: a hung rpc times out and follows the failure mode", async () => {
  const hang: RpcFn = () => new Promise(() => {});
  const l = createRateLimiter({ rpc: hang, rpcTimeoutMs: 20, onRpcFailure: "deny" });
  assert.equal(await l.check("k", 5, 60), false);
  const l2 = createRateLimiter({ rpc: hang, rpcTimeoutMs: 20 });
  assert.equal(await l2.check("k", 5, 60), true);
});

test("a throwing onError never changes the decision", async () => {
  const l = createRateLimiter({
    rpc: async () => { throw new Error("x"); },
    onError: () => { throw new Error("reporter down"); },
    onRpcFailure: "deny",
  });
  assert.equal(await l.check("k", 5, 60), false);
});

test("no rpc configured: pure in-memory limiter", async () => {
  const l = createRateLimiter();
  assert.equal(await l.check("k", 1, 60), true);
  assert.equal(await l.check("k", 1, 60), false);
});
