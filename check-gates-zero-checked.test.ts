import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";

// Estate issue b4bd94c4: a CI gate that checked nothing used to exit 0. These pin the new contract
// (zero checked is a failure, or an explicit NOT APPLICABLE / opt-out), run as consumer CI runs them.

const S = (n: string) => join(process.cwd(), "scripts", n);

function repo(files: Record<string, string>, git = false): string {
  const dir = mkdtempSync(join(tmpdir(), "gate-zero-"));
  for (const [rel, body] of Object.entries(files)) {
    const full = join(dir, rel);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, body, "utf8");
  }
  if (git) {
    spawnSync("git", ["init", "-q"], { cwd: dir });
    spawnSync("git", ["add", "--", ...Object.keys(files)], { cwd: dir });
  }
  return dir;
}
function run(script: string, dir: string, extra: string[] = []) {
  const r = spawnSync(process.execPath, [S(script), dir, ...extra], { encoding: "utf8" });
  return { status: r.status, out: r.stdout + r.stderr };
}
const NEXT = JSON.stringify({ dependencies: { next: "15.0.0" } });
const WEBHOOK_GATES = ["check-webhook-verification.mjs", "check-webhook-swallowed-errors.mjs"];

for (const gate of WEBHOOK_GATES) {
  test(`${gate}: Next app with no route files under the roots FAILS`, () => {
    const d = repo({ "package.json": NEXT, "src/app/page.tsx": "export default function P(){return null}" });
    try {
      const r = run(gate, d, ["--strict"]);
      assert.equal(r.status, 1);
      assert.match(r.out, /checked nothing/);
    } finally { rmSync(d, { recursive: true, force: true }); }
  });

  test(`${gate}: allowNoRoutes opt-out passes, loudly`, () => {
    const d = repo({ "package.json": NEXT, ".webhook-auth-gate.json": '{"allowNoRoutes":true}' });
    try {
      const r = run(gate, d, ["--strict"]);
      assert.equal(r.status, 0);
      assert.match(r.out, /allowNoRoutes/);
    } finally { rmSync(d, { recursive: true, force: true }); }
  });

  test(`${gate}: a repo with no next dependency is NOT APPLICABLE, said out loud`, () => {
    const d = repo({ "package.json": JSON.stringify({ dependencies: {} }) });
    try {
      const r = run(gate, d, ["--strict"]);
      assert.equal(r.status, 0);
      assert.match(r.out, /NOT APPLICABLE/);
    } finally { rmSync(d, { recursive: true, force: true }); }
  });
}

