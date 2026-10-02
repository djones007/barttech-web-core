import { test } from "node:test";
import assert from "node:assert/strict";
import { buildSafetyNet, maskEmail, normaliseSafetyNetKind, safetyNetCopyText, SAFETY_NET_KINDS, KEEP_NOTE, PRIVATE_NOTE } from "./safetyNet";
import { buildTicketPdf } from "./ticketPdf";

const base = { brandName: "Acme", productName: "The Thing", orderRef: "AB12CD34", email: "jo@example.com", supportEmail: "help@acme.test" };

test("every kind, including an unknown one, produces a usable block with the order ref, steps, keep note and support line", () => {
  for (const kind of [...SAFETY_NET_KINDS, "something_new", "", null, undefined]) {
    const m = buildSafetyNet({ ...base, kind });
    assert.ok(m.title.length > 0, String(kind));
    assert.ok(m.rows.some((r) => r.label === "Order ref" && r.value === "AB12CD34"), String(kind));
    assert.ok(m.steps.length >= 2, String(kind));
    assert.equal(m.keepNote, KEEP_NOTE);
    assert.match(m.supportLine, /help@acme\.test/);
    assert.match(m.supportLine, /AB12CD34/);
  }
  assert.equal(normaliseSafetyNetKind("something_new"), "other");
});

test("a claim code or link makes the private note appear, and nothing else does", () => {
  assert.equal(buildSafetyNet({ ...base, kind: "game_licence" }).privateNote, null);
  assert.equal(buildSafetyNet({ ...base, kind: "game_licence", claimCode: "STILL-ABCD-EFGH" }).privateNote, PRIVATE_NOTE);
  const m = buildSafetyNet({ ...base, kind: "game_licence", claimCode: "STILL-ABCD-EFGH", claimUrl: "https://x.test/redeem?code=STILL-ABCD-EFGH" });
  assert.ok(m.rows.some((r) => r.style === "code" && r.value === "STILL-ABCD-EFGH"));
  assert.ok(m.rows.some((r) => r.style === "link"));
  assert.equal(m.hasClaim, true);
});

test("pre-sale: the opening time is a row and a step, and the title is a game pass", () => {
  const m = buildSafetyNet({ ...base, kind: "game_licence", opensWhen: "Saturday 10 October at 6pm UK time", claimCode: "C" });
  assert.equal(m.title, "Your game pass");
  assert.ok(m.rows.some((r) => r.label === "Opens" && /Saturday 10 October/.test(r.value)));
  assert.ok(m.steps.some((s) => /Saturday 10 October/.test(s)));
  assert.equal(buildSafetyNet({ ...base, kind: "game_licence" }).title, "Your game pass");
});

test("no support address falls back to replying to the brand's email, never an empty string", () => {
  const m = buildSafetyNet({ ...base, supportEmail: null, kind: "none" });
  assert.match(m.supportLine, /Reply to any email from Acme/);
});

test("hostile or oversized input is flattened and capped, never carried into the model raw", () => {
  const m = buildSafetyNet({ ...base, productName: "A\nB\u0000" + "x".repeat(500), kind: "none", note: "n\n" + "y".repeat(900) });
  assert.ok(![...m.headline].some((c) => (c.codePointAt(0) ?? 0) < 32));
  assert.ok(m.headline.length <= 160);
  assert.ok((m.note ?? "").length <= 400);
});

test("copy text carries the same facts as the model", () => {
  const m = buildSafetyNet({ ...base, kind: "game_licence", claimCode: "STILL-ABCD-EFGH", claimUrl: "https://x.test/r" });
  const t = safetyNetCopyText(m, "Acme");
  for (const r of m.rows) assert.ok(t.includes(`${r.label}: ${r.value}`), r.label);
  assert.ok(t.includes(PRIVATE_NOTE));
  assert.ok(t.includes("1. "));
});

test("maskEmail hides the middle of the local part and keeps the domain", () => {
  assert.equal(maskEmail("jonathan@gmail.com"), "j******@gmail.com");
  assert.match(maskEmail("jo@x.co"), /^j\*+@x\.co$/);
  assert.equal(maskEmail("nope"), "");
  assert.equal(maskEmail(null), "");
});

// ---- the PDF ----

function structure(pdf: Uint8Array) {
  const s = new TextDecoder().decode(pdf);
  assert.ok(s.startsWith("%PDF-1.4\n"));
  assert.ok(s.trimEnd().endsWith("%%EOF"));
  const startxref = Number(/startxref\n(\d+)\n%%EOF/.exec(s)![1]);
  assert.equal(s.slice(startxref, startxref + 4), "xref");
  const entries = [...s.slice(startxref).matchAll(/^(\d{10}) 00000 n $/gm)].map((e) => Number(e[1]));
  assert.equal(entries.length, 10);
  entries.forEach((off, i) => assert.equal(s.slice(off, off + `${i + 1} 0 obj`.length), `${i + 1} 0 obj`, `object ${i + 1} offset`));
  const len = Number(/<< \/Length (\d+) >>\nstream\n/.exec(s)![1]);
  const start = s.indexOf("stream\n") + 7;
  assert.equal(s.slice(start + len, start + len + 10), "\nendstream");
  assert.ok(![...s].some((c) => (c.codePointAt(0) ?? 0) > 127), "the file is pure ASCII");
  return s;
}

test("the PDF is structurally valid: header, xref offsets, stream length, trailer", () => {
  const m = buildSafetyNet({ ...base, kind: "game_licence", opensWhen: "Saturday 10 October at 6pm UK time", claimCode: "STILL-ABCD-EFGH", claimUrl: "https://example.test/redeem?code=STILL-ABCD-EFGH" });
  structure(buildTicketPdf("Acme", m));
});

test("the PDF is valid for every kind, with and without a QR, with long and non-ASCII text", () => {
  const qr = Array.from({ length: 29 }, (_, r) => Array.from({ length: 29 }, (_, c) => (r * 7 + c * 3) % 5 < 2));
  for (const kind of [...SAFETY_NET_KINDS, "weird"]) {
    const m = buildSafetyNet({ ...base, kind, productName: "Café “Quoted” — £5 €5 日本 " + "long ".repeat(40), claimCode: kind === "game_licence" ? "STILL-ABCD-EFGH" : null, claimUrl: kind === "game_licence" ? "https://example.test/" + "a".repeat(200) : null });
    structure(buildTicketPdf("Acme & Co", m, { qr: kind === "game_licence" ? qr : null, footer: "Created today", palette: { accent: "#ff8800" } }));
  }
});

test("a QR adds the matrix, no QR adds none", () => {
  const m = buildSafetyNet({ ...base, kind: "game_licence", claimCode: "C", claimUrl: "https://x.test/r" });
  const qr = Array.from({ length: 21 }, () => Array.from({ length: 21 }, () => true));
  const withQr = new TextDecoder().decode(buildTicketPdf("Acme", m, { qr }));
  const without = new TextDecoder().decode(buildTicketPdf("Acme", m));
  assert.ok(withQr.length > without.length + 100);
  assert.ok(withQr.includes("0.000 0.000 0.000 rg"));
});

test("the printed code is in the PDF text (hex of Courier line), so it can be typed from paper", () => {
  const m = buildSafetyNet({ ...base, kind: "game_licence", claimCode: "STILL-ABCD-EFGH" });
  const s = new TextDecoder().decode(buildTicketPdf("Acme", m));
  const hexCode = Buffer.from("STILL-ABCD-EFGH").toString("hex");
  assert.ok(s.toLowerCase().includes(`<${hexCode}>`));
});
