#!/usr/bin/env node
// ---------------------------------------------------------------------------
// Landing-page server-event gate.
//
// WHY THIS EXISTS
// Every page that receives paid or campaign traffic must count its visits
// SERVER-SIDE (the `pageEvents` module in this repo), inside `after()`, so the
// count never depends on a cookie choice. Browser analytics only sees people who
// tap Accept; a smaller cookie banner once took client-side sessions from 11% to
// 0% of real ad clicks in one deploy, and it was misread as a multi-day
// "analytics outage" while the ads kept spending.
//
// The server call is designed to fail quietly (a tracking write must never
// break a page), which means a page that LOSES the call keeps rendering
// perfectly. Nothing notices until the campaign report reads zero. This gate
// is the code half of the guard; the runtime half (env vars unset, a token
// rotated) needs a monitor reading the event store, because CI cannot see
// env values.
//
// THE CONTRACT (opt-in, per repo)
// A repo lists its landing routes in `.landing-routes` at the repo root. Each
// listed route's page file must:
//   1. import `after` from "next/server", and
//   2. call a page-event function INSIDE an `after(...)` argument.
// Accepted call names default to `recordPageEvent` (the template's shim) and
// `trackServerEvent` (web-core's function). Add a repo's own wrapper with a
// `calls:` line.
//
// MANIFEST FORMAT (`.landing-routes`)
//
//     # One entry per line. `#` starts a comment (a trailing reason is welcome).
//     /                        # URL route, resolved under app/ or src/app/
//     /2026-choice             # route groups like (marketing) are ignored
//     /[slug]                  # dynamic segments are written literally
//     src/components/Hero.tsx  # or a FILE path, when after() lives outside page.tsx
//     calls: recordLanding, trackLanding
//     wrapper: measureLanding lib/landing-measurement.ts
//
// `wrapper: <fn> <file>` is for a repo whose pages call ONE helper that does
// the after() scheduling itself. The helper's file must pass the full check
// (imports `after`, calls a page-event function inside after()), and then a
// listed page passes if it calls `<fn>(` outside a comment. Both halves are
// checked on every run, so emptying the helper fails as surely as dropping
// the call from a page.
//
// An entry that resolves to no file FAILS (a renamed page must not silently
// drop out of coverage). A manifest with no entries FAILS (an empty manifest
// is a disabled gate that looks enabled). No manifest at all passes with a
// notice: the gate is opt-in so a repo with no marketing pages is not forced
// to invent one.
//
// SCOPE / KNOWN GAPS
// Deterministic text matching, no AST: comments are blanked first, `after(`
// arguments are extracted by paren balancing with string/template skipping.
// It proves the call is PRESENT in after(), not that the env vars are set or
// that the event reaches the event store. Those are runtime facts and belong
// to the monitor.
//
// Exit codes: 0 = every listed route is wired (or no manifest).
//             1 = at least one listed route is missing the call, or the manifest is broken.
//
// Usage: node check-landing-page-events.mjs [rootDir]   (default: cwd)
//        node check-landing-page-events.mjs --self-test
// ---------------------------------------------------------------------------

