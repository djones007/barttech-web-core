// ---------------------------------------------------------------------------
// A one-page ticket PDF, written by hand: no library, no network, no paid API. Built from a
// SafetyNetModel (safetyNet.ts) so the PDF, the page and the "copy details" text always agree.
//
// Standard fonts only (Helvetica, Times, Courier: every PDF reader has them), WinAnsi text, A4,
// optional QR (the caller passes the module matrix; this file does not generate QR codes, so it
// carries no dependency). The caller sets the colours from its brand, so the file matches the
// product it is for.
//
// The PDF holds a bearer code when the model has one: the route that serves it must send
// `Cache-Control: private, no-store` and authorise the caller first.
// ---------------------------------------------------------------------------

import type { SafetyNetModel } from "./safetyNet";

export interface TicketPalette {
  bg: string;
  panel: string;
  text: string;
  muted: string;
  accent: string;
}

export const DEFAULT_TICKET_PALETTE: TicketPalette = { bg: "#15110d", panel: "#211b15", text: "#f1ebe0", muted: "#a89b88", accent: "#d9a85a" };

export interface TicketPdfOptions {
  palette?: Partial<TicketPalette>;
  /** QR module matrix (true = dark), e.g. from the `qrcode` package's `create(...).modules`. */
  qr?: boolean[][] | null;
  qrCaption?: string;
  /** Shown small at the foot ("Created 2 October 2026"). */
  footer?: string;
}

const W = 595.28;
const H = 841.89;
const M = 48;

// Helvetica advance widths for 32..126 (per 1000 em), from the standard AFM metrics.
const HELV = [278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556, 1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556, 333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556, 556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584];

function textWidth(s: string, size: number, bold = false): number {
  let w = 0;
  for (const ch of s) {
    const c = ch.codePointAt(0) ?? 63;
    w += c >= 32 && c <= 126 ? HELV[c - 32] : 556;
  }
  return (w / 1000) * size * (bold ? 1.08 : 1) * 1.02;
}

/** Break on spaces to a width; a token longer than the line (a URL) is broken by character. */
function wrap(s: string, size: number, maxW: number, bold = false): string[] {
  const out: string[] = [];
  let line = "";
  const push = () => {
    if (line) out.push(line);
    line = "";
  };
  for (const word of s.split(/\s+/).filter(Boolean)) {
    let w = word;
    while (textWidth(w, size, bold) > maxW) {
      let cut = w.length - 1;
      while (cut > 1 && textWidth(w.slice(0, cut), size, bold) > maxW) cut--;
      push();
      out.push(w.slice(0, cut));
      w = w.slice(cut);
    }
    const next = line ? `${line} ${w}` : w;
    if (textWidth(next, size, bold) <= maxW) line = next;
    else {
      push();
      line = w;
    }
  }
  push();
  return out;
}

const WIN_ANSI: Record<number, number> = {
  0x20ac: 0x80, 0x201a: 0x82, 0x0192: 0x83, 0x201e: 0x84, 0x2026: 0x85, 0x2020: 0x86, 0x2021: 0x87, 0x02c6: 0x88, 0x2030: 0x89, 0x0160: 0x8a, 0x2039: 0x8b, 0x0152: 0x8c, 0x017d: 0x8e,
  0x2018: 0x91, 0x2019: 0x92, 0x201c: 0x93, 0x201d: 0x94, 0x2022: 0x95, 0x2013: 0x96, 0x2014: 0x97, 0x02dc: 0x98, 0x2122: 0x99, 0x0161: 0x9a, 0x203a: 0x9b, 0x0153: 0x9c, 0x017e: 0x9e, 0x0178: 0x9f,
};

/** A PDF hex string of the text in WinAnsi: no escaping needed, and nothing outside ASCII in the file. */
function hex(s: string): string {
  let out = "";
  for (const ch of s) {
    const c = ch.codePointAt(0) ?? 63;
    let b = 63;
    if (c >= 32 && c <= 126) b = c;
    else if (c >= 0xa0 && c <= 0xff) b = c;
    else if (WIN_ANSI[c] !== undefined) b = WIN_ANSI[c];
    out += b.toString(16).padStart(2, "0");
  }
  return `<${out}>`;
}

