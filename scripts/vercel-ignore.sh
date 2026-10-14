#!/bin/sh
# Vercel "Ignored Build Step" for every site. The ONE copy of this logic.
# vercel.json calls it as:   sh <web-core mount>/scripts/vercel-ignore.sh
#
# EXIT-CODE CONVENTION (Vercel's, easy to invert):
#   exit 0  = SKIP the build  (nothing that can change the site was touched)
#   exit 1  = BUILD
#   any other exit code (2, 127, 128 ...) = Vercel reports a build ERROR and
#   deploys nothing. This script therefore NEVER exits anything but 0 or 1:
#   every internal failure (git error, bad object, shallow clone, missing
#   variable) is folded into 1, so it fails TOWARD building, never into an error.
#
# WHAT IT SKIPS: a push whose changes are only markdown, CLAUDE.md, .github,
# docs, tests, .env.example or .gitignore. Deliberate: build CPU is ~72% of the
# Vercel bill. Do NOT make *.md trigger builds.
#
# THE BUG THIS FIXES (Fix Engine 39be6bdb): the old inline command diffed only
# HEAD^..HEAD. A feature merge followed by a CHANGELOG-only tip commit looked
# markdown-only, so the push was cancelled and the feature never deployed.
# Now the diff is against the last commit Vercel actually deployed on this
# branch (VERCEL_GIT_PREVIOUS_SHA), so everything since then counts.
#
# WHY THE EARLIER VERCEL_GIT_PREVIOUS_SHA ATTEMPT BROKE (one site,
# 2026-10-13, reverted): Vercel's clone is shallow and does not contain that
# commit, so `git diff <missing sha> HEAD` died with "bad object" (exit 128) and
# the unguarded command passed 128 straight through = build ERROR. Here the SHA
# is used only if `git cat-file` proves it exists (after one best-effort shallow
# fetch of that single commit), else we fall back to HEAD^ (the old behaviour),
# and any non-0 result of the final diff is a BUILD.
#
# No previous SHA at all (new branch, first deploy): BUILD, there is nothing deployed to compare with.
#
# Redeploys: if the previous SHA equals HEAD (a redeploy of the deployed commit)
# it is ignored, otherwise the diff would be empty and a redeploy would skip.
#
# Tested by vercelIgnore.test.ts in web-core (scenario matrix, run with `sh`).
# Checked against every repo's vercel.json by scripts/check-vercel-ignore.mjs.

verdict() {
  case "${VERCEL_GIT_COMMIT_REF:-}" in dependabot/*) return 0 ;; esac

  head=$(git rev-parse -q --verify HEAD 2>/dev/null) || return 1
  echo "vercel-ignore: head=$head prev=${VERCEL_GIT_PREVIOUS_SHA:-unset} ref=${VERCEL_GIT_COMMIT_REF:-unset} shallow=$(git rev-parse --is-shallow-repository 2>/dev/null)"

  base=""
  p="${VERCEL_GIT_PREVIOUS_SHA:-}"
  # No previous deployment on this branch (a new branch, or the first deploy): nothing has
  # shipped yet, so there is nothing to compare against. BUILD. Falling back to HEAD^ here
  # skipped a feature + markdown-tip push on a fresh branch (proved on a Vercel preview).
  if [ -z "$p" ]; then return 1; fi
  if [ -n "$p" ] && [ "$p" != "$head" ]; then
    if ! git cat-file -e "$p^{commit}" 2>/dev/null; then
      # Not in the shallow clone: try to fetch just that commit. Bounded, and
      # allowed to fail (no network / no credentials / unknown SHA).
      if command -v timeout >/dev/null 2>&1; then
        timeout 20 git fetch --quiet --no-tags --depth=1 origin "$p" >/dev/null 2>&1
      else
        git fetch --quiet --no-tags --depth=1 origin "$p" >/dev/null 2>&1
      fi
    fi
    if git cat-file -e "$p^{commit}" 2>/dev/null; then base="$p"; fi
  fi

  if [ -z "$base" ]; then
    # No usable previous deployment: old behaviour, plus one merge-aware step.
    base=$(git rev-parse -q --verify HEAD^ 2>/dev/null) || return 1 # root commit: build
    if git rev-parse -q --verify "HEAD^^2" >/dev/null 2>&1; then
      base=$(git rev-parse -q --verify "HEAD^^1" 2>/dev/null) || return 1
    fi
  fi

  echo "vercel-ignore: base=$base"
  git diff --quiet "$base" "$head" -- \
    ':(exclude,glob)*.md' ':(exclude,glob)**/CLAUDE.md' \
    ':!.github' ':!docs' ':!tests' ':!.env.example' ':!.gitignore' \
    >/dev/null 2>&1
  # 0 = identical (skip). 1 = changed, 128 = git error: both build.
  return $?
}

verdict
if [ "$?" -eq 0 ]; then exit 0; fi
exit 1
