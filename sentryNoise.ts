// ---------------------------------------------------------------------------
// sentryNoise — the estate's shared "this error is not ours" predicate for
// Sentry's client-side `beforeSend`.
//
// WHY THIS IS SHARED
//
// A browser error handler catches everything that throws on the page, not just
// what the page shipped. Extensions, analytics tags, translation proxies and
// in-app-browser WebViews all inject scripts into a page they did not write,
// and when one of those throws it lands on `window.onerror` — which is ours —
// so Sentry attributes it to us. None of it is fixable from the application
// side, and left unfiltered it is the bulk of a busy project's issue stream,
// burying the errors that ARE ours.
//
// Every consumer discovered this separately and wrote its own filter, which is
// the problem this module exists to end. At the point it was consolidated, the
// filters had split into three families across the estate and NOT ONE consumer
// carried all three: browser-extension noise in seven repos, the framework's
// internal redirect signal in six, third-party script noise in three — and
// eight repos had no `beforeSend` at all. The clearest evidence that the copies
// had stopped tracking each other: one consumer had independently found and
// filtered the iOS in-app-browser bridge error, and another had independently
// found and filtered the ANDROID one, and neither knew about the other's. They
// are the same bug wearing two operating systems, and each site was reporting
// the half its neighbour had already fixed.
//
// So the rule for this file: a filter added here for one site is a filter every
// site gets. Add to it; do not copy out of it.
//
// WHAT DOES NOT BELONG HERE
//
// Anything whose match could plausibly hit a real error in SOME consumer, even
// if it is safe in the one that needs it. Two live examples were deliberately
// left in their own repos rather than promoted:
//
//   - an exact match on a generic network-error message, used by one site to
//     drop font-download failures on flaky connections. On a marketing page
//     that is noise; in a checkout or an admin console a network error is the
//     thing you most want to hear about.
//   - a stack-frame match on the filename `script.js`, used to drop one
//     analytics vendor's serialisation bug. `script.js` is a filename any
//     consumer could legitimately ship, and a rule that swallows a real error
//     is far more expensive than the noise it removes.
//
// A filter that is right for one consumer and wrong for another stays with that
// consumer, and `beforeSend` composes: call this first, then apply local rules.
//
// NO IMPORTS, BY DESIGN
//
// The Sentry event shape is described structurally below rather than imported
// from `@sentry/*`. Consumers vendor this repo as source, so an import here of
// a package a consumer does not install is a build failure in a repo that never
// uses this module (golden rule 1b) — and consumers deliberately split across
// `@sentry/nextjs` and `@sentry/react` for bundle-size reasons, so there is no
// single package to import from anyway. The interfaces are all-optional and
// structural, so a real Sentry `ErrorEvent`/`EventHint` satisfies them.
// ---------------------------------------------------------------------------

/** Structural subset of a Sentry stack frame. */
export interface NoiseStackFrame {
  filename?: string;
}

/** Structural subset of a Sentry exception entry. */
export interface NoiseException {
  value?: string;
  stacktrace?: { frames?: NoiseStackFrame[] };
}

/** Structural subset of a Sentry error event. */
export interface NoiseEvent {
  exception?: { values?: NoiseException[] };
  request?: { url?: string };
}

/** Structural subset of a Sentry event hint. */
export interface NoiseEventHint {
  originalException?: unknown;
}

/**
 * URL schemes used by in-app browsers to inject their own instrumentation into
 * the page they are displaying. A frame with one of these filenames is, by
 * definition, not application code.
 *
 * `iabjs:` is the scheme Meta's Android in-app browser (Facebook, Instagram,
 * Messenger) serves its injected scripts from — "iab" for in-app browser.
 */
const INJECTED_SCRIPT_SCHEMES = ["iabjs:"];

/**
 * Substrings that identify a throw from inside an in-app browser's native
 * bridge rather than from page code.
 *
 * Both of these are the same failure on two platforms: the host app injects a
 * navigation-timing script that calls back into native code, and on page unload
 * that call outlives the native object on the other side of the bridge.
 *
 *   - Android: the WebView's JavaScript-to-Java bridge object has already been
 *     garbage collected, and `postMessage` throws "Java object is gone".
 *   - iOS: `window.webkit.messageHandlers` is absent in the WKWebView the page
 *     has been handed, so the analytics tag's call to it throws.
 *
 * These matter disproportionately on pages that are the destination of paid
 * social traffic, because that audience arrives INSIDE the app that produces
 * the error — the noise concentrates precisely where the real conversion
 * errors need to be visible.
 */
