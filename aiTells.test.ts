import { test } from "node:test";
import assert from "node:assert/strict";
import {
  scoreText,
  stripHtmlForScoring,
  countSyllables,
  FIXTURE_CLEAN,
  FIXTURE_SLOP,
  DEFAULT_VOICE,
  type AiTellsDetectorResult,
} from "./aiTells";

const DETECTOR_IDS = [
  "burstiness", "vocab-cluster", "formatting", "negation-pivot", "vague-attribution",
  "hedge-stack", "praise-adjectives", "em-dash-rate", "conjunctive-openers", "wrap-up",
  "announced-payoff", "punctuation-tics", "ing-tail", "copula-avoidance", "quiet-gravitas",
  "rule-of-three",
];

function findDetector(detectors: AiTellsDetectorResult[], id: string): AiTellsDetectorResult {
  const d = detectors.find((x) => x.id === id);
  assert.ok(d, `detector ${id} missing from result`);
  return d!;
}

/* --------------------------- calibration contract -------------------------- */
/* Release-blocking per the source pack: human writing scores clean, deliberate */
/* slop scores high. This is the contract the gate's ai_tells_fix_score threshold */
/* (default 35, see bartmail gate.ts) sits between.                             */

test("a genuine human sample scores clean (< 12) with no hard fail", () => {
  const r = scoreText(FIXTURE_CLEAN, { channel: "article" });
  assert.ok(r.score < 12, `clean sample scored ${r.score}: ${JSON.stringify(r.detectors.filter((d) => d.hits.length))}`);
  assert.equal(r.hardFail, false);
  assert.equal(r.verdict, "clean");
});

test("constructed slop scores high (> 45), hard-fails on chat artifacts, and verdict is fix", () => {
  const r = scoreText(FIXTURE_SLOP, { channel: "article" });
  assert.ok(r.score > 45, `slop sample scored ${r.score}`);
  assert.equal(r.hardFail, true);
  assert.equal(r.verdict, "fix");
  assert.ok(r.zeroTolerance.length > 0);
});

test("every detector fires somewhere across the two calibration fixtures", () => {
  const clean = scoreText(FIXTURE_CLEAN);
  const slop = scoreText(FIXTURE_SLOP);
  for (const id of DETECTOR_IDS) {
    const inClean = findDetector(clean.detectors, id);
    const inSlop = findDetector(slop.detectors, id);
    const fired = inClean.hits.length > 0 || inSlop.hits.length > 0;
    assert.ok(fired, `detector ${id} never fired on either fixture`);
  }
});

test("readability is computed math, not guessed: slop grades harder than clean prose", () => {
  const clean = scoreText(FIXTURE_CLEAN, { channel: "article" });
  const slop = scoreText(FIXTURE_SLOP, { channel: "article" });
  assert.ok(clean.readability.grade > 0);
  assert.ok(slop.readability.grade > clean.readability.grade);
});

test("verdict bands: clean < 12, pass-with-notes 12-45, fix > 45 or hard fail", () => {
  assert.equal(scoreText("Short piece. Two sentences. Both plain.").verdict, "clean");
  // A moderate slop stack (vocab cluster + hedge stack + negation pivots + one
  // em dash) should land in the middle band without tripping the
  // zero-tolerance chat-artifact gate.
  const mid = scoreText(
    "It's worth noting our seamless, robust, comprehensive platform isn't just fast, it's dependable — genuinely so. " +
      "This isn't a plugin, it's the whole platform. It's important to note the results speak for themselves.",
  );
  assert.ok(mid.score >= 12 && mid.score <= 45, `expected a mid-band score, got ${mid.score}`);
  assert.equal(mid.verdict, "pass-with-notes");
});

/* ------------------------------- readability ------------------------------- */

test("countSyllables floors at 1 and handles short/long words", () => {
  assert.equal(countSyllables("a"), 1);
  assert.equal(countSyllables("the"), 1);
  assert.equal(countSyllables("business"), 3); // vowel-group heuristic: bu-si-ne(ss) -> 3 groups
  assert.equal(countSyllables(""), 0);
});

