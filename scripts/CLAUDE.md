# scripts

Standalone maintenance scripts. Unlike the `.ts` modules at the repo root, these
are **not** imported by consuming apps — they are executed directly, normally by
a CI step that fetches the raw file.

- `check-vendored-libs.mjs` — audits third-party libraries **copied** into a repo
  (typically a `.min.js` under `public/`) rather than installed. Copied libraries
  are absent from `package-lock.json`, so lockfile-based tooling cannot see them,
  yet they run in every visitor's browser. Reads each library's version from the
  banner comment its distribution ships with and queries the public OSV.dev
  advisory API. Plain Node, no dependencies, no key, no auth.

## Rules

- **Keep them dependency-free and runnable with a bare `node <file>.mjs`.** They
  are fetched and run by CI in other repos, which install nothing from here.
- **Fail loudly on anything that cannot be checked.** A maintenance script that
  silently skips what it does not understand reports success while missing the
  very thing it exists to catch.
- **Scope by what is committed, not by filename.** A copied library is tracked in
  git (which is why lockfile tooling misses it); a build artifact is ignored and
  is already covered by dependency auditing. Filenames prove nothing — the first
  version of the vendored check keyed off names and missed a large bundle with an
  ordinary-looking one.
- Same public-repo rule as the rest of this repository: **mechanism only**, no
  organisation names, hostnames, internal repo names, or credentials.
