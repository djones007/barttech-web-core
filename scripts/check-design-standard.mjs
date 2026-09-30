#!/usr/bin/env node
// ---------------------------------------------------------------------------
// Design-standard gate (ratcheted).
//
// WHY THIS EXISTS
// The estate's website design standard bans the default AI/Tailwind
// look: stock slate/zinc/gray greys, an indigo/purple gradient, `rounded-xl`
// on everything, stock `shadow-sm/md/lg`, and hex literals in components
// instead of CSS-variable tokens. Until 2026-09-30 the only enforcement was a
// manual pre-ship grep, and a manual step is a step that gets skipped: on
// 2026-09-24 three live marketing sites carried 676, 107 and 80 stock
// slate/gray/zinc uses. A twice-skipped rule becomes a gate
// (memory/feedback_mechanical_rule_gates.md).
//
// WHY A RATCHET, NOT A BAN
// Failing on every existing hit would block every build on every site the day
// this lands, and a gate that blocks everything is switched off within a week.
// So each repo commits `.design-standard-baseline.json` (per rule, per file,
// the hit count today). The gate fails only when a file has MORE hits of a
// rule than its baseline — new debt. Fewer hits prints a notice to re-run with
// `--write-baseline`, which lowers the ceiling for good. Deleting a file's
// entry is how a cleaned-up file becomes zero-tolerance.
//
// THE RULES (the standard's pre-ship grep, plus check 7)
//   stock-palette  (bg|text|border|ring|divide|from|via|to)-(slate|zinc|gray)-N
//   ai-gradient    from-(indigo|purple)-
//   stock-radius   rounded[-side]-(xl|2xl|3xl)   — outside the 3-value radius budget
//   stock-shadow   shadow-(sm|md|lg)
//   hex-literal    a #rgb/#rrggbb colour in a .tsx/.jsx component (tokens live
//                  in CSS). OG/icon image routes and email templates (any path
//                  containing "email") are exempt: neither can use a stylesheet.
// The `(?<![\w-])` lookbehind is the word boundary the standard warns about: a
// naive `slate-` also matches `translate-x-4`.
//
// WHAT THIS GATE CANNOT SEE
// A computed style, a colour from the database, or a class built by string
// concatenation (`"bg-" + tone + "-100"`). The screenshot checks (1, 3, 6, 8)
// stay manual; this covers only the greppable half of the standard.
//
// USAGE
//   node check-design-standard.mjs [repoRoot]                 check against baseline
//   node check-design-standard.mjs [repoRoot] --write-baseline  record today's counts
//   node check-design-standard.mjs --self-test
// Scans <repoRoot>/src (or <repoRoot>/app + components when there is no src/).
// Skips node_modules, .next, the web-core and app-ui mounts, and *.test.* files.
// ---------------------------------------------------------------------------
import { readFileSync, writeFileSync, readdirSync, statSync, existsSync, mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { tmpdir } from "node:os";

const BASELINE_FILE = ".design-standard-baseline.json";
const EXTS = /\.(tsx|jsx|ts|js|mjs|css|mdx)$/;
const COMPONENT_EXTS = /\.(tsx|jsx)$/;
const SKIP_DIRS = new Set(["node_modules", ".next", ".git", "web-core", "barttech-web-core", "app-ui", "dist", "build", ".testbuild"]);
// Satori (next/og ImageResponse) routes have no stylesheet, and email HTML must inline its
// colours (clients strip <style> and never see CSS variables), so hex is required in both.
const HEX_EXEMPT = /(^|\/)(opengraph-image|twitter-image|icon|apple-icon)(\.[a-z0-9-]+)?\.(tsx|jsx)$|email/i;

export const RULES = [
  { id: "stock-palette", re: /(?<![\w-])(?:bg|text|border|ring|divide|from|via|to)-(?:slate|zinc|gray)-\d/g },
  { id: "ai-gradient", re: /(?<![\w-])from-(?:indigo|purple)-/g },
  { id: "stock-radius", re: /(?<![\w-])rounded(?:-(?:t|r|b|l|tl|tr|bl|br|s|e|ss|se|es|ee))?-(?:xl|2xl|3xl)(?![\w-])/g },
  { id: "stock-shadow", re: /(?<![\w-])shadow-(?:sm|md|lg)(?![\w-])/g },
  // A colour literal inside a string, template, arbitrary Tailwind value or style object.
  { id: "hex-literal", re: /(?<=["'`[(:\s,])#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3,4})(?![\w-])/g, componentsOnly: true },
];

function walk(dir, out) {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (EXTS.test(name) && !/\.test\.|\.spec\./.test(name)) out.push(p);
  }
  return out;
}

export function scan(root) {
  const dirs = existsSync(join(root, "src")) ? ["src"] : ["app", "components"].filter((d) => existsSync(join(root, d)));
  const counts = {};
  for (const d of dirs) {
    for (const file of walk(join(root, d), [])) {
      const rel = relative(root, file).split(sep).join("/");
      const text = readFileSync(file, "utf8");
      for (const rule of RULES) {
        if (rule.componentsOnly && (!COMPONENT_EXTS.test(rel) || HEX_EXEMPT.test(rel))) continue;
        const n = (text.match(rule.re) || []).length;
        if (!n) continue;
        (counts[rule.id] ||= {})[rel] = n;
      }
    }
  }
  return counts;
}

export function compare(counts, baseline) {
  const worse = [];
  const better = [];
  for (const rule of RULES) {
    const now = counts[rule.id] || {};
    const base = baseline[rule.id] || {};
    for (const [file, n] of Object.entries(now)) {
      const allowed = base[file] || 0;
      if (n > allowed) worse.push({ rule: rule.id, file, n, allowed });
    }
    for (const [file, allowed] of Object.entries(base)) {
      const n = now[file] || 0;
      if (n < allowed) better.push({ rule: rule.id, file, n, allowed });
    }
  }
  return { worse, better };
}

function sorted(counts) {
  const out = {};
  for (const rule of RULES) {
    const files = counts[rule.id];
    if (!files) continue;
    out[rule.id] = Object.fromEntries(Object.keys(files).sort().map((f) => [f, files[f]]));
  }
  return out;
}

function total(counts) {
  return Object.values(counts).reduce((s, files) => s + Object.values(files).reduce((a, b) => a + b, 0), 0);
}

function main(argv) {
  const root = argv.find((a) => !a.startsWith("--")) || ".";
  const counts = scan(root);
  const basePath = join(root, BASELINE_FILE);

  if (argv.includes("--write-baseline")) {
    writeFileSync(basePath, JSON.stringify(sorted(counts), null, 2) + "\n");
    console.log(`Design-standard baseline written: ${basePath} (${total(counts)} hit(s)).`);
    return 0;
  }

  const baseline = existsSync(basePath) ? JSON.parse(readFileSync(basePath, "utf8")) : {};
  const { worse, better } = compare(counts, baseline);
  for (const w of worse) {
    console.log(`::error file=${w.file}::design standard: ${w.rule} ${w.n} hit(s), baseline allows ${w.allowed}. Use the brand's CSS-variable tokens and declared radii (website design standard).`);
  }
  if (better.length) {
    console.log(`::notice::design standard: ${better.length} file/rule count(s) are below baseline. Run \`node check-design-standard.mjs . --write-baseline\` and commit ${BASELINE_FILE} to lock the improvement in.`);
  }
  if (worse.length) {
    console.log(`Design-standard gate FAILED: ${worse.length} file/rule count(s) above baseline.`);
    return 1;
  }
  console.log(`Design-standard gate OK — ${total(counts)} hit(s), none above baseline (${total(baseline)} baselined).`);
  return 0;
}

function selfTest() {
  const assert = (cond, msg) => { if (!cond) { console.error(`SELF-TEST FAIL: ${msg}`); process.exit(1); } };
  const dir = mkdtempSync(join(tmpdir(), "design-std-"));
  try {
    mkdirSync(join(dir, "src/app"), { recursive: true });
    mkdirSync(join(dir, "src/web-core"), { recursive: true });
    const page = join(dir, "src/app/page.tsx");
    writeFileSync(page, [
      `<div className="bg-slate-50 hover:text-gray-700 translate-x-4 rounded-xl rounded-t-2xl rounded-full shadow-md shadow-[0_2px_4px] from-indigo-500" />`,
      `<a href="#top" style={{ color: "#1c1a18" }} className="bg-[#ECE7DB]" />`,
    ].join("\n"));
    writeFileSync(join(dir, "src/app/opengraph-image.tsx"), `const c = "#ffffff";`);
    mkdirSync(join(dir, "src/emails"), { recursive: true });
    writeFileSync(join(dir, "src/emails/Welcome.tsx"), `<td style={{ color: "#1a1a1a" }} />`);
    mkdirSync(join(dir, "src/app-ui"), { recursive: true });
    writeFileSync(join(dir, "src/app-ui/Pill.tsx"), `<i className="bg-gray-100" />`);
    writeFileSync(join(dir, "src/app/globals.css"), `:root { --canvas: #ECE7DB; }\n.x { @apply rounded-xl; }`);
    writeFileSync(join(dir, "src/web-core/x.tsx"), `<i className="bg-slate-900" />`);
    writeFileSync(join(dir, "src/app/page.test.tsx"), `<i className="bg-slate-900" />`);

    const c = scan(dir);
    const get = (r, f) => (c[r] || {})[f] || 0;
    assert(get("stock-palette", "src/app/page.tsx") === 2, "bg-slate-50 + hover:text-gray-700, not translate-x-4");
    assert(get("stock-radius", "src/app/page.tsx") === 2, "rounded-xl + rounded-t-2xl, not rounded-full");
    assert(get("stock-radius", "src/app/globals.css") === 1, "@apply rounded-xl in CSS counts");
    assert(get("stock-shadow", "src/app/page.tsx") === 1, "shadow-md, not an arbitrary shadow");
    assert(get("ai-gradient", "src/app/page.tsx") === 1, "from-indigo-500");
    assert(get("hex-literal", "src/app/page.tsx") === 2, "two colour literals, not the #top anchor");
    assert(!c["hex-literal"]?.["src/app/opengraph-image.tsx"], "OG image route exempt from hex");
    assert(!c["hex-literal"]?.["src/emails/Welcome.tsx"], "email template exempt from hex");
    assert(!c["stock-palette"]?.["src/app-ui/Pill.tsx"], "app-ui submodule mount skipped");
    assert(!c["hex-literal"]?.["src/app/globals.css"], "CSS token definitions exempt from hex");
    assert(!Object.values(c).some((f) => f["src/web-core/x.tsx"] || f["src/app/page.test.tsx"]), "web-core mount and tests skipped");

    assert(main([dir]) === 1, "no baseline → existing hits fail");
    assert(main([dir, "--write-baseline"]) === 0, "baseline written");
    assert(main([dir]) === 0, "at baseline → pass");
    writeFileSync(page, readFileSync(page, "utf8") + `\n<p className="text-zinc-500" />`);
    assert(main([dir]) === 1, "one new hit above baseline → fail");
    writeFileSync(page, `<p />`);
    assert(main([dir]) === 0, "below baseline → pass (with notice)");
    console.log("check-design-standard self-test OK");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

if (process.argv.includes("--self-test")) selfTest();
else process.exit(main(process.argv.slice(2)));
