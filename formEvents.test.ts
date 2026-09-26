import { test } from "node:test";
import assert from "node:assert/strict";

import { trackFormEvent, attachFormLifecycle } from "./formEvents";

// Same reasoning as consentEvents.test.ts: this suite runs under plain
// `node --test`, with no `window`/`document`/`HTMLFormElement` — the
// server-side half of this browser-only module's contract, which must never
// throw even though it is transpiled into a server-rendered bundle.

test("trackFormEvent no-ops on the server without throwing", () => {
  assert.doesNotThrow(() =>
    trackFormEvent("/api/form-event", { form: "contact", event: "form_start" })
  );
  assert.doesNotThrow(() =>
    trackFormEvent("/api/form-event", {
      form: "contact",
      event: "form_field_error",
      field: "email",
    })
  );
});

test("trackFormEvent no-ops on an empty url without throwing", () => {
  assert.doesNotThrow(() => trackFormEvent("", { form: "contact", event: "form_submit" }));
});

test("attachFormLifecycle returns a no-op cleanup on the server", () => {
  // `typeof window === "undefined"` is true in this environment, so the
  // function must return before ever touching its `form` argument — passing
  // `null as unknown as HTMLFormElement` proves that, since any real
  // attempt to call `.addEventListener` on it would throw.
  const cleanup = attachFormLifecycle(
    null as unknown as HTMLFormElement,
    "/api/form-event",
    "contact"
  );
  assert.equal(typeof cleanup, "function");
  assert.doesNotThrow(() => cleanup());
});
