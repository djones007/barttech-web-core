import { test } from "node:test";
import assert from "node:assert/strict";
import { checkCronPause, cronPauseResponse } from "./cronPause";
import { writeCronHeartbeat } from "./cronHeartbeat";

// The switch must FAIL OPEN: every way of not knowing has to mean "run", and a
// paused job must heartbeat `paused` (never an error). These are the cases.

type Call = { url: string; body: unknown };

function mockFetch(rpc: () => Response | Promise<Response>): { calls: Call[]; restore: () => void } {
  const calls: Call[] = [];
  const real = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : null });
    if (url.includes("cron_control_check")) return rpc();
    return new Response(null, { status: 201 });
  }) as typeof fetch;
  return { calls, restore: () => { globalThis.fetch = real; } };
}

const base = { controlUrl: "https://example.supabase.co", controlKey: "k", jobName: "job-x" };
const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status });

test("no row = on, runs, writes nothing", async () => {
  const m = mockFetch(() => json([]));
  try {
    const d = await checkCronPause(base);
    assert.equal(d.paused, false);
    assert.equal(d.mode, "on");
    assert.equal(m.calls.length, 1);
  } finally { m.restore(); }
});

test("paused = does not run, heartbeat status is 'paused'", async () => {
  const m = mockFetch(() => json([{ mode: "paused" }]));
  try {
    const r = await cronPauseResponse(base);
    assert.ok(r);
    const hb = m.calls.find((c) => c.url.includes("cron_heartbeats"));
    assert.equal((hb?.body as { last_status: string }).last_status, "paused");
  } finally { m.restore(); }
});

test("HTTP error fails OPEN and the next heartbeat is degraded, not ok", async () => {
  const m = mockFetch(() => json({ message: "boom" }, 500));
  try {
    const d = await checkCronPause(base);
    assert.equal(d.paused, false);
    assert.ok(d.caveat);
    await writeCronHeartbeat({ url: base.controlUrl, key: "k", jobName: "job-x", status: "ok" });
    const hb = m.calls.find((c) => c.url.includes("cron_heartbeats"));
    assert.equal((hb?.body as { last_status: string }).last_status, "degraded");
  } finally { m.restore(); }
});

test("network failure fails OPEN", async () => {
  const m = mockFetch(() => { throw new Error("down"); });
  try {
    const d = await checkCronPause(base);
    assert.equal(d.paused, false);
    assert.ok(d.caveat);
  } finally { m.restore(); }
});

test("missing config fails OPEN", async () => {
  const d = await checkCronPause({ ...base, controlKey: "" });
  assert.equal(d.paused, false);
  assert.ok(d.caveat);
});

test("unknown mode and auto mode both fail OPEN", async () => {
  for (const mode of ["banana", "auto_when_ads_live"]) {
    const m = mockFetch(() => json([{ mode }]));
    try {
      const d = await checkCronPause(base);
      assert.equal(d.paused, false, mode);
      assert.ok(d.caveat, mode);
    } finally { m.restore(); }
  }
});

test("a caveat is consumed once — the following run is clean again", async () => {
  const m = mockFetch(() => json({}, 500));
  try {
    await checkCronPause({ ...base, jobName: "job-y" });
    await writeCronHeartbeat({ url: base.controlUrl, key: "k", jobName: "job-y", status: "ok" });
    await writeCronHeartbeat({ url: base.controlUrl, key: "k", jobName: "job-y", status: "ok" });
    const hbs = m.calls.filter((c) => c.url.includes("cron_heartbeats")).map((c) => (c.body as { last_status: string }).last_status);
    assert.deepEqual(hbs, ["degraded", "ok"]);
  } finally { m.restore(); }
});