test("readability ceiling follows the channel, defaulting to article when unknown", () => {
  const r1 = scoreText(FIXTURE_CLEAN, { channel: "email" });
  assert.equal(r1.readability.channel, "email");
  assert.equal(r1.readability.ceiling, 6);
  const r2 = scoreText(FIXTURE_CLEAN, { channel: "ad" });
  assert.equal(r2.readability.ceiling, 5);
  const r3 = scoreText(FIXTURE_CLEAN, { channel: "not-a-real-channel" });
  assert.equal(r3.readability.channel, "article");
  assert.equal(r3.readability.ceiling, 8);
});

/* -------------------------- individual detector tests ----------------------- */

test("burstiness needs 5+ sentences before it scores at all", () => {
  const r = scoreText("Short one. Another line here. Third.");
  const d = findDetector(r.detectors, "burstiness");
  assert.equal(d.score, 0);
  assert.equal(d.hits.length, 0);
});

test("burstiness fires on a machine-even run of medium sentences", () => {
  const text = [
    "Our growing platform helps modern teams manage every part of their daily workflow with ease.",
    "Every customer team can plan, share, and track daily projects without any real friction here.",
    "Teams across every department now collaborate on shared projects without losing any daily context.",
    "Support tickets move through the queue faster because every step follows the same clear path.",
    "Reports update automatically each morning so nobody has to chase the same numbers again.",
  ].join(" ");
  const r = scoreText(text);
  const d = findDetector(r.detectors, "burstiness");
  assert.ok(d.score > 0, "expected burstiness to fire on a run of near-identical-length sentences");
});

test("vocab-cluster never flags a single hit, only a cluster", () => {
  const r = scoreText("This roadmap will delve into our next quarter, one topic at a time, carefully.");
  const d = findDetector(r.detectors, "vocab-cluster");
  assert.equal(d.score, 0, "a single vocab word must never flag");
});

test("vocab-cluster fires on 3+ distinct high/mid tier words close together", () => {
  const r = scoreText(
    "Our team will delve into the roadmap, showcase the new dashboard, and underscore why this matters for every customer this quarter.",
  );
  const d = findDetector(r.detectors, "vocab-cluster");
  assert.ok(d.score > 0, "expected a 3-word cluster to flag");
});

test("vocab-cluster allowWords exempts a domain word from the list", () => {
  const text = "We will delve into the roadmap, showcase the new dashboard, and underscore the plan for the landscape ahead.";
  const withoutAllow = scoreText(text, { voice: { allowWords: [] } });
  const withAllow = scoreText(text, { voice: { allowWords: ["landscape"] } });
  assert.ok(withoutAllow.score >= withAllow.score);
});

test("formatting fires on bold-phrase overuse and Title Case headings", () => {
  const text = [
    "# Unlock Your Full Business Potential Today",
    "",
    "This **streamlined** workflow gives you **enhanced** results with **seamless** integration across every single team you run today.",
  ].join("\n");
  const r = scoreText(text);
  const d = findDetector(r.detectors, "formatting");
  assert.ok(d.score > 0);
});

test("formatting stays quiet on plain prose with no markup", () => {
  const r = scoreText(FIXTURE_CLEAN);
  const d = findDetector(r.detectors, "formatting");
  assert.equal(d.score, 0);
});

test("negation-pivot allows one contrast for free, scores extras", () => {
  const oneOnly = scoreText("This isn't a small fix, it's the whole redesign, and we are proud of the work.");
  assert.equal(findDetector(oneOnly.detectors, "negation-pivot").score, 0);
  const stacked = scoreText(
    "This isn't a small fix, it's the whole redesign. This isn't a patch, it's a rebuild. This isn't optional, it's the plan.",
  );
  assert.ok(findDetector(stacked.detectors, "negation-pivot").score > 0);
});

