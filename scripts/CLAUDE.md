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

- `check-unsanitised-html.mjs` — requires every `dangerouslySetInnerHTML` to have
  a **visible** reason to be safe. Passes a call site whose `__html` expression is
  `renderSafeHtml(...)`, `jsonLd(...)`, a SCREAMING_CASE constant, or a local
  variable assigned from one of those in the same file. Anything else — notably
  the common case of sanitising upstream at the data layer — needs an inline
  `// safe-html-ok: <where it is sanitised>` annotation. Written after two live
  sites were found rendering agent-written markdown with no sanitiser at all, and
  two more each kept a private copy of the same sanitiser; none of it was visible
  from the call site, which is the whole problem. Three things it does that a
  naive version got wrong, each after a false result in testing:
  **(1)** comments are blanked before matching, because the two repos that
  handled this correctly did so with a comment *explaining* they avoid the API —
  flagging them is how a gate loses its audience; **(2)** an annotation naming a
  file is **verified**, not trusted, so deleting the sanitiser upstream while
  leaving the annotation behind fails instead of reading as checked; **(3)** that
  verification blanks comments too, because the first version was fooled by the
  named file's own comment mentioning `renderSafeHtml` while the call had gone —
  the same "grep matched the word, not the behaviour" mistake the gate exists to
  stop. `public/` is skipped (minified vendor bundles).

- `check-heartbeat-status.mjs` — a monitor must not report **success while it is
  counting failures**. Flags a bare success literal passed to a run-status writer
  when the same file tallies `errors`/`failed`/`skipped` **earlier in the file**.
  That combination means the recorded outcome cannot disagree with the code, so a
  run in which every unit of work failed is byte-identical, on every dashboard, to
  a perfect one — a failure mode that points towards silence and therefore
  survives for months, because the surfaces built to reveal it are the ones
  showing green. **Position is the whole trick:** routes legitimately record "ok"
  on an early return ("feature disabled", "nothing due") *before* attempting work,
  and a healthy skip must still be recorded or a run of correct answers looks like
  a dead job — so only writes occurring after counting begins are considered.
  Ignoring that ordering put three waivers into one file whose author had done
  nothing wrong, which is exactly how a gate loses its audience. Derived statuses
  (`errors.length ? "error" : "ok"`, a variable, a call) are never flagged — that
  is the desired form. Waivers use `// heartbeat-status-ok: <reason>`, and a bare
  annotation with no reason is **itself** a failure, because "someone looked at
  this" and "someone decided this" must not be indistinguishable. Repos may tune
  call/counter names via `.heartbeat-status.json`.

