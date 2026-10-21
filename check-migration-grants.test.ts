import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// scripts/check-migration-grants.mjs is a standalone Node CLI, run directly
// by consumer CI, so it is exercised here the same way CI exercises it: as a
// child process against real fixture files on disk, asserting on exit code
// and output.
// ---------------------------------------------------------------------------

const SCRIPT = join(process.cwd(), "scripts", "check-migration-grants.mjs");
const M = "supabase/migrations/";

function runAgainst(files: Record<string, string>, extraArgs: string[] = []): { status: number | null; stdout: string } {
  const dir = mkdtempSync(join(tmpdir(), "migration-grants-"));
  try {
    for (const [rel, contents] of Object.entries(files)) {
      const full = join(dir, rel);
      mkdirSync(join(full, ".."), { recursive: true });
      writeFileSync(full, contents, "utf8");
    }
    const result = spawnSync(process.execPath, [SCRIPT, dir, ...extraArgs], { encoding: "utf8" });
    return { status: result.status, stdout: result.stdout + result.stderr };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const CREATE = "create table public.widgets (\n  id uuid primary key default gen_random_uuid(),\n  name text\n);\n";

test("a new public table with no service_role grant fails", () => {
  const r = runAgainst({ [M + "20261021_widgets.sql"]: CREATE });
  assert.equal(r.status, 1);
  assert.match(r.stdout, /20261021_widgets\.sql:1 {2}public\.widgets/);
  assert.match(r.stdout, /GRANT SELECT, INSERT, UPDATE, DELETE ON public\.widgets TO service_role;/);
});

test("an unqualified CREATE TABLE is treated as public", () => {
  const r = runAgainst({ [M + "20261022a_widgets.sql"]: "create table if not exists widgets (id int);" });
  assert.equal(r.status, 1);
  assert.match(r.stdout, /public\.widgets/);
});

test("a grant to service_role in the same file passes", () => {
  const r = runAgainst({
    [M + "20261021_widgets.sql"]: CREATE + "grant select, insert, update, delete on table public.widgets to service_role;\n",
  });
  assert.equal(r.status, 0, r.stdout);
  assert.match(r.stdout, /1 in-scope public table/);
});

test("a grant listing several tables and several roles passes for each", () => {
  const r = runAgainst({
    [M + "20261021_two.sql"]:
      "create table public.a (id int);\ncreate table public.b (id int);\n" +
      "GRANT ALL ON public.a, public.b TO authenticated, service_role;\n",
  });
  assert.equal(r.status, 0, r.stdout);
  assert.match(r.stdout, /2 in-scope public table/);
});

test("a grant in a LATER migration file passes", () => {
  const r = runAgainst({
    [M + "20261021_widgets.sql"]: CREATE,
    [M + "20261023_widgets_grants.sql"]: "grant select on public.widgets to service_role;",
  });
  assert.equal(r.status, 0, r.stdout);
});

test("a grant to other roles only (not service_role) still fails", () => {
  const r = runAgainst({
    [M + "20261021_widgets.sql"]: CREATE + "grant select on public.widgets to anon, authenticated;\n",
  });
  assert.equal(r.status, 1);
});

test("a grant that exists only inside a comment or string does not count", () => {
  const r = runAgainst({
    [M + "20261021_widgets.sql"]:
      CREATE + "-- grant select on public.widgets to service_role;\n" +
      "select 'grant select on public.widgets to service_role;';\n",
  });
  assert.equal(r.status, 1);
});

test("GRANT ... ON ALL TABLES IN SCHEMA public after the CREATE passes", () => {
  const r = runAgainst({
    [M + "20261021_widgets.sql"]: CREATE + "grant all on all tables in schema public to service_role;\n",
  });
  assert.equal(r.status, 0, r.stdout);
});

test("GRANT ... ON ALL TABLES IN SCHEMA public BEFORE the CREATE does not cover it", () => {
  const r = runAgainst({
    [M + "20261021_widgets.sql"]: "grant all on all tables in schema public to service_role;\n" + CREATE,
  });
  assert.equal(r.status, 1);
});

test("ALTER DEFAULT PRIVILEGES granting to service_role passes", () => {
  const r = runAgainst({
    [M + "20261021_widgets.sql"]:
      "alter default privileges in schema public grant select, insert, update, delete on tables to service_role;\n" + CREATE,
  });
  assert.equal(r.status, 0, r.stdout);
});

test("migrations before the cutoff are grandfathered", () => {
  const r = runAgainst({
    [M + "20261020c_widgets.sql"]: CREATE,
    [M + "20250101_old.sql"]: "create table public.old (id int);",
  });
  assert.equal(r.status, 0, r.stdout);
  assert.match(r.stdout, /0 in-scope public table\(s\) across 0 of 2 migrations/);
});

test("--all ignores the cutoff and audits every file", () => {
  const r = runAgainst({ [M + "20261020c_widgets.sql"]: CREATE }, ["--all"]);
  assert.equal(r.status, 1);
});

test("a 14-digit CLI timestamp prefix is dated by its first 8 digits", () => {
  assert.equal(runAgainst({ [M + "20261021093000_widgets.sql"]: CREATE }).status, 1);
  assert.equal(runAgainst({ [M + "20261020235959_widgets.sql"]: CREATE }).status, 0);
});

test("sequential migrations are unchecked (and say so) until enforceFromSequence is set", () => {
  const r = runAgainst({ [M + "0546_widgets.sql"]: CREATE });
  assert.equal(r.status, 0, r.stdout);
  assert.match(r.stdout, /1 sequentially-numbered migration\(s\) are NOT checked/);
});

test("sequential migrations at or above enforceFromSequence are enforced", () => {
  const r = runAgainst({
    ".migration-grants-gate.json": JSON.stringify({ enforceFromSequence: 546 }),
    [M + "0545_old.sql"]: "create table public.old (id int);",
    [M + "0546_widgets.sql"]: CREATE,
  });
  assert.equal(r.status, 1);
  assert.match(r.stdout, /0546_widgets\.sql:1/);
  assert.doesNotMatch(r.stdout, /public\.old/);
});

test("tables in other schemas, temp tables and partitions are skipped", () => {
  const r = runAgainst({
    [M + "20261021_misc.sql"]:
      "create table private.secret (id int);\n" +
      "create temp table scratch (id int);\n" +
      "create table public.events_2026 partition of public.events for values from ('2026-01-01') to ('2027-01-01');\n",
  });
  assert.equal(r.status, 0, r.stdout);
  assert.match(r.stdout, /0 in-scope/);
});

test("a table dropped later is not required to have a grant", () => {
  const r = runAgainst({
    [M + "20261021_widgets.sql"]: CREATE,
    [M + "20261022_drop.sql"]: "drop table if exists public.widgets;",
  });
  assert.equal(r.status, 0, r.stdout);
});

test("a rename carries the obligation, and a grant on the new name satisfies it", () => {
  const files = {
    [M + "20261021_widgets.sql"]: CREATE,
    [M + "20261022_rename.sql"]: "alter table public.widgets rename to gadgets;",
  };
  const fail = runAgainst(files);
  assert.equal(fail.status, 1);
  assert.match(fail.stdout, /public\.gadgets/);
  const pass = runAgainst({ ...files, [M + "20261023_g.sql"]: "grant select on public.gadgets to service_role;" });
  assert.equal(pass.status, 0, pass.stdout);
});

test("a grants-ok annotation with a reason suppresses the finding", () => {
  const r = runAgainst({
    [M + "20261021_widgets.sql"]: "-- grants-ok: only reached through a security-definer rpc\n" + CREATE,
  });
  assert.equal(r.status, 0, r.stdout);
});

test("a bare grants-ok annotation with no reason fails", () => {
  const r = runAgainst({ [M + "20261021_widgets.sql"]: "-- grants-ok:\n" + CREATE });
  assert.equal(r.status, 1);
  assert.match(r.stdout, /bare "grants-ok" annotation/);
});

test("ignoreTables in config skips matching tables", () => {
  const r = runAgainst({
    ".migration-grants-gate.json": JSON.stringify({ ignoreTables: ["widg*"] }),
    [M + "20261021_widgets.sql"]: CREATE,
  });
  assert.equal(r.status, 0, r.stdout);
});

test("a repo with no supabase/migrations directory passes", () => {
  const r = runAgainst({ "README.md": "no migrations here" });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /nothing to check/);
});
