import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// scripts/check-dead-space.mjs is a standalone CLI run by consumer CI, so it is
// exercised as a child process against fixture trees, asserting exit code + stdout.

const SCRIPT = join(process.cwd(), "scripts", "check-dead-space.mjs");

function runAgainst(files: Record<string, string>): { status: number | null; stdout: string } {
  const dir = mkdtempSync(join(tmpdir(), "dead-space-"));
  try {
    for (const [rel, contents] of Object.entries(files)) {
      const full = join(dir, rel);
      mkdirSync(join(full, ".."), { recursive: true });
      writeFileSync(full, contents, "utf8");
    }
    const r = spawnSync(process.execPath, [SCRIPT, dir], { encoding: "utf8" });
    return { status: r.status, stdout: r.stdout + r.stderr };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const UI = { "app/page.tsx": "export default function P(){return <main/>}" };

test("a spec that imports and calls auditDeadSpace passes", () => {
  const r = runAgainst({
    ...UI,
    "tests/mobile.spec.ts": `import { auditDeadSpace, DEAD_SPACE_VIEWPORTS } from "../src/web-core/deadSpace";\nconst r = await auditDeadSpace(page, v);`,
  });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /OK — tests\/mobile\.spec\.ts imports and calls/);
});

test("a multi-line import passes", () => {
  const r = runAgainst({
    ...UI,
    "tests/mobile.spec.ts": `import {\n  auditDeadSpace,\n  deadSpaceGapMessage,\n} from "@/web-core/deadSpace";\nawait auditDeadSpace(page, v);`,
  });
  assert.equal(r.status, 0);
});

test("a spec that only names the thresholds fails", () => {
  const r = runAgainst({
    ...UI,
    "tests/mobile.spec.ts": `const DEAD_SPACE_FAIL_PX = { phone: 120, desktop: 200 };\n// auditDeadSpace would go here`,
  });
  assert.equal(r.status, 1);
  assert.match(r.stdout, /does not import auditDeadSpace/);
  assert.match(r.stdout, /never calls auditDeadSpace/);
});

test("importing without calling fails", () => {
  const r = runAgainst({
    ...UI,
    "tests/mobile.spec.ts": `import { auditDeadSpace } from "@/web-core/deadSpace";\nvoid 0;`,
  });
  assert.equal(r.status, 1);
  assert.match(r.stdout, /never calls/);
});

test("calling a local copy without the shared import fails", () => {
  const r = runAgainst({
    ...UI,
    "tests/mobile.spec.ts": `async function auditDeadSpace(p:any,v:any){}\nawait auditDeadSpace(page, v);`,
  });
  assert.equal(r.status, 1);
  assert.match(r.stdout, /does not import/);
});

test("a commented-out call does not count", () => {
  const r = runAgainst({
    ...UI,
    "tests/mobile.spec.ts": `import { auditDeadSpace } from "@/web-core/deadSpace";\n// await auditDeadSpace(page, v);`,
  });
  assert.equal(r.status, 1);
});

test("no mobile spec: pass silently", () => {
  const r = runAgainst({ ...UI, "tests/other.spec.ts": "" });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /nothing to gate/);
});

test("no UI: pass silently even with a bare spec", () => {
  const r = runAgainst({ "lib/a.ts": "export {}", "tests/mobile.spec.ts": "" });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /no UI/);
});

test("baselined spec is skipped", () => {
  const r = runAgainst({ ...UI, "tests/mobile.spec.ts": "", ".dead-space-baseline": "tests/mobile.spec.ts # internal tool\n" });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /baselined/);
});
