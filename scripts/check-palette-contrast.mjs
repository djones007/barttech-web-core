#!/usr/bin/env node
// ---------------------------------------------------------------------------
// Palette contrast gate (WCAG 2.1 AA) for HARDCODED colour pairs in source.
//
// WHY THIS EXISTS
// A form-field border shipped at 1.13:1 against the 3:1 WCAG 1.4.11 floor. It was
// invisible, and found only by a person noticing. The runtime `contrast.spec.ts`
// audits rendered TEXT; nothing checked a hardcoded control border or a literal
// foreground/background pair in source, and barttech-app-ui/contrast.ts solves a
// different problem (runtime colours from data). (CC task 7e8f23d2.)
//
// WHAT IT CHECKS (static, no rendering, so it only judges pairs it can SEE together)
//   1. CSS rule blocks (.css): `color` + `background(-color)` in one block      -> text, 4.5:1
//      (3:1 when the block sets font-size >= 24px). `border(-color)` + background
//      in a block whose selector names a form control (input, textarea, select,
//      .input, .field, .control)                                              -> border, 3:1
//   2. JSX style objects and Tailwind arbitrary classes (`text-[#abc] bg-[#def]`)
//      sitting together in one tag / one string. Border check applies only inside
//      <input|textarea|select> tags.
//   3. `.contrast-pairs.json` at the repo root: an explicit list for palettes that
//      live in a constants file the scanner cannot connect:
//        [{ "name": "muted on card", "fg": "#8a8f98", "bg": "#ffffff", "min": 4.5 }]
//      `min` defaults to 4.5.
//
// WHAT IT CANNOT DO (be honest about it): resolve a class like `text-gray-400` to a
// surface, or a colour inherited from a parent. Pairs split across elements are not
// seen. The rendered `contrast.spec.ts` stays the authority for those; this gate
// catches the literal pairs a render-time check only finds if the route is listed.
// Colours with alpha, `var()`, named colours and non-hex syntax are skipped, and
// the count is printed so the skip is visible.
//
// WAIVER: `contrast-ok: <reason>` on the same line, the line above, or inside the
// block. The reason is required (a bare `contrast-ok:` is itself a finding).
//
// Usage: node check-palette-contrast.mjs [dir]   (dir defaults to cwd)
// Plain Node, no dependencies. Consumers fetch it from raw.githubusercontent
// pinned to a web-core sha.
// ---------------------------------------------------------------------------
import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.argv[2] ? join(process.cwd(), process.argv[2]) : process.cwd();
const CONTROL_SEL = /\b(input|textarea|select)\b|\.(input|field|control|form-control)\b/i;
const SRC = /\.(css|tsx|jsx)$/i;
const SKIP = /(^|\/)(node_modules|\.next|web-core|src\/web-core|tests?|e2e|__tests__|\.testbuild)\//;

