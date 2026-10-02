import { test } from "node:test";
import assert from "node:assert/strict";
import { suggestEmailCorrection, isValidEmail } from "./validation";

const s = (e: string) => suggestEmailCorrection(e)?.suggestion ?? null;

test("common provider typos are corrected", () => {
  assert.equal(s("jo@hotmial.com"), "jo@hotmail.com");
  assert.equal(s("jo@hotmai.com"), "jo@hotmail.com");
  assert.equal(s("jo@gmial.com"), "jo@gmail.com");
  assert.equal(s("jo@gmal.com"), "jo@gmail.com");
  assert.equal(s("jo@gmaill.com"), "jo@gmail.com");
  assert.equal(s("jo@yahooo.com"), "jo@yahoo.com");
  assert.equal(s("jo@outlok.com"), "jo@outlook.com");
  assert.equal(s("jo@iclod.com"), "jo@icloud.com");
  assert.equal(s("jo@gmmal.com"), null); // two edits: not sure enough to suggest
  assert.equal(s("jo@icloud.cmo"), "jo@icloud.com");
});

test("top-level-domain slips are corrected", () => {
  assert.equal(s("jo@gmail.con"), "jo@gmail.com");
  assert.equal(s("jo@hotmail.co.k"), "jo@hotmail.co.uk");
  assert.equal(s("jo@yahoo.co.k"), "jo@yahoo.co.uk");
  assert.equal(s("jo@gmial.con"), "jo@gmail.com");
  assert.equal(s("jo@outlook.con"), "jo@outlook.com");
  assert.equal(s("jo@gmail.co"), "jo@gmail.com");
  assert.equal(s("jo@hotmail.co"), "jo@hotmail.com");
  assert.equal(s("jo@mycompany.con"), "jo@mycompany.com");
  assert.equal(s("jo@mycompany.co.k"), "jo@mycompany.co.uk");
});

test("a correct or unknown address gets no suggestion", () => {
  for (const e of ["jo@gmail.com", "jo@hotmail.co.uk", "jo@outlook.com", "jo@mycompany.co.uk", "jo@mycompany.com", "jo@company.co", "jo@example.cm", "jo@mail.com", "jo@email.com", "jo@ymail.com", "jo@aol.com", "jo@live.co.uk", "jo@proton.me", "jo@yahoo.co.jp"]) {
    assert.equal(s(e), null, e);
  }
});

test("mail.com and email.com are real, not typos of gmail.com", () => {
  assert.equal(s("a@mail.com"), null);
  assert.equal(s("a@email.com"), null);
});

test("the part before the @ keeps its case and the domain is matched case-insensitively", () => {
  assert.equal(s("Jo.Smith+x@HOTMIAL.COM"), "Jo.Smith+x@hotmail.com");
  assert.equal(s("  jo@gmial.com  "), "jo@gmail.com");
});

test("the suggested domain is reported alone for the prompt", () => {
  assert.deepEqual(suggestEmailCorrection("jo@hotmial.com"), { suggestion: "jo@hotmail.com", domain: "hotmail.com" });
});

test("garbage in never throws and never suggests", () => {
  for (const e of [undefined, null, 5, "", "nope", "@gmial.com", "a@@gmial.com", "a@b@gmial.com", "a@gmial", "a b@gmial.com", "x".repeat(300) + "@gmial.com"]) {
    assert.equal(suggestEmailCorrection(e), null, String(e));
  }
});

test("every suggestion is itself a valid address", () => {
  for (const e of ["jo@hotmial.com", "jo@gmail.con", "jo@yahoo.co.k", "jo@outlok.com"]) {
    assert.equal(isValidEmail(suggestEmailCorrection(e)?.suggestion), true, e);
  }
});
