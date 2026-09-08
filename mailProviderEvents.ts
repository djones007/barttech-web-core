// ---------------------------------------------------------------------------
// mailProviderEvents — browser-safe analytics for the post-submit
// deliverability notice (mailProviderNotice.ts). NO node imports — client
// components import this file directly, same rule as mailProviderNotice.ts
// and mailProviderDomains.ts.
//
// Two independent signals, both best-effort and both no-ops when unavailable:
//   1. A gtag event, when `window.gtag` is already a function (the site has
//      wired up GA4/Google Ads via consent.ts / adPlatforms.ts — this module
//      never loads or initialises gtag itself, and never fires before consent
//      because it never fires anything on its own; a caller decides when to
//      call it).
//   2. A `CustomEvent("post-submit-notice")` dispatched on `window`, so a
//      site with no analytics tag configured at all can still observe the
//      notice being shown or resent (e.g. to drive its own in-house metric).
//
// As in consent.ts / adPlatforms.ts, this file does NOT `declare global` for
// `gtag` — several consumers already declare it themselves, and a second
// global augmentation with a different signature is a hard TS error that
// would break them the moment this file is mounted. A local structural type
// + one cast keeps this module self-contained (golden rule 6).
// ---------------------------------------------------------------------------

import type { MailProvider, NoticeMode } from "./mailProviderNotice";

export type PostSubmitNoticeEventKind = "view" | "resend";

export interface PostSubmitNoticeEventDetail {
  provider: MailProvider;
  mode: NoticeMode;
  brand?: string;
}

type GtagFn = (...args: unknown[]) => void;

interface MailProviderEventsWindow {
  gtag?: GtagFn;
}

/** The window, structurally typed — or null on the server. */
function eventsWindow(): MailProviderEventsWindow | null {
  return typeof window === "undefined" ? null : (window as unknown as MailProviderEventsWindow);
}

const GTAG_EVENT_NAME: Record<PostSubmitNoticeEventKind, string> = {
  view: "post_submit_notice_view",
  resend: "post_submit_notice_resend",
};

/**
 * Fire the post-submit-notice analytics signal for one of the two event
 * kinds. Never throws.
 *
 * No-ops entirely on the server (`window` undefined). In the browser, it does
 * two independent things, neither gating the other:
 *
 *   - Calls `window.gtag("event", …)` with `mail_provider`, `notice_mode` and
 *     (when given) `brand` as event params, but ONLY when `window.gtag` is
 *     already a function — this module never creates a gtag stub and never
 *     loads any tag itself, so a site with no analytics configured sees no
 *     gtag call at all.
 *   - Dispatches `new CustomEvent("post-submit-notice", { detail })` on
 *     `window` regardless of whether gtag exists, so a site with no gtag can
 *     still observe the notice via its own listener.
 */
export function emitPostSubmitNoticeEvent(
  kind: PostSubmitNoticeEventKind,
  detail: PostSubmitNoticeEventDetail
): void {
  const w = eventsWindow();
  if (!w) return;

  try {
    if (typeof w.gtag === "function") {
      w.gtag("event", GTAG_EVENT_NAME[kind], {
        mail_provider: detail.provider,
        notice_mode: detail.mode,
        ...(detail.brand !== undefined ? { brand: detail.brand } : {}),
      });
    }
  } catch {
    // A misbehaving gtag stub must never break the page.
  }

  try {
    window.dispatchEvent(new CustomEvent("post-submit-notice", { detail: { kind, ...detail } }));
  } catch {
    // CustomEvent construction/dispatch can throw in a locked-down sandbox —
    // never let an observability signal break the caller.
  }
}
