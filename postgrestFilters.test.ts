import { test } from "node:test";
import assert from "node:assert/strict";
import { escapeLikeTerm, orFilterLiteral, orIlikeContains, orIlikeAnyOf } from "./postgrestFilters";

// ---------------------------------------------------------------------------
// The cases here are the ones that were live in production on 2026-08-29, not
// invented ones. Each `.or()` string below was checked against the real
// PostgREST instance first — see the header of postgrestFilters.ts for the
// request/response evidence.
// ---------------------------------------------------------------------------

test("escapeLikeTerm neutralises LIKE wildcards", () => {
  assert.equal(escapeLikeTerm("50% Ltd"), "50\\% Ltd");
  assert.equal(escapeLikeTerm("a_b"), "a\\_b");
  assert.equal(escapeLikeTerm("plain"), "plain");
});

test("escapeLikeTerm escapes the backslash before the wildcards", () => {
  // Reversing the order would re-escape the backslashes added by the wildcard
  // pass, turning `\%` into `\\%` — a literal backslash followed by a wildcard.
  assert.equal(escapeLikeTerm("a\\b"), "a\\\\b");
  assert.equal(escapeLikeTerm("\\%"), "\\\\\\%");
});

test("orFilterLiteral quotes and escapes", () => {
  assert.equal(orFilterLiteral("plain"), '"plain"');
  assert.equal(orFilterLiteral('a"b'), '"a\\"b"');
  assert.equal(orFilterLiteral("a\\b"), '"a\\\\b"');
});

test("orIlikeContains contains the comma that used to split the filter", () => {
  // The live 400: or=(title.ilike.%a,b%) -> PGRST100 unexpected "%".
  const out = orIlikeContains(["title"], "a,b");
  assert.equal(out, 'title.ilike."%a,b%"');
  // The comma is inside the quotes, so it cannot start a new condition.
  assert.match(out, /^title\.ilike\."[^"]*"$/);
});

test("orIlikeContains defeats the appended-disjunct injection", () => {
  // The live parse success: or=(title.ilike.%a%),or(id.gt.0) — the trailing
  // text became a second disjunct and broadened the result set.
  const out = orIlikeContains(["title"], "a%),or(id.gt.0");
  // TWO layers of unescaping stand between this string and the LIKE pattern, so
  // the backslash is doubled: PostgREST turns \\ back into \ when it unquotes,
  // and only then does Postgres see \% and read it as a literal percent sign.
  assert.equal(out, 'title.ilike."%a\\\\%),or(id.gt.0%"');
  assert.ok(!/^[^"]*\)/.test(out), "no unquoted paren escapes the condition");
});

test("orIlikeContains spans every column with one escaped value", () => {
  assert.equal(
    orIlikeContains(["title", "folder", "reference"], "q"),
    'title.ilike."%q%",folder.ilike."%q%",reference.ilike."%q%"'
  );
});

test("orIlikeContains rejects a column name that is not an identifier", () => {
  assert.throws(() => orIlikeContains(["title,id.gt.0"], "q"), /unsafe column name/);
  assert.throws(() => orIlikeContains([], "q"), /no columns given/);
});

test("orIlikeAnyOf matches one column against many terms", () => {
  assert.equal(
    orIlikeAnyOf("source_page", ["a.example", "b.example"]),
    'source_page.ilike."%a.example%",source_page.ilike."%b.example%"'
  );
});

test("orIlikeAnyOf escapes each term independently", () => {
  // A full stop is filter syntax outside quotes; a hostname is mostly full stops.
  assert.equal(orIlikeAnyOf("source_page", ["a,b"]), 'source_page.ilike."%a,b%"');
  assert.throws(() => orIlikeAnyOf("col,x", ["a"]), /unsafe column name/);
  assert.throws(() => orIlikeAnyOf("col", []), /no terms given/);
});
