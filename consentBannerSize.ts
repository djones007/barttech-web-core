// ---------------------------------------------------------------------------
// How much of a phone screen a cookie-consent banner is allowed to cover.
//
// WHY A SHARED NUMBER AND NOT A DESIGN OPINION
// A consent banner is the first thing a visitor sees and the only thing on the
// page they did not ask for. On a desktop mock-up it looks like a modest strip;
// the same markup on a 390x844 phone is a different object entirely, because
// the prose reflows to five or six lines and three buttons that sat in a row
// stack into three full-width rows. Measured across a set of sibling sites
// built from the same scaffold, banners ranged from 173px to 462px tall on one
// phone viewport — 20% to 55% of the screen — with no one having changed the
// design between them. Nobody chose 55%; it is what the same component does
// once its text is a paragraph longer.
//
// The cost is not aesthetic. A banner that covers half the viewport covers the
// hero's call to action, so a visitor arriving from a paid click sees a headline
// and a wall of cookie text, and the two things they might have done next -- read
// the offer, press the button -- are both behind a dismissal. That is paid traffic
// landing on an interstitial.
//
// WHAT THIS MODULE IS NOT
// It is not a licence to shrink the banner by removing the choice. Under UK PECR
// reg. 6 and UK GDPR, consent must be informed, and rejecting must be as easy as
// accepting (the ICO has enforced against an "Accept" button paired with only a
// "Manage preferences" link). Both survive a small banner intact:
//
//   - Equal prominence is about the CONTROLS, not the prose. Accept and Reject
//     must stay the same size, in the same row, styled with the same weight.
//     Putting them side by side instead of stacked makes the banner shorter AND
//     makes the equality more obvious, not less.
//   - "Informed" is satisfied by naming the purposes and linking the full policy.
//     Two plain lines that say what the optional cookies are FOR, plus a privacy
//     link, is informed consent. Six lines of the same information is not more
//     lawful, it is just taller.
//
// So the way to hit this budget is: two lines of prose, one row of buttons, a
// policy link, tighter padding. Never: dropping a category, hiding Reject behind
// a second click, or pre-ticking anything.
//
// This module holds no React and no styling -- web-core is framework-agnostic and
// the banner component itself stays per-repo because brand styling differs. What
// belongs here is the RULE, so that every repo's test asserts the same number
// rather than each one picking a threshold that its current banner happens to
// pass.
// ---------------------------------------------------------------------------

/**
 * The most of a mobile viewport a consent banner may occupy, as a percentage.
 *
 * 20 is not arbitrary: it is roughly a fifth of the screen, which leaves the
 * hero headline AND its first call to action visible on a 390x844 phone, and it
 * is a budget a two-line banner with a single row of buttons meets comfortably
 * (a real one measures 173px, or 20.5%, at that viewport). It is set at the
 * level where a banner is a defect rather than merely tighter than ideal --
 * a gate tuned to "perfect" is one people switch off.
 *
 * Raising this number is not a fix. If a banner cannot meet it, the prose is
 * too long or the buttons are stacked; both are changes to the banner.
 */
export const MAX_CONSENT_BANNER_COVERAGE_PCT = 20;

/**
 * The viewport a banner is judged against.
 *
 * A single common phone size rather than a range: the budget is a percentage,
 * so a taller phone does not make a fixed-height banner compliant, and pinning
 * one viewport keeps the number in a failure message comparable between runs.
 */
export const CONSENT_BANNER_TEST_VIEWPORT = { width: 390, height: 844 } as const;

/** What {@link measureConsentBanner} reports back. */
export interface ConsentBannerMeasurement {
  /** False when no consent banner was found — see the note on that case below. */
  found: boolean;
  /** Viewport height the percentage was taken against. */
  viewportHeight: number;
  /** Rendered height of the banner's outermost element, in CSS pixels. */
  heightPx: number;
  /** Portion of the viewport the banner actually obscures, 0-100, rounded. */
  coveragePct: number;
  /** Accessible names of the controls inside it, for a legible failure message. */
  buttons: string[];
}

