import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCRIPT = join(process.cwd(), "scripts", "check-success-safety-net.mjs");

function runAgainst(files: Record<string, string>): { status: number | null; out: string } {
  const dir = mkdtempSync(join(tmpdir(), "safety-net-"));
  try {
    for (const [rel, contents] of Object.entries(files)) {
      const full = join(dir, rel);
      mkdirSync(join(full, ".."), { recursive: true });
      writeFileSync(full, contents, "utf8");
    }
    const r = spawnSync(process.execPath, [SCRIPT, dir], { encoding: "utf8" });
    return { status: r.status, out: r.stdout + r.stderr };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const SELLING_PAGE = `export default function S(){ return <h1>Payment complete. Your order is confirmed.</h1>; }`;

test("a payment-confirming success page with no safety net fails", () => {
  const r = runAgainst({ "src/app/success/SuccessClient.tsx": SELLING_PAGE });
  assert.equal(r.status, 1);
  assert.match(r.out, /src\/app\/success\/SuccessClient\.tsx/);
});

test("rendering the SafetyNet component passes", () => {
  const r = runAgainst({ "src/app/success/SuccessClient.tsx": `import SafetyNet from "@/components/SafetyNet";\n${SELLING_PAGE.replace("<h1>", "<SafetyNet pi={p} /><h1>")}` });
  assert.equal(r.status, 0, r.out);
});

test("a thin page.tsx passes when its sibling client renders the net", () => {
  const r = runAgainst({
    "src/app/success/page.tsx": `export default function P(){ return <SuccessClient />; } // Payment complete`,
    "src/app/success/SuccessClient.tsx": `import { SafetyNet } from "@/components/SafetyNet";\nexport default function C(){ return <div>Payment complete<SafetyNet/></div>; }`,
  });
  assert.equal(r.status, 0, r.out);
});

test("importing the shared web-core module counts", () => {
  const r = runAgainst({ "app/thank-you/page.tsx": `import { buildSafetyNet } from "@/web-core/safetyNet";\n${SELLING_PAGE}` });
  assert.equal(r.status, 0, r.out);
});

test("an optin thank-you that confirms no payment is not a selling page", () => {
  const r = runAgainst({ "app/thank-you/page.tsx": `export default function P(){ return <h1>Thanks for signing up</h1>; }` });
  assert.equal(r.status, 0, r.out);
});

test("an annotation with a reason waives the file; one without does not", () => {
  assert.equal(runAgainst({ "app/success/page.tsx": `// safety-net-ok: booking confirmation, no purchase\n${SELLING_PAGE}` }).status, 0);
  assert.equal(runAgainst({ "app/success/page.tsx": `// safety-net-ok:\n${SELLING_PAGE}` }).status, 1);
});

test("the baseline waives a path only with a reason", () => {
  assert.equal(runAgainst({ "app/success/page.tsx": SELLING_PAGE, ".safety-net-baseline": "app/success/page.tsx # payment taken off-site, nothing to show\n" }).status, 0);
  assert.equal(runAgainst({ "app/success/page.tsx": SELLING_PAGE, ".safety-net-baseline": "app/success/page.tsx\n" }).status, 1);
});

test("a repo with no success page, and test files, are ignored", () => {
  assert.equal(runAgainst({ "src/app/page.tsx": `export default function P(){ return <p>hi</p>; }` }).status, 0);
  assert.equal(runAgainst({ "tests/success/page.tsx": SELLING_PAGE }).status, 0);
});