/** @returns {[number,number,number]|null} null = not a plain opaque hex colour */
export function parseHex(s) {
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(String(s).trim());
  if (!m) return null;
  let h = m[1];
  if (h.length === 3) h = [...h].map((c) => c + c).join("");
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
}
const lum = (rgb) => {
  const [r, g, b] = rgb.map((v) => { const c = v / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
export function ratio(a, b) {
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

const HEX = "#[0-9a-fA-F]{3,8}\\b";
const findings = [];
let checked = 0;
let skipped = 0;

function waived(text, idx, end) {
  // same line / line above / inside [idx,end]
  const lineStart = text.lastIndexOf("\n", text.lastIndexOf("\n", idx - 1) - 1) + 1;
  const region = text.slice(Math.max(0, lineStart), end);
  const m = /contrast-ok:\s*([^\n*]*)/.exec(region);
  if (!m) return { ok: false };
  return m[1].trim().length >= 3 ? { ok: true } : { ok: false, bare: true };
}

function judge(file, text, idx, end, label, fg, bg, min, kind) {
  const f = parseHex(fg), b = parseHex(bg);
  if (!f || !b) { skipped++; return; }
  checked++;
  const r = ratio(f, b);
  if (r + 1e-9 >= min) return;
  const w = waived(text, idx, end);
  if (w.ok) return;
  const line = text.slice(0, idx).split("\n").length;
  findings.push(`${file}:${line}: ${kind} ${fg} on ${bg} is ${r.toFixed(2)}:1, needs ${min}:1 (${label})${w.bare ? " [contrast-ok has no reason]" : ""}`);
}

/** hex value of the first matching property in a declaration list */
function decl(body, names) {
  for (const n of names) {
    const m = new RegExp(`(?:^|[;{\\s])${n}\\s*:\\s*([^;}]+)`, "i").exec(body);
    if (m) {
      const hx = new RegExp(HEX).exec(m[1]);
      if (hx) return hx[0];
      return "(non-hex)";
    }
  }
  return null;
}

function scanCss(file, text) {
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m;
  while ((m = re.exec(text))) {
    const sel = m[1].trim(), body = m[2];
    const idx = m.index + m[1].length - m[1].trimStart().length;
    const end = m.index + m[0].length;
    const bg = decl(body, ["background-color", "background"]);
    if (!bg) continue;
    const fg = decl(body, ["color"]);
    if (fg) {
      const fs = /font-size\s*:\s*(\d+(?:\.\d+)?)px/i.exec(body);
      judge(file, text, idx, end, sel, fg, bg, fs && Number(fs[1]) >= 24 ? 3 : 4.5, "text");
    }
    if (CONTROL_SEL.test(sel)) {
      const bd = decl(body, ["border-color", "border"]);
      if (bd) judge(file, text, idx, end, sel, bd, bg, 3, "control border");
    }
  }
}

/** Walk a balanced {...} starting at text[open] === "{"; returns index after the close. */
function balanced(text, open) {
  let d = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === "{") d++;
    else if (text[i] === "}" && --d === 0) return i + 1;
  }
  return text.length;
}

function scanJsx(file, text) {
  // Tag-level: Tailwind arbitrary classes + style objects inside one tag.
  const tag = /<([a-zA-Z][\w.]*)\b/g;
  let m;
  while ((m = tag.exec(text))) {
    // find the end of the opening tag, skipping {...} expressions
    let i = m.index + m[0].length;
    while (i < text.length) {
      if (text[i] === "{") i = balanced(text, i);
      else if (text[i] === ">") break;
      else i++;
    }
    const chunk = text.slice(m.index, i);
    const isControl = /^(input|textarea|select)$/i.test(m[1]);
    const tw = (p) => new RegExp(`(?:^|[\\s"'\`:])${p}-\\[(${HEX})\\]`).exec(chunk)?.[1] ?? null;
    const twText = tw("text"), twBg = tw("bg"), twBorder = tw("border");
    if (twText && twBg) judge(file, text, m.index, i, `<${m[1]}> classes`, twText, twBg, 4.5, "text");
    if (isControl && twBorder && twBg) judge(file, text, m.index, i, `<${m[1]}> classes`, twBorder, twBg, 3, "control border");
    // style={{ ... }}
    const sm = /style=\{\{([\s\S]*?)\}\}/.exec(chunk);
    if (sm) {
      const pick = (...ks) => { for (const k of ks) { const x = new RegExp(`\\b${k}\\s*:\\s*["'\`](${HEX})["'\`]`).exec(sm[1]); if (x) return x[1]; } return null; };
      const fg = pick("color"), bg = pick("backgroundColor", "background"), bd = pick("borderColor");
      if (fg && bg) judge(file, text, m.index, i, `<${m[1]}> style`, fg, bg, 4.5, "text");
      if (isControl && bd && bg) judge(file, text, m.index, i, `<${m[1]}> style`, bd, bg, 3, "control border");
    }
  }
}

function trackedFiles() {
  try {
    return execSync("git ls-files", { cwd: ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }).split("\n").filter(Boolean);
  } catch { return []; }
}

if (process.env.CONTRAST_GATE_NO_MAIN !== "1") {
  const files = trackedFiles().filter((f) => SRC.test(f) && !SKIP.test(f));
  for (const f of files) {
    const p = join(ROOT, f);
    if (!existsSync(p)) continue;
    const text = readFileSync(p, "utf8");
    if (/\.css$/i.test(f)) scanCss(f, text);
    else scanJsx(f, text);
  }
  const pairsFile = join(ROOT, ".contrast-pairs.json");
  if (existsSync(pairsFile)) {
    let pairs;
    try { pairs = JSON.parse(readFileSync(pairsFile, "utf8")); } catch (e) { pairs = null; findings.push(`.contrast-pairs.json: not valid JSON (${e.message})`); }
    if (pairs && !Array.isArray(pairs)) findings.push(".contrast-pairs.json: must be an array");
    for (const p of Array.isArray(pairs) ? pairs : []) {
      if (!p || !parseHex(p.fg) || !parseHex(p.bg)) { findings.push(`.contrast-pairs.json: "${p?.name}" needs opaque hex fg and bg`); continue; }
      judge(".contrast-pairs.json", "", 0, 0, p.name ?? "pair", p.fg, p.bg, p.min ?? 4.5, "pair");
    }
  }
  if (findings.length) {
    console.log("::error::Palette contrast gate FAILED — a hardcoded colour pair is below WCAG 2.1 AA (4.5:1 text, 3:1 control borders/large text).");
    for (const f of findings) console.log("  " + f);
    console.log("Fix the colour, or waive a deliberate case with `contrast-ok: <reason>` in/above the block.");
    process.exit(1);
  }
  console.log(`Palette contrast gate: OK (${checked} pair(s) measured, ${skipped} skipped as non-hex/alpha/var).`);
}
