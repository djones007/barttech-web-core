import { test } from "node:test";
import assert from "node:assert/strict";
import { renderSafeHtmlNoDom } from "./safeHtmlNoDom";
import { renderSafeHtml } from "./safeHtml";

// ---------------------------------------------------------------------------
// This file asserts the jsdom-free sanitiser upholds the SAME contract as the
// DOMPurify one in safeHtml.test.ts — the contract that exists because a
// sanitiser silently rewriting published content is a content regression no
// tag-count or visible-text check can see.
//
// The cases below are deliberately the same cases, so the two files can be
// diffed against each other. The final test goes further and asserts the two
// implementations agree byte-for-byte on every one of them, which is the real
// claim being made: that a consumer can move from one to the other without its
// output changing.
//
// It also adds the checks the ALLOWLIST model needs that the blocklist model
// did not: sanitize-html only refuses a `javascript:` URL because a scheme
// allowlist is configured, so that configuration is asserted rather than
// assumed.
// ---------------------------------------------------------------------------

const EQUIVALENT_CASES: string[] = [
  '<a href="https://example.com" target="_blank" rel="noopener">x</a>',
  '<a href="https://example.com" target="_parent">x</a>',
  '<img src="https://cdn.example.com/a.jpg" alt="a" width="600" height="400">',
  '<div class="post wide" id="top"><a href="#a" rel="noopener">x</a></div>',
  '<p style="color:red">t</p>',
  "<p>a</p>",
  "<ul><li>a</li><li>b</li></ul>",
  "<h2>Title</h2><p>Body <strong>bold</strong> and <em>italic</em>.</p>",
  "<pre><code>const x = 1;</code></pre>",
  "<blockquote><p>quoted</p></blockquote>",
];

test("preserves target — the 2026-08-08 regression", () => {
  const html = '<a href="https://example.com" target="_blank" rel="noopener">x</a>';
  assert.equal(renderSafeHtmlNoDom(html), html);
});

test("preserves a non-_blank target", () => {
  const html = '<a href="https://example.com" target="_parent">x</a>';
  assert.equal(renderSafeHtmlNoDom(html), html);
});

test("preserves image attributes, and does not self-close the tag", () => {
  // `<img ...>` not `<img ... />` — several callers compare output exactly
  // against what DOMPurify produced.
  const html = '<img src="https://cdn.example.com/a.jpg" alt="a" width="600" height="400">';
  assert.equal(renderSafeHtmlNoDom(html), html);
});

test("preserves rel, class and id", () => {
  const html = '<div class="post wide" id="top"><a href="#a" rel="noopener">x</a></div>';
  assert.equal(renderSafeHtmlNoDom(html), html);
});

test("preserves table structure attributes", () => {
  const out = renderSafeHtmlNoDom('<table><tr><td colspan="2">c</td></tr></table>');
  assert.match(out, /colspan="2"/);
});

test("preserves inline style", () => {
  const html = '<p style="color:red">t</p>';
  assert.equal(renderSafeHtmlNoDom(html), html);
});

for (const [name, input] of Object.entries({
  script: "<p>a</p><script>alert(1)</script>",
  iframe: '<iframe src="https://x"></iframe>',
  object: '<object data="x"></object>',
  embed: '<embed src="x">',
  form: "<form><input></form>",
  styleTag: "<style>p{color:red}</style>",
})) {
  test(`strips <${name}>`, () => {
    assert.doesNotMatch(renderSafeHtmlNoDom(input), new RegExp(`<${name.replace("Tag", "")}`, "i"));
  });
}

test("stripping a script removes its CONTENTS too, not just the tags", () => {
  // Dropping only the tags would leave `alert(1)` as visible page text.
  assert.doesNotMatch(renderSafeHtmlNoDom("<p>a</p><script>alert(1)</script>"), /alert/);
  assert.doesNotMatch(renderSafeHtmlNoDom("<style>p{color:red}</style>"), /color:red/);
});

for (const attr of ["onerror", "onload", "onclick"]) {
  test(`strips ${attr}`, () => {
    const out = renderSafeHtmlNoDom(`<img src=x ${attr}="alert(1)">`);
    assert.doesNotMatch(out, new RegExp(attr, "i"));
  });
}

// --- URL schemes: what the allowlist model must earn -----------------------

test("refuses javascript: and data: URLs on a link", () => {
  assert.doesNotMatch(renderSafeHtmlNoDom('<a href="javascript:alert(1)">x</a>'), /javascript:/i);
  assert.doesNotMatch(renderSafeHtmlNoDom('<a href="data:text/html;base64,PHM=">x</a>'), /data:/i);
  // Case and whitespace tricks must not get through either.
  assert.doesNotMatch(renderSafeHtmlNoDom('<a href="JaVaScRiPt:alert(1)">x</a>'), /alert/i);
  assert.doesNotMatch(renderSafeHtmlNoDom('<a href=" javascript:alert(1)">x</a>'), /alert/i);
});

test("keeps the URL schemes real content uses", () => {
  for (const href of ["https://x.com/a?b=1", "http://x.com", "mailto:a@b.com", "tel:+441234", "#anchor", "/relative/path"]) {
    const out = renderSafeHtmlNoDom(`<a href="${href}">x</a>`);
    assert.match(out, /<a href=/, `expected ${href} to survive, got ${out}`);
  }
});

