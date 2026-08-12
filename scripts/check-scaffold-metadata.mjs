#!/usr/bin/env node
/**
 * Gate: scaffold placeholders must never reach production.
 *
 * WHY THIS EXISTS
 * New apps here are scaffolded from a shared Next.js template. The template
 * ships deliberate placeholders — a stand-in page title, a `TODO:` meta
 * description, `REPLACE_WITH_<THING>` tokens — on the assumption that whoever
 * clones it replaces them. Repeatedly, nobody did, and nothing complained: the
 * build is green, the page renders, the tests pass. The only symptom is a
 * customer reading the wrong words.
 *
 * Three occurrences before this gate existed:
 *   - A checkout app served the template's placeholder title, so a customer saw
 *     it in their browser tab on the post-payment success page. Found by an
 *     end-to-end health check months later, not by review.
 *   - An internal tool served both the placeholder title AND the literal string
 *     "TODO: replace with the brand's site title and meta description." as its
 *     live meta description, indexable, for as long as it had been deployed.
 *   - A repo's own README still listed both as outstanding after they had been
 *     fixed — a checklist that lists finished work teaches you to skim it.
 *
 * WHAT IT CHECKS
 *   1. The root layout's metadata carries no scaffold placeholder — no `TODO`,
 *      and no generic "<framework> Template" stand-in title.
 *   2. No `REPLACE_WITH_<TOKEN>` survives anywhere in tracked source in a
 *      position that actually executes.
 *
 * WHAT IT DELIBERATELY DOES NOT CHECK
 * Placeholder body copy on legal pages (`<p>TODO: pricing and refunds</p>`).
 * That is the same family but a different problem, it needs real content rather
 * than a rename, and a gate that arrives red on work nobody has scheduled gets
 * removed rather than obeyed. Add it here once the estate is clean.
 *
 * COMMENTS ARE BLANKED BEFORE MATCHING, and that is not a detail — it is the
 * difference between a gate people trust and one they mute. The repos that
 * FIXED this bug did so with a comment explaining what the placeholder used to
 * be ("It previously read ... — the scaffold's placeholder"). Matching raw text
 * flags the fix itself, which is precisely how a gate loses its audience. The
 * sibling unsanitised-HTML gate learned the same lesson the same way.
 *
 * Deliberate exceptions carry a reason on or just above the line:
 *
 *   // scaffold-metadata-ok: <why this placeholder is correct here>
 *
 * The reason is required. A bare annotation is itself a failure — "someone
 * looked at this" and "someone decided this" must not be indistinguishable.
 */
import { readFileSync, existsSync } from "node:fs";
import { execSync } from "node:child_process";
import { join } from "node:path";

const ROOT = process.cwd();

// ---------------------------------------------------------------------------
// Comment blanking. Replaces comment bodies with spaces so line/column numbers
// and string positions survive, then matching runs on what actually executes.
// Handles // line, /* block */, and {/* JSX */} — the JSX form is what legal
// and layout files use most.
// ---------------------------------------------------------------------------
function blankComments(src) {
  let out = "";
  let i = 0;
  let state = "code"; // code | line | block | single | double | template
  while (i < src.length) {
    const c = src[i];
    const next = src[i + 1];

    if (state === "code") {
      if (c === "/" && next === "/") { state = "line"; out += "  "; i += 2; continue; }
      if (c === "/" && next === "*") { state = "block"; out += "  "; i += 2; continue; }
      if (c === "'") { state = "single"; out += c; i++; continue; }
      if (c === '"') { state = "double"; out += c; i++; continue; }
      if (c === "`") { state = "template"; out += c; i++; continue; }
      out += c; i++; continue;
    }
    if (state === "line") {
      if (c === "\n") { state = "code"; out += c; i++; continue; }
      out += " "; i++; continue;
    }
    if (state === "block") {
      if (c === "*" && next === "/") { state = "code"; out += "  "; i += 2; continue; }
      out += c === "\n" ? "\n" : " "; i++; continue;
    }
    // Inside a string literal — copy verbatim, honouring escapes.
    if (c === "\\") { out += src.slice(i, i + 2); i += 2; continue; }
    if ((state === "single" && c === "'") || (state === "double" && c === '"') || (state === "template" && c === "`")) {
      state = "code";
    }
    out += c; i++;
  }
  return out;
}

const ANNOTATION = /scaffold-metadata-ok:\s*(\S.*)/;
const BARE_ANNOTATION = /scaffold-metadata-ok:\s*$/m;

// A line is waived if it, or the line above it, carries a reasoned annotation.
function waivedAt(rawLines, idx) {
  for (const line of [rawLines[idx], rawLines[idx - 1]]) {
    if (!line) continue;
    const m = line.match(ANNOTATION);
    if (m && m[1].trim()) return m[1].trim();
  }
  return null;
}

const findings = [];
const notes = [];