import { readFileSync, readdirSync, statSync, existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

export const MANIFEST = ".landing-routes";
export const DEFAULT_CALLS = ["recordPageEvent", "trackServerEvent"];
const APP_DIRS = ["src/app", "app"];
const PAGE_FILE = /^page\.(tsx|jsx|ts|js)$/;
const SKIP_DIRS = new Set(["node_modules", ".next", ".git", "dist", "build", ".vercel", ".turbo", "coverage"]);

function readWithinRoot(root, target) {
  const base = resolve(root) + sep;
  const resolved = resolve(root, target);
  if (!resolved.startsWith(base)) throw new Error(`refusing to read outside repo root: ${target}`);
  return readFileSync(resolved, "utf8");
}

/** Parse the manifest text into { entries: [{value, line}], calls: [...], wrappers: [{name, file, line}] }. */
export function parseManifest(text) {
  const entries = [];
  const calls = [...DEFAULT_CALLS];
  const wrappers = [];
  text.split(/\r?\n/).forEach((raw, i) => {
    const line = raw.replace(/\s+#.*$/, "").replace(/^#.*$/, "").trim();
    if (!line) return;
    const w = line.match(/^wrapper:\s*([A-Za-z_$][\w$]*)\s+(\S+)$/i);
    if (w) { wrappers.push({ name: w[1], file: w[2], line: i + 1 }); return; }
    const m = line.match(/^calls:\s*(.+)$/i);
    if (m) {
      for (const n of m[1].split(",").map((s) => s.trim()).filter(Boolean)) {
        if (/^[A-Za-z_$][\w$]*$/.test(n) && !calls.includes(n)) calls.push(n);
      }
      return;
    }
    entries.push({ value: line, line: i + 1 });
  });
  return { entries, calls, wrappers };
}

/** Blank // and /* *\/ comments without touching string contents or line numbers. */
export function stripComments(src) {
  let out = "";
  let i = 0;
  let q = null; // current quote char
  while (i < src.length) {
    const c = src[i];
    const n = src[i + 1];
    if (q) {
      out += c;
      if (c === "\\") { out += n ?? ""; i += 2; continue; }
      if (c === q) q = null;
      i++;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") { q = c; out += c; i++; continue; }
    if (c === "/" && n === "/") {
      while (i < src.length && src[i] !== "\n") { out += " "; i++; }
      continue;
    }
    if (c === "/" && n === "*") {
      out += "  "; i += 2;
      while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) { out += src[i] === "\n" ? "\n" : " "; i++; }
      out += "  "; i += 2;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

/** Every `after(...)` argument text in the (comment-stripped) source. */
export function afterArguments(src) {
  const args = [];
  const re = /(^|[^\w$.])after\s*\(/g;
  let m;
  while ((m = re.exec(src))) {
    let i = m.index + m[0].length;
    const start = i;
    let depth = 1;
    let q = null;
    while (i < src.length && depth > 0) {
      const c = src[i];
      if (q) {
        if (c === "\\") { i += 2; continue; }
        if (c === q) q = null;
      } else if (c === '"' || c === "'" || c === "`") q = c;
      else if (c === "(") depth++;
      else if (c === ")") depth--;
      i++;
    }
    args.push(src.slice(start, i - 1));
  }
  return args;
}

/** Verdict for one file's source: null when wired, otherwise the reason it is not. */
export function checkSource(source, calls = DEFAULT_CALLS) {
  const src = stripComments(source);
  if (!/import\s*\{[^}]*\bafter\b[^}]*\}\s*from\s*["']next\/server["']/.test(src)) {
    return 'does not import `after` from "next/server"';
  }
  const args = afterArguments(src);
  if (!args.length) return "never calls after()";
  const names = new RegExp(`\\b(${calls.map((c) => c.replace(/\$/g, "\\$")).join("|")})\\b`);
  if (!args.some((a) => names.test(a))) {
    return `calls after() but none of its arguments call ${calls.join(" / ")}`;
  }
  return null;
}

/** URL route for a page file relative to an app dir, e.g. "(site)/foo/page.tsx" -> "/foo". */
export function routeFor(relPath) {
  const segs = relPath.split(/[\\/]/).slice(0, -1).filter((s) => !/^\(.*\)$/.test(s) && !s.startsWith("@"));
  return "/" + segs.join("/");
}

function walkPages(root, dir, out) {
  let names;
  try { names = readdirSync(join(root, dir)); } catch { return; }
  for (const name of names) {
    if (SKIP_DIRS.has(name) || name.startsWith(".")) continue;
    const rel = join(dir, name);
    let st;
    try { st = statSync(join(root, rel)); } catch { continue; }
    if (st.isDirectory()) walkPages(root, rel, out);
    else if (PAGE_FILE.test(name)) out.push(rel);
  }
}

/** Map of URL route -> page file (relative to root), across app/ and src/app/. */
export function pageRoutes(root) {
  const map = new Map();
  for (const appDir of APP_DIRS) {
    if (!existsSync(join(root, appDir))) continue;
    const files = [];
    walkPages(root, appDir, files);
    for (const f of files) {
      const route = routeFor(relative(appDir, f));
      if (!map.has(route)) map.set(route, f);
    }
  }
  return map;
}

/** Run the gate. Returns { status: 'no-manifest'|'pass'|'fail', problems: string[], checked: string[] }. */
export function run(root) {
  const manifestPath = join(root, MANIFEST);
  if (!existsSync(manifestPath)) return { status: "no-manifest", problems: [], checked: [] };
  const { entries, calls, wrappers } = parseManifest(readWithinRoot(root, MANIFEST));
  const problems = [];
  const checked = [];
  if (!entries.length) {
    problems.push(`${MANIFEST} lists no routes — an empty manifest is a disabled gate. List the landing routes, or delete the file.`);
    return { status: "fail", problems, checked };
  }
  // Wrappers first: a wrapper only counts if its own file is wired.
  const goodWrappers = [];
  for (const w of wrappers) {
    const abs = resolve(root, w.file);
    if (!abs.startsWith(resolve(root) + sep) || !existsSync(abs)) {
      problems.push(`${MANIFEST}:${w.line} wrapper file ${w.file} does not exist in this repo — update the manifest.`);
      continue;
    }
    const why = checkSource(readWithinRoot(root, w.file), calls);
    checked.push(`wrapper ${w.name} -> ${w.file}`);
    if (why) problems.push(`wrapper ${w.name} (${w.file}): ${why}.`);
    else goodWrappers.push(w.name);
  }
  const routes = pageRoutes(root);
  for (const { value, line } of entries) {
    let file = null;
    if (value.startsWith("/")) {
      const want = value.length > 1 ? value.replace(/\/+$/, "") : "/";
      file = routes.get(want) || null;
      if (!file) {
        problems.push(`${MANIFEST}:${line} route ${value} has no page file under ${APP_DIRS.join(" or ")}/ — renamed or deleted? Update the manifest.`);
        continue;
      }
    } else {
      if (!existsSync(resolve(root, value)) || !resolve(root, value).startsWith(resolve(root) + sep)) {
        problems.push(`${MANIFEST}:${line} file ${value} does not exist in this repo — update the manifest.`);
        continue;
      }
      file = value;
    }
    const source = readWithinRoot(root, file);
    let why = checkSource(source, calls);
    if (why && goodWrappers.length) {
      const stripped = stripComments(source);
      if (goodWrappers.some((n) => new RegExp(`(^|[^\\w$.])${n.replace(/\$/g, "\\$")}\\s*\\(`).test(stripped))) why = null;
      else why = `${why}, and calls no wrapper (${goodWrappers.join(", ")})`;
    }
    checked.push(`${value} -> ${file}`);
    if (why) problems.push(`${value} (${file}): ${why}.`);
  }
  return { status: problems.length ? "fail" : "pass", problems, checked };
}

function selfTest() {
  const cases = [];
  const t = (name, fn) => cases.push([name, fn]);
  const wired = `import { after } from "next/server";\nexport default function P(){ after(() => recordPageEvent({ event: "landing" })); return null; }`;
  t("wired page passes", () => checkSource(wired) === null);
  t("call outside after() fails", () =>
    checkSource(`import { after } from "next/server";\nafter(() => doOther());\nrecordPageEvent({});`) !== null);
  t("no after import fails", () => checkSource(`after(() => recordPageEvent({}));`) !== null);
  t("commented-out call fails", () =>
    checkSource(`import { after } from "next/server";\n// after(() => recordPageEvent({}))\nafter(() => x());`) !== null);
  t("nested parens + strings inside after() still found", () =>
    checkSource(`import { headers } from "next/headers";\nimport { after } from "next/server";\nafter(async () => { const s = ")"; await trackServerEvent({ site: f(g("a")) }); });`) === null);
  t("custom call name via calls:", () => checkSource(`import { after } from "next/server";\nafter(() => recordLanding());`, [...DEFAULT_CALLS, "recordLanding"]) === null);
  t("obj.after( is not after(", () => checkSource(`import { after } from "next/server";\nx.after(() => recordPageEvent());`) !== null);
  t("route groups ignored", () => routeFor("(marketing)/offer/page.tsx") === "/offer" && routeFor("page.tsx") === "/");
  t("manifest parse", () => {
    const m = parseManifest("# c\n/ # home\n/x\ncalls: a, b\n\n");
    return m.entries.length === 2 && m.calls.includes("a") && m.calls.includes("b");
  });

  // End-to-end against a temp repo.
  // Evaluated NOW (not deferred): the temp dir is gone by the time the loop below runs.
  const now = (name, fn) => { let v = false; try { v = fn(); } catch { v = false; } cases.push([name, () => v]); };
  const dir = mkdtempSync(join(tmpdir(), "landing-gate-"));
  try {
    mkdirSync(join(dir, "src/app/(site)/offer"), { recursive: true });
    writeFileSync(join(dir, "src/app/page.tsx"), wired);
    writeFileSync(join(dir, "src/app/(site)/offer/page.tsx"), `export default function P(){ return null; }`);
    now("no manifest = opt-out notice", () => run(dir).status === "no-manifest");
    writeFileSync(join(dir, MANIFEST), "# nothing\n");
    now("empty manifest fails", () => run(dir).status === "fail");
    writeFileSync(join(dir, MANIFEST), "/\n");
    now("wired route passes", () => run(dir).status === "pass");
    writeFileSync(join(dir, MANIFEST), "/\n/offer\n");
    now("unwired route fails", () => run(dir).status === "fail");
    writeFileSync(join(dir, MANIFEST), "/gone\n");
    now("missing route fails", () => run(dir).status === "fail");
    mkdirSync(join(dir, "src/lib"), { recursive: true });
    writeFileSync(join(dir, "src/lib/measure.ts"), `import { after } from "next/server";\nexport function measureLanding(){ after(() => recordPageEvent({})); }`);
    writeFileSync(join(dir, "src/app/(site)/offer/page.tsx"), `import { measureLanding } from "@/lib/measure";\nexport default function P(){ measureLanding(); return null; }`);
    writeFileSync(join(dir, MANIFEST), "wrapper: measureLanding src/lib/measure.ts\n/offer\n");
    now("page calling a wired wrapper passes", () => run(dir).status === "pass");
    writeFileSync(join(dir, "src/lib/measure.ts"), `export function measureLanding(){ /* gutted */ }`);
    now("gutted wrapper fails", () => run(dir).status === "fail");
    writeFileSync(join(dir, "src/lib/measure.ts"), `import { after } from "next/server";\nexport function measureLanding(){ after(() => recordPageEvent({})); }`);
    writeFileSync(join(dir, "src/app/(site)/offer/page.tsx"), `export default function P(){ /* measureLanding(); */ return null; }`);
    now("page with the wrapper call commented out fails", () => run(dir).status === "fail");
    writeFileSync(join(dir, MANIFEST), "../outside.tsx\n");
    now("path outside root fails, not read", () => run(dir).status === "fail");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  let failed = 0;
  for (const [name, fn] of cases) {
    let ok = false;
    try { ok = fn(); } catch (e) { ok = false; console.log(`  threw: ${e.message}`); }
    if (!ok) failed++;
    console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
  }
  console.log(`\n${cases.length - failed}/${cases.length} passed`);
  process.exit(failed ? 1 : 0);
}

const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) {
  if (process.argv.includes("--self-test")) selfTest();
  const root = process.argv[2] || process.cwd();
  const res = run(root);
  if (res.status === "no-manifest") {
    console.log(`landing-page-events: no ${MANIFEST} in this repo — opt-in gate, nothing checked.`);
    process.exit(0);
  }
  for (const c of res.checked) console.log(`  checked ${c}`);
  if (res.status === "pass") {
    console.log(`landing-page-events: ${res.checked.length} landing route(s) record a server-side page event in after().`);
    process.exit(0);
  }
  console.error("landing-page-events: FAILED");
  for (const p of res.problems) console.error(`  - ${p}`);
  console.error(
    "\nEvery landing route must count visits server-side, consent-independently:\n" +
      '  import { after } from "next/server";\n' +
      '  after(() => recordPageEvent({ event: "landing", path, headers: h, searchParams: sp }));\n' +
      "See the scaffold template's landing-example page for the full pattern.\n" +
      "To stop tracking a route, remove it from .landing-routes."
  );
  process.exit(1);
}
