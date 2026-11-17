import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCRIPT = join(process.cwd(), "scripts", "check-foreign-service-key.mjs");

function runAgainst(files: Record<string, string>, extra: string[] = ["--forbid", "OTHERAPP"]) {
  const dir = mkdtempSync(join(tmpdir(), "foreign-key-"));
  try {
    for (const [rel, contents] of Object.entries(files)) {
      const full = join(dir, rel);
      mkdirSync(join(full, ".."), { recursive: true });
      writeFileSync(full, contents, "utf8");
    }
    const r = spawnSync(process.execPath, [SCRIPT, dir, ...extra], { encoding: "utf8" });
    return { status: r.status, out: r.stdout + r.stderr };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

test("clean site passes, unlisted prefix is allowed", () => {
  const r = runAgainst({ "package.json": '{"name":"site"}', "src/a.ts": "const k = process.env.SHARED_SUPABASE_SERVICE_ROLE_KEY;" });
  assert.equal(r.status, 0);
});
test("another app's key in a site fails", () => {
  const r = runAgainst({ "package.json": '{"name":"site"}', "src/a.ts": "const k = process.env.OTHERAPP_SUPABASE_SERVICE_KEY;" });
  assert.equal(r.status, 1);
  assert.match(r.out, /src\/a\.ts:1/);
});
test("_ROLE_KEY spelling fails too, and .env.example is scanned", () => {
  const r = runAgainst({ "package.json": '{"name":"site"}', ".env.example": "OTHERAPP_SUPABASE_SERVICE_ROLE_KEY=" });
  assert.equal(r.status, 1);
});
test("annotation with a reason passes, without a reason fails", () => {
  const ok = runAgainst({ "package.json": '{"name":"site"}', "a.ts": "// foreign-service-key-ok: weekly lessons cron needs report rows\nconst k = process.env.OTHERAPP_SUPABASE_SERVICE_KEY;" });
  assert.equal(ok.status, 0);
  const bad = runAgainst({ "package.json": '{"name":"site"}', "a.ts": "// foreign-service-key-ok:\nconst k = process.env.OTHERAPP_SUPABASE_SERVICE_KEY;" });
  assert.equal(bad.status, 1);
});
test("no prefixes given fails; owner repo is exempt; markdown and web-core are ignored", () => {
  assert.equal(runAgainst({ "package.json": '{"name":"site"}', "a.ts": "x" }, []).status, 1);
  assert.equal(runAgainst({ "package.json": '{"name":"the-owner"}', "a.ts": "OTHERAPP_SUPABASE_SERVICE_KEY" }, ["--forbid", "OTHERAPP", "--owner", "the-owner"]).status, 0);
  assert.equal(runAgainst({ "package.json": '{"name":"site"}', "CHANGELOG.md": "OTHERAPP_SUPABASE_SERVICE_KEY", "src/web-core/x.ts": "OTHERAPP_SUPABASE_SERVICE_KEY", "a.ts": "x" }).status, 0);
});