// ---------------------------------------------------------------------------
// Tracked source only. Scope by what is committed — a build artefact is not
// ours to police and is usually minified, so every match there is noise.
// ---------------------------------------------------------------------------
let tracked = [];
try {
  tracked = execSync("git ls-files '*.ts' '*.tsx' '*.js' '*.jsx' '*.mjs'", { encoding: "utf8", cwd: ROOT })
    .split("\n")
    .filter(Boolean)
    // Vendored submodules are gated in their own repo; a consumer must not re-check them.
    .filter((f) => !/(^|\/)(web-core|app-ui|lms|node_modules)(\/|$)/.test(f));
} catch (e) {
  console.log(`::error::Could not list tracked files — this gate cannot run. ${e.message}`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// 1. Root layout metadata.
// ---------------------------------------------------------------------------
const LAYOUTS = ["src/app/layout.tsx", "app/layout.tsx", "src/app/layout.jsx", "app/layout.jsx"];
const layoutPath = LAYOUTS.find((p) => existsSync(join(ROOT, p)));

// Generic scaffold tells. No brand or repo names — a placeholder is recognisable
// by its shape, and hardcoding a specific one would miss the next template.
const PLACEHOLDER_TITLE = /\b(?:Next\.?js|React|Vite|Astro|Remix)\s+Template\b/i;
const TODO_TOKEN = /\bTODO\b/;

if (layoutPath) {
  const raw = readFileSync(join(ROOT, layoutPath), "utf8");
  const rawLines = raw.split("\n");
  const code = blankComments(raw).split("\n");

  code.forEach((line, i) => {
    // Only metadata-bearing lines: a title/description key with a string value.
    if (!/\b(title|description)\s*:/.test(line)) return;
    const hit = PLACEHOLDER_TITLE.test(line) ? "placeholder template title" : TODO_TOKEN.test(line) ? "TODO left in metadata" : null;
    if (!hit) return;

    const reason = waivedAt(rawLines, i);
    if (reason) { notes.push(`${layoutPath}:${i + 1} — waived: ${reason}`); return; }

    findings.push({
      file: layoutPath,
      line: i + 1,
      what: hit,
      detail:
        "This is the browser tab title and the search-result snippet. Replace it with the real" +
        " site title and description. A placeholder here is invisible in review and fully visible" +
        " to whoever loads the page.",
      text: rawLines[i].trim().slice(0, 120),
    });
  });
} else {
  notes.push("no root layout found — metadata check skipped (not a Next.js App Router repo)");
}

// ---------------------------------------------------------------------------
// 2. Surviving REPLACE_WITH_* tokens in live code.
// ---------------------------------------------------------------------------
const REPLACE_TOKEN = /REPLACE_WITH_[A-Z0-9_]+/;

for (const file of tracked) {
  let raw;
  try { raw = readFileSync(join(ROOT, file), "utf8"); } catch { continue; }
  if (!REPLACE_TOKEN.test(raw)) continue;

  const rawLines = raw.split("\n");
  blankComments(raw).split("\n").forEach((line, i) => {
    const m = line.match(REPLACE_TOKEN);
    if (!m) return;

    const reason = waivedAt(rawLines, i);
    if (reason) { notes.push(`${file}:${i + 1} — waived: ${reason}`); return; }

    findings.push({
      file,
      line: i + 1,
      what: `unreplaced scaffold token ${m[0]}`,
      detail:
        "This token is live code, not a comment. Whatever it configures is pointing at a" +
        " placeholder — which usually fails silently rather than erroring, because the value is" +
        " a plausible-looking string.",
      text: rawLines[i].trim().slice(0, 120),
    });
  });
}

// ---------------------------------------------------------------------------
// A bare annotation is a failure in its own right.
// ---------------------------------------------------------------------------
for (const file of tracked) {
  let raw;
  try { raw = readFileSync(join(ROOT, file), "utf8"); } catch { continue; }
  if (BARE_ANNOTATION.test(raw)) {
    findings.push({
      file,
      line: raw.split("\n").findIndex((l) => BARE_ANNOTATION.test(l)) + 1,
      what: "scaffold-metadata-ok annotation with no reason",
      detail:
        "The reason is the point. Without it there is no way to tell a considered exception from" +
        " someone silencing the gate, which is how an exception list stops meaning anything.",
      text: "",
    });
  }
}

// ---------------------------------------------------------------------------
// Report.
// ---------------------------------------------------------------------------
for (const n of notes) console.log(`  note: ${n}`);

if (findings.length) {
  console.log(
    "::error::Scaffold placeholder(s) reached this repo's source. These ship silently — the build" +
      " is green, the page renders, and the only symptom is a customer reading the wrong words." +
      ' If a placeholder is genuinely correct here, annotate the line "// scaffold-metadata-ok:' +
      ' <reason>"; the reason is required.'
  );
  for (const f of findings) {
    console.log(`  ${f.file}:${f.line}  ${f.what}`);
    if (f.text) console.log(`      ${f.text}`);
    console.log(`      ${f.detail}`);
  }
  process.exit(1);
}

console.log(
  `Scaffold-metadata gate OK — ${layoutPath ?? "no layout"} clean,` +
    ` ${tracked.length} tracked source file(s) carry no unreplaced scaffold token,` +
    ` ${notes.length} note(s).`
);
