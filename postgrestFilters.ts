// ---------------------------------------------------------------------------
// Safe construction of PostgREST filter strings from user-typed search terms.
//
// WHY THIS EXISTS
// `.or()` takes ONE STRING that PostgREST parses server-side as a filter
// expression. `.ilike()` does not — supabase-js appends it with
// `URLSearchParams.append`, so the value is percent-encoded and arrives as an
// opaque parameter. Those two facts have opposite consequences and the estate
// had five different hand-rolled escapers that each got a different subset
// right, spread across four separate consumers.
//
// Verified live against a real PostgREST instance on 2026-08-29, not assumed:
//
//   or=(title.ilike.%a,b%)        -> 400 PGRST100, "unexpected %"
//   or=(title.ilike."%a,b%")      -> parses (reaches the permission layer)
//   or=(title.ilike.%a%),or(id.gt.0)
//                                 -> PARSES. The trailing text became a second
//                                    disjunct. This is the injection: a comma
//                                    in a search box appends conditions to
//                                    somebody else's OR.
//   or=(title.ilike."%a\"b%")     -> parses; \" is the in-quotes escape
//
// So the rule is: a user-supplied value inside an `.or()` expression must be
// double-quoted, with `\` and `"` escaped inside the quotes. `orIlikeContains`
// is the safe way to build the common "search these columns" filter, and it is
// the only thing most call sites need.
//
// SEPARATELY, and regardless of injection: `%` and `_` are Postgres LIKE
// wildcards. A customer called "50% Ltd" typed into an unescaped search silently
// matches half the table. `escapeLikeTerm` handles that, and it is needed for
// BOTH forms — including `.ilike()`, which is injection-proof but still passes
// the pattern to LIKE.
//
// KNOWN LIMITATION — the asterisk. PostgREST documents `*` as an alias for `%`
// in like/ilike, to spare callers the URL-encoding. There is no escape for it,
// because the substitution happens above Postgres rather than inside the LIKE
// pattern. It could not be confirmed empirically: the probe role holds no SELECT
// grant, correctly, so every request stops at the permission layer before any row
// could show whether it matched. Treat a literal `*` in a search term
// as possibly over-matching. That is a wrong-results bug, not an injection —
// the value is still confined to its own condition — so it is documented rather
// than silently stripped, which is what two of the five old escapers did.
//
// Pure string functions, no I/O, safe in any runtime. Import as
// `@/web-core/postgrestFilters`.
// ---------------------------------------------------------------------------

/**
 * Escape the Postgres LIKE metacharacters in a user-typed term.
 *
 * Backslash first, then the wildcards — reversing that order would re-escape the
 * backslashes this function just added. Postgres LIKE uses backslash as its
 * default ESCAPE character, so `\%` matches a literal percent sign.
 *
 * Use for the `.ilike()` builder form, where injection is not possible but the
 * wildcards still apply:
 *
 *     query.ilike("name", `%${escapeLikeTerm(q)}%`)
 */
export function escapeLikeTerm(term: string): string {
  return term.replace(/\\/g, "\\\\").replace(/[%_]/g, (c) => `\\${c}`);
}

/**
 * Quote a value for use inside a PostgREST filter expression.
 *
 * Returns the value wrapped in double quotes with `\` and `"` escaped, which is
 * what stops a comma, a full stop or a parenthesis in the value from being read
 * as filter syntax. The quotes are part of the return value — do not add your
 * own.
 *
 * Prefer `orIlikeContains` for search filters; reach for this directly only when
 * building a shape it does not cover.
 */
export function orFilterLiteral(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/**
 * Build a complete `.or()` argument that matches `term` anywhere in any of
 * `columns`, case-insensitively.
 *
 * This is the safe replacement for the pattern that was written by hand five
 * times before this module existed:
 *
 *     // before — a comma in `q` appends conditions to this OR
 *     .or(`title.ilike.%${q}%,folder.ilike.%${q}%`)
 *
 *     // after
 *     .or(orIlikeContains(["title", "folder"], q))
 *
 * Column names are the caller's own literals, never user input, so they are not
 * escaped — but they ARE checked, because a column name reaching this function
 * from a request (a sort/filter picker, say) would be the one way back to the
 * same bug. Throws rather than silently dropping the column: a search that
 * quietly stops covering a field looks like it is working.
 */
export function orIlikeContains(columns: readonly string[], term: string): string {
  if (!columns.length) throw new Error("orIlikeContains: no columns given");
  for (const c of columns) {
    if (!/^[a-z_][a-z0-9_]*$/i.test(c)) {
      throw new Error(`orIlikeContains: unsafe column name ${JSON.stringify(c)}`);
    }
  }
  const value = orFilterLiteral(`%${escapeLikeTerm(term)}%`);
  return columns.map((c) => `${c}.ilike.${value}`).join(",");
}

/**
 * Build a complete `.or()` argument that matches `term` EXACTLY in any of
 * `columns`, case-insensitively — `ilike` with no wildcards around the value.
 *
 * The narrow-then-widen pair (try exact, fall back to contains) is a common
 * lookup shape, and the exact half is the one most likely to be written by hand
 * because it looks too simple to need a helper. It needs the same escaping: the
 * value is still a value inside a filter expression.
 */
export function orIlikeExact(columns: readonly string[], term: string): string {
  if (!columns.length) throw new Error("orIlikeExact: no columns given");
  for (const c of columns) {
    if (!/^[a-z_][a-z0-9_]*$/i.test(c)) {
      throw new Error(`orIlikeExact: unsafe column name ${JSON.stringify(c)}`);
    }
  }
  const value = orFilterLiteral(escapeLikeTerm(term));
  return columns.map((c) => `${c}.ilike.${value}`).join(",");
}

/**
 * Build a complete `.or()` argument that matches ONE column against any of
 * several terms — the mirror image of `orIlikeContains`.
 *
 * Both shapes occur: "does this term appear in any of these columns" (a search
 * box) and "does this column match any of these values" (a set of configured
 * hostnames, say). Sharing one helper between them by making the caller pass
 * a matrix would be worse than having two.
 *
 * The terms are usually internal values rather than typed input, which is
 * exactly why this exists: `%` in a config value silently widens the match, and
 * a `,` truncates the filter. Neither announces itself.
 */
export function orIlikeAnyOf(column: string, terms: readonly string[]): string {
  if (!terms.length) throw new Error("orIlikeAnyOf: no terms given");
  if (!/^[a-z_][a-z0-9_]*$/i.test(column)) {
    throw new Error(`orIlikeAnyOf: unsafe column name ${JSON.stringify(column)}`);
  }
  return terms
    .map((t) => `${column}.ilike.${orFilterLiteral(`%${escapeLikeTerm(t)}%`)}`)
    .join(",");
}
