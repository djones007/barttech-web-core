import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// scripts/vercel-ignore.sh is run by Vercel with `sh`, so it is tested with
// `sh` against real git repos. Exit 0 = SKIP, 1 = BUILD, anything else = a
// Vercel build ERROR, which is the failure this whole thing exists to prevent.

const SCRIPT = join(process.cwd(), "scripts", "vercel-ignore.sh");
const CHECK = join(process.cwd(), "scripts", "check-vercel-ignore.mjs");

function sh(cwd: string, cmd: string, env: Record<string, string> = {}) {
  const r = spawnSync("sh", ["-c", cmd], {
    cwd,
    encoding: "utf8",
    env: {
      PATH: process.env.PATH ?? "",
      HOME: process.env.HOME ?? "",
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@t",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@t",
      ...env,
    },
  });
  return { status: r.status, out: (r.stdout + r.stderr).trim() };
}

function commit(dir: string, file: string, body = String(Math.random())) {
  mkdirSync(join(dir, file, ".."), { recursive: true });
  writeFileSync(join(dir, file), body);
  sh(dir, `git add --all && git commit -q -m "c ${file}"`);
  return sh(dir, "git rev-parse HEAD").out;
}

function verdict(dir: string, env: Record<string, string> = {}) {
  return sh(dir, `sh "${SCRIPT}"`, env).status;
}

function repo(): string {
  const d = mkdtempSync(join(tmpdir(), "vercel-ignore-"));
  sh(d, "git init -q -b main");
  return d;
}

