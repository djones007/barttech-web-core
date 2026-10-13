#!/usr/bin/env node
/**
 * lighthouse-gate — the page-speed gate for the weekly smoke.yml job, against the LIVE production URL.
 * Plain Node, no dependencies. Consumers FETCH this file from raw.githubusercontent in CI (same pattern as
 * check-lead-store-ordering.mjs), so tuning it fixes every repo at once. CC project "Page speed", task 00f3e85b.
 *
 * WHAT IT ASSERTS. Budgets on METRICS: LCP (ms), CLS, TBT (ms). NEVER the 0-100 score: it is a weighted composite
 * that swings several points run to run on identical code, a flaky gate gets disabled, and a disabled gate catches
 * nothing. Each route is run RUNS times (default 3) and judged on the MEDIAN of each metric.
 *
 * FAILS LOUD. Zero routes, a Lighthouse run that cannot load the page, or no median for a metric is a failure, not
 * a pass: a gate that measured nothing must not report success (memory/feedback_silent_success.md).
 *
 * Env:
 *   BASE_URL            required, e.g. https://example.com (live production; a preview needs a bypass token)
 *   LIGHTHOUSE_ROUTES   comma-separated paths, default "/"
 *   LH_LCP_MS / LH_CLS / LH_TBT_MS   budgets (a blank/unset one is reported, not judged); at least one must be set
 *   LH_RUNS             runs per route, default 3
 *   LH_ENFORCE          "false" = report only (exit 0 on a breach); default enforcing
 *   CHROME_PATH         Chromium binary (CI: the Playwright one, see smoke.yml); falls back to Lighthouse's own detection
 *   LH_VERSION          lighthouse npm version, default pinned below
 * Mobile emulation + Lighthouse's default simulated throttling (the PSI-equivalent profile). Budgets here are
 * mirrored by hand from Command Centre /page-speed; CI cannot read that table (no service key in repo secrets).
 */
import { spawnSync } from 'node:child_process';
import { readFileSync, appendFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const LH_VERSION = process.env.LH_VERSION || '13.5.0';
const base = (process.env.BASE_URL || '').replace(/\/$/, '');
const routes = (process.env.LIGHTHOUSE_ROUTES || '/').split(',').map((s) => s.trim()).filter(Boolean);
const runs = Math.max(1, Number(process.env.LH_RUNS || 3));
const enforce = process.env.LH_ENFORCE !== 'false';
const num = (k) => (process.env[k] && process.env[k].trim() !== '' ? Number(process.env[k]) : null);
const budget = { lcp: num('LH_LCP_MS'), cls: num('LH_CLS'), tbt: num('LH_TBT_MS') };

function die(msg) { console.error(`lighthouse-gate: ${msg}`); process.exit(1); }
if (!/^https:\/\/[^/]+$/.test(base)) die('BASE_URL must be an https origin, e.g. https://example.com');
if (!routes.length) die('no routes: LIGHTHOUSE_ROUTES resolved to nothing');
if (routes.some((r) => !r.startsWith('/'))) die('every route must start with /');
if (Object.values(budget).every((v) => v === null)) die('no budget set (LH_LCP_MS / LH_CLS / LH_TBT_MS): a gate with no budget judges nothing');
if (Object.values(budget).some((v) => v !== null && !Number.isFinite(v))) die('a budget is not a number');

const tmp = mkdtempSync(path.join(tmpdir(), 'lhgate-'));
const median = (xs) => { const v = xs.filter((x) => typeof x === 'number').sort((a, b) => a - b); return v.length ? v[Math.floor(v.length / 2)] : null; };

function once(url, n) {
  const out = path.join(tmp, `run-${n}-${Math.random().toString(36).slice(2)}.json`);
  const r = spawnSync('npx', ['--yes', `lighthouse@${LH_VERSION}`, url, '--output=json', `--output-path=${out}`, '--quiet',
    '--only-categories=performance', '--form-factor=mobile', '--chrome-flags=--headless=new --no-sandbox --disable-gpu'],
    { encoding: 'utf8', timeout: 240000, env: process.env });
  if (r.status !== 0) throw new Error(`lighthouse exit ${r.status}: ${(r.stderr || '').trim().split('\n').slice(-2).join(' | ').slice(0, 300)}`);
  const lr = JSON.parse(readFileSync(out, 'utf8'));
  if (lr.runtimeError) throw new Error(`lighthouse runtimeError: ${lr.runtimeError.code}`);
  const v = (id) => (lr.audits && lr.audits[id] && typeof lr.audits[id].numericValue === 'number' ? lr.audits[id].numericValue : null);
  return { lcp: v('largest-contentful-paint'), cls: v('cumulative-layout-shift'), tbt: v('total-blocking-time'), score: lr.categories?.performance?.score ?? null };
}

const rows = [];
let failed = 0;
for (const route of routes) {
  const url = `${base}${route}`;
  const got = []; const errs = [];
  for (let i = 0; i < runs; i++) { try { got.push(once(url, i)); } catch (e) { errs.push(e.message); } }
  const need = Math.ceil(runs / 2);
  if (got.length < need) { rows.push({ url, error: `only ${got.length}/${runs} runs completed: ${errs[0] || 'unknown'}` }); failed++; continue; }
  const m = { lcp: median(got.map((g) => g.lcp)), cls: median(got.map((g) => g.cls)), tbt: median(got.map((g) => g.tbt)), score: median(got.map((g) => (g.score === null ? null : Math.round(g.score * 100)))) };
  const over = [];
  for (const k of ['lcp', 'cls', 'tbt']) {
    if (budget[k] === null) continue;
    if (m[k] === null) { over.push(`${k} not measured`); continue; }
    if (m[k] > budget[k]) over.push(`${k} ${k === 'cls' ? m[k].toFixed(3) : Math.round(m[k])} > ${budget[k]}`);
  }
  rows.push({ url, m, runs: got.length, over });
  if (over.length) failed++;
}

const lines = ['| Page | LCP ms | CLS | TBT ms | Score (info) | Runs | Result |', '|---|---|---|---|---|---|---|'];
for (const r of rows) {
  lines.push(r.error ? `| ${r.url} | | | | | | FAILED: ${r.error} |`
    : `| ${r.url} | ${Math.round(r.m.lcp)} | ${r.m.cls.toFixed(3)} | ${Math.round(r.m.tbt)} | ${r.m.score} | ${r.runs} | ${r.over.length ? 'OVER BUDGET: ' + r.over.join(', ') : 'ok'} |`);
}
const table = lines.join('\n');
console.log(`Lighthouse gate (mobile, median of ${runs}; budgets lcp=${budget.lcp ?? '-'}ms cls=${budget.cls ?? '-'} tbt=${budget.tbt ?? '-'}ms; ${enforce ? 'ENFORCING' : 'report only'})\n${table}`);
if (process.env.GITHUB_STEP_SUMMARY) { try { appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### Lighthouse gate\n${table}\n`); } catch { /* summary is a nicety */ } }
if (failed && enforce) { console.error(`lighthouse-gate: ${failed} route(s) over budget or unmeasurable`); process.exit(1); }
if (failed) console.error(`lighthouse-gate: ${failed} route(s) over budget or unmeasurable (report only: not failing)`);
