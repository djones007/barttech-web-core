import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  isMailProvider,
  detectMailProviderFromDomain,
  providerFromMxHosts,
  detectMailProvider,
  clearMailProviderCache,
  mailProviderNotice,
} from "./mailProvider";

// ---------------------------------------------------------------------------
// The MX fallback path has two silent failure modes worth guarding directly:
// a resolveMx that never resolves must not hang the caller past timeoutMs,
// and a transient error/timeout must never poison the cache for a domain
// that would resolve fine on the next try. Both are covered below alongside
// the pure functions and the notice copy.
// ---------------------------------------------------------------------------

test("domain map hits, mixed case and whitespace", () => {
  assert.equal(detectMailProviderFromDomain("Person@GMAIL.com"), "gmail");
  assert.equal(detectMailProviderFromDomain("  person@Outlook.CO.UK  "), "outlook");
  assert.equal(detectMailProviderFromDomain("person@icloud.com"), "apple");
  assert.equal(detectMailProviderFromDomain("person@sky.com"), "yahoo");
  assert.equal(detectMailProviderFromDomain("person@aol.com"), "yahoo");
});

test("malformed email is unknown", () => {
  assert.equal(detectMailProviderFromDomain("not-an-email"), "unknown");
  assert.equal(detectMailProviderFromDomain("person@"), "unknown");
  assert.equal(detectMailProviderFromDomain("@domain.com"), "unknown");
  assert.equal(detectMailProviderFromDomain("person@nodottld"), "unknown");
  assert.equal(detectMailProviderFromDomain(""), "unknown");
});

test("unmapped domain is unknown", () => {
  assert.equal(detectMailProviderFromDomain("person@some-business.example"), "unknown");
});

test("providerFromMxHosts covers each provider and falls back to unknown", () => {
  assert.equal(providerFromMxHosts(["aspmx.l.google.com"]), "gmail");
  assert.equal(providerFromMxHosts(["mail.protection.outlook.com"]), "outlook");
  assert.equal(providerFromMxHosts(["example-com.mail.protection.outlook.com."]), "outlook");
  assert.equal(providerFromMxHosts(["mx1.mail.icloud.com"]), "apple");
  assert.equal(providerFromMxHosts(["mx-eu.mail.am0.yahoodns.net"]), "yahoo");
  assert.equal(providerFromMxHosts(["mx.some-random-host.net"]), "unknown");
  assert.equal(providerFromMxHosts([]), "unknown");
});

test("detectMailProvider with injected resolveMx returning google MX resolves gmail", async () => {
  clearMailProviderCache();
  const r = await detectMailProvider("person@custom-business-domain.example", {
    resolveMx: async () => [{ exchange: "aspmx.l.google.com", priority: 10 }],
  });
  assert.equal(r, "gmail");
});

test("resolveMx that never resolves times out to unknown and does not hang", async () => {
  clearMailProviderCache();
  const start = Date.now();
  const r = await detectMailProvider("person@never-resolves.example", {
    timeoutMs: 50,
    resolveMx: () => new Promise(() => {}), // deliberately never settles
  });
  assert.equal(r, "unknown");
  assert.ok(Date.now() - start < 1000, "must not wait anywhere near the default timeout");
});

test("resolveMx that throws resolves to unknown, never throws", async () => {
  clearMailProviderCache();
  const r = await detectMailProvider("person@throws.example", {
    resolveMx: async () => {
      throw new Error("ENOTFOUND");
    },
  });
  assert.equal(r, "unknown");
});

test("a cache hit skips a second resolveMx call", async () => {
  clearMailProviderCache();
  let calls = 0;
  const opts = {
    resolveMx: async () => {
      calls++;
      return [{ exchange: "aspmx.l.google.com", priority: 10 }];
    },
  };
  const first = await detectMailProvider("person@cached-domain.example", opts);
  const second = await detectMailProvider("person@cached-domain.example", opts);
  assert.equal(first, "gmail");
  assert.equal(second, "gmail");
  assert.equal(calls, 1, "second lookup must be served from cache");
});

test("an error result is not cached — the next call tries again", async () => {
  clearMailProviderCache();
  let calls = 0;
  const opts = {
    resolveMx: async () => {
      calls++;
      throw new Error("ESERVFAIL");
    },
  };
  await detectMailProvider("person@flaky-domain.example", opts);
  await detectMailProvider("person@flaky-domain.example", opts);
  assert.equal(calls, 2, "an error must not poison the cache for a domain that might resolve next time");
});

