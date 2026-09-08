import { test } from "node:test";
import assert from "node:assert/strict";
import { isPdfSafeText, pdfSafeText } from "./pdfText";

// ---------------------------------------------------------------------------
// Two different mistakes are possible here and they fail in opposite ways.
//
// Letting an unencodable character through fails LOUDLY — the PDF library
// throws and nothing is produced. Deleting a character that carried meaning
// fails SILENTLY: a document renders, looks finished, and says something other
// than what was written. The second is why this module substitutes at all, so
// the substitution cases below matter as much as the safety ones.
//
// The repertoire in `isEncodable` is written out from the CP1252 code page
// rather than derived from the module's own regex — a check copied from the
// thing it checks proves nothing. Node ships no CP1252 encoder to test against
// (`latin1` maps by code point and so disagrees over 0x80–0x9F, which is
// exactly the range at issue), so the authoritative test — handing the output
// to the real PDF library — lives in the consumers that depend on one. This
// file pins the contract those consumers rely on.
// ---------------------------------------------------------------------------

/** CP1252's 0x80–0x9F block, in code-page order; the gaps are genuinely undefined. */
const CP1252_SPECIALS = "€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ";

function isEncodable(text: string): boolean {
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    if (cp >= 0x20 && cp <= 0x7e) continue;
    if (cp >= 0xa0 && cp <= 0xff) continue;
    if (CP1252_SPECIALS.includes(ch)) continue;
    return false;
  }
  return true;
}

test("a tick becomes a bullet rather than vanishing", () => {
  assert.equal(pdfSafeText("✓ Dark web monitoring"), "• Dark web monitoring");
  assert.equal(pdfSafeText("✔ Included"), "• Included");
  assert.equal(pdfSafeText("✗ Not included"), "x Not included");
});

test("a list keeps one marker per line", () => {
  // pdfSafeText is line-level: callers split first, because sanitising a whole
  // block would delete the newlines the split needs. This mirrors that order.
  const lines = "✓ Backup\n✓ Monitoring\n✓ Training".split("\n").map(pdfSafeText);
  assert.deepEqual(lines, ["• Backup", "• Monitoring", "• Training"]);
});

test("curly quotes, dashes and the ellipsis are preserved, not flattened", () => {
  // A document that reproduces text verbatim must not rewrite its own
  // typography. All of these are encodable, so none of them is this module's
  // business.
  const typography = "the Customer’s — “as accepted” … £350 ÷ ½ © Ærø";
  assert.equal(pdfSafeText(typography), typography);
  assert.equal(isPdfSafeText(typography), true);
});

test("an arrow or comparator is written out rather than lost mid-sentence", () => {
  assert.equal(pdfSafeText("Basic → Premium"), "Basic -> Premium");
  assert.equal(pdfSafeText("≥ 10 users"), ">= 10 users");
  assert.equal(pdfSafeText("≤ 5 devices"), "<= 5 devices");
});

test("a space that is not U+0020 becomes one, so words do not close up", () => {
  // Dropping these turned "12 GB" into "12GB", which reads as intentional.
  assert.equal(pdfSafeText("12 GB"), "12 GB", "U+00A0 is encodable and left alone");
  assert.equal(pdfSafeText("12 GB"), "12 GB");
  assert.equal(pdfSafeText("12 GB"), "12 GB");
});

test("a glyph with no meaningful stand-in is dropped, not thrown on", () => {
  assert.equal(pdfSafeText("Order 🎉 confirmed"), "Order  confirmed");
  // Astral characters must not be half-removed into a lone surrogate.
  assert.equal(pdfSafeText("🎉"), "");
  assert.equal(isEncodable(pdfSafeText("🎉🙂👍")), true);
});

test("a newline is stripped, so a single-line draw site cannot smuggle one in", () => {
  assert.equal(pdfSafeText("one\ntwo"), "onetwo");
  assert.equal(pdfSafeText("one\r\ntwo"), "onetwo");
  assert.equal(pdfSafeText("tab\there"), "tabhere");
});

test("every substitution is itself encodable — a stand-in must not need one", () => {
  // The failure this guards against is adding a well-meant replacement that is
  // no more drawable than the character it replaces, which would move the crash
  // rather than fix it.
  const everySubstitutedChar = "✓✔☑✅✗✘☒❌‣⁃▪▫◦●○★☆→←↔⇒≥≤≠≈′″‑‒⁄    ";
  const out = pdfSafeText(everySubstitutedChar);
  assert.equal(isEncodable(out), true);
  assert.ok(!/[✓✔☑✅✗✘☒❌]/u.test(out), "no tick or cross survives");
});

test("output is always encodable, whatever goes in", () => {
  const hostile = [
    "✓ Cloud backup, ≥ 10 seats",
    "Name 🎉 — “signed”",
    "12 GB · £1,234.56",
    "​️⁠zero width",
    "混合 script 日本語",
    "",
  ];
  for (const raw of hostile) {
    assert.equal(isEncodable(pdfSafeText(raw)), true, `not encodable: ${JSON.stringify(raw)}`);
  }
});

test("isPdfSafeText flags what would be altered, and only that", () => {
  assert.equal(isPdfSafeText("Plain ASCII, £ and ’"), true);
  assert.equal(isPdfSafeText("✓ ticked"), false);
  assert.equal(isPdfSafeText("emoji 🎉"), false);
});
