import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MAX_CONSENT_BANNER_COVERAGE_PCT,
  CONSENT_BANNER_TEST_VIEWPORT,
  consentBannerCoverageMessage,
  measureConsentBanner,
  type ConsentBannerMeasurement,
} from "./consentBannerSize";

// ---------------------------------------------------------------------------
// `measureConsentBanner` runs in a BROWSER, shipped there as source text by
// Playwright's `page.evaluate`. That is the whole reason these tests exist and
// it is why they look unusual: the interesting failure is not a wrong number,
// it is a function that stops being serialisable. If someone helpfully factors
// a shared regex or a constant out to module scope, the source still compiles,
// still typechecks, still lints — and throws `X is not defined` inside the
// browser at the moment the assertion runs, in a weekly job, on a live site.
//
// So the first test reads the function's own source. It is a blunt instrument
// and it is the only one available: there is no DOM here to run the real thing
// against, and adding jsdom to prove it would reintroduce exactly the
// dependency golden rule 1d forbids.
// ---------------------------------------------------------------------------

test("measureConsentBanner stays serialisable — no closure over module scope", () => {
  const source = measureConsentBanner.toString();

  // Every module-scope name this file exports or declares. If the function body
  // mentions one, `page.evaluate` will ship a body that cannot resolve it.
  const moduleScopeNames = [
    "MAX_CONSENT_BANNER_COVERAGE_PCT",
    "CONSENT_BANNER_TEST_VIEWPORT",
    "consentBannerCoverageMessage",
  ];

  for (const name of moduleScopeNames) {
    assert.ok(
      !new RegExp(`\\b${name}\\b`).test(source),
      `measureConsentBanner references module-scope "${name}". Playwright ships this function's ` +
        `SOURCE to the browser, where that name does not exist — the assertion would throw ` +
        `"${name} is not defined" at runtime in a weekly job against a live site, long after the ` +
        `change that broke it. Inline the value instead.`
    );
  }

  assert.ok(
    !/\bimport\b|\brequire\(/.test(source),
    "measureConsentBanner must not import anything — its source is evaluated in a page context " +
      "with no module loader."
  );
});

test("the coverage budget is a percentage a two-line banner can actually meet", () => {
  assert.ok(
    Number.isInteger(MAX_CONSENT_BANNER_COVERAGE_PCT),
    "the budget is compared against a rounded percentage; keep it an integer"
  );
  // Not a style preference — the bounds are the two ways this number stops
  // doing its job. Below ~10% no real banner with three buttons and a policy
  // link fits, so the gate fires on correct work and gets switched off. Above
  // ~30% it stops describing the failure it was written for: the measured
  // banners that buried a hero call-to-action sat at 32-55%.
  assert.ok(
    MAX_CONSENT_BANNER_COVERAGE_PCT >= 10 && MAX_CONSENT_BANNER_COVERAGE_PCT <= 30,
    `a budget of ${MAX_CONSENT_BANNER_COVERAGE_PCT}% is outside the range where this gate is ` +
      `useful — too low and it fires on compliant banners until someone disables it, too high and ` +
      `it stops catching the banners that cover the hero.`
  );
});

test("the test viewport is a real phone, in portrait", () => {
  const { width, height } = CONSENT_BANNER_TEST_VIEWPORT;
  assert.ok(width <= 430, "the budget must be judged on a phone, not a tablet");
  assert.ok(height > width, "portrait — a landscape viewport makes any fixed banner look compliant");
});

test("the failure message says what to change, and what not to change", () => {
  const measurement: ConsentBannerMeasurement = {
    found: true,
    viewportHeight: 844,
    heightPx: 404,
    coveragePct: 48,
    buttons: ["Accept all", "Reject all", "Analytics only"],
  };
  const msg = consentBannerCoverageMessage(measurement, "/");

  assert.match(msg, /48%/, "reports the measured coverage");
  assert.match(msg, /404px/, "reports the measured height, so the fix can be checked against it");
  assert.match(msg, new RegExp(`${MAX_CONSENT_BANNER_COVERAGE_PCT}%`), "reports the budget");
  assert.match(msg, /\//, "names the route measured");

  // The half of the message that matters most. A developer under time pressure
  // reads "make the banner smaller" and reaches for the fastest edit, which is
  // dropping a button or hiding Reject behind a click — and that turns a
  // conversion defect into a PECR/ICO one. The message has to close that door
  // in the same breath as it opens the right one.
  assert.match(msg, /same size in the same row|same row/i, "protects equal prominence");
  assert.match(msg, /removing a category|pre-tick/i, "forbids the unlawful shortcuts");
  assert.match(msg, /two lines|one ROW|padding/i, "names the legitimate fixes");
});

test("a measurement with no banner formats without inventing numbers", () => {
  const msg = consentBannerCoverageMessage(
    { found: false, viewportHeight: 844, heightPx: 0, coveragePct: 0, buttons: [] },
    "/pricing"
  );
  assert.match(msg, /0%/);
  assert.match(msg, /pricing/);
});
