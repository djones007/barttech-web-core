import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

// pageEvents.ts imports the Next-only "server-only" marker, which is not
// installed in this source-only repo. Stub its resolution before loading.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const Module = require("node:module");
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request: string, ...rest: unknown[]) {
  if (request === "server-only") return require.resolve("./pageEvents.test");
  return origResolve.call(this, request, ...rest);
};
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { trackServerEvent } = require("./pageEvents") as typeof import("./pageEvents");

const TOKEN = "secret-token-123";
const browserHeaders = new Headers({
  "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/128.0 Safari/537.36",
  "sec-fetch-mode": "navigate",
  "sec-fetch-dest": "document",
});

const realFetch = globalThis.fetch;
const realErr = console.error;
let calls: { url: string; init: RequestInit }[] = [];

beforeEach(() => {
  calls = [];
  process.env.PAGE_EVENTS_TOKEN = TOKEN;
  console.error = () => {};
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    calls.push({ url: String(url), init });
    return new Response("ok");
  }) as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = realFetch;
  console.error = realErr;
  delete process.env.PAGE_EVENTS_URL;
  delete process.env.PAGE_EVENTS_TOKEN;
});

async function send(url: string) {
  process.env.PAGE_EVENTS_URL = url;
  await trackServerEvent({ site: "example.com", event: "landing", path: "/", headers: browserHeaders });
}

for (const bad of [
  "http://ops.example.com/api/page-events",
  "https://localhost/api/page-events",
  "https://127.0.0.1/api/page-events",
  "https://10.0.0.5/api/page-events",
  "https://169.254.169.254/latest/meta-data",
  "https://user:pw@ops.example.com/api/page-events",
  "not a url",
]) {
  test(`unsafe PAGE_EVENTS_URL is not fetched and sends no token: ${bad}`, async () => {
    await assert.doesNotReject(send(bad));
    assert.equal(calls.length, 0);
  });
}

test("a safe https URL is still fetched with the bearer token", async () => {
  await send("https://ops.example.com/api/page-events");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://ops.example.com/api/page-events");
  assert.equal((calls[0].init.headers as Record<string, string>).Authorization, `Bearer ${TOKEN}`);
});
