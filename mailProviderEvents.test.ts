import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { emitPostSubmitNoticeEvent } from "./mailProviderEvents";

// ---------------------------------------------------------------------------
// This suite runs under plain node:test — there is no `window` global here,
// so every test below that needs one fakes it minimally and deletes it
// afterwards, the same style consent.ts/adPlatforms.ts tests elsewhere in
// this repo use for browser-oriented, SSR-safe modules.
// ---------------------------------------------------------------------------

test("no-ops without window (node environment) — never throws", () => {
  assert.equal(typeof (globalThis as { window?: unknown }).window, "undefined");
  assert.doesNotThrow(() => {
    emitPostSubmitNoticeEvent("view", { provider: "gmail", mode: "asset" });
  });
});

test("calls a stubbed gtag with the right event name and params on view", () => {
  const calls: unknown[][] = [];
  const fakeWindow = {
    gtag: (...args: unknown[]) => {
      calls.push(args);
    },
    dispatchEvent: () => true,
  };
  (globalThis as { window?: unknown }).window = fakeWindow;
  try {
    emitPostSubmitNoticeEvent("view", { provider: "gmail", mode: "confirm", brand: "acme" });
    assert.equal(calls.length, 1);
    const [eventName, eventKind, params] = calls[0] as [string, string, Record<string, unknown>];
    assert.equal(eventName, "event");
    assert.equal(eventKind, "post_submit_notice_view");
    assert.equal(params.mail_provider, "gmail");
    assert.equal(params.notice_mode, "confirm");
    assert.equal(params.brand, "acme");
  } finally {
    delete (globalThis as { window?: unknown }).window;
  }
});

test("calls gtag with the resend event name and no brand key when brand is omitted", () => {
  const calls: unknown[][] = [];
  const fakeWindow = {
    gtag: (...args: unknown[]) => {
      calls.push(args);
    },
    dispatchEvent: () => true,
  };
  (globalThis as { window?: unknown }).window = fakeWindow;
  try {
    emitPostSubmitNoticeEvent("resend", { provider: "outlook", mode: "later" });
    assert.equal(calls.length, 1);
    const [, eventKind, params] = calls[0] as [string, string, Record<string, unknown>];
    assert.equal(eventKind, "post_submit_notice_resend");
    assert.equal(params.mail_provider, "outlook");
    assert.equal(params.notice_mode, "later");
    assert.equal("brand" in params, false, "brand key must not be present when not supplied");
  } finally {
    delete (globalThis as { window?: unknown }).window;
  }
});

test("does not call gtag when window.gtag is not a function", () => {
  let dispatched = false;
  const fakeWindow = {
    gtag: "not-a-function",
    dispatchEvent: () => {
      dispatched = true;
      return true;
    },
  };
  (globalThis as { window?: unknown }).window = fakeWindow;
  try {
    assert.doesNotThrow(() => {
      emitPostSubmitNoticeEvent("view", { provider: "unknown", mode: "asset" });
    });
    assert.equal(dispatched, true, "the CustomEvent dispatch must still happen without gtag");
  } finally {
    delete (globalThis as { window?: unknown }).window;
  }
});

test("dispatches a post-submit-notice CustomEvent on window", () => {
  let receivedDetail: unknown;
  const fakeWindow = {
    dispatchEvent: (event: { detail?: unknown }) => {
      receivedDetail = event.detail;
      return true;
    },
  };
  (globalThis as { window?: unknown }).window = fakeWindow;
  // emitPostSubmitNoticeEvent constructs `new CustomEvent(...)`, so the node
  // environment needs the CustomEvent global — Node 22 (this repo's engines
  // floor) provides it. No polyfill needed.
  try {
    emitPostSubmitNoticeEvent("view", { provider: "apple", mode: "link", brand: "example-brand" });
    assert.deepEqual(receivedDetail, {
      kind: "view",
      provider: "apple",
      mode: "link",
      brand: "example-brand",
    });
  } finally {
    delete (globalThis as { window?: unknown }).window;
  }
});

test("never throws even if gtag itself throws", () => {
  const fakeWindow = {
    gtag: () => {
      throw new Error("boom");
    },
    dispatchEvent: () => true,
  };
  (globalThis as { window?: unknown }).window = fakeWindow;
  try {
    assert.doesNotThrow(() => {
      emitPostSubmitNoticeEvent("view", { provider: "gmail", mode: "asset" });
    });
  } finally {
    delete (globalThis as { window?: unknown }).window;
  }
});

// ---------------------------------------------------------------------------
// Source-invariant test, same style as mailProviderNotice.ts's and
// mailProviderDomains.ts's own tests: this file is imported directly by
// client components, so a reintroduced `node:` import (or any dynamic
// import(...)/require(...)) is a build break waiting to happen the moment a
// browser bundler tries to resolve it.
// ---------------------------------------------------------------------------
test("mailProviderEvents.ts is browser-safe — no node imports at all", () => {
  const source = readFileSync(join(process.cwd(), "mailProviderEvents.ts"), "utf8");
  assert.doesNotMatch(source, /\bimport\s*\(/, "no dynamic import(...)");
  assert.doesNotMatch(source, /\brequire\s*\(/, "no require(...)");
  assert.doesNotMatch(source, /\bnode:/, "no node: built-in specifier");
});
