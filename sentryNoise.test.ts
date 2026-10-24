import { test } from "node:test";
import assert from "node:assert/strict";
import { isNoiseEvent, type NoiseEvent } from "./sentryNoise";

// ---------------------------------------------------------------------------
// The expensive mistake in an error-report filter is not letting noise through
// — it is SWALLOWING A REAL ERROR, because the evidence that it happened is the
// thing being deleted. There is no alert for "an error you needed was dropped".
//
// So the negative cases below carry as much weight as the positive ones, and
// deliberately include errors that LOOK like the noise being filtered: an
// application error thrown while inside an in-app browser, an application file
// legitimately named for one of the matched substrings, a real network failure.
// Each one is a filter that was considered and scoped narrowly on purpose.
// ---------------------------------------------------------------------------

function errorEvent(value: string, filenames: string[] = []): NoiseEvent {
  return {
    exception: {
      values: [{ value, stacktrace: { frames: filenames.map((filename) => ({ filename })) } }],
    },
  };
}

test("drops the Android in-app browser bridge error", () => {
  const event = errorEvent("Error invoking postMessage: Java object is gone", [
    "iabjs://navigation_performance_logger_android",
  ]);
  assert.equal(isNoiseEvent(event), true);
});

test("drops any throw from an injected in-app-browser script, whatever the message", () => {
  // The message varies across host-app versions; the scheme does not. This is
  // why the frame check exists alongside the message list.
  const event = errorEvent("some other bridge failure", ["iabjs://some_other_injected_logger"]);
  assert.equal(isNoiseEvent(event), true);
});

test("drops the iOS in-app browser bridge error", () => {
  assert.equal(isNoiseEvent(errorEvent("undefined is not an object (evaluating 'window.webkit.messageHandlers')")), true);
});

test("drops browser-extension DOM serialisation noise", () => {
  assert.equal(isNoiseEvent(errorEvent("Object Not Found Matching Id:4")), true);
  assert.equal(
    isNoiseEvent(errorEvent("Converting circular structure to JSON ... HTMLAnchorElement")),
    true,
  );
  assert.equal(
    isNoiseEvent(errorEvent("Invalid call to runtime.sendMessage(). Tab not found.")),
    true,
  );
});

test("drops the framework's internal redirect signal, by digest and by message", () => {
  const err = Object.assign(new Error("NEXT_REDIRECT"), { digest: "NEXT_REDIRECT;replace;/thanks;307;" });
  assert.equal(isNoiseEvent(errorEvent("boom"), { originalException: err }), true);
  assert.equal(isNoiseEvent(errorEvent("NEXT_REDIRECT")), true);
});

test("drops translation-proxy noise by frame and by request origin", () => {
  assert.equal(isNoiseEvent(errorEvent("Error: Da", ["https://x/translate_http.js"])), true);
  assert.equal(
    isNoiseEvent({ exception: { values: [{ value: "Error: Da" }] }, request: { url: "https://example-com.translate.goog/x" } }),
    true,
  );
});

test("finds an injected frame deeper in a wrapped exception chain", () => {
  const event: NoiseEvent = {
    exception: {
      values: [
        { value: "Wrapper", stacktrace: { frames: [{ filename: "app.js" }] } },
        { value: "Error invoking postMessage", stacktrace: { frames: [{ filename: "iabjs://logger" }] } },
      ],
    },
  };
  assert.equal(isNoiseEvent(event), true);
});

const GOOGLE_APP_IOS_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) GSA/330.0.663358993 Mobile/15E148 Safari/604.1";
const SAFARI_IOS_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.4 Mobile/15E148 Safari/604.1";

function withUserAgent(event: NoiseEvent, ua: string): NoiseEvent {
  return { ...event, request: { url: "https://example.test/blog/post", headers: { "User-Agent": ua } } };
}

test("drops the Google app's injected-script throws on iOS", () => {
  // The three shapes seen live: a frame on the document past its last line,
  // a frame whose filename is the literal string "undefined", and no stack.
  for (const event of [
    errorEvent("pa", ["app:///blog/post"]),
    errorEvent("Maximum call stack size exceeded.", ["undefined"]),
    errorEvent("La"),
  ]) {
    assert.equal(isNoiseEvent(withUserAgent(event, GOOGLE_APP_IOS_UA)), true);
  }
});

// --- must NOT be filtered ---------------------------------------------------

test("keeps an application error thrown inside the Google app", () => {
  const event = errorEvent("Cannot read properties of null (reading 'id')", [
    "app:///_next/static/chunks/page-abc.js",
  ]);
  assert.equal(isNoiseEvent(withUserAgent(event, GOOGLE_APP_IOS_UA)), false);
});

test("keeps a frameless error from any browser other than the Google app", () => {
  assert.equal(isNoiseEvent(withUserAgent(errorEvent("pa", ["app:///blog/post"]), SAFARI_IOS_UA)), false);
  assert.equal(isNoiseEvent(errorEvent("La")), false);
});

test("keeps an application error thrown inside an in-app browser", () => {
  // The whole point of scoping by frame origin rather than by user-agent: a real
  // bug that only reproduces in the Facebook browser is exactly the bug worth
  // hearing about, and it has application frames.
  const event = errorEvent("Cannot read properties of null (reading 'entrantId')", [
    "https://example.test/_next/static/chunks/page.js",
  ]);
  assert.equal(isNoiseEvent(event), false);
});

test("keeps a real network error", () => {
  // One consumer filters a generic network-error message locally, for font
  // downloads on a marketing page. It is deliberately NOT promoted here: on a
  // checkout or an admin console, this is the error you most want.
  assert.equal(isNoiseEvent(errorEvent("NetworkError: A network error occurred.")), false);
});

test("keeps an error from an application file named script.js", () => {
  // The other deliberately un-promoted local filter. `script.js` is a filename
  // any consumer could legitimately ship.
  assert.equal(isNoiseEvent(errorEvent("Cannot read properties of undefined", ["https://example.test/script.js"])), false);
});

test("keeps an error whose message merely mentions a filtered term", () => {
  assert.equal(isNoiseEvent(errorEvent("Failed to load translate_http config from CMS")), false);
});

test("never throws on a malformed, empty or undefined event", () => {
  assert.equal(isNoiseEvent(undefined), false);
  assert.equal(isNoiseEvent({}), false);
  assert.equal(isNoiseEvent({ exception: {} }), false);
  assert.equal(isNoiseEvent({ exception: { values: [] } }), false);
  assert.equal(isNoiseEvent({ exception: { values: [{}] } }), false);
  assert.equal(isNoiseEvent({ exception: { values: [{ stacktrace: { frames: [{}] } }] } }), false);
});
