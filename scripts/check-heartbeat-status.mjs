#!/usr/bin/env node
/**
 * check-heartbeat-status — a monitor must not report success while it is
 * counting failures.
 *
 * WHAT IT FLAGS
 * ----------------------------------------------------------------------------
 * A scheduled job that passes a BARE STRING LITERAL as its heartbeat status
 * while the same file tracks a failure counter (`errors`, `failed`, `skipped`,
 * …). That combination means the recorded outcome cannot disagree with the code
 * — it is "ok" whatever happened — so a run in which every single unit of work
 * failed is byte-identical, on every dashboard and to every watcher, to a
 * perfect run.
 *
 * This is the most dangerous shape a monitor can take, because it fails towards
 * silence. A crash is loud and gets fixed; a job that quietly reports success
 * while doing nothing can persist for months, and the surfaces built to reveal
 * that are the very ones showing green. Real occurrences behind this gate: an
 * outbound send pipeline whose per-item failures were tallied, logged, and then
 * followed by an unconditional "ok"; and an uptime probe that discarded the
 * error from its own datastore read, so "checked 0 targets" and "everything is
 * healthy" produced identical output.
 *
 * The rule is not new — it is the long-standing estate requirement that a status
 * be DERIVED and that any counter meaning "something did not happen" must reach
 * it. This gate exists because that rule was written down and shipped past
 * repeatedly, which is the same reason the other scripts here exist.
 *
 * WHAT IT DOES NOT FLAG
 * ----------------------------------------------------------------------------
 *   - A derived status: `errors.length ? "error" : "ok"`, `deriveStatus(errs)`,
 *     a variable, anything that is not a bare literal. That is the correct form
 *     and is the whole point.
 *   - A literal status in a file with no failure counter at all. A job that
 *     genuinely cannot partially fail is entitled to say "ok"; there is nothing
 *     for the status to disagree with.
 *   - Anything carrying `// heartbeat-status-ok: <reason>` on the call line or
 *     the line above. The reason is REQUIRED — a bare annotation is itself a
 *     failure, because "someone looked at this" and "someone decided this" must
 *     not be indistinguishable.
 *
 * Deliberately conservative: it reports only where both signals are present in
 * one file. It cannot see a status derived in a helper two modules away, nor a
 * counter held in imported state — those still need a human.
 *
 * Config: a repo may override the call and counter names with
 * `.heartbeat-status.json` at its root: { "calls": [...], "counters": [...],
 * "ignore": ["glob-ish substring", ...] }.
 *
 * Plain Node, no dependencies. Exit 1 on any finding.
 */

import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, relative, extname } from "node:path";

const ROOT = process.argv[2] ?? process.cwd();

const DEFAULTS = {
  // Functions whose job is to record a run's outcome.
  calls: ["writeHeartbeat", "writeCronHeartbeat", "heartbeat", "recordRun", "reportRun"],
  // Identifiers that mean "something did not happen".
  //
  // Only ever add a name whose INCREASE is bad. `notified` was here briefly and
  // was wrong: it counts successful notifications (`else notified++`), so it made
  // the gate fire on a route doing the right thing. A counter list that includes
  // success counters produces exactly the false positives that get a gate
  // switched off. When unsure, leave it out — a missed case is recoverable, a
  // gate nobody trusts is not.
  counters: ["errors", "errored", "failed", "failures", "failedCount", "errorCount", "skipped", "skippedCount", "failedTotal"],
  ignore: [],
};

const SKIP_DIRS = new Set([
  "node_modules", ".git", ".next", "dist", "build", "out", "coverage",
  ".vercel", ".turbo", "web-core", "app-ui", ".testbuild",
]);

const CODE_EXT = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]);

function loadConfig() {
  const p = join(ROOT, ".heartbeat-status.json");
  if (!existsSync(p)) return DEFAULTS;
  try {
    const raw = JSON.parse(readFileSync(p, "utf8"));
    return {
      calls: raw.calls ?? DEFAULTS.calls,
      counters: raw.counters ?? DEFAULTS.counters,
      ignore: raw.ignore ?? [],
    };
  } catch {
    console.log(`::error::.heartbeat-status.json is present but unparseable — refusing to run with unknown config.`);
    process.exit(1);
  }
}

function walk(dir, out = []) {
  let entries;
  try { entries = readdirSync(dir); } catch { return out; }
  for (const name of entries) {
    if (SKIP_DIRS.has(name)) continue;
    const full = join(dir, name);
    let st;
    try { st = statSync(full); } catch { continue; }
    if (st.isDirectory()) walk(full, out);
    else if (CODE_EXT.has(extname(name))) out.push(full);
  }
  return out;
}

/**
 * Argument list of the call starting at `open` (index of its "("), split on
 * TOP-LEVEL commas only. Paren/bracket/brace aware and string aware, so a
 * ternary, an object literal or a nested call cannot be mistaken for a boundary.
 * Returns null if the parens never balance (truncated or unparseable).
 */
