import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

// ---------------------------------------------------------------------------
// clientEvents.ts decides whether a browser event reaches GA4/Meta ONCE, late,
// or never. Each rule tested here is a silent failure when broken: a missing
// eventID double-counts every consenting visitor in Meta; a load-time event
// that doesn't wait for consent is never sent at all. No DOM: the module
// touches window.gtag, window.fbq, and (through consent.ts) localStorage,
// document.cookie and window.addEventListener, so those are stubbed.
// ---------------------------------------------------------------------------

class MemoryStorage {
  private map = new Map<string, string>();
  getItem(k: string): string | null {
    return this.map.has(k) ? (this.map.get(k) as string) : null;
  }
  setItem(k: string, v: string): void {
    this.map.set(k, String(v));
  }
  removeItem(k: string): void {
    this.map.delete(k);
  }
  clear(): void {
    this.map.clear();
  }
}

type Call = unknown[];
const storage = new MemoryStorage();
const g = globalThis as unknown as Record<string, unknown>;
const win: Record<string, unknown> = {
  location: { hostname: "example.test", protocol: "https:" },
  localStorage: storage,
  addEventListener: () => {},
  removeEventListener: () => {},
};
g.window = win;
g.localStorage = storage;
g.document = { cookie: "" };

// eslint-disable-next-line @typescript-eslint/no-require-imports
const events = require("./clientEvents") as typeof import("./clientEvents");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const consent = require("./consent") as typeof import("./consent");

let gtagCalls: Call[] = [];
let fbqCalls: Call[] = [];

function installGtag(): void {
  win.gtag = (...args: unknown[]) => {
    gtagCalls.push(args);
  };
}
function installFbq(): void {
  win.fbq = (...args: unknown[]) => {
    fbqCalls.push(args);
  };
}
const tick = () => new Promise((r) => setTimeout(r, 5));

beforeEach(() => {
  gtagCalls = [];
  fbqCalls = [];
  delete win.fbq;
  installGtag();
  storage.clear();
  (g.document as { cookie: string }).cookie = "";
});

test("track() sends a GA4 event through gtag", () => {
  events.track("view_item", { value: 1 });
  assert.deepEqual(gtagCalls, [["event", "view_item", { value: 1 }]]);
});

test("trackMeta() passes the eventID so Meta can de-duplicate against the server twin", () => {
  installFbq();
  events.trackMeta("ViewContent", { value: 2 }, { eventId: "abc-123" });
  assert.deepEqual(fbqCalls, [["track", "ViewContent", { value: 2 }, { eventID: "abc-123" }]]);
});

test("trackMeta() without an id sends the plain three-argument call", () => {
  installFbq();
  events.trackMeta("AddToCart", { value: 3 });
  assert.deepEqual(fbqCalls, [["track", "AddToCart", { value: 3 }]]);
});

test("no pixel (no advertising consent) and no waitForConsent: nothing is sent, later or ever", async () => {
  events.trackMeta("AddToCart", {});
  installFbq();
  await tick();
  assert.equal(fbqCalls.length, 0, "a click event must never replay on a later, unrelated consent");
});

test("waitForConsent: fires once the pixel loads right after mount (stored consent)", async () => {
  events.trackMeta("ViewContent", { v: 1 }, { waitForConsent: true, eventId: "e1" });
  installFbq(); // the banner's mount effect loads the pixel after the page's effect
  await tick();
  assert.deepEqual(fbqCalls, [["track", "ViewContent", { v: 1 }, { eventID: "e1" }]]);
});

test("waitForConsent: fires once when advertising consent is given later, not on analytics-only", async () => {
  events.trackMeta("ViewContent", {}, { waitForConsent: true, eventId: "e2" });
  await tick();
  assert.equal(fbqCalls.length, 0);

  consent.writeConsent({ analytics: true, marketing: false });
  await tick();
  assert.equal(fbqCalls.length, 0, "analytics-only consent must not release an advertising event");

  installFbq(); // what the banner does on marketing consent
  consent.writeConsent({ analytics: true, marketing: true });
  await tick();
  assert.equal(fbqCalls.length, 1);
  assert.deepEqual(fbqCalls[0][3], { eventID: "e2" });

  consent.writeConsent({ analytics: true, marketing: true });
  await tick();
  assert.equal(fbqCalls.length, 1, "the listener unsubscribes after firing: exactly once");
});

test("product params: one description renders both platform shapes consistently", () => {
  const p = { id: "sku-1", name: "Thing", currency: "GBP", value: 19.99, category: "game" };
  const ga4 = events.ga4ItemParams(p) as { currency: string; value: number; items: Array<Record<string, unknown>> };
  const meta = events.metaProductParams(p) as Record<string, unknown>;
  assert.equal(ga4.currency, "GBP");
  assert.equal(ga4.value, 19.99);
  assert.equal(ga4.items[0].item_id, "sku-1");
  assert.equal(ga4.items[0].item_category, "game");
  assert.equal(ga4.items[0].quantity, 1);
  assert.deepEqual(meta.content_ids, ["sku-1"]);
  assert.equal(meta.value, 19.99);
  assert.equal(meta.num_items, 1);
});
