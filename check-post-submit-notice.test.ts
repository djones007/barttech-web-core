import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// scripts/check-post-submit-notice.mjs is a standalone Node CLI, run directly
// by consumer CI (see scripts/CLAUDE.md) rather than imported as a module —
// so it is exercised here the same way CI exercises it: as a child process
// against real fixture files on disk, asserting on exit code and stdout.
// ---------------------------------------------------------------------------

const SCRIPT = join(process.cwd(), "scripts", "check-post-submit-notice.mjs");

function runAgainst(files: Record<string, string>): { status: number | null; stdout: string } {
  const dir = mkdtempSync(join(tmpdir(), "post-submit-notice-"));
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

test("hand-written spam-folder copy with no import is a finding", () => {
  const r = runAgainst({
    "components/Confirm.tsx": `
      export function Confirm() {
        return <p>Check your spam folder if you don't see it.</p>;
      }
    `,
  });
  assert.equal(r.status, 1);
  assert.match(r.stdout, /components\/Confirm\.tsx:\d+/);
});

test("same copy is clean once the file imports PostSubmitNotice", () => {
  const r = runAgainst({
    "components/Confirm.tsx": `
      import { PostSubmitNotice } from "./PostSubmitNotice";
      export function Confirm() {
        return <PostSubmitNotice provider="gmail" sender="a@b.com" mode="confirm" />;
      }
    `,
  });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /OK/);
});

test("importing the shared module directly is also clean", () => {
  const r = runAgainst({
    "components/Confirm.tsx": `
      import { mailProviderNotice } from "@/web-core/mailProviderNotice";
      export function Confirm() {
        const n = mailProviderNotice({ provider: "gmail", sender: "a@b.com", mode: "confirm" });
        return <p>{n.body} Check your spam folder if you don't see it.</p>;
      }
    `,
  });
  assert.equal(r.status, 0);
});

test("a generic no-spam promise is not a folder instruction and does not match", () => {
  const r = runAgainst({
    "components/Footer.tsx": `
      export function Footer() {
        return <p>No spam. Unsubscribe any time.</p>;
      }
    `,
  });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /OK/);
});

test("an annotated line is suppressed", () => {
  const r = runAgainst({
    "components/Confirm.tsx": `
      export function Confirm() {
        return (
          <p>
            {/* post-submit-notice-ok: legal disclosure text, not a recovery instruction */}
            Check your spam folder for details.
          </p>
        );
      }
    `,
  });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /1 annotated exception/);
});

test("a bare annotation with no reason does not suppress the finding", () => {
  const r = runAgainst({
    "components/Confirm.tsx": `
      export function Confirm() {
        return (
          <p>
            {/* post-submit-notice-ok: */}
            Check your spam folder for details.
          </p>
        );
      }
    `,
  });
  assert.equal(r.status, 1);
});

test("a stale .claude worktree checkout is not reported", () => {
  const r = runAgainst({
    "app/quiz-thank-you/page.tsx": `
      export default function Page() {
        return <p>Welcome — check your spam folder if you don't see the confirmation.</p>;
      }
    `,
    ".claude/worktrees/x/app/page.tsx": `
      export default function Page() {
        return <p>Check your spam folder for the confirmation email.</p>;
      }
    `,
  });
  // The real file is still a genuine finding — only the dot-directory copy
  // must be excluded.
  assert.equal(r.status, 1);
  assert.match(r.stdout, /app\/quiz-thank-you\/page\.tsx:\d+/);
  assert.doesNotMatch(r.stdout, /\.claude/);
});

test("the web-core mount path is excluded even with unimported copy inside it", () => {
  const r = runAgainst({
    "src/web-core/mailProviderNotice.tsx": `
      export function Fallback() {
        return <p>Check your spam folder if you don't see it.</p>;
      }
    `,
  });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /OK/);
});

test("test files are excluded", () => {
  const r = runAgainst({
    "components/Confirm.test.tsx": `
      test("renders", () => {
        expect(render()).toContain("Check your spam folder");
      });
    `,
  });
  assert.equal(r.status, 0);
});

// ---------------------------------------------------------------------------
// Calibration miss found by running the gate against a real consumer: "where
// the email goes" phrasing ("land in Junk") named no folder/tab/contacts
// action, so it passed clean even though it is the same hand-written drift
// this gate exists to catch. These four are the exact strings that surfaced
// the miss and were used to widen PHRASE.
// ---------------------------------------------------------------------------

test("'land in Junk' phrasing is a finding", () => {
  const r = runAgainst({
    "components/Confirm.tsx": `
      export function Confirm() {
        return <p>Sometimes they land in Junk, so keep an eye out.</p>;
      }
    `,
  });
  assert.equal(r.status, 1);
  assert.match(r.stdout, /components\/Confirm\.tsx:\d+/);
});

test("'check your junk/spam folder' phrasing is a finding", () => {
  const r = runAgainst({
    "components/Confirm.tsx": `
      export function Confirm() {
        return <p>Don't forget to check your junk/spam folder for our confirmation email.</p>;
      }
    `,
  });
  assert.equal(r.status, 1);
});

test("'check your spam folder' after a time window is a finding", () => {
  const r = runAgainst({
    "components/Confirm.tsx": `
      export function Confirm() {
        return <p>If you don't see it in the next couple of minutes, check your spam folder.</p>;
      }
    `,
  });
  assert.equal(r.status, 1);
});

test("'Check your spam folder, or try again' is a finding", () => {
  const r = runAgainst({
    "components/Confirm.tsx": `
      export function Confirm() {
        return <p>Didn't receive it? Check your spam folder, or try again.</p>;
      }
    `,
  });
  assert.equal(r.status, 1);
});

test("'we don't spam' is a promise, not a folder instruction, and stays clean", () => {
  const r = runAgainst({
    "components/Footer.tsx": `
      export function Footer() {
        return <p>we don't spam, and you can unsubscribe any time.</p>;
      }
    `,
  });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /OK/);
});

test("'No spam, ever' is a promise, not a folder instruction, and stays clean", () => {
  const r = runAgainst({
    "components/Footer.tsx": `
      export function Footer() {
        return <p>No spam, ever.</p>;
      }
    `,
  });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /OK/);
});

test("a clean repo with no matching files reports zero findings", () => {
  const r = runAgainst({
    "components/Hero.tsx": `
      export function Hero() {
        return <h1>Welcome</h1>;
      }
    `,
  });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /0 annotated exception/);
});
