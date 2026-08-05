// ---------------------------------------------------------------------------
// Barttech shared JSON-LD serialiser for structured data embedded in HTML.
//
// Plain `JSON.stringify` is NOT safe inside a
// `<script type="application/ld+json">` block: a `</script>` sequence in ANY
// string value terminates the tag early, and everything after it is parsed as
// markup rather than as JSON. That turns an attacker-influenced (or merely
// machine-generated) title, description or author name into script injection.
//
// Escaping `<`, `>` and `&` to their `\uXXXX` forms is inert inside JSON — a
// parser reads the original characters straight back — so the structured data
// a search engine sees is byte-for-byte equivalent while the tag breakout is
// impossible. Escaping `&` as well as the angle brackets also blocks HTML
// entity-based variants of the same trick.
//
// This matters most wherever the serialised values are NOT hand-written by a
// human immediately before publishing — generated copy, imported feeds, or any
// pipeline where text reaches the page without someone reading it first.
//
// Framework-free and runtime-agnostic (pure string work, no Node built-ins, no
// React). Import as `@/web-core/jsonLd`.
// ---------------------------------------------------------------------------

/**
 * Serialise a value for safe embedding inside a
 * `<script type="application/ld+json">` tag.
 *
 * Use this instead of `JSON.stringify` for every JSON-LD block:
 *
 * ```tsx
 * <script
 *   type="application/ld+json"
 *   dangerouslySetInnerHTML={{ __html: jsonLd(articleSchema) }}
 * />
 * ```
 *
 * The output is valid JSON and parses back to a value deep-equal to the input.
 */
export function jsonLd(data: unknown): string {
  return JSON.stringify(data)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026");
}
