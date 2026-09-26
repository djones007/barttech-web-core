// ---------------------------------------------------------------------------
// formEvents — the ONE contract for form-stage telemetry, so every public
// form is diagnosable, not just the one that happened to have it hand-built.
//
// WHY THIS EXISTS. One consumer site's quote form fires four bespoke stage
// events and is the only form in the estate a funnel dashboard can see
// inside — every other form is one opaque step: N arrived, M submitted, no
// idea where the rest went. This module is the reusable version of that
// pattern: `form_start` / `form_field_error` / `form_abandon` / `form_submit`
// (see `pageEvents.ts`'s vocabulary), so a new form gets diagnosability by
// construction instead of a bespoke build.
//
// NO NODE IMPORTS — client components import this file directly, same rule
// as `consentEvents.ts`/`consent.ts`. No-ops entirely on the server.
//
// THIS FILE MUST NOT CARRY THE `PAGE_EVENTS_TOKEN` — same reasoning as
// consentEvents.ts. `trackFormEvent()` posts to the CONSUMER'S OWN same-origin
// route handler, which holds the token and calls `trackServerEvent()` from
// `pageEvents.ts` server-side.
//
// DELIBERATELY AGGREGATE-ONLY: a form identifier and (for `form_field_error`)
// a field name, nothing else. No visitor id, no field VALUE — never log what
// someone typed, only that a field they were on errored.
// ---------------------------------------------------------------------------

export type FormStageEvent = "form_start" | "form_field_error" | "form_abandon" | "form_submit";

export interface FormEventPayload {
  /** The form's identifier, e.g. "contact", "get-a-quote". Stable across a form's lifetime. */
  form: string;
  event: FormStageEvent;
  /** Required for `form_field_error`; ignored otherwise. */
  field?: string | null;
}

/** POST one form-stage event to the consumer's own same-origin endpoint. Never throws. */
export function trackFormEvent(url: string, payload: FormEventPayload): void {
  if (typeof window === "undefined" || !url) return;

  try {
    const body = JSON.stringify(payload);
    // `form_abandon` fires from a page-hide/unload path more often than the
    // other three, so prefer sendBeacon everywhere for one consistent code
    // path rather than branching per event.
    if (typeof navigator !== "undefined" && typeof navigator.sendBeacon === "function") {
      const sent = navigator.sendBeacon(url, new Blob([body], { type: "application/json" }));
      if (sent) return;
    }
    void fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
      keepalive: true,
      cache: "no-store",
    }).catch(() => {});
  } catch {
    // Never let a telemetry call break the form.
  }
}

/**
 * Attach the standard lifecycle to a plain HTML `<form>` element:
 * `form_start` on the first focus/input inside it, `form_abandon` if the tab
 * is hidden or the page unloads after a start with no submit recorded, and
 * nothing else — `form_submit` and `form_field_error` are fired explicitly by
 * the caller (a controlled React form knows its own submit-succeeded and
 * validation-failed moments far better than a DOM listener can guess).
 *
 * Returns a cleanup function. Safe to call once per mounted form; calling it
 * twice on the same element double-attaches listeners.
 *
 * ```tsx
 * useEffect(() => {
 *   if (!formRef.current) return;
 *   return attachFormLifecycle(formRef.current, "/api/form-event", "contact");
 * }, []);
 * ```
 */
export function attachFormLifecycle(
  form: HTMLFormElement,
  url: string,
  formName: string
): () => void {
  if (typeof window === "undefined") return () => {};

  let started = false;
  let finished = false; // submitted, or already abandoned — never double-fire

  const onStart = () => {
    if (started) return;
    started = true;
    trackFormEvent(url, { form: formName, event: "form_start" });
  };

  const markSubmitted = () => {
    finished = true;
  };

  const maybeAbandon = () => {
    if (started && !finished) {
      finished = true;
      trackFormEvent(url, { form: formName, event: "form_abandon" });
    }
  };

  const onVisibilityChange = () => {
    if (document.visibilityState === "hidden") maybeAbandon();
  };

  form.addEventListener("focusin", onStart);
  form.addEventListener("input", onStart);
  form.addEventListener("submit", markSubmitted);
  document.addEventListener("visibilitychange", onVisibilityChange);
  window.addEventListener("pagehide", maybeAbandon);

  return () => {
    form.removeEventListener("focusin", onStart);
    form.removeEventListener("input", onStart);
    form.removeEventListener("submit", markSubmitted);
    document.removeEventListener("visibilitychange", onVisibilityChange);
    window.removeEventListener("pagehide", maybeAbandon);
  };
}
