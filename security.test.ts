import { test } from "node:test";
import assert from "node:assert/strict";
import { safeRedirectPath } from "./security";

const SITE = "https://site.example";

const HOSTILE: string[] = [
  "/.//evil.com",
  "/..//evil.com",
  "/././/evil.com",
  "/a/..//evil.com",
  "/\\evil.com",
  "/\\\\evil.com",
  "/%2f/evil.com",
  "/%2F/evil.com",
  "/%5cevil.com",
  "/%5Cevil.com",
  "//evil.com",
  "///evil.com",
  "https://evil.com",
  "http://evil.com",
  "/\t/evil.com",
  "/\n/evil.com",
  "/\r/evil.com",
  "/%09/evil.com",
  "/%0a/evil.com",
  "/%0d/evil.com",
  "\t//evil.com",
  " //evil.com",
  "/ /evil.com",
  "/\u0000/evil.com",
  "/​/evil.com",
  "javascript:alert(1)",
  "JaVaScRiPt:alert(1)",
  "\tjavascript:alert(1)",
  "data:text/html,x",
  "evil.com",
  "/%252f/evil.com",
  "/%255cevil.com",
  "/%25252f/evil.com",
  "/%2e//evil.com",
  "/%2e%2e//evil.com",
  "/%",
  "/%zz",
  "/path\\evil.com",
  "/%5c/evil.com",
  "/..\\evil.com",
  "/ok?next=1\n//evil.com",
];

test("hostile inputs fall back to / and never leave the origin", () => {
  for (const input of HOSTILE) {
    const out = safeRedirectPath(input);
    assert.equal(out, "/", `expected fallback for ${JSON.stringify(input)}, got ${JSON.stringify(out)}`);
  }
});

test("every result resolves to the same origin and is shaped safely", () => {
  const inputs = [...HOSTILE, "/.%2f/evil.com", "/dashboard?x=1#y", "/", "", "/a/b/../c", "/search?q=a%20b"];
  for (const input of inputs) {
    const out = safeRedirectPath(input);
    assert.equal(new URL(out, SITE).origin, SITE, JSON.stringify(input));
    assert.ok(out.startsWith("/"), JSON.stringify(input));
    assert.ok(!out.startsWith("//"), JSON.stringify(input));
    assert.ok(!out.startsWith("/\\"), JSON.stringify(input));
    // eslint-disable-next-line no-control-regex
    assert.ok(!/[\\\u0000-\u001f\u007f]/.test(out), JSON.stringify(input));
  }
});

test("null, undefined-ish and empty fall back to /", () => {
  assert.equal(safeRedirectPath(null), "/");
  assert.equal(safeRedirectPath(""), "/");
  assert.equal(safeRedirectPath(undefined as unknown as string), "/");
});

test("legitimate paths are preserved", () => {
  assert.equal(safeRedirectPath("/dashboard?x=1#y"), "/dashboard?x=1#y");
  assert.equal(safeRedirectPath("/"), "/");
  assert.equal(safeRedirectPath("/a/b/c"), "/a/b/c");
  assert.equal(safeRedirectPath("/a/b/../c"), "/a/c");
  assert.equal(safeRedirectPath("/search?q=a%20b&r=50%25"), "/search?q=a%20b&r=50%25");
  assert.equal(safeRedirectPath("/orders/123?tab=items"), "/orders/123?tab=items");
});
