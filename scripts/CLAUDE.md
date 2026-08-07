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

- `check-lead-store-ordering.mjs` — enforces that a form route's **primary
  contact write comes first**, above every early return and every unguarded
  third-party await in the same handler. Whichever system a route writes first
  is the only one guaranteed to run; everything below it is conditional on
  nothing above it returning or throwing. Two live incidents six days apart came
  from exactly this, and in both the primary write was present, awaited and
  wrapped in its own try/catch — only its POSITION was wrong, which is why
  review never caught it. Deliberate exceptions carry an inline
  `// primary-store-ordering-ok: <reason>` annotation; the reason is required.
  Repos override the call-name patterns via `.lead-store-ordering.json`. Plain
  Node, no dependencies. Consumers fetch it from raw.githubusercontent in CI
  (see `tools/lead-store-gate-rollout.py` in the workspace root) rather than
  embedding a copy, so tuning the rules fixes every repo at once.

- `check-id-list-filters.mjs` — flags an **unbounded id array being used as a
  PostgREST query filter**, i.e. the interpolated `.not('id', 'in', \`(${…})\`)`
  form. PostgREST has two caps and fixing one leads into the other: paginating a
  read to escape the 1000-row cap produces an id array, and that array then goes
  into the request URL, which breaks at ~1,000 ids (39KB → HTTP 400) and fails at
  the connection level past ~100KB. So the usual "fix" relocates the failure
  rather than removing it; the answer is to move the whole predicate into an RPC.
  Literal and page-scoped lists are deliberately not flagged. Note the gate
  cannot see `.in('id', ids)` where `ids` came from a pagination loop — that
  still needs a human. Plain Node, no dependencies.

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