function rgb(hexColor: string): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hexColor.trim());
  const v = m ? m[1] : "000000";
  const n = [0, 2, 4].map((i) => (parseInt(v.slice(i, i + 2), 16) / 255).toFixed(3));
  return n.join(" ");
}

const n2 = (n: number) => n.toFixed(2);

type FontKey = "F1" | "F2" | "F3" | "F4" | "F5";
const FONTS: Record<FontKey, string> = { F1: "Helvetica", F2: "Helvetica-Bold", F3: "Times-Roman", F4: "Times-Bold", F5: "Courier-Bold" };

export function buildTicketPdf(brandName: string, m: SafetyNetModel, opts: TicketPdfOptions = {}): Uint8Array {
  const pal: TicketPalette = { ...DEFAULT_TICKET_PALETTE, ...(opts.palette ?? {}) };
  const ops: string[] = [];
  const fill = (color: string, x: number, y: number, w: number, h: number) => ops.push(`${rgb(color)} rg ${n2(x)} ${n2(y)} ${n2(w)} ${n2(h)} re f`);
  const text = (font: FontKey, size: number, color: string, x: number, y: number, s: string, spacing = 0) =>
    ops.push(`BT /${font} ${size} Tf ${rgb(color)} rg ${spacing} Tc 1 0 0 1 ${n2(x)} ${n2(y)} Tm ${hex(s)} Tj ET`);

  fill(pal.bg, 0, 0, W, H);
  fill(pal.accent, 0, H - 10, W, 10);

  let y = H - 56;
  text("F2", 10, pal.accent, M, y, brandName.toUpperCase().slice(0, 60), 2);
  y -= 40;
  text("F4", 32, pal.text, M, y, m.title.slice(0, 40));
  y -= 28;
  for (const line of wrap(m.headline, 15, W - 2 * M).slice(0, 2)) {
    text("F3", 15, pal.muted, M, y, line);
    y -= 20;
  }
  y -= 6;
  fill(pal.accent, M, y, 54, 2);
  y -= 26;

  const qr = opts.qr && opts.qr.length ? opts.qr : null;
  const qrSize = 150;
  const colW = qr ? W - 2 * M - qrSize - 24 : W - 2 * M;
  const rowsTop = y;

  for (const r of m.rows) {
    text("F2", 8, pal.muted, M, y, r.label.toUpperCase(), 1.2);
    y -= 17;
    if (r.style === "code") {
      text("F5", 24, pal.accent, M, y - 2, r.value.slice(0, 40));
      y -= 30;
    } else if (r.style === "link") {
      for (const line of wrap(r.value, 9.5, colW)) {
        text("F1", 9.5, pal.text, M, y, line);
        y -= 12.5;
      }
      y -= 8;
    } else {
      for (const line of wrap(r.value, 12, colW, true)) {
        text("F2", 12, pal.text, M, y, line);
        y -= 15;
      }
      y -= 6;
    }
  }

  if (qr) {
    const x0 = W - M - qrSize;
    const y0 = rowsTop - qrSize + 4;
    fill("#ffffff", x0 - 8, y0 - 8, qrSize + 16, qrSize + 16 + 14);
    const cells = qr.length;
    const cell = qrSize / cells;
    ops.push(`${rgb("#000000")} rg`);
    for (let row = 0; row < cells; row++) {
      let runStart = -1;
      for (let col = 0; col <= cells; col++) {
        const dark = col < cells && !!qr[row][col];
        if (dark && runStart < 0) runStart = col;
        if (!dark && runStart >= 0) {
          ops.push(`${n2(x0 + runStart * cell)} ${n2(y0 + qrSize - (row + 1) * cell)} ${n2((col - runStart) * cell + 0.15)} ${n2(cell + 0.15)} re f`);
          runStart = -1;
        }
      }
    }
    const cap = (opts.qrCaption ?? "Scan to claim").slice(0, 30);
    text("F2", 8, "#333333", x0 + (qrSize - textWidth(cap, 8, true)) / 2, y0 + qrSize + 6, cap);
    y = Math.min(y, y0 - 24);
  }

  y -= 20;
  text("F4", 17, pal.text, M, y, "How to get in");
  y -= 22;
  m.steps.forEach((s, i) => {
    const lines = wrap(s, 11, W - 2 * M - 26);
    text("F2", 11, pal.accent, M, y, `${i + 1}.`);
    for (const line of lines) {
      text("F1", 11, pal.text, M + 26, y, line);
      y -= 15;
    }
    y -= 4;
  });
  if (m.note) {
    y -= 4;
    for (const line of wrap(m.note, 10.5, W - 2 * M)) {
      text("F1", 10.5, pal.muted, M, y, line);
      y -= 14;
    }
  }

  y -= 12;
  const keepLines = wrap(m.keepNote, 10.5, W - 2 * M - 28, true);
  const privLines = m.privateNote ? wrap(m.privateNote, 10, W - 2 * M - 28, true) : [];
  const boxH = 18 + (keepLines.length + privLines.length) * 14 + (privLines.length ? 6 : 0);
  fill(pal.panel, M, y - boxH + 12, W - 2 * M, boxH);
  fill(pal.accent, M, y - boxH + 12, 3, boxH);
  let by = y - 6;
  for (const line of keepLines) {
    text("F2", 10.5, pal.text, M + 16, by, line);
    by -= 14;
  }
  if (privLines.length) {
    by -= 6;
    for (const line of privLines) {
      text("F2", 10, pal.accent, M + 16, by, line);
      by -= 14;
    }
  }
  y -= boxH + 10;

  for (const line of wrap(m.supportLine, 10.5, W - 2 * M)) {
    text("F1", 10.5, pal.muted, M, y, line);
    y -= 14;
  }
  text("F1", 8, pal.muted, M, 34, (opts.footer ?? "").slice(0, 100));

  // ---- assemble: catalog, pages, page, content, five fonts, info ----
  const content = ops.join("\n");
  const objs: string[] = [];
  objs[1] = "<< /Type /Catalog /Pages 2 0 R >>";
  objs[2] = "<< /Type /Pages /Kids [3 0 R] /Count 1 >>";
  objs[3] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${n2(W)} ${n2(H)}] /Resources << /Font << ${(Object.keys(FONTS) as FontKey[]).map((k, i) => `/${k} ${5 + i} 0 R`).join(" ")} >> >> /Contents 4 0 R >>`;
  objs[4] = `<< /Length ${content.length} >>\nstream\n${content}\nendstream`;
  (Object.keys(FONTS) as FontKey[]).forEach((k, i) => {
    objs[5 + i] = `<< /Type /Font /Subtype /Type1 /BaseFont /${FONTS[k]} /Encoding /WinAnsiEncoding >>`;
  });
  const titleUtf16 = `<FEFF${Array.from(`${brandName}: ${m.title}`.slice(0, 80)).map((ch) => (ch.codePointAt(0)! & 0xffff).toString(16).padStart(4, "0")).join("")}>`;
  objs[10] = `<< /Title ${titleUtf16} /Producer ${hex("web-core ticketPdf")} >>`;

  let pdf = "%PDF-1.4\n";
  const offsets: number[] = [];
  for (let i = 1; i <= 10; i++) {
    offsets[i] = pdf.length;
    pdf += `${i} 0 obj\n${objs[i]}\nendobj\n`;
  }
  const xrefAt = pdf.length;
  pdf += `xref\n0 11\n0000000000 65535 f \n`;
  for (let i = 1; i <= 10; i++) pdf += `${String(offsets[i]).padStart(10, "0")} 00000 n \n`;
  pdf += `trailer\n<< /Size 11 /Root 1 0 R /Info 10 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`;
  return new TextEncoder().encode(pdf);
}
