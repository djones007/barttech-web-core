import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync, execSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// scripts/check-palette-contrast.mjs is a standalone CLI; exercised as a child process against a real git repo.
const SCRIPT = join(process.cwd(), "scripts", "check-palette-contrast.mjs");

function run(files: Record<string, string>): { status: number | null; out: string } {
  const dir = mkdtempSync(join(tmpdir(), "palette-contrast-"));
  try {
    for (const [rel, body] of Object.entries(files)) {
      const full = join(dir, rel);
      mkdirSync(join(full, ".."), { recursive: true });
      writeFileSync(full, body);
    }
    execSync("git init -q && git add -A", { cwd: dir });
    const r = spawnSync(process.execPath, [SCRIPT], { cwd: dir, encoding: "utf8" });
    return { status: r.status, out: r.stdout + r.stderr };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("the shipped 1.13:1 form border is caught (CSS rule on an input)", () => {
  const r = run({ "app/globals.css": "input, textarea { background: #ffffff; border: 1px solid #e6e6e6; color: #111111; }" });
  assert.equal(r.status, 1);
  assert.match(r.out, /control border #e6e6e6 on #ffffff is 1\.2\d:1, needs 3:1/);
});

test("a compliant control border and text pass", () => {
  const r = run({ "app/globals.css": ".input { background: #ffffff; border-color: #767676; color: #111; }" });
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /2 pair\(s\) measured/);
});

test("low-contrast text in a CSS block fails; 3:1 is allowed for 24px+ text", () => {
  assert.equal(run({ "a.css": ".x { color: #888888; background: #ffffff; }" }).status, 1);
  assert.equal(run({ "a.css": ".x { color: #888888; background: #ffffff; font-size: 28px; }" }).status, 0);
});

test("a non-control border is not judged as a control border", () => {
  assert.equal(run({ "a.css": ".card { background: #ffffff; border: 1px solid #eeeeee; }" }).status, 0);
});

test("Tailwind arbitrary classes and style objects inside one tag", () => {
  assert.equal(run({ "a.tsx": `export const A = () => <p className="text-[#aaaaaa] bg-[#ffffff]">x</p>;` }).status, 1);
  assert.equal(run({ "a.tsx": `export const A = () => <input style={{ backgroundColor: "#fff", borderColor: "#eeeeee" }} />;` }).status, 1);
  assert.equal(run({ "a.tsx": `export const A = () => <p className="text-[#111111] bg-[#ffffff]">x</p>;` }).status, 0);
});

test("waiver needs a reason", () => {
  const css = (c: string) => `${c}\n.x { color: #999999; background: #ffffff; }`;
  assert.equal(run({ "a.css": css("/* contrast-ok: decorative watermark, aria-hidden */") }).status, 0);
  assert.equal(run({ "a.css": css("/* contrast-ok: */") }).status, 1);
});

test("alpha, var() and named colours are skipped, and the count says so", () => {
  const r = run({ "a.css": ".x { color: rgba(0,0,0,.2); background: var(--bg); }\n.y { color: #999; background: #ffffff80; }" });
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /0 pair\(s\) measured, \d+ skipped/);
});

test(".contrast-pairs.json declares palette pairs", () => {
  const bad = run({ ".contrast-pairs.json": JSON.stringify([{ name: "muted on card", fg: "#8a8f98", bg: "#ffffff" }]) });
  assert.equal(bad.status, 1);
  assert.match(bad.out, /muted on card/);
  const ok = run({ ".contrast-pairs.json": JSON.stringify([{ name: "border", fg: "#767676", bg: "#ffffff", min: 3 }]) });
  assert.equal(ok.status, 0, ok.out);
});

test("tests and node_modules are not scanned", () => {
  assert.equal(run({ "tests/x.css": ".x { color: #999; background: #fff; }", "node_modules/p/a.css": ".x { color: #999; background: #fff; }" }).status, 0);
});
