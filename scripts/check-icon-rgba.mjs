#!/usr/bin/env node
/**
 * Gate: app-router icon files must be RGBA.
 *
 * WHY THIS EXISTS
 * Next.js processes the app router's metadata icon files (`favicon.ico`, `icon.png`,
 * `apple-icon.png`, numbered variants) at build time and rejects a PNG that is not RGBA. On a
 * live site a favicon drawn in RGB failed the Vercel build, and because only the build failed,
 * production silently stayed on the previous deployment: the push looked fine and nothing
 * shipped. This runs as a prebuild step, so the failure is immediate, local, and names the file.
 *
 * WHAT IT CHECKS
 * Every `favicon*.ico`, `icon*.png` and `apple-icon*.png` anywhere under `app/` or `src/app/`:
 *   - PNG: IHDR colour type must be 6 (truecolour + alpha).
 *   - ICO: every embedded image must be RGBA — a PNG entry with colour type 6, or a BMP entry at
 *     32 bits per pixel.
 * Files under `public/` are not processed by Next's icon pipeline and are not checked.
 *
 * Fix: re-save as RGBA (Pillow: `.convert("RGBA")` before `.save`; the scaffold ships
 * `scripts/make-favicon.py`, which always does).
 *
 * Usage: node check-icon-rgba.mjs [repoDir]. No git needed (runs where `vercel --prod` uploads
 * without .git).
 */
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join, resolve, relative } from "node:path";

const ROOT = resolve(process.argv.slice(2).find((a) => !a.startsWith("--")) ?? process.cwd());
const ICON_NAME = /^(favicon\d*\.ico|icon\d*\.png|apple-icon\d*\.png)$/i;
const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const COLOUR = { 0: "greyscale", 2: "RGB", 3: "palette", 4: "greyscale+alpha", 6: "RGBA" };

function findIcons(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name.startsWith(".")) continue;
    const full = join(dir, name);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) findIcons(full, out);
    else if (ICON_NAME.test(name)) out.push(full);
  }
  return out;
}

/** Returns a problem string, or null when the PNG buffer is RGBA. */
function pngProblem(buf) {
  if (buf.length < 26 || !buf.subarray(0, 8).equals(PNG_SIG)) return "not a valid PNG";
  const type = buf[25];
  return type === 6 ? null : `PNG colour type ${type} (${COLOUR[type] ?? "unknown"}), needs 6 (RGBA)`;
}

function icoProblems(buf) {
  if (buf.length < 6 || buf.readUInt16LE(0) !== 0 || buf.readUInt16LE(2) !== 1) {
    // Some tools write a PNG with an .ico name; judge it as the PNG it is.
    if (buf.subarray(0, 8).equals(PNG_SIG)) {
      const p = pngProblem(buf);
      return p ? [p] : [];
    }
    return ["not a valid ICO file"];
  }
  const count = buf.readUInt16LE(4);
  const problems = [];
  for (let i = 0; i < count; i++) {
    const e = 6 + i * 16;
    if (e + 16 > buf.length) {
      problems.push(`entry ${i}: truncated directory`);
      break;
    }
    const w = buf[e] || 256;
    const bitCount = buf.readUInt16LE(e + 6);
    const size = buf.readUInt32LE(e + 8);
    const offset = buf.readUInt32LE(e + 12);
    const img = buf.subarray(offset, offset + size);
    if (img.subarray(0, 8).equals(PNG_SIG)) {
      const p = pngProblem(img);
      if (p) problems.push(`${w}px entry: ${p}`);
    } else {
      // BMP entry: the BITMAPINFOHEADER's own bit count is authoritative (the directory's may be 0).
      const bpp = img.length >= 16 ? img.readUInt16LE(14) : bitCount;
      if (bpp !== 32) problems.push(`${w}px entry: BMP at ${bpp} bpp, needs 32 (RGBA)`);
    }
  }
  return problems;
}

const icons = [...findIcons(join(ROOT, "src", "app")), ...findIcons(join(ROOT, "app"))];
const findings = [];
for (const file of icons) {
  const buf = readFileSync(file);
  const problems = /\.ico$/i.test(file) ? icoProblems(buf) : [pngProblem(buf)].filter(Boolean);
  for (const p of problems) findings.push(`${relative(ROOT, file)}: ${p}`);
}

if (findings.length) {
  console.log(`::error::Icon gate FAILED — Next.js rejects non-RGBA app icons and the build fails (production silently stays on the old deploy).`);
  for (const f of findings) console.log(`  ${f}`);
  console.log('Re-save as RGBA, e.g. Pillow `.convert("RGBA")`, or run the scaffold\'s scripts/make-favicon.py.');
  process.exit(1);
}
console.log(`Icon gate: OK (${icons.length} app icon file(s), all RGBA).`);
