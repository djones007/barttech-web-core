import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import {
  fbcFromStoredClick,
  hashedCapiIdentity,
  normaliseCountry,
  normalisePhone,
} from "./metaCapiUserData";

const h = (s: string) => createHash("sha256").update(s).digest("hex");

test("email is trimmed and lower-cased before hashing", () => {
  assert.equal(hashedCapiIdentity({ email: "  Jane.Doe@Example.COM " }).em, h("jane.doe@example.com"));
});

test("names are trimmed and lower-cased before hashing", () => {
  const u = hashedCapiIdentity({ firstName: " Jane ", lastName: "DOE" });
  assert.equal(u.fn, h("jane"));
  assert.equal(u.ln, h("doe"));
});

test("an empty value is dropped, never hashed", () => {
  const u = hashedCapiIdentity({ email: "   ", firstName: "", phone: "n/a", externalId: " " });
  assert.deepEqual(u, {});
});

test("a national phone number gets the default country code in place of the trunk 0", () => {
  assert.equal(normalisePhone("01234 567 890", "44"), "441234567890");
});

test("an international phone number keeps its own country code", () => {
  assert.equal(normalisePhone("+1 (415) 555-0100", "44"), "14155550100");
  assert.equal(normalisePhone("0033 1 23 45 67 89", "44"), "33123456789");
});

test("without a default country code a national number is left as digits", () => {
  assert.equal(normalisePhone("020 7946 0000"), "02079460000");
});

test("phone is hashed after normalisation", () => {
  assert.equal(hashedCapiIdentity({ phone: "07700 900123", phoneCountryCode: "44" }).ph, h("447700900123"));
});

test("country must be a two-letter code", () => {
  assert.equal(normaliseCountry(" GB "), "gb");
  assert.equal(normaliseCountry("GBR"), "");
  assert.equal(hashedCapiIdentity({ country: "GB" }).country, h("gb"));
});

test("external id is hashed as given (trimmed, case kept)", () => {
  assert.equal(hashedCapiIdentity({ externalId: " AbC-1 " }).external_id, h("AbC-1"));
});

test("fbc from a stored click uses the CLICK time, not now", () => {
  assert.equal(fbcFromStoredClick("IwAR123", 1757000000000), "fb.1.1757000000000.IwAR123");
  assert.equal(fbcFromStoredClick("", 1757000000000), undefined);
  assert.equal(fbcFromStoredClick("IwAR123", Number.NaN), undefined);
});
