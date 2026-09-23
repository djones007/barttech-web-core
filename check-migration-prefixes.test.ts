import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// scripts/check-migration-prefixes.mjs is a standalone Node CLI, run directly
// by consumer CI, so it is exercised here the same way CI exercises it: as a
// child process against real fixture files on disk, asserting on exit code
// and stdout.
// ---------------------------------------------------------------------------

const SCRIPT = join(process.cwd(), "scripts", "check-migration-prefixes.mjs");

function runAgainst(files: Record<string, string>): { status: number | null; stdout: string } {
  const dir = mkdtempSync(join(tmpdir(), "migration-prefixes-"));
  try {
    for (const [rel, contents] of Object.entries(files)) {
      const full = join(dir, rel);
      mkdirSync(join(full, ".."), { recursive: true });
      writeFileSync(full, contents, "utf8");
    }
    const result = spawnSync(process.execPath, [SCRIPT, dir], { encoding: "utf8" });
    return { status: result.status, stdout: result.stdout + result.stderr };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("a duplicate sequential prefix is a finding", () => {
  const r = runAgainst({
    "supabase/migrations/0053_amazon_campaign_status.sql": "select 1;",
    "supabase/migrations/0053_funnel_economics.sql": "select 1;",
  });
  assert.equal(r.status, 1);
  assert.match(r.stdout, /\[sequential\] 0053/);
  assert.match(r.stdout, /0053_amazon_campaign_status\.sql/);
  assert.match(r.stdout, /0053_funnel_economics\.sql/);
});

test("a duplicate lettered-date prefix is a finding", () => {
  const r = runAgainst({
    "supabase/migrations/20260729d_contact_events_brand_and_index.sql": "select 1;",
    "supabase/migrations/20260729d_ms_ramp_recipients.sql": "select 1;",
  });
  assert.equal(r.status, 1);
  assert.match(r.stdout, /\[date-lettered\] 20260729d/);
});

test("an unlettered same-date group is NOT a finding, even with many files", () => {
  const r = runAgainst({
    "supabase/migrations/20260713_a.sql": "select 1;",
    "supabase/migrations/20260713_b.sql": "select 1;",
    "supabase/migrations/20260713_c.sql": "select 1;",
    "supabase/migrations/20260713_d.sql": "select 1;",
    "supabase/migrations/20260713_e.sql": "select 1;",
    "supabase/migrations/20260713_f.sql": "select 1;",
    "supabase/migrations/20260713_g.sql": "select 1;",
  });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /OK — 7 file\(s\) checked/);
});

test("a baselined prefix with a reason passes", () => {
  const r = runAgainst({
    ".migration-prefix-baseline":
      "0053  # both applied and object-disjoint; renaming would desync one from its ledger name\n",
    "supabase/migrations/0053_amazon_campaign_status.sql": "select 1;",
    "supabase/migrations/0053_funnel_economics.sql": "select 1;",
  });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /OK — 2 file\(s\) checked, 1 baselined prefix/);
});

test("a baseline entry with no reason does NOT suppress the finding", () => {
  const r = runAgainst({
    ".migration-prefix-baseline": "0053\n",
    "supabase/migrations/0053_amazon_campaign_status.sql": "select 1;",
    "supabase/migrations/0053_funnel_economics.sql": "select 1;",
  });
  assert.equal(r.status, 1);
  assert.match(r.stdout, /\[sequential\] 0053/);
});

test("a baseline entry with a bare hash and no reason text also does NOT suppress", () => {
  const r = runAgainst({
    ".migration-prefix-baseline": "0053  #\n",
    "supabase/migrations/0053_amazon_campaign_status.sql": "select 1;",
    "supabase/migrations/0053_funnel_economics.sql": "select 1;",
  });
  assert.equal(r.status, 1);
});

test("a clean repo with unique prefixes passes with a non-zero file count", () => {
  const r = runAgainst({
    "supabase/migrations/0001_init.sql": "select 1;",
    "supabase/migrations/0002_next.sql": "select 1;",
    "supabase/migrations/20260801_same_day_one.sql": "select 1;",
    "supabase/migrations/20260801_same_day_two.sql": "select 1;",
    "supabase/migrations/20260802a_disambiguated.sql": "select 1;",
  });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /OK — 5 file\(s\) checked, 0 baselined prefix/);
});

test("a repo with no supabase/migrations directory passes with zero files checked", () => {
  const r = runAgainst({
    "README.md": "no migrations here",
  });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /OK — 0 file\(s\) checked/);
});
