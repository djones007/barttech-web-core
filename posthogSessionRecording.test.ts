import { test } from "node:test";
import assert from "node:assert/strict";
import {
  POSTHOG_PII_MASK_SELECTOR,
  POSTHOG_SESSION_RECORDING_DEFAULTS,
  POSTHOG_CLIENT_DEFAULTS,
} from "./posthogSessionRecording";

test("masking defaults on — the whole point of this module is never off by default", () => {
  assert.equal(
    POSTHOG_SESSION_RECORDING_DEFAULTS.maskAllInputs,
    true,
    "maskAllInputs must default true — this is the client-side twin of the project-level " +
      "session_recording_masking_config, and the two must never disagree"
  );
});

test("the PII mask selector is a usable CSS attribute selector", () => {
  assert.match(
    POSTHOG_PII_MASK_SELECTOR,
    /^\[[a-z-]+\]$/,
    "must be a bare attribute selector so it can be passed straight to maskTextSelector, and so " +
      "a consumer can add the same attribute to markup with `<span data-ph-mask>`"
  );
  assert.ok(
    POSTHOG_PII_MASK_SELECTOR.includes("data-"),
    "should be a data-* attribute — not a class or id a consumer's styling might already use"
  );
});

test("session_recording defaults reference the exported selector, not a re-typed copy", () => {
  assert.equal(
    POSTHOG_SESSION_RECORDING_DEFAULTS.maskTextSelector,
    POSTHOG_PII_MASK_SELECTOR,
    "a hand-copied string here is exactly the drift this module exists to prevent — the day the " +
      "selector changes, a copy silently stops matching"
  );
});

test("client defaults nest the same session_recording object, not a duplicate", () => {
  assert.equal(
    POSTHOG_CLIENT_DEFAULTS.session_recording,
    POSTHOG_SESSION_RECORDING_DEFAULTS,
    "must be the SAME reference — two independently-constructed objects with equal values today " +
      "silently diverge the next time either export is edited alone"
  );
});

test("console recording is off client-side — defence in depth alongside the project setting", () => {
  assert.equal(
    POSTHOG_CLIENT_DEFAULTS.enable_recording_console_log,
    false,
    "console output can carry stack traces, request payloads and anything a caller happens to log " +
      "— this must not depend solely on the project dashboard setting staying correct"
  );
});

test("exported shapes carry no function values — safe to spread into posthog.init() options", () => {
  // These are meant to be spread into a config object that itself is passed
  // across the posthog-js public API boundary. A function value here would be
  // fine at runtime but is a signal this module has drifted from "plain
  // literal config" into "behaviour", which is exactly what golden rule 1b
  // warns against for a module with no framework/SDK dependency of its own.
  for (const [key, value] of Object.entries(POSTHOG_CLIENT_DEFAULTS)) {
    assert.notEqual(typeof value, "function", `${key} must not be a function`);
  }
  for (const [key, value] of Object.entries(POSTHOG_SESSION_RECORDING_DEFAULTS)) {
    assert.notEqual(typeof value, "function", `${key} must not be a function`);
  }
});
