import { test } from "node:test";
import assert from "node:assert/strict";
import { BUG_REPORT_MAX_BREADCRUMBS, bugReportToIssue, cleanBugReport, forwardBugReport } from "./bugReport";

const base = {
  description: "The save button does nothing. It just spins.",
  expected: "The row saves",
  url: "https://app.example.com/orders/42?token=secret#x",
  path: "/orders/42?token=secret",
  pageTitle: "Order 42",
  capturedAt: 61_500,
  screenshotIncluded: true,
  context: { viewport: { w: 1440, h: 900, dpr: 2 }, errors: [{ message: "TypeError: x is undefined", source: "app.js:10", at: 5 }], sentryEventId: "a".repeat(32) },
  breadcrumbs: [
    { at: 1000, kind: "nav", detail: "/orders" },
    { at: 30_000, kind: "click", detail: "button \"Order 42\"" },
    { at: 60_000, kind: "click", detail: "button \"Save\"" },
    { at: 60_500, kind: "error", detail: "Unhandled rejection: 500" },
  ],
};

test("cleanBugReport requires a description", () => {
  assert.deepEqual(cleanBugReport({ ...base, description: " " }), { ok: false, error: "description_required" });
  assert.deepEqual(cleanBugReport(null), { ok: false, error: "description_required" });
});

test("cleanBugReport drops query strings, unknown keys and bad breadcrumbs", () => {
  const r = cleanBugReport({ ...base, extra: "nope", breadcrumbs: [...base.breadcrumbs, { kind: "evil", detail: "x" }, { kind: "click" }] });
  assert.ok(r.ok);
  if (!r.ok) return;
  assert.equal(r.report.url, "https://app.example.com/orders/42");
  assert.equal(r.report.path, "/orders/42");
  assert.equal(r.report.breadcrumbs.length, 4);
  assert.equal((r.report as unknown as Record<string, unknown>).extra, undefined);
  assert.equal(cleanBugReport({ ...base, url: "javascript:alert(1)" }).ok && (cleanBugReport({ ...base, url: "javascript:alert(1)" }) as { report: { url: string } }).report.url, "");
});

test("cleanBugReport caps breadcrumbs to the most recent", () => {
  const many = Array.from({ length: 60 }, (_, i) => ({ at: i, kind: "click", detail: `b${i}` }));
  const r = cleanBugReport({ ...base, breadcrumbs: many });
  assert.ok(r.ok);
  if (!r.ok) return;
  assert.equal(r.report.breadcrumbs.length, BUG_REPORT_MAX_BREADCRUMBS);
  assert.equal(r.report.breadcrumbs.at(-1)?.detail, "b59");
});

test("bugReportToIssue builds numbered steps, context and a titled issue", () => {
  const r = cleanBugReport(base);
  assert.ok(r.ok);
  if (!r.ok) return;
  const i = bugReportToIssue(r.report, { repo: "demo-app", reporter: "ops@example.com", appVersion: "0123456789abcdef", browser: "Chrome 128" });
  assert.equal(i.title, "demo-app /orders/42: The save button does nothing.");
  assert.equal(i.area, "/orders/42");
  assert.equal(i.expected_behavior, "The row saves");
  assert.match(i.steps_to_reproduce, /^1\. \+0:01 Went to \/orders\n2\. \+0:30 Clicked button "Order 42"\n3\. \+1:00 Clicked button "Save"\n4\. On https:\/\/app\.example\.com\/orders\/42 \("Order 42"\): /);
  assert.match(i.context, /by ops@example\.com/);
  assert.match(i.context, /demo-app @ 0123456789ab/);
  assert.match(i.context, /1440x900 @2x, Chrome 128/);
  assert.match(i.context, /TypeError: x is undefined \(app\.js:10\)/);
  assert.match(i.context, /Unhandled rejection: 500/);
  assert.match(i.context, /picture of the page is attached/);
  assert.deepEqual(i.related_links, ["https://app.example.com/orders/42"]);
});

test("forwardBugReport never throws and refuses when unconfigured", async () => {
  const r = cleanBugReport(base);
  assert.ok(r.ok);
  if (!r.ok) return;
  const out = await forwardBugReport({ baseUrl: "", token: "t", report: r.report, meta: { repo: "demo-app", reporter: null } });
  assert.deepEqual(out, { ok: false, error: "not configured" });
});
