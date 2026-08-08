import DOMPurify from "isomorphic-dompurify";
import { jsonLd } from "./jsonLd";

// ---------------------------------------------------------------------------
// Safe HTML rendering for machine- or user-authored content, with optional
// JSON-LD schema preservation.
//
// Why this exists: content that reaches `dangerouslySetInnerHTML` from a
// database row, a markdown pipeline, or an automated author must be sanitised
// as defence-in-depth. But a blanket DOMPurify pass silently deletes embedded
// `<script type="application/ld+json">` SEO schema blocks, which such content
// legitimately carries. This module does both correctly:
//
//   1. Extract every ld+json block and require it to parse as pure JSON —
//      a block that doesn't parse is broken or hostile, and is dropped.
//   2. Sanitise the remaining HTML (scripts, styles, iframes, event handlers
//      stripped; standard HTML profile kept).
//   3. Re-attach each schema serialised through `jsonLd()`, whose escaping
//      makes a crafted `</script>` inside a schema string inert.
//
// `preserveJsonLd` defaults to FALSE. Step 3 puts `<script>` tags back into the
// output, so a function named "safe" doing that silently would be the wrong
// surprise: a caller sanitising genuinely untrusted input (a ticket body, a
// comment) would re-emit attacker-supplied schema. That is not script execution
// — ld+json is data, and `jsonLd()` blocks the tag breakout — but it does hand
// an attacker arbitrary structured data on the page, which is worth an explicit
// opt-in. Callers rendering their own authored content pass `true`.
//
// The consumer must have `isomorphic-dompurify` installed (it runs on both
// the server and the client). Import this module ONLY in the file that
// sanitises — never from a barrel or a shared entry point. That is not a
// tidiness preference: this dependency pulls in jsdom, and one consumer on
// Next 16 + Turbopack + a serverless runtime hit an ESM/CommonJS conflict in
// that chain (a `require()` of an ES module) which threw at MODULE-LOAD time
// and so returned 500 on every request to the route, not merely the ones with
// HTML to clean. That consumer moved to a sanitiser with no jsdom dependency.
// Rendering paths (pages, views) are unaffected and use this happily; before
// importing it into a serverless API route on that stack, verify with a local
// production build first.
// ---------------------------------------------------------------------------

const LD_JSON_RE = /<script\s+type=["']application\/ld\+json["']\s*>([\s\S]*?)<\/script>/gi;

export interface SafeHtmlOptions {
  /** Extract, validate and re-attach embedded ld+json schema blocks. Default false. */
  preserveJsonLd?: boolean;
  /** Extra tags to forbid beyond the defaults. */
  forbidTags?: string[];
  /** Extra attributes to forbid beyond the defaults. */
  forbidAttr?: string[];
}

const DEFAULT_FORBID_TAGS = ["script", "style", "iframe", "object", "embed", "form"];
const DEFAULT_FORBID_ATTR = ["onerror", "onload", "onclick"];

// DOMPurify's standard HTML profile drops `target`, so `<a target="_blank">`
// silently becomes a same-tab link. That is a content regression, not a security
// win: it was caught only after a consumer shipped it across 20 editorial posts
// (34 links) whose authors had deliberately opened external references in a new
// tab, and it is invisible in any check that counts tags or compares text.
//
// Re-allowing it is safe. Reverse tabnabbing — the reason `target` was ever
// treated as risky — is mitigated by every current browser applying implicit
// `noopener` to `target="_blank"`, and `rel` survives sanitisation, so content
// that sets `rel="noopener"` keeps it belt-and-braces.
const DEFAULT_ADD_ATTR = ["target"];

/** Sanitise an HTML string for `dangerouslySetInnerHTML`, optionally preserving valid JSON-LD. */
export function renderSafeHtml(raw: string | null | undefined, opts: SafeHtmlOptions = {}): string {
  if (!raw) return "";
  const { preserveJsonLd = false, forbidTags = [], forbidAttr = [] } = opts;

  const schemas: string[] = [];
  const withoutSchemas = preserveJsonLd
    ? raw.replace(LD_JSON_RE, (_m, body: string) => {
        try {
          schemas.push(`<script type="application/ld+json">${jsonLd(JSON.parse(body))}</script>`);
        } catch {
          // Doesn't parse as JSON: broken schema (search engines ignore it
          // anyway) or an injection attempt. Either way it doesn't ship.
        }
        return "";
      })
    : raw;

  const clean = DOMPurify.sanitize(withoutSchemas, {
    USE_PROFILES: { html: true },
    ADD_ATTR: DEFAULT_ADD_ATTR,
    // Deduped: DOMPurify treats these as sets, and a caller passing a default
    // again shouldn't change behaviour.
    FORBID_TAGS: Array.from(new Set([...DEFAULT_FORBID_TAGS, ...forbidTags])),
    // FORBID_ATTR wins over ADD_ATTR, so a caller can still forbid `target`.
    FORBID_ATTR: Array.from(new Set([...DEFAULT_FORBID_ATTR, ...forbidAttr])),
  });

  return schemas.length ? `${clean}\n${schemas.join("\n")}` : clean;
}
