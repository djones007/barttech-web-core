import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// scripts/check-third-party-fonts.mjs is a standalone Node CLI, run directly
// by consumer CI (see scripts/CLAUDE.md) rather than imported as a module —
// so it is exercised here the same way CI exercises it: as a child process
// against real fixture files on disk, asserting on exit code and stdout.
// ---------------------------------------------------------------------------

const SCRIPT = join(process.cwd(), "scripts", "check-third-party-fonts.mjs");

function runAgainst(files: Record<string, string>): { status: number | null; stdout: string } {
  const dir = mkdtempSync(join(tmpdir(), "third-party-fonts-"));
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

test("a Google Fonts <link> is a finding", () => {
  const r = runAgainst({
    "app/layout.tsx": `
      export default function Layout() {
        return (
          <html>
            <head>
              <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter" />
            </head>
          </html>
        );
      }
    `,
  });
  assert.equal(r.status, 1);
  assert.match(r.stdout, /app\/layout\.tsx:\d+.*Google Fonts/);
});

test("a Bunny Fonts @import in CSS is a finding", () => {
  const r = runAgainst({
    "styles/legacy.css": `@import url("https://fonts.bunny.net/css?family=inter");`,
  });
  assert.equal(r.status, 1);
  assert.match(r.stdout, /styles\/legacy\.css:\d+.*Bunny Fonts/);
});

test("a hardcoded Adobe Fonts/Typekit URL assigned to a variable is a finding", () => {
  const r = runAgainst({
    "lib/theme.ts": `export const kitUrl = "https://use.typekit.net/abc1234.css";`,
  });
  assert.equal(r.status, 1);
  assert.match(r.stdout, /lib\/theme\.ts:\d+.*Adobe Fonts/);
});

test("the same host named only inside a CSP directive is not flagged (permission, not a load)", () => {
  const r = runAgainst({
    "next.config.ts": `
      const csp = "font-src 'self' https://fonts.gstatic.com; style-src 'self' https://fonts.googleapis.com";
    `,
  });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /OK/);
});

test("Content-Security-Policy header name on the same line also suppresses the match", () => {
  const r = runAgainst({
    "lib/headers.ts": `res.headers.set("Content-Security-Policy", "font-src https://fonts.googleapis.com");`,
  });
  assert.equal(r.status, 0);
});

test("next/font self-hosting is clean — no third-party host referenced at all", () => {
  const r = runAgainst({
    "app/layout.tsx": `
      import { Inter } from "next/font/google";
      const inter = Inter({ subsets: ["latin"] });
      export default function Layout({ children }: { children: React.ReactNode }) {
        return <html className={inter.className}>{children}</html>;
      }
    `,
  });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /OK/);
});

test("an annotated exception on the line above is suppressed", () => {
  const r = runAgainst({
    "app/layout.tsx": `
      // third-party-font-ok: legacy embed kept live for one archived page, tracked on estate issue 123
      const url = "https://fonts.googleapis.com/css2?family=Inter";
    `,
  });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /1 annotated exception/);
});

test("an annotated exception with no reason does not suppress the finding", () => {
  const r = runAgainst({
    "app/layout.tsx": `
      // third-party-font-ok:
      const url = "https://fonts.googleapis.com/css2?family=Inter";
    `,
  });
  assert.equal(r.status, 1);
});

test(".font-cdn-baseline exempts a whole file with a # reason", () => {
  const r = runAgainst({
    ".font-cdn-baseline": "content/legacy-import.css  # archival WordPress export, imported by nothing\n",
    "content/legacy-import.css": `@import url("https://fonts.googleapis.com/css?family=Inter");`,
  });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /1 baselined file/);
});

test("the web-core mount path is excluded", () => {
  const r = runAgainst({
    "src/web-core/legacy.css": `@import url("https://fonts.googleapis.com/css?family=Inter");`,
  });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /OK/);
});