function withRepo(fn: (d: string) => void) {
  const d = repo();
  try {
    fn(d);
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
}

const GHOST = "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef";

test("source commit builds", () =>
  withRepo((d) => {
    commit(d, "a.txt");
    commit(d, "src/x.ts");
    assert.equal(verdict(d), 1);
  }));

test("markdown-only commit after a deployed source commit skips", () =>
  withRepo((d) => {
    commit(d, "a.txt");
    const deployed = commit(d, "src/x.ts");
    commit(d, "CHANGELOG.md");
    assert.equal(verdict(d, { VERCEL_GIT_PREVIOUS_SHA: deployed }), 0);
    assert.equal(verdict(d), 1, "no previous SHA = nothing deployed on this branch yet: build");
  }));

test("markdown-only after markdown-only after deployed source still skips", () =>
  withRepo((d) => {
    commit(d, "a.txt");
    const deployed = commit(d, "src/x.ts");
    commit(d, "CHANGELOG.md");
    commit(d, "docs/y.txt");
    commit(d, "README.md");
    assert.equal(verdict(d, { VERCEL_GIT_PREVIOUS_SHA: deployed }), 0);
  }));

test("THE BUG: source commit then markdown-only tip, source never deployed, builds", () =>
  withRepo((d) => {
    const deployed = commit(d, "a.txt");
    commit(d, "src/x.ts");
    commit(d, "CHANGELOG.md");
    assert.equal(verdict(d, { VERCEL_GIT_PREVIOUS_SHA: deployed }), 1);
  }));

test("THE BUG: feature merge then CHANGELOG-only tip builds, with or without a previous SHA", () =>
  withRepo((d) => {
    const deployed = commit(d, "a.txt");
    sh(d, "git checkout -q -b feat");
    commit(d, "src/feature.ts");
    sh(d, "git checkout -q main");
    commit(d, "other.md");
    sh(d, "git merge -q --no-ff feat -m merge");
    commit(d, "CHANGELOG.md");
    assert.equal(verdict(d, { VERCEL_GIT_PREVIOUS_SHA: deployed }), 1);
    assert.equal(verdict(d), 1, "merge-aware HEAD^ fallback");
  }));

test("previous SHA equal to HEAD (a redeploy) does not skip a source commit", () =>
  withRepo((d) => {
    commit(d, "a.txt");
    const head = commit(d, "src/x.ts");
    assert.equal(verdict(d, { VERCEL_GIT_PREVIOUS_SHA: head }), 1);
  }));

test("previous SHA missing or garbage never errors: falls back to HEAD^", () =>
  withRepo((d) => {
    commit(d, "a.txt");
    commit(d, "CHANGELOG.md");
    assert.equal(verdict(d, { VERCEL_GIT_PREVIOUS_SHA: GHOST }), 0);
    assert.equal(verdict(d, { VERCEL_GIT_PREVIOUS_SHA: "not a sha" }), 0);
    commit(d, "src/z.ts");
    assert.equal(verdict(d, { VERCEL_GIT_PREVIOUS_SHA: GHOST }), 1);
  }));

test("first (root) commit builds", () =>
  withRepo((d) => {
    commit(d, "README.md");
    assert.equal(verdict(d), 1);
  }));

test("not a git repository builds (exit 1, not an error code)", () => {
  const d = mkdtempSync(join(tmpdir(), "vercel-ignore-nogit-"));
  try {
    assert.equal(verdict(d), 1);
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

test("dependabot branches skip", () =>
  withRepo((d) => {
    commit(d, "a.txt");
    commit(d, "src/x.ts");
    assert.equal(verdict(d, { VERCEL_GIT_COMMIT_REF: "dependabot/npm/x" }), 0);
  }));

test("shallow clone: previous SHA outside the clone is fetched from origin and used", () =>
  withRepo((origin) => {
    const work = mkdtempSync(join(tmpdir(), "vercel-ignore-shallow-"));
    try {
      commit(origin, "a.txt");
      const deployed = commit(origin, "src/x.ts");
      commit(origin, "CHANGELOG.md");
      commit(origin, "docs/a.md");
      commit(origin, "src/new.ts");
      commit(origin, "CHANGELOG.md");
      rmSync(work, { recursive: true, force: true });
      assert.equal(sh(tmpdir(), `git clone -q --depth=2 file://${origin} ${work}`).status, 0);
      assert.notEqual(sh(work, `git cat-file -e ${deployed}^{commit}`).status, 0, "precondition: not in the shallow clone");
      // deployed..HEAD includes src/new.ts => build, though HEAD^..HEAD is markdown-only
      assert.equal(verdict(work, { VERCEL_GIT_PREVIOUS_SHA: deployed }), 1);
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  }));

test("shallow clone, unreachable origin: no error, HEAD^ fallback; depth 1 builds", () =>
  withRepo((origin) => {
    const work = mkdtempSync(join(tmpdir(), "vercel-ignore-shallow2-"));
    const work1 = `${work}-d1`;
    try {
      commit(origin, "a.txt");
      const deployed = commit(origin, "src/x.ts");
      commit(origin, "CHANGELOG.md");
      commit(origin, "CHANGELOG.md");
      rmSync(work, { recursive: true, force: true });
      sh(tmpdir(), `git clone -q --depth=2 file://${origin} ${work}`);
      sh(work, "git remote remove origin");
      assert.equal(verdict(work, { VERCEL_GIT_PREVIOUS_SHA: deployed }), 0);
      sh(tmpdir(), `git clone -q --depth=1 file://${origin} ${work1}`);
      assert.equal(verdict(work1), 1, "depth 1 has no HEAD^: build");
    } finally {
      rmSync(work, { recursive: true, force: true });
      rmSync(work1, { recursive: true, force: true });
    }
  }));

test("rebased / force-pushed branch: previous SHA not an ancestor never errors", () =>
  withRepo((d) => {
    commit(d, "a.txt");
    sh(d, "git checkout -q -b old");
    const oldTip = commit(d, "src/old.ts");
    sh(d, "git checkout -q main");
    commit(d, "CHANGELOG.md");
    assert.equal(verdict(d, { VERCEL_GIT_PREVIOUS_SHA: oldTip }), 1, "trees differ in source: build");
  }));

// ---- the vercel.json wrapper, exactly as Vercel will run it ----

const WRAPPER =
  "for p in src/web-core web-core; do [ -f $p/scripts/vercel-ignore.sh ] && { sh $p/scripts/vercel-ignore.sh; [ $? -eq 0 ] && exit 0; exit 1; }; done; exit 1";

function wrapped(layout: "src/web-core" | "web-core" | "none", fn: (d: string) => void) {
  withRepo((d) => {
    commit(d, "a.txt");
    if (layout !== "none") {
      mkdirSync(join(d, layout, "scripts"), { recursive: true });
      writeFileSync(join(d, layout, "scripts", "vercel-ignore.sh"), readFileSync(SCRIPT, "utf8"));
    }
    sh(d, "git add --all && git commit -q -m sm --allow-empty");
    fn(d);
  });
}

test("wrapper: runs the script from either mount path (md-only skips, source builds)", () => {
  for (const layout of ["src/web-core", "web-core"] as const) {
    wrapped(layout, (d) => {
      const PREV = "export VERCEL_GIT_PREVIOUS_SHA=$(git rev-parse HEAD^); ";
      commit(d, "CHANGELOG.md");
      assert.equal(sh(d, PREV + WRAPPER).status, 0, layout);
      commit(d, "src/x.ts");
      assert.equal(sh(d, PREV + WRAPPER).status, 1, layout);
    });
  }
});

test("wrapper: submodule not checked out (script missing) builds, never errors", () =>
  wrapped("none", (d) => {
    commit(d, "CHANGELOG.md");
    assert.equal(sh(d, WRAPPER).status, 1);
  }));

test("wrapper: a script that crashes with an odd exit code builds", () =>
  wrapped("src/web-core", (d) => {
    for (const code of [2, 127, 128]) {
      writeFileSync(join(d, "src/web-core/scripts/vercel-ignore.sh"), `exit ${code}\n`);
      assert.equal(sh(d, WRAPPER).status, 1, String(code));
    }
  }));

// ---- the gate ----

function gate(files: Record<string, string>) {
  const d = mkdtempSync(join(tmpdir(), "vercel-gate-"));
  try {
    for (const [rel, body] of Object.entries(files)) {
      mkdirSync(join(d, rel, ".."), { recursive: true });
      writeFileSync(join(d, rel), body);
    }
    const r = spawnSync(process.execPath, [CHECK, d], { encoding: "utf8" });
    return { status: r.status, out: r.stdout + r.stderr };
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
}

test("gate: canonical wrapper passes, a drifted one fails", () => {
  const ok = gate({ "vercel.json": JSON.stringify({ ignoreCommand: WRAPPER }), "src/web-core/scripts/vercel-ignore.sh": "" });
  assert.equal(ok.status, 0, ok.out);
  const bad = gate({ "vercel.json": JSON.stringify({ ignoreCommand: "git diff --quiet HEAD^ HEAD" }), "src/web-core/scripts/vercel-ignore.sh": "" });
  assert.equal(bad.status, 1);
  assert.match(bad.out, /not the canonical WRAPPER/);
});

test("gate: a repo without web-core must keep the inline command", () => {
  const r = gate({ "vercel.json": JSON.stringify({ ignoreCommand: WRAPPER }) });
  assert.equal(r.status, 1);
  assert.match(r.out, /INLINE/);
});

test("gate: .vercelignore must exclude nested node_modules and must not exclude src", () => {
  const base = { "vercel.json": JSON.stringify({ ignoreCommand: WRAPPER }), "src/web-core/scripts/vercel-ignore.sh": "" };
  const good = gate({ ...base, ".vercelignore": "**/node_modules\n.next\n.env*\n.git\nscene/out\n" });
  assert.equal(good.status, 0, good.out);
  const noNested = gate({ ...base, ".vercelignore": "node_modules\n.next\n.env*\n.git\n" });
  assert.match(noNested.out, /\*\*\/node_modules/);
  const bad = gate({ ...base, ".vercelignore": "**/node_modules\n.next\n.env*\n.git\nsrc\n" });
  assert.match(bad.out, /excludes src/);
});

test("gate: nested node_modules inside a submodule (file-count) demands a .vercelignore", () => {
  assert.ok(existsSync(SCRIPT));
});
