import { test } from "node:test";
import assert from "node:assert/strict";

import { trackConsentEvent } from "./consentEvents";

// This suite runs under plain `node --test`, which has no `window`/`navigator`/
// `document` — exactly the server-side half of this browser-only module's
// contract. Every export must be safe to call there, since it is transpiled
// into the SAME bundle Next.js server-renders. A DOM-backed harness would be
// needed to assert the sendBeacon/fetch call itself; that is a job for the
// consuming app's own Playwright suite, not this dependency-free package.

test("no-ops on the server (no window) without throwing", () => {
  assert.doesNotThrow(() => trackConsentEvent("/api/consent-event", "shown"));
  assert.doesNotThrow(() => trackConsentEvent("/api/consent-event", "accept"));
  assert.doesNotThrow(() => trackConsentEvent("/api/consent-event", "reject"));
});

test("no-ops on an empty url without throwing", () => {
  assert.doesNotThrow(() => trackConsentEvent("", "accept"));
});
