import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// scripts/check-legal-placeholders.mjs runs as a consumer's prebuild step; exercised the same way.

const SCRIPT = join(process.cwd(), "scripts", "check-legal-placeholders.mjs");

function runAgainst(files: Record<string, string>, env: Record<string, string> = {}, extra: string[] = []) {
  const dir = mkdtempSync(join(tmpdir(), "legal-placeholders-"));
  try {
    const all = { "package.json": JSON.stringify({ name: "some-brand-site" }), ...files };
    for (const [rel, contents] of Object.entries(all)) {
      const full = join(dir, rel);
      mkdirSync(join(full, ".."), { recursive: true });
      writeFileSync(full, contents, "utf8");
    }
    const r = spawnSync(process.execPath, [SCRIPT, dir, ...extra], {
      encoding: "utf8",
      env: { ...process.env, VERCEL_ENV: "", ...env },
    });
    return { status: r.status, out: r.stdout + r.stderr };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const TODO_PAGE = `export default function P() { return <p>TODO: who we are.</p>; }`;
const REAL_PAGE = `// It used to say TODO here; now it is real.
export default function P() { return <p>We are Example Ltd. Email help@example.test.</p>; }`;

test("production build + TODO in /privacy fails", () => {
  const r = runAgainst({ "src/app/privacy/page.tsx": TODO_PAGE }, { VERCEL_ENV: "production" });
  assert.equal(r.status, 1);
  assert.match(r.out, /src\/app\/privacy\/page\.tsx:1\s+TODO/);
});

test("preview / local build with the same page only warns", () => {
  const r = runAgainst({ "src/app/privacy/page.tsx": TODO_PAGE }, { VERCEL_ENV: "preview" });
  assert.equal(r.status, 0);
  assert.match(r.out, /::warning::/);
});

test("--strict fails outside production", () => {
  assert.equal(runAgainst({ "app/terms/page.tsx": TODO_PAGE }, {}, ["--strict"]).status, 1);
});

test("[BRAND] and [CONTACT EMAIL] placeholders fail; route groups are searched", () => {
  const r = runAgainst(
    { "src/app/(marketing)/disclaimer/page.tsx": `export default function P() { return <p>[BRAND] is not advice. Contact [CONTACT EMAIL].</p>; }` },
    { VERCEL_ENV: "production" }
  );
  assert.equal(r.status, 1);
  assert.match(r.out, /\[BRAND\]/);
});

test("a TODO only inside a comment passes — the fix's own explanation must not trip the gate", () => {
  assert.equal(runAgainst({ "src/app/privacy/page.tsx": REAL_PAGE }, { VERCEL_ENV: "production" }).status, 0);
});

test("a REPLACE_WITH token in lib/seller.ts fails", () => {
  const r = runAgainst({ "src/lib/seller.ts": `export const SELLER = { company: "REPLACE_WITH_LEGAL_ENTITY" };` }, { VERCEL_ENV: "production" });
  assert.equal(r.status, 1);
  assert.match(r.out, /REPLACE_WITH_LEGAL_ENTITY/);
});

test("a reasoned waiver passes", () => {
  const page = `export default function P() {
  // legal-placeholder-ok: the product is literally called TODO
  return <p>TODO is our app.</p>;
}`;
  assert.equal(runAgainst({ "src/app/terms/page.tsx": page }, { VERCEL_ENV: "production" }).status, 0);
});

test("a package named *-template is skipped (it owns the placeholders)", () => {
  const r = runAgainst(
    { "package.json": JSON.stringify({ name: "x-next-template" }), "src/app/privacy/page.tsx": TODO_PAGE },
    { VERCEL_ENV: "production" }
  );
  assert.equal(r.status, 0);
  assert.match(r.out, /SKIPPED/);
});