test("vague-attribution flags an unnamed source, not one with a named study", () => {
  const vague = scoreText("Experts say this approach works better than the alternative for most small teams.");
  assert.ok(findDetector(vague.detectors, "vague-attribution").score > 0);
  const named = scoreText("A 2024 Cambridge Institute study found this approach works better for most small teams.");
  assert.equal(findDetector(named.detectors, "vague-attribution").score, 0);
});

test("hedge-stack allows one hedge, scores the stack", () => {
  const one = scoreText("It's worth noting that Fridays are our busiest day, so book ahead if you can.");
  assert.equal(findDetector(one.detectors, "hedge-stack").score, 0);
  const stacked = scoreText(
    "It's worth noting that Fridays are busy. It should be noted that Saturdays are busier. Needless to say, book ahead.",
  );
  assert.ok(findDetector(stacked.detectors, "hedge-stack").score > 0);
});

test("praise-adjectives allows one earned adjective, scores the cluster", () => {
  const one = scoreText("Our new checkout flow is seamless and customers have said so directly.");
  assert.equal(findDetector(one.detectors, "praise-adjectives").score, 0);
  const cluster = scoreText("Our seamless, robust, world-class platform delivers unparalleled, cutting-edge results.");
  assert.ok(findDetector(cluster.detectors, "praise-adjectives").score > 0);
});

test("em-dash-rate: default voice bans them outright (Dom's global no-em-dash rule)", () => {
  const r = scoreText("The launch went fine — better than fine, honestly, and the team slept well.");
  assert.ok(findDetector(r.detectors, "em-dash-rate").score > 0, "default voice config must flag a single em dash");
});

test("em-dash-rate: an explicit rate-mode voice only flags density, not one dash", () => {
  const r = scoreText("The launch went fine — better than fine, honestly, and the team slept well.", {
    voice: { emDash: "rate" },
  });
  assert.equal(findDetector(r.detectors, "em-dash-rate").score, 0);
});

test("conjunctive-openers fires on sentence-initial Additionally/Furthermore", () => {
  const r = scoreText("We shipped the update on time. Additionally, every customer was notified by email the same day.");
  assert.ok(findDetector(r.detectors, "conjunctive-openers").score > 0);
});

test("wrap-up reflex scores more when it closes the piece than mid-piece", () => {
  const r = scoreText(FIXTURE_SLOP);
  const d = findDetector(r.detectors, "wrap-up");
  assert.ok(d.score > 0);
  assert.ok(d.hits.some((h) => h.includes("closing the piece")));
});

test("announced-payoff flags a stock opener and a payoff phrase, unless sanctioned", () => {
  const plain = scoreText("Here's the thing. Your prices are a number, and you can change the number when you decide it's time.");
  assert.ok(findDetector(plain.detectors, "announced-payoff").score > 0);
  const sanctioned = scoreText(
    "Here's the thing. Your prices are a number, and you can change the number when you decide it's time.",
    { voice: { sanctioned: ["here's the thing"] } },
  );
  assert.equal(findDetector(sanctioned.detectors, "announced-payoff").score, 0);
});

test("punctuation-tics flags arrow connectors and doubled exclamation marks", () => {
  const r = scoreText("Faster onboarding => more revenue! Try it today!! You will not regret it.");
  assert.ok(findDetector(r.detectors, "punctuation-tics").score > 0);
});

test("punctuation-tics: curly quotes only flag when the voice requires straight quotes", () => {
  const text = 'She called it “a must-have” for the whole team, and meant every word of it.';
  const any = scoreText(text, { voice: { quotes: "any" } });
  const straight = scoreText(text, { voice: { quotes: "straight" } });
  assert.ok(straight.score >= any.score);
});

test('ing-tail flags a trailing restating participle', () => {
  const r = scoreText("The team shipped the new dashboard on schedule, highlighting its importance for every customer this quarter.");
  assert.ok(findDetector(r.detectors, "ing-tail").score > 0);
});

test("copula-avoidance scores a fancy stand-in for a plain is", () => {
  const one = scoreText("This feature serves as the backbone of the whole release.");
  assert.ok(findDetector(one.detectors, "copula-avoidance").score > 0);
});

