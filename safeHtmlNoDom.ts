import sanitizeHtml from "sanitize-html";
import { jsonLd } from "./jsonLd";
import type { SafeHtmlOptions } from "./safeHtml";

// ---------------------------------------------------------------------------
// The same sanitising contract as `safeHtml.ts`, with NO jsdom in the
// dependency chain.
//
// WHY THIS EXISTS (and why it is not simply a replacement)
// `renderSafeHtml` is DOMPurify via `isomorphic-dompurify`, which pulls in
// jsdom. On Next 16 + Turbopack + a Vercel serverless runtime that chain throws
// at MODULE LOAD, so every request to the route 500s whether or not it has any
// HTML to clean: jsdom 30 requires `html-encoding-sniffer` 6, which does a
// CommonJS `require()` of `@exodus/bytes` — and every published version of that
// package is ESM-only, so no dependency pin can fix it.
//
// `safeHtml.ts` documented this hazard but claimed "rendering paths (pages,
// views) are unaffected". That was wrong, and a live page proved it: a help
// page 500'd on every signed-in request from 2026-08-08 until 2026-08-12. The
// verification recorded at the time — load the page and check it redirects to
// login rather than 500 — could not have caught it, because the auth redirect
// happens in the layout BEFORE the page body runs, so it never reached the
// import.
//
// So why keep two? Because several consumers render PUBLISHED BLOG CONTENT
// through `renderSafeHtml`. The two sanitisers are equivalent on the contract
// asserted by the tests, but a subtle serialisation difference on real-world
// markup would silently rewrite live posts — which is precisely the failure
// (`target` being dropped from 34 links across 20 posts) that put those tests
// there. Migrating the remaining consumers is a deliberate, verified step, not
// a side effect of fixing a 500.
//
// USE THIS ONE for anything that runs in a serverless function or an edge
// runtime. Use `renderSafeHtml` for content whose exact output has already been
// verified against DOMPurify and where nothing is gained by churn.
//
// SECURITY MODEL — note this differs in shape from DOMPurify's
// DOMPurify allows a standard profile and blocks the rest. sanitize-html is the
// opposite: an allowlist. Configuring it with "allow everything" and then
// subtracting would drop sanitize-html's URL-scheme checking too, so this
// module keeps the allowlist and states it explicitly below. The consequence
// worth knowing: a tag nobody listed is DROPPED rather than kept. That is the
// safe direction, but it means adding, say, <video> support is a change here.
//
// The consumer must have `sanitize-html` installed.
// ---------------------------------------------------------------------------