test("lead-store-ordering: lead-capture routes present but none calls the primary store FAILS", () => {
  const d = repo({ "src/app/api/optin/route.ts": "export async function POST(){ return Response.json({ok:true}) }\n" }, true);
  try {
    const r = run("check-lead-store-ordering.mjs", d);
    assert.equal(r.status, 1);
    assert.match(r.out, /checked NOTHING/);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test("lead-store-ordering: allowNoPrimary opt-out and no-lead-routes repos pass without claiming a clean check", () => {
  const a = repo({ "src/app/api/optin/route.ts": "export async function POST(){ return Response.json({ok:true}) }\n", ".lead-store-ordering.json": '{"allowNoPrimary":true}' }, true);
  const b = repo({ "src/app/api/health/route.ts": "export async function GET(){ return Response.json({ok:true}) }\n" }, true);
  try {
    assert.equal(run("check-lead-store-ordering.mjs", a).status, 0);
    const rb = run("check-lead-store-ordering.mjs", b);
    assert.equal(rb.status, 0);
    assert.match(rb.out, /NOT APPLICABLE/);
    assert.doesNotMatch(rb.out, /gate OK/);
  } finally { rmSync(a, { recursive: true, force: true }); rmSync(b, { recursive: true, force: true }); }
});

test("lead-store-ordering: a real primary write is still checked and a bad ordering still fails", () => {
  const good = repo({ "src/app/api/optin/route.ts": "export async function POST(r:Request){\n await bartmailOptin({email:'a'});\n return Response.json({ok:true}) }\n" }, true);
  const bad = repo({ "src/app/api/optin/route.ts": "export async function POST(r:Request){\n if (x) { return Response.json({ok:true}) }\n await bartmailOptin({email:'a'}); return Response.json({ok:true}) }\n" }, true);
  try {
    assert.equal(run("check-lead-store-ordering.mjs", good).status, 0);
    assert.equal(run("check-lead-store-ordering.mjs", bad).status, 1);
  } finally { rmSync(good, { recursive: true, force: true }); rmSync(bad, { recursive: true, force: true }); }
});

// ---- M8 follow-ups (b4bd94c4): gates that passed without really checking ----

test("lead-store-ordering: a `received: true` success return above the primary write FAILS", () => {
  const d = repo({ "src/app/api/optin/route.ts": "export async function POST(r:Request){\n if (x) { return NextResponse.json({ received: true }) }\n await bartmailOptin({email:'a'}); return Response.json({ok:true}) }\n" }, true);
  try { assert.equal(run("check-lead-store-ordering.mjs", d).status, 1); } finally { rmSync(d, { recursive: true, force: true }); }
});

test("lead-store-ordering: a fire-and-forget primary write FAILS, an awaited or returned one passes", () => {
  const bare = repo({ "src/app/api/optin/route.ts": "export async function POST(r:Request){\n bartmailOptin({email:'a'});\n return Response.json({ok:true}) }\n" }, true);
  const voided = repo({ "src/app/api/optin/route.ts": "export async function POST(r:Request){\n void bartmailOptin({email:'a'});\n return Response.json({ok:true}) }\n" }, true);
  const ret = repo({ "src/app/api/optin/route.ts": "export async function POST(r:Request){\n return bartmailOptin({email:'a'}) }\n" }, true);
  try {
    const rb = run("check-lead-store-ordering.mjs", bare);
    assert.equal(rb.status, 1);
    assert.match(rb.out, /not awaited/);
    assert.equal(run("check-lead-store-ordering.mjs", voided).status, 1);
    assert.equal(run("check-lead-store-ordering.mjs", ret).status, 0);
  } finally { for (const d of [bare, voided, ret]) rmSync(d, { recursive: true, force: true }); }
});

// Built by concatenation so this file does not itself contain a storage call for the gate to scan.
const STORE = "await supabase" + ".stor" + "age.from('b').upload(key, file);\n";
// This gate walks process.cwd() rather than taking a directory argument.
function runInCwd(script: string, dir: string) {
  const r = spawnSync(process.execPath, [S(script)], { encoding: "utf8", cwd: dir });
  return { status: r.status, out: r.stdout + r.stderr };
}
test("storage-path-traversal: an import with no call FAILS; an import that is called passes", () => {
  const unused = repo({ "src/a.ts": "import { safeUploadFilename } from '@/lib/uploads';\n" + STORE }, false);
  const used = repo({ "src/a.ts": "import { safeUploadFilename } from '@/lib/uploads';\nconst key = safeUploadFilename(n);\n" + STORE }, false);
  const aliased = repo({ "src/a.ts": "import { safeUploadFilename as clean } from '@/lib/uploads';\nconst key = clean(n);\n" + STORE }, false);
  const none = repo({ "src/a.ts": STORE }, false);
  try {
    assert.equal(runInCwd("check-storage-path-traversal.mjs", unused).status, 1);
    assert.equal(runInCwd("check-storage-path-traversal.mjs", used).status, 0);
    assert.equal(runInCwd("check-storage-path-traversal.mjs", aliased).status, 0);
    assert.equal(runInCwd("check-storage-path-traversal.mjs", none).status, 1);
  } finally { for (const d of [unused, used, aliased, none]) rmSync(d, { recursive: true, force: true }); }
});
