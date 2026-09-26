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

// ---------------------------------------------------------------------------
// Second invariant (2026-09-26): a screen that TRIGGERS an email must show a
// notice at all, regardless of whether it also writes hand-written copy the
// first invariant would catch. A live consumer's sign-in, sign-up and reset
// screens shipped with no notice whatsoever — the phrase-based gate above
// cannot flag copy that was never written.
// ---------------------------------------------------------------------------

test("signInWithOtp with no notice and no recovery copy is a trigger finding", () => {
  const r = runAgainst({
    "components/LoginForm.tsx": `
      "use client";
      export default function LoginForm() {
        const auth = () => supabaseBrowser().auth;
        const send = async () => {
          await auth().signInWithOtp({ email: "a@b.com" });
        };
        return <div>Link sent.</div>;
      }
    `,
  });
  assert.equal(r.status, 1);
  assert.match(r.stdout, /components\/LoginForm\.tsx\s+\[trigger\]/);
});

test("signInWithOtp is clean once the file renders PostSubmitNotice", () => {
  const r = runAgainst({
    "components/LoginForm.tsx": `
      "use client";
      import PostSubmitNotice from "./PostSubmitNotice";
      export default function LoginForm() {
        const auth = () => supabaseBrowser().auth;
        const send = async () => {
          await auth().signInWithOtp({ email: "a@b.com" });
        };
        return <PostSubmitNotice provider="gmail" sender="a@b.com" mode="link" />;
      }
    `,
  });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /OK/);
});

test("'check your email' success copy with no notice is a finding even with no visible trigger call", () => {
  const r = runAgainst({
    "components/OptinThanks.tsx": `
      export default function OptinThanks() {
        return <p>Check your email for the download link.</p>;
      }
    `,
  });
  assert.equal(r.status, 1);
  assert.match(r.stdout, /components\/OptinThanks\.tsx\s+\[success-copy\]/);
});

test("signUp and resetPasswordForEmail are also triggers", () => {
  const rSignUp = runAgainst({
    "components/SignUp.tsx": `
      export default function SignUp() {
        const go = async () => { await auth().signUp({ email: "a@b.com", password: "x" }); };
        return <div>Almost there.</div>;
      }
    `,
  });
  assert.equal(rSignUp.status, 1);

  const rReset = runAgainst({
    "components/Reset.tsx": `
      export default function Reset() {
        const go = async () => { await auth().resetPasswordForEmail("a@b.com"); };
        return <div>Almost there.</div>;
      }
    `,
  });
  assert.equal(rReset.status, 1);
});

test("bartmailOptin with no notice is a trigger finding", () => {
  const r = runAgainst({
    "components/LeadForm.tsx": `
      export default function LeadForm() {
        const go = async () => { await bartmailOptin({ email: "a@b.com" }); };
        return <div>Almost there.</div>;
      }
    `,
  });
  assert.equal(r.status, 1);
  assert.match(r.stdout, /components\/LeadForm\.tsx\s+\[trigger\]/);
});

test("updateUser({ data }) with no email change is not a trigger", () => {
  const r = runAgainst({
    "components/Profile.tsx": `
      export default function Profile() {
        const save = async () => { await auth().updateUser({ data: { name: "x" } }); };
        return <div>Saved.</div>;
      }
    `,
  });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /OK/);
});

test("updateUser({ email }) with no notice is a trigger finding", () => {
  const r = runAgainst({
    "components/Profile.tsx": `
      export default function Profile() {
        const save = async () => { await auth().updateUser({ email: "new@b.com" }); };
        return <div>Saved.</div>;
      }
    `,
  });
  assert.equal(r.status, 1);
  assert.match(r.stdout, /components\/Profile\.tsx\s+\[trigger\]/);
});

test("a trigger-baselined path with a reason is suppressed", () => {
  const r = runAgainst({
    "components/LoginForm.tsx": `
      export default function LoginForm() {
        const go = async () => { await auth().signInWithOtp({ email: "a@b.com" }); };
        return <div>Link sent.</div>;
      }
    `,
    ".post-submit-trigger-baseline": "components/LoginForm.tsx # background reconciliation, never shown to a user\n",
  });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /1 trigger-baselined exception/);
});

test("a trigger-baseline entry with no reason is not honoured", () => {
  const r = runAgainst({
    "components/LoginForm.tsx": `
      export default function LoginForm() {
        const go = async () => { await auth().signInWithOtp({ email: "a@b.com" }); };
        return <div>Link sent.</div>;
      }
    `,
    ".post-submit-trigger-baseline": "components/LoginForm.tsx\n",
  });
  assert.equal(r.status, 1);
});

test("a plain success page with no trigger and no email copy stays clean", () => {
  const r = runAgainst({
    "components/OrderConfirmed.tsx": `
      export default function OrderConfirmed() {
        return <div>Your order is confirmed.</div>;
      }
    `,
  });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /OK/);
});
