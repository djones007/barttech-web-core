import { test } from "node:test";
import assert from "node:assert/strict";
import { renderSafeHtml } from "./safeHtml";

// ---------------------------------------------------------------------------
// These tests exist because this module shipped a content regression that a
// plausible-looking check could not see.
//
// On 2026-08-08 `renderSafeHtml` was rolled out to six sites. It was verified by
// rendering every real post before and after and comparing TAG COUNTS and
// VISIBLE TEXT. Both were identical, so the check passed — but DOMPurify's
// standard profile drops `target`, and an attribute is neither a tag nor text.
// 34 links across 20 published posts silently became same-tab.
//
// The lesson is encoded below rather than written down: an ATTRIBUTE-LEVEL
// assertion for everything this module is expected to preserve, and an
// assertion for everything it must strip. Add to both lists whenever the
// forbid/allow config changes — a sanitiser is exactly the kind of module where
// "it still renders fine" is not evidence.
// ---------------------------------------------------------------------------

// --- Attributes that MUST survive -----------------------------------------
// Each of these is here because losing it silently changes published content.

test("preserves target — the 2026-08-08 regression", () => {
  const html = '<a href="https://example.com" target="_blank" rel="noopener">x</a>';
  assert.equal(renderSafeHtml(html), html);
});

test("preserves a non-_blank target", () => {
  const html = '<a href="https://example.com" target="_parent">x</a>';
  assert.equal(renderSafeHtml(html), html);
});

test("preserves image attributes (some sites host images off-repo)", () => {
  const html = '<img src="https://cdn.example.com/a.jpg" alt="a" width="600" height="400">';
  assert.equal(renderSafeHtml(html), html);
});

test("preserves rel, class and id", () => {
  const html = '<div class="post wide" id="top"><a href="#a" rel="noopener">x</a></div>';
  assert.equal(renderSafeHtml(html), html);
});

test("preserves table structure attributes", () => {
  const out = renderSafeHtml('<table><tr><td colspan="2">c</td></tr></table>');
  assert.match(out, /colspan="2"/);
});

test("preserves inline style", () => {
  const html = '<p style="color:red">t</p>';
  assert.equal(renderSafeHtml(html), html);
});

// --- Things that MUST be stripped ------------------------------------------

for (const [name, input] of Object.entries({
  script: "<p>a</p><script>alert(1)</script>",
  iframe: '<iframe src="https://x"></iframe>',
  object: '<object data="x"></object>',
  embed: '<embed src="x">',
  form: "<form><input></form>",
  styleTag: "<style>p{color:red}</style>",
})) {
  test(`strips <${name}>`, () => {
    assert.doesNotMatch(renderSafeHtml(input), new RegExp(`<${name.replace("Tag", "")}`, "i"));
  });
}

for (const attr of ["onerror", "onload", "onclick"]) {
  test(`strips ${attr}`, () => {
    const out = renderSafeHtml(`<img src=x ${attr}="alert(1)">`);
    assert.doesNotMatch(out, new RegExp(attr, "i"));
  });
}

// --- JSON-LD carve-out ------------------------------------------------------

const SCHEMA = '<p>a</p><script type="application/ld+json">{"@type":"FAQPage"}</script>';

test("preserveJsonLd defaults to FALSE — schema is stripped unless asked for", () => {
  // Deliberate: step 3 re-emits <script> tags. A caller sanitising untrusted
  // input must not silently re-emit attacker-supplied schema.
  const out = renderSafeHtml(SCHEMA);
  assert.doesNotMatch(out, /ld\+json/);
  assert.match(out, /<p>a<\/p>/);
});

test("preserveJsonLd: true keeps valid schema and its data", () => {
  const out = renderSafeHtml(SCHEMA, { preserveJsonLd: true });
  assert.match(out, /application\/ld\+json/);
  const body = out.match(/ld\+json">([\s\S]*?)<\/script>/)![1];
  assert.deepEqual(JSON.parse(body), { "@type": "FAQPage" });
});

test("drops a schema block that is not valid JSON", () => {
  const out = renderSafeHtml('<p>a</p><script type="application/ld+json">{not json}</script>', {
    preserveJsonLd: true,
  });
  assert.doesNotMatch(out, /ld\+json/);
  assert.match(out, /<p>a<\/p>/);
});

// This is the protection that actually applies, and the realistic case: valid
// schema whose STRING VALUES contain angle brackets. jsonLd() escapes them to
// < / >, so nothing can close the script element from inside a value,
// and the schema still parses back to exactly the same data.
test("escapes angle brackets inside schema values, losslessly", () => {
  const value = JSON.stringify({ name: "Is <script> allowed?", answer: "No </b> & <i>x</i>" });
  const out = renderSafeHtml(`<script type="application/ld+json">${value}</script>`, {
    preserveJsonLd: true,
  });
  const body = out.match(/ld\+json">([\s\S]*?)<\/script>/)![1];
  assert.doesNotMatch(body, /[<>]/, "no raw angle bracket may survive in emitted schema");
  assert.deepEqual(JSON.parse(body), JSON.parse(value), "escaping must be lossless");
});

// A RAW `</script>` in the source terminates the script element — that is what
// the HTML parser does, so matching non-greedily here mirrors the browser rather
// than diverging from it. The fragment before it is not valid JSON, so the block
// is dropped and the remainder is sanitised as ordinary markup. Nothing is
// injected; the schema is simply lost, which is also what a browser would do
// with that source. Pinned so the behaviour is a decision, not an accident.
test("a raw </script> in the source drops the block without injecting", () => {
  const evil = '<script type="application/ld+json">{"n":"</script><img src=x onerror=alert(1)>"}</script>';
  const out = renderSafeHtml(evil, { preserveJsonLd: true });
  assert.doesNotMatch(out, /onerror/, "no event handler may survive");
  assert.equal((out.match(/<script/g) ?? []).length, 0, "no script element may survive");
});

test("keeps multiple schema blocks", () => {
  const out = renderSafeHtml(
    '<script type="application/ld+json">{"a":1}</script><p>x</p><script type="application/ld+json">{"b":2}</script>',
    { preserveJsonLd: true }
  );
  assert.equal((out.match(/ld\+json/g) ?? []).length, 2);
});

// --- Options and edge cases -------------------------------------------------

test("forbidAttr still wins over the default allow — target can be removed", () => {
  const out = renderSafeHtml('<a href="#" target="_blank">x</a>', { forbidAttr: ["target"] });
  assert.doesNotMatch(out, /target/);
});

test("forbidTags extends rather than replaces the defaults", () => {
  const out = renderSafeHtml("<p>a</p><h1>b</h1><script>x</script>", { forbidTags: ["h1"] });
  assert.doesNotMatch(out, /<h1/);
  assert.doesNotMatch(out, /<script/);
  assert.match(out, /<p>a<\/p>/);
});

test("passing a default forbid value again does not change behaviour", () => {
  const input = "<p>a</p>";
  assert.equal(renderSafeHtml(input, { forbidTags: ["script"], forbidAttr: ["onclick"] }), input);
});

for (const [name, value] of Object.entries({ null: null, undefined: undefined, empty: "" })) {
  test(`returns "" for ${name}`, () => {
    assert.equal(renderSafeHtml(value as string | null | undefined), "");
  });
}
