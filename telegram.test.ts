import { test } from "node:test";
import assert from "node:assert/strict";
import { sendTelegramAlert } from "./telegram";

// ---------------------------------------------------------------------------
// These tests exist because every failure mode of this module is SILENT.
//
// Telegram answers 200 with {ok:false} for some errors and 404 for a revoked
// token — both resolve the fetch promise perfectly happily. A caller that only
// checked for a thrown exception would treat either as delivered, on the channel
// whose entire purpose is to be heard when the primary one is not.
//
// The over-length case is the same shape: Telegram rejects a message over 4096
// characters outright rather than truncating it, so the longest and most
// detailed alerts — the ones most worth reading — would be the ones that
// vanished.
// ---------------------------------------------------------------------------

const realFetch = globalThis.fetch;
function stubFetch(impl: (url: string, init: RequestInit) => Promise<Response> | Response) {
  globalThis.fetch = ((url: string, init: RequestInit) => Promise.resolve(impl(url, init))) as typeof fetch;
}
function restore() {
  globalThis.fetch = realFetch;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

test("missing token or chat id is a returned answer, not a throw", async () => {
  for (const [t, c] of [[undefined, "1"], ["t", undefined], [undefined, undefined], ["", ""]] as const) {
    const r = await sendTelegramAlert(t, c, "hi");
    assert.equal(r.ok, false);
    assert.match(r.reason, /not configured/);
  }
});

test("a successful send reports ok", async () => {
  stubFetch(() => json({ ok: true, result: {} }));
  try {
    const r = await sendTelegramAlert("token", "chat", "hello");
    assert.equal(r.ok, true);
    assert.equal(r.reason, "");
  } finally { restore(); }
});

test("HTTP 200 with {ok:false} is NOT treated as delivered", async () => {
  stubFetch(() => json({ ok: false, description: "chat not found" }));
  try {
    const r = await sendTelegramAlert("token", "chat", "hello");
    assert.equal(r.ok, false, "a 200 body saying ok:false must not read as sent");
    assert.match(r.reason, /chat not found/);
  } finally { restore(); }
});

test("a revoked token (404) is NOT treated as delivered", async () => {
  stubFetch(() => json({ ok: false, description: "Not Found" }, 404));
  try {
    const r = await sendTelegramAlert("token", "chat", "hello");
    assert.equal(r.ok, false);
    assert.match(r.reason, /404/);
  } finally { restore(); }
});

test("an over-long message is truncated rather than rejected wholesale", async () => {
  let sent = "";
  stubFetch((_url, init) => {
    sent = JSON.parse(String(init.body)).text;
    return json({ ok: true });
  });
  try {
    const r = await sendTelegramAlert("token", "chat", "x".repeat(9000));
    assert.equal(r.ok, true);
    assert.ok(sent.length < 4096, `must fit Telegram's cap, got ${sent.length}`);
    assert.match(sent, /truncated/, "must say it was cut, so the reader knows to check the email");
  } finally { restore(); }
});

test("a message under the cap is sent unmodified", async () => {
  let sent = "";
  stubFetch((_url, init) => { sent = JSON.parse(String(init.body)).text; return json({ ok: true }); });
  try {
    await sendTelegramAlert("token", "chat", "short message");
    assert.equal(sent, "short message");
  } finally { restore(); }
});

test("no parse mode is set — an alert body must never fail to send on a stray character", async () => {
  let body: Record<string, unknown> = {};
  stubFetch((_url, init) => { body = JSON.parse(String(init.body)); return json({ ok: true }); });
  try {
    await sendTelegramAlert("token", "chat", "error in some_file.ts: *unbalanced");
    assert.equal(body.parse_mode, undefined);
  } finally { restore(); }
});

test("a thrown network error is caught and reported", async () => {
  stubFetch(() => { throw new Error("ECONNRESET"); });
  try {
    const r = await sendTelegramAlert("token", "chat", "hello");
    assert.equal(r.ok, false);
    assert.match(r.reason, /ECONNRESET/);
  } finally { restore(); }
});