- `check-sentry-instrumentation.mjs` — a repo that installs `@sentry/nextjs` must
  actually be **wired to report server-side errors**. `Sentry.init()` arms the
  SDK; it does not subscribe to the framework's server error channel. That is a
  separate module-level `export const onRequestError = Sentry.captureRequestError`
  from the instrumentation file, and without it every page render, route handler
  and server action failure is dropped while client errors keep arriving — so the
  dashboard stays green and looks correct. An audit found that **no** repo here
  had ever exported it, proven by a 3.5-day outage in which every article on a
  site returned 500 and not one alert fired. The SDK does warn about it on every
  build; nobody read the warning, which is the argument for a gate. Also flags
  **orphaned** legacy `sentry.{server,edge,client}.config.*` files, which the
  current SDK does not load — the server/edge names are absent from the v10 build
  plugin entirely, and the client one is injected only on the webpack path, so
  under the default bundler it is inert. Orphaned is the operative word: a
  server/edge config the instrumentation file imports inside `register()` is a
  supported layout and is deliberately left alone (getting that wrong was the
  gate's one false positive in testing). Waivers use
  `// sentry-instrumentation-ok: <reason>` in the instrumentation file, or a path
  plus a `#` reason in `.sentry-instrumentation-ok`; a waiver with no reason is
  itself a failure.

- `check-storage-path-traversal.mjs` — a file calling Supabase Storage with a
  write/read-by-key operation (`.upload(` `.remove(` `.createSignedUrl(`
  `.createSignedUrls(` `.download(` `.move(` `.copy(`, chained off
  `.storage.from(...)`) must import `safeUploadFilename` (or its alias
  `sanitizeStorageSegment`) from `@/web-core/uploads` or `@/lib/uploads`. Added
  after Aikido flagged grouped issue 37987812 (High, "path traversal in
  Supabase Storage") on 2026-08-24 — 7 subissues across two live repos, every
  one a user- or DB-controlled string reaching a storage key with either no
  guard at all or a hand-rolled duplicate of the guard this repo already
  exports. File-level heuristic, same tradeoff as the other gates here: it
  cannot see whether the sanitiser is applied to the SPECIFIC key built in the
  file, only that the file imports it at all — a data-flow check is out of
  scope for a dependency-free script, and "imported but unused for the actual
  key" is a far smaller, more reviewable gap than "never imported." A file
  whose storage key is built entirely from compile-time constants (no
  interpolation) is a legitimate, rare false positive — add it to
  `.storage-path-baseline` (mirrors `.web-core-baseline`) with a `#` reason.

- `check-scaffold-metadata.mjs` — **scaffold placeholders must not reach
  production**. New apps are cloned from a shared template that ships deliberate
  stand-ins (a placeholder page title, a `TODO:` meta description,
  `REPLACE_WITH_<THING>` tokens) on the assumption someone replaces them.
  Repeatedly nobody did, and nothing complained — build green, page renders,
  tests pass, and the only symptom is a customer reading the wrong words. It
  happened three times before this gate: a checkout app served the placeholder
  title to a paying customer in their browser tab on the post-payment page
  (found months later by an e2e health check, not review); an internal tool
  served the placeholder title *and* the literal `TODO: replace with...` string
  as its live, indexable meta description; and one repo's README still listed
  both as outstanding after they were fixed. Checks two things: the root
  layout's `title`/`description` carry no `TODO` and no generic
  "<framework> Template" stand-in, and no `REPLACE_WITH_*` token survives in
  live code. **Comments are blanked before matching** — the repos that FIXED
  this bug documented it with a comment quoting the old placeholder, so raw
  matching flags the fix itself, the same lesson `check-unsanitised-html.mjs`
  learned. Placeholder body copy on legal pages is deliberately **not** checked:
  same family, but it needs real content rather than a rename, and a gate that
  arrives red on unscheduled work gets removed rather than obeyed. Waivers are
  `// scaffold-metadata-ok: <reason>`; a bare annotation is itself a failure.
  The template repo is excluded at rollout — it is the source of the
  placeholders, not a consumer of them.

- `check-postgrest-filter-terms.mjs` — flags a **user-typed term interpolated
  into a PostgREST filter**. `.or()` and `.ilike()` look symmetrical and are not:
  supabase-js appends an `.ilike()` pattern via `URLSearchParams.append`, so the
  value is percent-encoded and opaque, whereas `.or()` appends one string that
  PostgREST then **parses** as a filter expression. Confirmed live before the gate
  was written: `or=(title.ilike.%a,b%)` returns 400 PGRST100, and
  `or=(title.ilike.%a%),or(id.gt.0)` **parses** — the trailing text becomes a
  second disjunct, so a comma in a search box appends conditions to somebody
  else's OR. Five hand-rolled escapers existed at the time; one stripped `%` and
  `,`, one escaped `%`, `_` and `\` but not `,`, one stripped `,()*`, and two did
  nothing — the signature of a rule that needs an implementation rather than more
  prose. Reports two kinds: `[or-filter]` (the injection; fix with
  `orIlikeContains` / `orIlikeAnyOf`) and `[like-pattern]` (not injectable, but
  `%` and `_` are still LIKE wildcards, so "50% Ltd" matches half the table; fix
  with `escapeLikeTerm`). The condition form is matched **wherever it appears**
  rather than near a `.or(` — conditions are routinely built in an array and
  joined several lines later, which is where a proximity-based first draft missed
  five of them. Filters on internal values (`.eq.${brandId}`, `.gte.${todayIso}`)
  are deliberately not matched: they were correct, and a gate that fires on
  correct code is one people learn to skim past. Waivers are
  `// postgrest-filter-ok: <reason>` on the line or the line above, for a value
  that provably cannot carry a metacharacter (one matched out by a narrow regex);
  a bare annotation with no reason is **itself** a failure. Prefer escaping to
  waiving wherever escaping is a no-op — escaping hex costs nothing and survives
  someone widening the regex later. Plain Node, no dependencies.

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

- `check-fk-covering-indexes.mjs` — requires every foreign key in
  `supabase/migrations` to have an index whose **first** column is the
  referencing column. Postgres indexes a PRIMARY KEY and a UNIQUE constraint and
  indexes nothing for a FOREIGN KEY, so without one, every parent delete and
  every join on that column scans the whole child table — correctly, silently,
  with no error to notice. Found after a 1.7M-row table logged 1,133 sequential
  scans totalling 1.25 billion rows read; one index took the lookup from 1,269ms
  to 0.162ms, and a sweep found 130 unindexed foreign keys across four
  databases. Replays migrations in filename order and follows `RENAME TO`,
  splits multi-clause `ALTER TABLE` on top-level commas (so `ADD COLUMN a, ADD
  COLUMN b REFERENCES x` credits the FK to `b`, not `a`), and accepts a partial
  index only when its predicate is `<col> IS NOT NULL` — that one implies the
  FK check's `col = $1` and Postgres proves it, which was verified against live
  databases rather than assumed. Exceptions need `-- fk-index-ok: <reason>`;
  a bare annotation fails. **It only sees tables whose schema is in the repo** —
  pair it with a live-database check for tables that predate the migrations
  folder. Plain Node, no dependencies.
