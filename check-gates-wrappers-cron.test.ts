import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";

// Estate issue b4bd94c4 (M1/M7/M8 remainder): the lead-store gate must follow helper-wrapped primary
// writes, and the webhook gate must not let a signed receiver hide under a /cron/ path. Each gate
// has a violating fixture that FAILS and a clean one that passes.

const S = (n: string) => join(process.cwd(), "scripts", n);

function repo(files: Record<string, string>, git = false): string {
  const dir = mkdtempSync(join(tmpdir(), "gate-wrap-"));
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
function run(script: string, dir: string) {
  const r = spawnSync(process.execPath, [S(script), dir], { encoding: "utf8" });
  return { status: r.status, out: r.stdout + r.stderr };
}
const NEXT = JSON.stringify({ dependencies: { next: "15.0.0" } });
const LEAD = "check-lead-store-ordering.mjs";
const HOOK = "check-webhook-verification.mjs";

const HELPER = `import { bartmailOptin } from "@/web-core/bartmail";
export async function captureLead(email: string) {
  return await bartmailOptin({ email });
}
`;

test("lead-store: a helper-wrapped primary write sitting below a success return FAILS", () => {
  const d = repo({
    "src/lib/lead.ts": HELPER,
    "src/app/api/optin/route.ts": `import { captureLead } from "@/lib/lead";
export async function POST(req: Request) {
  const body = await req.json();
  if (body.skip) return Response.json({ ok: true });
  await captureLead(body.email);
  return Response.json({ ok: true });
}
`,
  }, true);
  try {
    const r = run(LEAD, d);
    assert.equal(r.status, 1, r.out);
    assert.match(r.out, /optin\/route\.ts/);
    assert.match(r.out, /success-return/);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test("lead-store: a helper-wrapped primary write that is first, awaited and unguarded-free PASSES", () => {
  const d = repo({
    "src/lib/lead.ts": HELPER,
    "src/app/api/optin/route.ts": `import { captureLead } from "@/lib/lead";
export async function POST(req: Request) {
  const body = await req.json();
  if (!body.email) return Response.json({ error: "bad" }, { status: 400 });
  await captureLead(body.email);
  return Response.json({ ok: true });
}
`,
  }, true);
  try {
    const r = run(LEAD, d);
    assert.equal(r.status, 0, r.out);
    assert.match(r.out, /gate OK/);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test("lead-store: a wrapper called but not awaited FAILS", () => {
  const d = repo({
    "src/lib/lead.ts": HELPER,
    "src/app/api/subscribe/route.ts": `import { captureLead } from "@/lib/lead";
export async function POST(req: Request) {
  const body = await req.json();
  captureLead(body.email);
  return Response.json({ ok: true });
}
`,
  }, true);
  try {
    const r = run(LEAD, d);
    assert.equal(r.status, 1, r.out);
    assert.match(r.out, /not awaited/);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test("lead-store: a same-file helper does not hide the handler's own ordering problem", () => {
  const d = repo({
    "src/app/api/optin/route.ts": `import { bartmailOptin } from "@/web-core/bartmail";
async function store(email: string) { return await bartmailOptin({ email }); }
export async function POST(req: Request) {
  const body = await req.json();
  await sendNotification(body.email);
  await store(body.email);
  return Response.json({ ok: true });
}
`,
  }, true);
  try {
    const r = run(LEAD, d);
    assert.equal(r.status, 1, r.out);
    assert.match(r.out, /unguarded secondary call/);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test("lead-store: an unreadable tracked file FAILS loudly instead of being skipped", () => {
  const d = repo({
    "src/app/api/optin/route.ts": `import { bartmailOptin } from "@/web-core/bartmail";
export async function POST(req: Request) { await bartmailOptin({ email: "a@b.c" }); return Response.json({ ok: true }); }
`,
    "src/lib/gone.ts": "export const x = 1;\n",
  }, true);
  try {
    rmSync(join(d, "src/lib/gone.ts"));
    const r = run(LEAD, d);
    assert.equal(r.status, 1, r.out);
    assert.match(r.out, /could not read/);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test("webhook: an unverified receiver under /cron/ that reads a signature header FAILS", () => {
  const d = repo({
    "package.json": NEXT,
    "src/app/api/cron/inbound/route.ts": `export async function POST(req: Request) {
  const sig = req.headers.get("stripe-signature");
  const body = await req.text();
  await markPaid(body, sig);
  return Response.json({ ok: true });
}
`,
  });
  try {
    const r = run(HOOK, d);
    assert.equal(r.status, 1, r.out);
    assert.match(r.out, /cron\/inbound/);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test("webhook: an outbound retry cron that merely mentions webhook in its path still PASSES, as not applicable", () => {
  const d = repo({
    "package.json": NEXT,
    "src/app/api/cron/retry-webhooks/route.ts": `export async function GET() { await retryDeliveries(); return Response.json({ ok: true }); }
`,
  });
  try {
    const r = run(HOOK, d);
    assert.equal(r.status, 0, r.out);
    assert.match(r.out, /NOT APPLICABLE/);
    assert.doesNotMatch(r.out, /all 0/);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test("webhook: a verified receiver under /cron/ PASSES", () => {
  const d = repo({
    "package.json": NEXT,
    "src/app/api/cron/inbound/route.ts": `import Stripe from "stripe";
export async function POST(req: Request) {
  const sig = req.headers.get("stripe-signature");
  const body = await req.text();
  let ev;
  try { ev = stripe.webhooks.constructEvent(body, sig!, secret); }
  catch { return Response.json({ error: "bad sig" }, { status: 400 }); }
  return Response.json({ ok: true });
}
`,
  });
  try {
    const r = run(HOOK, d);
    assert.equal(r.status, 0, r.out);
    assert.match(r.out, /1 webhook receiver/);
  } finally { rmSync(d, { recursive: true, force: true }); }
});