/**
 * Measure the consent banner currently on screen.
 *
 * DESIGNED TO BE SERIALISED. Playwright's `page.evaluate` ships a function's
 * SOURCE to the browser, so this closes over nothing from module scope and
 * takes no imports — every value it needs is either a literal or read from the
 * DOM. Call it as `page.evaluate(measureConsentBanner)`.
 *
 * FINDING THE BANNER, WITHOUT A PER-REPO SELECTOR. Each site names and classes
 * its own banner differently, so a selector list would need editing for every
 * consumer and would silently measure nothing the day one was renamed —
 * a gate that quietly passes is worse than none. Instead it looks for what a
 * consent banner unavoidably IS: a fixed or sticky element, visible, whose text
 * mentions cookies/consent AND offers an accept-or-reject style choice. Nested
 * matches collapse to the outermost, because the card and its wrapper both
 * match and only the wrapper's box is what the visitor loses.
 *
 * `found: false` is deliberately NOT an error here. A page can legitimately
 * have no banner — the visitor already chose, or the route loads no
 * non-essential tags at all. Deciding what an absent banner means is the
 * caller's job; this function only measures.
 */
export function measureConsentBanner(): ConsentBannerMeasurement {
  const viewportHeight = window.innerHeight;
  const empty: ConsentBannerMeasurement = {
    found: false,
    viewportHeight,
    heightPx: 0,
    coveragePct: 0,
    buttons: [],
  };

  const candidates = Array.from(document.querySelectorAll<HTMLElement>("body *")).filter((el) => {
    const style = window.getComputedStyle(el);
    if (style.position !== "fixed" && style.position !== "sticky") return false;
    if (style.visibility === "hidden" || style.display === "none") return false;
    if (parseFloat(style.opacity) === 0) return false;
    const text = (el.innerText || "").toLowerCase();
    // Both halves matter. "cookie" alone matches a policy page in a sticky
    // sidebar; the choice words alone match a newsletter bar saying "accept".
    return (
      /cookie|consent/.test(text) && /accept|reject|allow|agree|analytics|decline/.test(text)
    );
  });
  if (candidates.length === 0) return empty;

  // Wrapper and inner card both match. Keep only elements that no other
  // candidate contains, then the tallest of those.
  const outermost = candidates.filter((el) => !candidates.some((o) => o !== el && o.contains(el)));
  const banner = outermost.sort(
    (a, b) => b.getBoundingClientRect().height - a.getBoundingClientRect().height
  )[0];
  if (!banner) return empty;

  const box = banner.getBoundingClientRect();
  // Clip to the viewport: a banner anchored below the fold, or one taller than
  // the screen, obscures only the part actually on screen, and that is the
  // number the visitor experiences.
  const visible = Math.max(0, Math.min(box.bottom, viewportHeight) - Math.max(box.top, 0));

  return {
    found: true,
    viewportHeight,
    heightPx: Math.round(box.height),
    coveragePct: Math.round((visible / viewportHeight) * 100),
    buttons: Array.from(banner.querySelectorAll("button, a"))
      .map((el) => (el as HTMLElement).innerText?.trim())
      .filter((t): t is string => Boolean(t))
      .slice(0, 6),
  };
}

/**
 * The failure message, built once here so every repo reports the same thing
 * and the reader is told what to change rather than only what is wrong.
 */
export function consentBannerCoverageMessage(m: ConsentBannerMeasurement, route: string): string {
  return (
    `Consent banner covers ${m.coveragePct}% of a ${m.viewportHeight}px-tall phone viewport on ` +
    `${route} (${m.heightPx}px tall), over a budget of ${MAX_CONSENT_BANNER_COVERAGE_PCT}%. ` +
    `At this size it sits on top of the hero's call to action, so a visitor arriving from a paid ` +
    `click sees a headline and a wall of cookie text. Shorten it: two lines of prose naming what ` +
    `the optional cookies are for, one ROW of buttons rather than a stacked column, a link to the ` +
    `full policy, tighter padding. Do NOT hit the budget by removing a category, hiding Reject ` +
    `behind a second click, or pre-ticking anything — Accept and Reject must stay the same size ` +
    `in the same row. Controls found: ${JSON.stringify(m.buttons)}.`
  );
}
