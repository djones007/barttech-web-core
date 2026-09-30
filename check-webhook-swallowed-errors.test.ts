import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// scripts/check-webhook-swallowed-errors.mjs is a standalone CLI (warn-only unless --strict), exercised the
// way consumer CI runs it: as a child process against fixture route files.

const SCRIPT = join(process.cwd(), "scripts", "check-webhook-swallowed-errors.mjs");

function run(route: string, strict = true): { status: number | null; out: string } {
  const dir = mkdtempSync(join(tmpdir(), "webhook-swallow-"));
  try {
    const full = join(dir, "src/app/api/webhooks/x/route.ts");
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, route, "utf8");
    const r = spawnSync(process.execPath, [SCRIPT, dir, ...(strict ? ["--strict"] : [])], { encoding: "utf8" });
    return { status: r.status, out: r.stdout + r.stderr };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const HEAD = `import { NextResponse } from "next/server";\nexport async function POST(req: Request) {\n`;

test("a catch that answers 2xx and reports nothing is a finding", () => {
  const r = run(HEAD + `try { await work(); } catch (e) { console.log(e); return NextResponse.json({ ok: true }); }\nreturn NextResponse.json({ ok: true });\n}\n`);
  assert.equal(r.status, 1);
  assert.match(r.out, /answers 2xx and reports nothing/);
  assert.match(r.out, /route\.ts:3/);
});

test("warn-only by default: the same finding exits 0", () => {
  const r = run(HEAD + `try { await work(); } catch { return NextResponse.json({ ok: true }); }\n}\n`, false);
  assert.equal(r.status, 0);
  assert.match(r.out, /answer 2xx without reporting/);
});

test("a catch that falls through to a later 2xx is a finding", () => {
  const r = run(HEAD + `try { await work(); } catch (e) { console.log(e); }\nreturn NextResponse.json({ ok: true });\n}\n`);
  assert.equal(r.status, 1);
  assert.match(r.out, /falls through to a 2xx/);
});

test("a catch that reports (Sentry / notify / console.error) is fine even with a 200", () => {
  for (const report of ["Sentry.captureException(e);", "await notify({ title: 'x' });", "console.error(e);", "raiseAlert(e);"]) {
    const r = run(HEAD + `try { await work(); } catch (e) { ${report} return NextResponse.json({ ok: true }); }\n}\n`);
    assert.equal(r.status, 0, report);
  }
});

test("a catch that throws or returns 4xx/5xx is fine", () => {
  assert.equal(run(HEAD + `try { await work(); } catch (e) { throw e; }\nreturn NextResponse.json({ ok: true });\n}\n`).status, 0);
  assert.equal(run(HEAD + `try { await work(); } catch { return NextResponse.json({ error: "x" }, { status: 500 }); }\nreturn NextResponse.json({ ok: true });\n}\n`).status, 0);
});

test("the annotation needs a reason; a bare one is itself a finding", () => {
  const body = `try { await work(); } catch { return NextResponse.json({ ok: true }); }\n}\n`;
  assert.equal(run(`// webhook-200-ok: Shopify deletes the subscription after repeated 5xx; work() raises an alert\n` + HEAD + body).status, 0);
  const bare = run(`// webhook-200-ok:\n` + HEAD + body);
  assert.equal(bare.status, 1);
  assert.match(bare.out, /bare "webhook-200-ok"/);
});

test("a route that is not a webhook receiver is ignored", () => {
  const dir = mkdtempSync(join(tmpdir(), "webhook-swallow-"));
  try {
    const full = join(dir, "src/app/api/things/route.ts");
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, HEAD + `try { await work(); } catch { return NextResponse.json({ ok: true }); }\n}\n`, "utf8");
    const r = spawnSync(process.execPath, [SCRIPT, dir, "--strict"], { encoding: "utf8" });
    assert.equal(r.status, 0);
    assert.match(r.stdout, /no catch answers 2xx|nothing to check|0 webhook receiver/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
