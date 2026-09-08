/**
 * Text that is safe to draw with the standard PDF fonts.
 *
 * The 14 standard PDF fonts (Helvetica and friends) encode **WinAnsi**, i.e.
 * CP1252. That is ASCII, the Latin-1 supplement, and the CP1252 specials at
 * 0x80–0x9F — which is where curly quotes, en/em dashes and the ellipsis live.
 * Nothing else exists as far as those fonts are concerned.
 *
 * PDF libraries do not degrade gracefully here: `pdf-lib` THROWS on a character
 * it cannot encode, from `drawText` **and** from `widthOfTextAtSize`. So a
 * single stray glyph anywhere in a document — including in a value typed by a
 * user into a name or a title — fails the whole render rather than spoiling one
 * line of it. Anything unrepresentable therefore has to be dealt with before it
 * reaches the library, and this module is that step.
 *
 * Two rules, and the distinction between them is the whole point:
 *
 *   - A glyph that carries no meaning is DROPPED. An emoji in a company name
 *     costs nothing to lose.
 *   - A glyph that carries STRUCTURE is SUBSTITUTED. Dropping it silently
 *     changes what the document says.
 *
 * The second rule exists because of a real failure: descriptions written as
 * ✓-prefixed "what's included" lists rendered with no marker at all, because
 * U+2713 is not in CP1252 and the sanitiser deleted it. The HTML view showed a
 * ticked list and the PDF showed an undifferentiated block of lines — two
 * renderings of the same record disagreeing, with only the PDF being the one
 * that gets signed and filed.
 *
 * Substitutions are deliberately conservative: a mark of the same KIND, never a
 * paraphrase. A tick becomes a bullet because both say "this line is an item in
 * a list". Nothing here rewrites a word.
 *
 * Note what is NOT substituted: curly quotes, en/em dashes and the ellipsis are
 * already encodable and are left exactly as written. A document that reproduces
 * text verbatim — terms a signatory accepted, a quotation as issued — must not
 * quietly flatten its own typography.
 *
 * Embedding a font that covers these glyphs is the other possible fix and is
 * usually the wrong trade. Standard fonts mean no font file to ship, and a font
 * file read at runtime is a serverless bundling problem that appears only in
 * production. A substituted glyph beats a document that fails to render.
 */

/**
 * The characters the standard fonts can actually draw.
 *
 * The tail of this class is the CP1252 0x80–0x9F block, written out as literals
 * because that block is NOT contiguous in Unicode — the code points are
 * scattered across U+0152…U+2122 and a range expression cannot express it.
 */
const WINANSI_SAFE = /[^\x20-\x7E\xA0-\xFF€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ]/g;

/**
 * Characters that get a stand-in instead of being deleted.
 *
 * Add to this only when the character carries meaning that its absence would
 * change. If a reader would not notice the glyph was gone, dropping is correct
 * and an entry here is noise.
 */
const WINANSI_SUBSTITUTES = new Map<string, string>([
  // Ticks and crosses. These prefix list items, so losing one loses the list.
  ["✓", "•"], ["✔", "•"], ["☑", "•"], ["✅", "•"],
  ["✗", "x"], ["✘", "x"], ["☒", "x"], ["❌", "x"],
  // Other list markers, all of which mean "bullet".
  ["‣", "•"], ["⁃", "•"], ["▪", "•"], ["▫", "•"], ["◦", "•"], ["●", "•"], ["○", "•"],
  ["★", "*"], ["☆", "*"],
  /* Arrows and maths, written out rather than lost mid-sentence. Dropped, these
     leave a sentence that still reads as complete and now says something else:
     an upgrade path loses its direction, and a threshold loses the comparison
     that made it a threshold. */
  ["→", "->"], ["←", "<-"], ["↔", "<->"], ["⇒", "=>"],
  ["≥", ">="], ["≤", "<="], ["≠", "!="], ["≈", "~"],
  // Typography with an exact Latin-1 equivalent.
  ["′", "'"], ["″", '"'], ["‑", "-"], ["‒", "–"], ["⁄", "/"],
  /* Spaces that are not U+0020. Dropping one closes the words either side of it
     into a single word — "12 GB" silently becomes "12GB", which is not obviously
     a rendering fault to anyone reading the result. */
  [" ", " "], [" ", " "], [" ", " "], [" ", " "],
]);

/**
 * Make a string safe to hand to a standard-font PDF writer.
 *
 * Call this at EVERY draw site, not just the ones handling long body text.
 * Measurement throws as readily as drawing, so a helper that measures a string
 * to right-align or wrap it must sanitise BEFORE measuring, not after.
 *
 * LINE-LEVEL by design: a newline is a control character and is stripped like
 * any other, because a PDF text-drawing call renders one line. Callers holding
 * multi-line text split it first and sanitise each line — the split has to come
 * first, since sanitising a whole block would delete the very breaks the split
 * was going to use.
 */
export function pdfSafeText(input: string): string {
  let out = "";
  // for..of iterates by code point, so an astral character (an emoji) is one
  // unit here and cannot be half-removed into a lone surrogate.
  for (const ch of input) out += WINANSI_SUBSTITUTES.get(ch) ?? ch;
  return out.replace(WINANSI_SAFE, "");
}

/**
 * True when a string would survive a standard-font PDF writer untouched.
 *
 * For callers that would rather reject or flag input than silently alter it —
 * a validation step on an authored template, say, where a substitution is a
 * thing the author should know about rather than something done behind them.
 */
export function isPdfSafeText(input: string): boolean {
  return pdfSafeText(input) === input;
}