const LD_JSON_RE = /<script\s+type=["']application\/ld\+json["']\s*>([\s\S]*?)<\/script>/gi;

const DEFAULT_FORBID_TAGS = ["script", "style", "iframe", "object", "embed", "form"];
const DEFAULT_FORBID_ATTR = ["onerror", "onload", "onclick"];

/**
 * Roughly DOMPurify's `USE_PROFILES: { html: true }` surface — the tags real
 * editorial and documentation content uses. Deliberately excludes form and
 * embedding elements, which are in DEFAULT_FORBID_TAGS anyway.
 */
const ALLOWED_TAGS = [
  "a", "abbr", "address", "article", "aside", "b", "bdi", "bdo", "blockquote", "br",
  "caption", "cite", "code", "col", "colgroup", "data", "dd", "del", "details", "dfn",
  "div", "dl", "dt", "em", "figcaption", "figure", "footer", "h1", "h2", "h3", "h4",
  "h5", "h6", "header", "hgroup", "hr", "i", "img", "ins", "kbd", "li", "main", "mark",
  "nav", "ol", "p", "picture", "pre", "q", "rp", "rt", "ruby", "s", "samp", "section",
  "small", "source", "span", "strong", "sub", "summary", "sup", "table", "tbody", "td",
  "tfoot", "th", "thead", "time", "tr", "u", "ul", "var", "wbr",
];

/**
 * Attributes allowed on any element. `target` is present for the same reason it
 * is in `safeHtml.ts`: dropping it silently turns deliberate new-tab links into
 * same-tab ones, and reverse tabnabbing is mitigated by browsers applying
 * implicit `noopener` to `target="_blank"`.
 *
 * Event handlers are absent and are additionally stripped by prefix below, so
 * a future addition here cannot accidentally readmit one.
 */
const ALLOWED_ATTR = [
  "href", "src", "srcset", "sizes", "alt", "title", "width", "height", "loading",
  "target", "rel", "class", "id", "style", "colspan", "rowspan", "scope", "headers",
  "start", "reversed", "value", "datetime", "cite", "dir", "lang", "role", "type",
  "abbr", "align", "name",
];

/** Sanitise an HTML string for `dangerouslySetInnerHTML` without loading jsdom. */
export function renderSafeHtmlNoDom(
  raw: string | null | undefined,
  opts: SafeHtmlOptions = {}
): string {
  if (!raw) return "";
  const { preserveJsonLd = false, forbidTags = [], forbidAttr = [] } = opts;

  const schemas: string[] = [];
  const withoutSchemas = preserveJsonLd
    ? raw.replace(LD_JSON_RE, (_m, body: string) => {
        try {
          schemas.push(`<script type="application/ld+json">${jsonLd(JSON.parse(body))}</script>`);
        } catch {
          // Doesn't parse as JSON: broken schema or an injection attempt.
          // Either way it doesn't ship.
        }
        return "";
      })
    : raw;

  const forbiddenTags = new Set([...DEFAULT_FORBID_TAGS, ...forbidTags].map((t) => t.toLowerCase()));
  const forbiddenAttrs = new Set([...DEFAULT_FORBID_ATTR, ...forbidAttr].map((a) => a.toLowerCase()));

  const clean = sanitizeHtml(withoutSchemas, {
    allowedTags: ALLOWED_TAGS.filter((t) => !forbiddenTags.has(t)),
    allowedAttributes: {
      "*": ALLOWED_ATTR.filter((a) => !forbiddenAttrs.has(a)),
    },
    // Left at the default. Neither setting gives DOMPurify's serialisation on
    // its own — the default emits `<img />` and an empty list emits
    // `<img></img>` — so void elements are normalised after the fact, below.
    // Scheme checking is the main thing an allowlist buys over "allow all, then
    // subtract": it is what stops `href="javascript:…"`.
    allowedSchemes: ["http", "https", "mailto", "tel", "ftp"],
    allowedSchemesByTag: { img: ["http", "https", "data"] },
    allowProtocolRelative: true,
    // Drop the CONTENTS of these, not just the tags — otherwise stripping
    // `<script>alert(1)</script>` would leave `alert(1)` as visible text.
    nonTextTags: ["script", "style", "textarea", "option", "noscript"],
    // sanitize-html's default rewrites `rel` on target="_blank" links; the
    // input's own `rel` must survive untouched instead.
    transformTags: {},
  });

  const normalised = normaliseVoidElements(clean);
  return schemas.length ? `${normalised}\n${schemas.join("\n")}` : normalised;
}

/**
 * `<img … />` → `<img …>`, matching DOMPurify's serialisation.
 *
 * This is not cosmetic. Consumers compare rendered output against what
 * DOMPurify produced — that is how the dropped-`target` regression was caught —
 * and an XHTML-style slash would make every one of those comparisons fail while
 * rendering identically in a browser, burying any real difference in noise.
 *
 * Operating on the sanitiser's OUTPUT is safe: by this point every `<` and `>`
 * in text content has been entity-encoded, so a `/>` remaining in the string is
 * necessarily part of a tag this sanitiser just emitted, not user content.
 */
const VOID_ELEMENTS =
  /<(area|base|br|col|embed|hr|img|input|link|meta|param|source|track|wbr)\b([^>]*?)\s*\/>/gi;

function normaliseVoidElements(html: string): string {
  return html.replace(VOID_ELEMENTS, (_m, tag: string, attrs: string) => `<${tag}${attrs}>`);
}
