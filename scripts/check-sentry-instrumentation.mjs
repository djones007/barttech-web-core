#!/usr/bin/env node
/**
 * Gate: a repo that installs @sentry/nextjs must actually be wired to report
 * server-side errors.
 *
 * WHY THIS EXISTS
 * `Sentry.init()` arms the SDK. It does NOT subscribe to Next's server error
 * channel. That subscription is a separate, easily-forgotten module-level
 * export from the instrumentation file:
 *
 *   export const onRequestError = Sentry.captureRequestError;
 *
 * Without it, every server-side App Router error — a page render throwing, a
 * route handler throwing, a server action failing — is dropped on the floor,
 * while client-side errors keep arriving normally. Sentry looks healthy. On
 * 2026-08-12 an audit found that NO repo in this estate had ever exported it,
 * so no server error had ever been reported anywhere. The proof was a 3.5-day
 * outage on one site in which every article returned 500 and not one alert
 * fired; it was found by a human loading the page, not by the tooling built to
 * catch exactly that.
 *
 * The same audit found two repos still carrying `sentry.server.config.ts` /
 * `sentry.client.config.ts`. Those filenames were the v7 convention. The v10
 * build plugin contains no reference to the server/edge ones at all, and the
 * client one is honoured only on the webpack path — so under Turbopack, which
 * is the default bundler, they are inert files. Both repos had NO Sentry
 * whatsoever, server or browser, and had been shipping that way for months.
 *
 * The common thread is that all of it fails silently and looks fine. The SDK
 * does warn on every build ("Could not find `onRequestError` hook…") and nobody
 * read it, which is the argument for a gate rather than a note in a runbook.
 *
 * WHAT IT CHECKS (only when @sentry/nextjs is a dependency)
 *   1. An instrumentation file exists — `instrumentation.{ts,js}` at the repo
 *      root or under `src/`.
 *   2. It exports `onRequestError`.
 *   3. No ORPHANED legacy `sentry.{server,edge,client}.config.*` files remain.
 *      Orphaned is the operative word. A server/edge config that the
 *      instrumentation file explicitly imports inside register() is a perfectly
 *      valid layout and is left alone; only one that nothing imports is dead.
 *      A client config is dead whenever `instrumentation-client.*` is absent,
 *      because nothing imports it either — the build plugin injected it, and
 *      only ever on the webpack path.
 *
 * Deliberate exceptions carry an annotation naming the reason — in the
 * instrumentation file for the export, or in a `.sentry-instrumentation-ok`
 * file (one path per line, `#` comments allowed) for a legacy config file that
 * is genuinely still doing something:
 *
 *   // sentry-instrumentation-ok: <why this repo reports server errors another way>
 *
 * The reason is required. Naming it is the point.
 */
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();

const readIf = (p) => {
  try {
    return readFileSync(join(ROOT, p), "utf8");
  } catch {
    return null;
  }
};

// ---------------------------------------------------------------------------
// Applicability. No package.json, or no @sentry/nextjs, means nothing to check.
// A repo is free not to use Sentry; this gate never argues that it should.
// ---------------------------------------------------------------------------
const pkgRaw = readIf("package.json");
if (!pkgRaw) {
  console.log("Sentry-instrumentation gate SKIPPED — no package.json.");
  process.exit(0);
}

let pkg;
try {
  pkg = JSON.parse(pkgRaw);
} catch (e) {
  console.log(`::error::package.json is not valid JSON — ${e.message}`);
  process.exit(1);
}