const NATIVE_BRIDGE_MESSAGES = ["Java object is gone", "window.webkit.messageHandlers"];

/**
 * Google's public page-translation proxy re-serves a site through its own
 * origin and injects a translation bundle that throws minified internals while
 * rewriting the DOM. The stack contains no application frame at all; it reports
 * against the site's DSN only because the script runs on a page carrying it.
 *
 * Matched on the injected script's filename and on the proxy origin rather than
 * on the thrown message, which is a minified one- or two-letter identifier that
 * would make a substring rule certain to swallow a real error eventually.
 */
const TRANSLATE_PROXY_FRAME = "translate_http";
const TRANSLATE_PROXY_HOST = ".translate.goog";

/**
 * Browser extensions (password managers, grammar checkers, and similar) attach
 * observers that walk the DOM and try to serialise nodes React has attached its
 * own circular internals to. The throw surfaces in the page's error handler
 * with no application frame involved.
 */
function isBrowserExtensionNoise(value: string): boolean {
  if (value.includes("Object Not Found Matching Id")) return true;
  if (value.includes("Converting circular structure to JSON") && value.includes("HTMLAnchorElement")) {
    return true;
  }
  return false;
}

/**
 * Next.js signals a redirect by THROWING, and that control-flow exception
 * reaches `beforeSend` looking exactly like an error. `@sentry/nextjs`'s client
 * wrapper filters it automatically; consumers that init `@sentry/react`
 * directly — which several do deliberately, to keep the tracing bundle out of
 * the browser — bypass that wrapper and must filter it themselves. Without
 * this, every `redirect()` call reports as a fake error.
 *
 * Checked on the `digest` property of the original exception (the reliable
 * signal, which carries the destination after a `;`) and on the bare message
 * (the minified fallback, where the digest has been stripped).
 */
function isFrameworkRedirect(value: string, hint?: NoiseEventHint): boolean {
  const error = hint?.originalException;
  const digest =
    error && typeof error === "object" && "digest" in error
      ? (error as { digest?: unknown }).digest
      : undefined;
  if (typeof digest === "string" && digest.startsWith("NEXT_REDIRECT;")) return true;
  return value === "NEXT_REDIRECT";
}

/**
 * True when a Sentry error event came from something other than the
 * application's own code and should not be reported.
 *
 * Intended as the first line of a consumer's `beforeSend`:
 *
 *   beforeSend(event, hint) {
 *     if (isNoiseEvent(event, hint)) return null;
 *     // ...any filter specific to THIS site...
 *     return event;
 *   }
 *
 * Never throws: a malformed or partial event returns `false` (report it) rather
 * than failing inside the error reporter, because a `beforeSend` that throws
 * loses the event AND the error that was being reported.
 */
export function isNoiseEvent(event: NoiseEvent | undefined, hint?: NoiseEventHint): boolean {
  const exceptions = event?.exception?.values ?? [];
  const value = exceptions[0]?.value ?? "";

  if (isBrowserExtensionNoise(value)) return true;
  if (isFrameworkRedirect(value, hint)) return true;

  if (NATIVE_BRIDGE_MESSAGES.some((m) => value.includes(m))) return true;

  // Frames from EVERY exception in the chain, not just the first: a bridge or
  // proxy error that has been wrapped still has the injected script deeper in
  // the chain, and reading only `values[0]` would miss it.
  const frames = exceptions.flatMap((e) => e.stacktrace?.frames ?? []);
  for (const frame of frames) {
    const filename = frame?.filename ?? "";
    if (INJECTED_SCRIPT_SCHEMES.some((scheme) => filename.startsWith(scheme))) return true;
    if (filename.includes(TRANSLATE_PROXY_FRAME)) return true;
  }

  if ((event?.request?.url ?? "").includes(TRANSLATE_PROXY_HOST)) return true;

  return false;
}
