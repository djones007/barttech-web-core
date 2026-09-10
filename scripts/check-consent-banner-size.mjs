#!/usr/bin/env node
// ---------------------------------------------------------------------------
// Consent-banner size gate.
//
// WHY THIS EXISTS
// A cookie banner is the one thing on a landing page the visitor did not ask
// for, and its height is not a property anyone chooses — it is what the
// component does once its prose runs a paragraph long and its buttons stack on
// a narrow screen. Measured across a set of sibling sites built from the same
// scaffold, banners ranged from 173px to 462px on a single phone viewport: 20%
// to 55% of the screen. Nobody picked 55%. Above roughly a fifth of the
// viewport the banner sits on top of the hero's call to action, so traffic
// arriving from a paid click lands on what is functionally an interstitial —
// a headline, a wall of cookie text, and both next actions behind a dismissal.
//
// WHY THE GATE IS NOT A GREP FOR THE HEIGHT
// Coverage is a rendered property. It falls out of font size, prose length,
// button direction, padding and the viewport together, and no static pattern
// predicts it: two components with identical class lists measure differently
// because one has a longer sentence. A regex that tried would fire on correct
// banners and miss broken ones, and a rule that fires on correct code is a rule
// people switch off.
//
// So the measurement lives in a Playwright assertion that loads the real page
// at a real phone viewport and reads the real box (`measureConsentBanner` +
// `MAX_CONSENT_BANNER_COVERAGE_PCT` in `web-core/consentBannerSize`). What THIS
// gate enforces is the thing a static check can prove and a runtime test cannot
// prove about itself:
//
//     A repo that ships a consent banner must have that assertion wired,
//     and wired into something CI actually runs.
//
// That closes the failure mode where the shared rule exists, is documented, and
// is simply absent from the one repo that needed it. A runtime test cannot
// report that it was never installed.
//
// THE INVARIANT, precisely
//   1. If no consent-banner component is tracked in this repo -> pass, silently.
//      Not every consumer is a public site.
//   2. Otherwise a tracked Playwright spec must reference
//      MAX_CONSENT_BANNER_COVERAGE_PCT (importing it — a hardcoded 20 in the
//      spec is exactly the drift this module exists to prevent, so the constant
//      must be imported, not retyped).
//   3. That spec must be reachable from a package.json script, and some
//      workflow in .github/workflows must invoke that script. A test nothing
//      runs is a comment.
//
// DELIBERATE EXCEPTION
// A repo that genuinely should not be gated (an internal tool that happens to
// carry a banner, a static export with no test runner) lists the banner file in
// `.consent-banner-baseline`, one path per line, `#` comments allowed. Same
// ratchet as `.web-core-baseline`: the exception is recorded, not invisible.
// ---------------------------------------------------------------------------
import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";

const CONSTANT = "MAX_CONSENT_BANNER_COVERAGE_PCT";
const BASELINE_FILE = ".consent-banner-baseline";

const tracked = execSync("git ls-files", { encoding: "utf8" }).split("\n").filter(Boolean);

const baseline = existsSync(BASELINE_FILE)
  ? readFileSync(BASELINE_FILE, "utf8")
      .split("\n")
      .map((l) => l.replace(/#.*$/, "").trim())
      .filter(Boolean)
  : [];

const read = (f) => {
  try {
    return readFileSync(f, "utf8");
  } catch {
    return "";
  }
};

// A banner component: named for what it is, in a component-ish position, and
// actually rendering a consent choice. The name test alone would match a
// `cookie-banner.test.ts` or a docs page; the content test alone would match
// the privacy page's prose.
const banners = tracked.filter((f) => {
  if (!/\.(tsx|jsx)$/.test(f)) return false;
  if (!/(^|\/)[Cc]ookie[-_]?[Bb]anner[^/]*$/.test(f)) return false;
  if (baseline.includes(f)) return false;
  const src = read(f);
  return /accept/i.test(src) && /(reject|decline|deny)/i.test(src);
});

if (banners.length === 0) {
  console.log(
    `Consent-banner size gate OK — no consent banner in this repo${
      baseline.length ? ` (${baseline.length} baselined)` : ""
    }, nothing to gate.`
  );
  process.exit(0);
}

const problems = [];

// 2. The assertion exists, and imports the shared constant rather than copying
//    its value. A retyped 20 drifts the moment the shared number changes, which
//    is the whole reason the number is shared.
const specs = tracked.filter((f) => /\.spec\.(ts|tsx|js|mjs)$/.test(f));
const specsWithAssertion = specs.filter((f) => {
  const src = read(f);
  return src.includes(CONSTANT) && /\bimport\b[^;]*consentBannerSize/.test(src);
});

if (specsWithAssertion.length === 0) {
  const retyped = specs.filter((f) => read(f).includes(CONSTANT));
  problems.push(
    retyped.length
      ? `${retyped.join(", ")} names ${CONSTANT} but does not import it from web-core/consentBannerSize — a retyped threshold drifts the moment the shared one changes.`
      : `no Playwright spec imports ${CONSTANT} from web-core/consentBannerSize, so nothing measures how much of a phone screen this repo's banner covers.`
  );
}

// 3. Something CI runs has to reach that spec.
if (specsWithAssertion.length > 0) {
  const pkg = existsSync("package.json") ? JSON.parse(read("package.json")) : {};
  const scripts = pkg.scripts || {};
  const specNames = specsWithAssertion.map((f) => f.split("/").pop().replace(/\.spec\..*$/, ""));

  const runners = Object.entries(scripts).filter(([, cmd]) =>
    specNames.some((n) => String(cmd).includes(n))
  );

  if (runners.length === 0) {
    problems.push(
      `${specsWithAssertion.join(", ")} is not reachable from any package.json script, so CI has no way to run it.`
    );
  } else {
    const workflows = tracked.filter((f) => /^\.github\/workflows\/.*\.ya?ml$/.test(f));
    const workflowSrc = workflows.map(read).join("\n");
    const invoked = runners.some(([name]) =>
      new RegExp(`(npm|pnpm|yarn)\\s+(run\\s+)?${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(
        workflowSrc
      )
    );
    if (!invoked) {
      problems.push(
        `the script(s) that run ${specsWithAssertion.join(", ")} (${runners
          .map(([n]) => n)
          .join(", ")}) are not invoked by any workflow in .github/workflows — a test nothing runs is a comment.`
      );
    }
  }
}

if (problems.length) {
  console.log(
    `::error::This repo ships a consent banner but does not measure how much of a phone screen it` +
      ` covers. A banner's height is not chosen — it is what the component does once its prose runs` +
      ` long and its buttons stack, and past roughly a fifth of the viewport it sits on top of the` +
      ` hero's call to action, so paid traffic lands on an interstitial. Add the runtime assertion:` +
      ` import { measureConsentBanner, MAX_CONSENT_BANNER_COVERAGE_PCT, CONSENT_BANNER_TEST_VIEWPORT,` +
      ` consentBannerCoverageMessage } from "@/web-core/consentBannerSize", assert it in a Playwright` +
      ` spec at that viewport, and make sure a workflow runs it. If this repo genuinely should not be` +
      ` gated, list the banner file in ${BASELINE_FILE} with a comment saying why.`
  );
  console.log(`  banner component(s): ${banners.join(", ")}`);
  for (const p of problems) console.log(`  - ${p}`);
  process.exit(1);
}

console.log(
  `Consent-banner size gate OK — ${banners.length} banner(s), measured by ${specsWithAssertion.join(
    ", "
  )}${baseline.length ? `, ${baseline.length} baselined` : ""}.`
);