const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
if (!deps["@sentry/nextjs"]) {
  console.log("Sentry-instrumentation gate OK — @sentry/nextjs is not a dependency here.");
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Exceptions.
// ---------------------------------------------------------------------------
const ANNOTATION = /sentry-instrumentation-ok:\s*(\S.*)/;

const allowlist = new Map();
const allowRaw = readIf(".sentry-instrumentation-ok");
if (allowRaw) {
  for (const line of allowRaw.split("\n")) {
    const [pathPart, ...reasonParts] = line.split("#");
    const p = pathPart.trim();
    if (!p) continue;
    allowlist.set(p, reasonParts.join("#").trim());
  }
}

const findings = [];
const notes = [];

// ---------------------------------------------------------------------------
// 1 + 2. The instrumentation file and its onRequestError export.
// ---------------------------------------------------------------------------
const CANDIDATES = [
  "instrumentation.ts",
  "instrumentation.js",
  "src/instrumentation.ts",
  "src/instrumentation.js",
];

const found = CANDIDATES.filter((p) => existsSync(join(ROOT, p)));
const instrumentationSrc = found.map((p) => readFileSync(join(ROOT, p), "utf8")).join("\n");

if (found.length === 0) {
  findings.push({
    what: "no instrumentation file",
    detail:
      "@sentry/nextjs is installed but there is no instrumentation.{ts,js} at the repo root or" +
      " under src/. Since SDK v8 that file is the ONLY place the server SDK is initialised —" +
      " sentry.server.config.* is not read. Nothing server-side is being reported.",
  });
} else {
  for (const p of found) {
    const src = readFileSync(join(ROOT, p), "utf8");
    if (/\bonRequestError\b/.test(src)) continue;

    const ann = src.match(ANNOTATION);
    if (ann) {
      notes.push(`${p} — annotated exception: ${ann[1].trim()}`);
      continue;
    }
    findings.push({
      what: `${p} does not export onRequestError`,
      detail:
        "Add `export const onRequestError = Sentry.captureRequestError;` at module level (NOT" +
        " inside register(), and not conditional on NEXT_RUNTIME — Next looks it up as an" +
        " export). Without it Sentry.init() arms the SDK but subscribes to nothing, so no page" +
        " render, route handler or server action error is ever reported.",
    });
  }
}

// ---------------------------------------------------------------------------
// 3. ORPHANED legacy config files — ones nothing loads.
//
// A server/edge config imported from inside register() is live and correct; the
// Sentry docs show that layout. Only an unreferenced one is dead. The client
// config is different: nothing ever imports it, the build plugin injected it,
// and only on the webpack path — so it is dead the moment there is no
// instrumentation-client.* alongside it.
// ---------------------------------------------------------------------------
const hasClientEntry = ["instrumentation-client.ts", "instrumentation-client.js", "src/instrumentation-client.ts", "src/instrumentation-client.js"].some(
  (p) => existsSync(join(ROOT, p))
);

const LEGACY = [
  ["sentry.server.config", "instrumentation.ts (server init inside register())"],
  ["sentry.edge.config", "instrumentation.ts (edge init inside register())"],
  ["sentry.client.config", "instrumentation-client.ts"],
];

for (const [base, replacement] of LEGACY) {
  const isClient = base === "sentry.client.config";

  for (const ext of ["ts", "js", "mts", "mjs"]) {
    const p = `${base}.${ext}`;
    if (!existsSync(join(ROOT, p))) continue;

    // Imported by the instrumentation file — a live, supported layout.
    if (!isClient && new RegExp(`["'\\./]${base.replace(/\./g, "\\.")}["']`).test(instrumentationSrc)) {
      notes.push(`${p} — loaded by the instrumentation file, not orphaned`);
      continue;
    }
    // A client config sitting next to a real instrumentation-client entry is
    // redundant rather than fatal, but two inits is its own bug. Flag either way.
    if (isClient && hasClientEntry) {
      findings.push({
        what: `${p} duplicates instrumentation-client`,
        detail:
          "Both a legacy client config and an instrumentation-client entry are present, so the" +
          " browser SDK may be initialised twice on the webpack path and once under Turbopack." +
          " Keep instrumentation-client and delete this file.",
      });
      continue;
    }

    if (allowlist.has(p)) {
      const reason = allowlist.get(p);
      if (!reason) {
        findings.push({
          what: `${p} is allowlisted with no reason`,
          detail:
            "An entry in .sentry-instrumentation-ok must carry a `# <reason>` comment saying why" +
            " this legacy file is still doing something. An unexplained allowlist entry is how a" +
            " gate quietly stops meaning anything.",
        });
      } else {
        notes.push(`${p} — allowlisted: ${reason}`);
      }
      continue;
    }

    findings.push({
      what: `${p} is a legacy Sentry config the SDK no longer loads`,
      detail:
        `Move its contents into ${replacement} and delete it. The v10 build plugin has no` +
        " reference to the server/edge filenames at all, and injects the client one only on the" +
        " webpack path — under Turbopack it is inert. A repo carrying these looks instrumented" +
        " and is not. (If it genuinely still serves a purpose, add the path to" +
        " .sentry-instrumentation-ok with a `#` reason.)",
    });
  }
}

// ---------------------------------------------------------------------------
// Report.
// ---------------------------------------------------------------------------
for (const n of notes) console.log(`  note: ${n}`);

if (findings.length) {
  console.log(
    "::error::Sentry is installed here but is not wired to report server-side errors." +
      " This fails silently and looks healthy: the SDK loads, client errors arrive, dashboards" +
      " stay green, and every server 500 goes unreported. See each finding below."
  );
  for (const f of findings) {
    console.log(`  ${f.what}`);
    console.log(`      ${f.detail}`);
  }
  process.exit(1);
}

console.log(
  `Sentry-instrumentation gate OK — ${found.length} instrumentation file(s) export onRequestError,` +
    ` no legacy config files, ${notes.length} annotated exception(s).`
);