function callArgs(src, open) {
  let depth = 0;
  let quote = null;
  let start = open + 1;
  const args = [];
  for (let i = open; i < src.length; i++) {
    const ch = src[i];
    const prev = src[i - 1];
    if (quote) {
      if (ch === quote && prev !== "\\") quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") { quote = ch; continue; }
    if (ch === "(" || ch === "[" || ch === "{") depth++;
    else if (ch === ")" || ch === "]" || ch === "}") {
      depth--;
      if (depth === 0) { args.push(src.slice(start, i)); return args; }
    } else if (ch === "," && depth === 1) {
      args.push(src.slice(start, i));
      start = i + 1;
    }
  }
  return null;
}

/** A bare string literal — not a ternary, call, template or identifier. */
function isBareLiteral(arg) {
  const t = arg.trim();
  return /^(['"])[A-Za-z0-9_-]*\1$/.test(t);
}

function lineOf(src, index) {
  return src.slice(0, index).split("\n").length;
}

function hasAnnotation(src, callIndex) {
  const lines = src.split("\n");
  const ln = lineOf(src, callIndex) - 1; // 0-based
  const candidates = [lines[ln] ?? "", lines[ln - 1] ?? "", lines[ln - 2] ?? ""];
  for (const c of candidates) {
    const m = c.match(/heartbeat-status-ok:\s*(.*)$/);
    if (m) return { found: true, reason: m[1].trim() };
  }
  return { found: false, reason: "" };
}

const cfg = loadConfig();
const counterRe = new RegExp(
  `\\b(${cfg.counters.join("|")})\\b\\s*(\\+\\+|\\+=|\\.push\\s*\\(|=\\s*\\w+\\s*\\+\\s*1)`,
);

const findings = [];
const annotatedWithoutReason = [];

for (const file of walk(ROOT)) {
  const rel = relative(ROOT, file);
  if (cfg.ignore.some((frag) => rel.includes(frag))) continue;
  // The gate's own tests and this script itself would trivially match.
  if (rel.includes("check-heartbeat-status")) continue;

  let src;
  try { src = readFileSync(file, "utf8"); } catch { continue; }

  // Only meaningful if this file counts failures — and only for status writes
  // that happen AFTER the counting starts.
  //
  // Position is what separates the two cases, and getting this wrong would have
  // made the gate useless. A route commonly heartbeats "ok" on an early return
  // ("feature disabled", "nothing due") BEFORE any work is attempted: that is a
  // correct no-op, and reporting it is right — a healthy skip must still be
  // recorded or a run of correct answers looks like a dead job. Flagging those
  // would put three waivers in a file whose author did nothing wrong, and a gate
  // that fires on correct code is one people switch off.
  //
  // The dangerous shape is the terminal write: failures were tallied, and then
  // the run declared success anyway. So find where counting begins and only
  // consider status writes after it.
  counterRe.lastIndex = 0;
  const firstCount = src.search(counterRe);
  if (firstCount === -1) continue;

  for (const call of cfg.calls) {
    const re = new RegExp(`\\b${call}\\s*\\(`, "g");
    let m;
    while ((m = re.exec(src)) !== null) {
      if (m.index < firstCount) continue; // early-return no-op, before any counting
      const open = m.index + m[0].length - 1;
      const args = callArgs(src, open);
      if (!args) continue;
      // Look at every argument: signatures differ across the estate, so the
      // status is positional in some and second-of-three in others.
      const literal = args.find((a) => isBareLiteral(a) && /^['"]?(ok|success|healthy)['"]?$/i.test(a.trim().replace(/['"]/g, "")));
      if (!literal) continue;

      const ann = hasAnnotation(src, m.index);
      if (ann.found && ann.reason) continue;
      if (ann.found && !ann.reason) {
        annotatedWithoutReason.push(`${rel}:${lineOf(src, m.index)}  ${call}(…)`);
        continue;
      }
      findings.push(`${rel}:${lineOf(src, m.index)}  ${call}(… ${literal.trim()} …) — recorded AFTER failures are counted (first counted at line ${lineOf(src, firstCount)})`);
    }
  }
}

let failed = false;

if (findings.length) {
  failed = true;
  console.log(
    "::error::A run's recorded status is a hardcoded success literal in a file that counts failures. " +
    "Derive it from the counter (e.g. `errors.length ? \"error\" : \"ok\"`), so a run where everything failed " +
    "cannot look identical to a clean one. If the literal is genuinely correct, add " +
    "`// heartbeat-status-ok: <reason>` on that line or the line above.",
  );
  findings.forEach((f) => console.log("  " + f));
}

if (annotatedWithoutReason.length) {
  failed = true;
  console.log("::error::`heartbeat-status-ok` annotation with no reason. State the decision — an unexplained waiver is indistinguishable from an oversight.");
  annotatedWithoutReason.forEach((f) => console.log("  " + f));
}

if (failed) process.exit(1);
console.log("Heartbeat-status gate OK — no run reports success while counting failures.");