test("a timeout is not cached — the next call tries again", async () => {
  clearMailProviderCache();
  let calls = 0;
  const opts = {
    timeoutMs: 20,
    resolveMx: () => {
      calls++;
      return new Promise<Array<{ exchange: string; priority: number }>>(() => {});
    },
  };
  await detectMailProvider("person@slow-domain.example", opts);
  await detectMailProvider("person@slow-domain.example", opts);
  assert.equal(calls, 2, "a timeout must not poison the cache for a domain that might resolve next time");
});

test("isMailProvider", () => {
  assert.equal(isMailProvider("gmail"), true);
  assert.equal(isMailProvider("outlook"), true);
  assert.equal(isMailProvider("unknown"), true);
  assert.equal(isMailProvider("hotmail"), false);
  assert.equal(isMailProvider(42), false);
  assert.equal(isMailProvider(undefined), false);
});

test("mailProviderNotice merges the sender and picks provider copy", () => {
  const r = mailProviderNotice({ provider: "gmail", sender: "hello@example.com", mode: "asset" });
  assert.equal(r.providerLabel, "Gmail");
  assert.ok(r.steps[0].includes("Promotions"));
  assert.ok(r.steps.some((s) => s.includes("hello@example.com")), "sender must be merged into the steps");
  assert.ok(!r.steps.some((s) => s.includes("{sender}")), "placeholder must not leak through unmerged");
});

test("mailProviderNotice unknown provider has no label but still has steps", () => {
  const r = mailProviderNotice({ provider: "unknown", sender: "hello@example.com", mode: "confirm" });
  assert.equal(r.providerLabel, null);
  assert.ok(r.steps.some((s) => s.includes("hello@example.com")));
});

test("mode changes the heading", () => {
  const asset = mailProviderNotice({ provider: "outlook", sender: "a@b.com", mode: "asset" });
  const link = mailProviderNotice({ provider: "outlook", sender: "a@b.com", mode: "link" });
  const confirm = mailProviderNotice({ provider: "outlook", sender: "a@b.com", mode: "confirm" });
  assert.match(asset.heading, /couple of minutes/);
  assert.match(link.heading, /your link/);
  assert.match(confirm.heading, /confirmation email/);
  assert.notEqual(asset.heading, link.heading);
  assert.notEqual(link.heading, confirm.heading);
});

test("minutes phrases naturally at 1, 2 and 5+", () => {
  const one = mailProviderNotice({ provider: "gmail", sender: "a@b.com", mode: "asset", minutes: 1 });
  const two = mailProviderNotice({ provider: "gmail", sender: "a@b.com", mode: "asset", minutes: 2 });
  const five = mailProviderNotice({ provider: "gmail", sender: "a@b.com", mode: "asset", minutes: 5 });
  assert.match(one.heading, /a minute\?/);
  assert.match(two.heading, /couple of minutes/);
  assert.match(five.heading, /5 minutes/);
});

// ---------------------------------------------------------------------------
// mailProviderNotice.ts is imported directly by client components, so a
// reintroduced `node:dns` import (or any dynamic import/require) there is a
// build break waiting to happen the moment a browser bundler tries to resolve
// it. Pinned the way safeHtmlNoDom.test.ts pins the single-sanitiser-engine
// invariant: a mistake here fails a test rather than passing silently until
// someone's client bundle breaks.
// ---------------------------------------------------------------------------
test("mailProviderNotice.ts is browser-safe — no node imports at all", () => {
  const source = readFileSync(join(process.cwd(), "mailProviderNotice.ts"), "utf8");
  assert.doesNotMatch(source, /\bimport\s*\(/, "no dynamic import(...)");
  assert.doesNotMatch(source, /\brequire\s*\(/, "no require(...)");
  assert.doesNotMatch(source, /\bnode:/, "no node: built-in specifier");
});

// ---------------------------------------------------------------------------
// mailProviderDomains.ts is imported directly by client-side code doing sync
// domain-map detection with no MX fallback available (e.g. a client-only
// login page). It must have NO imports at all — not even a type-only one —
// so nothing it does can ever depend on how mailProvider.ts is bundled. Same
// invariant style as the mailProviderNotice.ts test above, but stricter: it
// also bans any `from "..."` import clause, not just dynamic import/require.
// ---------------------------------------------------------------------------
test("mailProviderDomains.ts is browser-safe — no imports at all", () => {
  const source = readFileSync(join(process.cwd(), "mailProviderDomains.ts"), "utf8");
  assert.doesNotMatch(source, /\bimport\s*\(/, "no dynamic import(...)");
  assert.doesNotMatch(source, /\brequire\s*\(/, "no require(...)");
  assert.doesNotMatch(source, /\bnode:/, "no node: built-in specifier");
  assert.doesNotMatch(source, /\bfrom\s*"/, 'no import ... from "..." of any kind, including type-only');
});
