import { renderSafeHtmlNoDom } from "./safeHtmlNoDom";

// ---------------------------------------------------------------------------
// Safe HTML rendering for machine- or user-authored content, with optional
// JSON-LD schema preservation.
//
// ONE ENGINE, TWO NAMES (consolidated 2026-08-15). `renderSafeHtml` is now an
// alias for `renderSafeHtmlNoDom` — the sanitize-html implementation in
// `safeHtmlNoDom.ts`, which holds the contract, the allowlist, and the full
// rationale. Both names are kept because consumers import both and the export
// surface must stay backwards-compatible (golden rule 4).
//
// Why the DOMPurify engine is gone: `isomorphic-dompurify` pulls in jsdom,
// whose html-encoding-sniffer → @exodus/bytes chain throws ERR_REQUIRE_ESM at
// MODULE-LOAD time on Next 16 + Turbopack + a serverless runtime — every
// request to any route importing the file 500'd, whether or not it had HTML to
// clean. No dependency pin can fix it (every published @exodus/bytes is
// ESM-only). It bit three consumers on three separate dates before the engine
// was retired here at the root. Do not reintroduce jsdom or anything that
// transitively depends on it.
//
// The consolidation was NOT a blind swap — golden rule 1d required migrating
// consumers deliberately, diffing real rendered output. Every consumer's full
// published corpus was rendered through both engines and compared at DOM level
// (tags, every attribute, text, JSON-LD block data) before this alias shipped
// — and that diff EARNED ITS KEEP: it caught the first allowlist silently
// stripping `data-*` attributes and `<img decoding>` from 13 of 64 real posts,
// which was fixed (and pinned in safeHtmlNoDom.test.ts) before anything
// propagated. `safeHtml.test.ts` pins the attribute-level contract (`target`
// preserved, inline style intact, event handlers stripped, ld+json validated)
// that the 2026-08-08 regression taught us to assert.
//
// The consumer must have `sanitize-html` installed. Import this module ONLY in
// the file that sanitises — never from a barrel — so repos that don't use it
// never pay for its dependency.
// ---------------------------------------------------------------------------

export interface SafeHtmlOptions {
  /** Extract, validate and re-attach embedded ld+json schema blocks. Default false. */
  preserveJsonLd?: boolean;
  /** Extra tags to forbid beyond the defaults. */
  forbidTags?: string[];
  /** Extra attributes to forbid beyond the defaults. */
  forbidAttr?: string[];
}

/** Sanitise an HTML string for `dangerouslySetInnerHTML`, optionally preserving valid JSON-LD. */
export const renderSafeHtml = renderSafeHtmlNoDom;