test('quiet-gravitas needs a cluster, or one hit inside a short piece', () => {
  const shortPiece = scoreText("We are quietly transforming how small teams plan their week.");
  assert.ok(findDetector(shortPiece.detectors, "quiet-gravitas").score > 0);
  const longPieceOneHit = scoreText(
    FIXTURE_CLEAN + " We are quietly transforming how bread gets made around here, one loaf at a time, every single morning without fail.",
  );
  assert.equal(findDetector(longPieceOneHit.detectors, "quiet-gravitas").score, 0);
});

test("rule-of-three flags repeated triple-lists beyond the first two, and anaphora", () => {
  const r = scoreText(
    "We deliver speed, scale, and simplicity. We deliver trust, care, and clarity. We deliver focus, pace, and grit. We deliver more, better, and faster.",
  );
  assert.ok(findDetector(r.detectors, "rule-of-three").score > 0);
});

test("chat-artifacts is zero tolerance: any hit hard-fails regardless of score", () => {
  const r = scoreText("Thanks for reaching out. As an AI language model, I can help with that request.");
  assert.equal(r.hardFail, true);
  assert.equal(r.verdict, "fix");
  assert.ok(r.zeroTolerance.some((t) => /ai language model/i.test(t)));
});

/* --------------------------------- voice config ------------------------------ */

test("DEFAULT_VOICE bans em dashes outright — the safe default for any caller with no voice config yet", () => {
  assert.equal(DEFAULT_VOICE.emDash, "zero");
});

test("no voice option at all falls back to the safe default (emDash zero)", () => {
  const r = scoreText("Good work today — really good.");
  assert.ok(findDetector(r.detectors, "em-dash-rate").score > 0);
});

test("an inline voice override merges onto the default rather than replacing it", () => {
  // Overriding only `quotes` must not silently turn emDash back to "rate".
  const r = scoreText("Good work today — really good.", { voice: { quotes: "straight" } });
  assert.ok(findDetector(r.detectors, "em-dash-rate").score > 0);
});

/* ---------------------------- stripHtmlForScoring ---------------------------- */

test("stripHtmlForScoring turns a marketing-email HTML body into scorable prose", () => {
  const html =
    '<p style="font-family:Arial;font-size:15px;margin:0 0 16px 0;">Hi {{first_name}},</p>' +
    '<p style="font-family:Arial;font-size:15px;margin:0 0 16px 0;">Ask most business owners how they feel about their IT support and you will get a shrug. That is resignation, not a review.</p>' +
    '<table><tr><td style="background-color:#F5A623;border-radius:4px;"><a href="https://example.com/contact?utm_source=email&amp;utm_medium=email&amp;utm_campaign=wk01" style="display:inline-block;font-weight:bold;padding:14px 32px;">Book My Free Health Check</a></td></tr></table>' +
    '<p>Acme Ltd &#183; Suite 652, 124 City Road, London, EC1V 2NX</p>' +
    '<p><a href="{{unsubscribe_url}}">Unsubscribe</a> | <a href="https://example.com/privacy">Privacy Policy</a></p>';

  const text = stripHtmlForScoring(html);
  assert.ok(!/<[a-z][\s\S]*>/i.test(text), "no HTML tags should survive");
  assert.match(text, /Hi \{\{first_name\}\},/);
  assert.match(text, /Book My Free Health Check \(https:\/\/example\.com\/contact/);
  assert.match(text, /Suite 652, 124 City Road, London, EC1V 2NX/);
  // Entities decoded: &#183; -> middle dot, &amp; -> &
  assert.ok(text.includes("·"));
  assert.ok(!text.includes("&amp;"));

  // And it must be usable by scoreText() itself — paragraph breaks preserved
  // enough that the sentence/paragraph splitter in prepare() does not choke.
  const r = scoreText(text, { channel: "email" });
  assert.ok(r.readability.words > 0);
  assert.ok(r.score >= 0 && r.score <= 100);
});