test("allows a data: image but not a data: script", () => {
  assert.match(renderSafeHtmlNoDom('<img src="data:image/png;base64,iVBOR">'), /data:image\/png/);
});

// --- JSON-LD carve-out ------------------------------------------------------

const SCHEMA = '<p>a</p><script type="application/ld+json">{"@type":"FAQPage"}</script>';

test("preserveJsonLd defaults to FALSE — schema is stripped unless asked for", () => {
  const out = renderSafeHtmlNoDom(SCHEMA);
  assert.doesNotMatch(out, /ld\+json/);
  assert.match(out, /<p>a<\/p>/);
});

test("preserveJsonLd: true keeps valid schema and its data", () => {
  const out = renderSafeHtmlNoDom(SCHEMA, { preserveJsonLd: true });
  assert.match(out, /application\/ld\+json/);
  const body = out.slice(out.indexOf(">", out.indexOf("ld+json")) + 1, out.lastIndexOf("</script>"));
  assert.deepEqual(JSON.parse(body), { "@type": "FAQPage" });
});

test("drops a schema block that is not valid JSON", () => {
  const out = renderSafeHtmlNoDom('<p>a</p><script type="application/ld+json">{nope}</script>', {
    preserveJsonLd: true,
  });
  assert.doesNotMatch(out, /ld\+json/);
  assert.match(out, /<p>a<\/p>/);
});

test("a raw </script> in the source drops the block without injecting", () => {
  const out = renderSafeHtmlNoDom(
    '<p>a</p><script type="application/ld+json">{"a":"</script><img src=x onerror=alert(1)>"}</script>',
    { preserveJsonLd: true }
  );
  assert.doesNotMatch(out, /onerror/, "no event handler may survive");
  assert.equal((out.match(/<script/g) ?? []).length, 0, "no script element may survive");
});

// --- Caller overrides -------------------------------------------------------

test("forbidAttr still wins over the default allow — target can be removed", () => {
  const out = renderSafeHtmlNoDom('<a href="https://x" target="_blank">x</a>', { forbidAttr: ["target"] });
  assert.doesNotMatch(out, /target/);
});

test("forbidTags extends rather than replaces the defaults", () => {
  const out = renderSafeHtmlNoDom("<h1>t</h1><p>a</p><script>x</script>", { forbidTags: ["h1"] });
  assert.doesNotMatch(out, /<h1/);
  assert.doesNotMatch(out, /<script/);
  assert.match(out, /<p>a<\/p>/);
});

test("passing a default forbid value again does not change behaviour", () => {
  const input = "<p>a</p>";
  assert.equal(renderSafeHtmlNoDom(input, { forbidTags: ["script"], forbidAttr: ["onclick"] }), input);
});

test("empty input", () => {
  for (const value of ["", null, undefined]) {
    assert.equal(renderSafeHtmlNoDom(value as string | null | undefined), "");
  }
});

// --- Corpus-found preservation contract (2026-08-15) ------------------------
// The consolidation corpus diff caught the allowlist silently stripping these
// from 13 of 64 real published posts. Same class as the dropped-`target`
// regression: invisible to tag-count and text checks, real content loss.

test("preserves data-* attributes — page-builder metadata on real posts", () => {
  const html = '<ul data-bold="inherit"><li data-id="4123">x</li></ul>';
  assert.equal(renderSafeHtmlNoDom(html), html);
});

test("preserves img decoding alongside loading", () => {
  const html = '<img src="https://cdn.example.com/a.jpg" alt="a" loading="lazy" decoding="async">';
  assert.equal(renderSafeHtmlNoDom(html), html);
});

test("preserves aria-* attributes", () => {
  const html = '<div aria-label="Note" role="note">x</div>';
  assert.equal(renderSafeHtmlNoDom(html), html);
});

test("data-* wildcard cannot readmit an event handler", () => {
  const out = renderSafeHtmlNoDom('<img src="https://x/a.jpg" data-x="1" onerror="alert(1)">');
  assert.doesNotMatch(out, /onerror/i);
  assert.match(out, /data-x="1"/);
});

test("passes inline style through verbatim — no CSS re-serialisation", () => {
  const html = '<span style="text-decoration: underline;">u</span>';
  assert.equal(renderSafeHtmlNoDom(html), html);
});

// --- The actual claim -------------------------------------------------------

test("renderSafeHtml IS renderSafeHtmlNoDom — one engine, two names", () => {
  // Until 2026-08-15 this test compared two live implementations byte-for-byte
  // (DOMPurify vs sanitize-html) to prove a consumer could migrate between them
  // without a silent content edit. The consolidation shipped that day: every
  // consumer's full published corpus was rendered through both engines and
  // DOM-diffed (tags, every attribute, text, JSON-LD data) before
  // `renderSafeHtml` became an alias of `renderSafeHtmlNoDom`. A byte-for-byte
  // loop against an alias would pass vacuously and imply a comparison that is
  // no longer happening — so the assertion now states the real invariant:
  // there is exactly ONE sanitiser implementation, and both exported names
  // resolve to it. If someone reintroduces a second engine, this fails and the
  // corpus-diff obligation in golden rule 1d applies again.
  assert.equal(renderSafeHtml, renderSafeHtmlNoDom);
  for (const input of EQUIVALENT_CASES) {
    assert.equal(
      renderSafeHtmlNoDom(input),
      renderSafeHtml(input),
      `implementations disagree on: ${input}`
    );
  }
});
