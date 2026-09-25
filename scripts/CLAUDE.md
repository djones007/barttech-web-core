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

- `check-consent-banner-size.mjs` — a repo that ships a **consent banner** must
  measure how much of a phone screen it covers. A banner's height is not a
  property anyone chooses: it is what the component does once its prose runs a
  paragraph long and its three buttons stack on a narrow screen. Measured across
  sibling sites built from one scaffold, banners ran **173px to 462px on a single
  390×844 viewport — 20% to 55% of the screen** — with no deliberate design change
  between them. Past roughly a quarter of the viewport the banner sits on top of
  the hero's call to action, so traffic from a paid click lands on what is
  functionally an interstitial. **The gate deliberately does not grep for the
  height**: coverage falls out of font size, prose length, button direction,
  padding and viewport together, and two components with identical class lists
  measure differently because one has a longer sentence — any regex broad enough
  to catch the bad ones fires on the good ones. So the measurement is a Playwright
  assertion against the real page (`measureConsentBanner` +
  `MAX_CONSENT_BANNER_COVERAGE_PCT` from `consentBannerSize.ts`), and this script
  enforces the one thing a runtime test cannot prove about itself — **that it was
  installed at all**: a banner in the repo requires a spec that *imports* the
  constant (a retyped number is the drift the shared module exists to remove),
  reachable from a package.json script, invoked by a workflow. Silent in a repo
  with no banner, since not every consumer is a public site. Exceptions go in
  `.consent-banner-baseline` with a `#` reason. Plain Node, no dependencies.

- `check-classifier-tests.mjs` — a function that maps untrusted request input
  (headers, cookies, a user agent) to a fixed set of outcomes must ship with a
  **committed, wired-in** test — not one run once from a throwaway script and
  discarded. A consumer site's `device(headers: Headers): "mobile" | "desktop"
  | null` read a single client hint that Safari and every iOS browser never
  send: 66 of its first 69 rows came back null, in a live paid campaign, for a
  day, before anyone looked. The fix was proven against nine real user-agent
  strings and shipped — but those nine cases were run from a script that was
  deleted afterwards, so the exact function this gate exists to catch remained
  itself unproven, one bug fixed and one left in place at the same time.
  Detects the shape structurally (a request-like parameter, a return type
  that's a union of 2-6 string literals) rather than by name, so it needs no
  per-repo config to find the next one. **Deliberately does not read what the
  classifier's rules ARE** — same reasoning as `check-consent-banner-size.mjs`:
  a static pattern cannot verify behaviour, and a rule that fires on correct
  code is a rule people switch off. What it proves instead is that a sibling
  `<name>.test.ts` exists, imports the function by name, carries at least four
  real cases, and is reachable from `package.json`'s test script or a
  `.github/workflows` file — a test nothing runs is a comment. `--self-test`
  proves the gate itself both ways (fires on the untested case, silent on the
  proven one, untouched by a same-shaped function returning a boolean).
  Exceptions go in `.classifier-baseline`, same ratchet as
  `.consent-banner-baseline`. Plain Node, no dependencies.

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

- `check-webhook-verification.mjs` — requires every webhook receiver to verify a
  signature AND to reject on failure. A webhook URL is public and does
  privileged writes, so the signature check is the only thing between a real
  provider event and anyone with curl; a verifier whose result is computed and
  never acted on reads as secure and is not. Also rejects **fail-open**
  verification (skipping the check when no secret is configured), which converts
  a config gap into an auth bypass — a missing secret must be a 503. Detects
  receivers by path (`webhook`/`hook`, excluding `cron/`) or by a known
  signature header, and skips thin re-export routes whose shared handler does
  the verifying. Exceptions need `// webhook-auth-ok: <reason>` for senders that
  genuinely cannot sign; a bare annotation fails. Two calibration lessons are in
  the source: `\s*` after the annotation colon matches a newline (a bare
  annotation silently captured the next line as its reason), and matching any
  warn containing "skip" flagged four healthy routes, so the message must name
  what is being skipped. Plain Node, no dependencies.

- `check-third-party-fonts.mjs` — flags a **runtime font load from a
  third-party CDN**: Google Fonts, Bunny Fonts, Adobe Fonts/Typekit, Font
  Awesome CDN (kit loader and cdnjs), jsDelivr/unpkg font packages. Loading a
  webfont from someone else's server sends every visitor's IP to that host on
  every page load — LG München I awarded €100 damages for exactly this
  (Google Fonts, Jan 2022) and it remains a live GDPR complaint pattern.
  Deliberately a **named denylist**, not an arbitrary-third-party-origin
  match: a regex for "any external URL near font-looking code" would fire on
  `@font-face { src: url(...) }` pointing at a repo's own R2/Cloudinary
  bucket, which is the false-positive rate that gets a gate switched off
  within a week. **Skips a host named only inside a Content-Security-Policy
  directive string** (`style-src`/`font-src`/the `Content-Security-Policy`
  header itself) — that is a permission, not a load, the same distinction
  `check-webhook-verification.mjs` draws between checking a signature and
  acting on it. Promoted here 2026-09-22 from a consumer's scaffold
  template, where it was written the same day web-core was mid-edit by
  another session — behaviour is unchanged, only the location and header's
  promotion note. **What it cannot see:** a per-brand or DB-sourced font URL
  (a `brands.theme.fontUrl`-shaped design, found live in one consumer) is
  the same violation with an extra layer of indirection — the hostname
  lives in a database row, not in the consuming repo's source, so no grep
  can see it — that needs a self-hosted-file-path allowlist instead, never
  a hostname regex. Waivers
  are `// third-party-font-ok: <reason>` on the line or the line above, or a
  path plus a `#` reason in `.font-cdn-baseline` for a whole-file exception;
  a bare annotation with no reason does not suppress the finding. Plain
  Node, no dependencies.

- `check-post-submit-notice.mjs` — flags **hand-written inbox/spam-folder
  copy** in a `.tsx`/`.jsx` file that does not import the shared
  deliverability notice. Any page telling a visitor "if you don't see it,
  check here" is deliverability copy, not just UX copy — steering someone to
  the right recovery action for THEIR provider (Promotions-tab drag for
  Gmail, Safe senders for Outlook, Not Junk for iCloud/Yahoo) is a positive
  reputation signal a mailbox provider reads about the sending domain, and
  this exact instruction had already drifted into five different phrasings
  across sites before the shared module existed. Matches case-insensitive
  phrases like "check your spam/junk", "spam/junk folder", "promotions tab",
  "safe senders", "add … to your contacts", "mark … not spam/junk" —
  deliberately does **not** match a generic deliverability promise ("No spam.
  Unsubscribe any time.") since that names no folder, tab, or contacts action.
  A file that imports the notice module directly, or imports/renders a local
  `PostSubmitNotice`, is trusted wholesale and skipped entirely — the copy
  living there IS the canonical copy. Comments are blanked before matching,
  same reasoning as `check-unsanitised-html.mjs`: the files most likely to
  TALK about this in prose are the ones that got it right. Waivers are
  `// post-submit-notice-ok: <reason>` on the line or the line above; a bare
  annotation with no reason does not suppress the finding. Plain Node, no
  dependencies.

- `check-migration-prefixes.mjs` — flags two files under `supabase/migrations/`
  that share the same leading prefix (the digits, optionally followed by one
  lowercase letter, before the first underscore). A migration runner assigns its
  own version and records what it applied by filename, so the prefix controls
  neither ordering nor dedup — a duplicate is a silent labelling fault, not a
  replay risk, but it is exactly the mistake two authors make without knowing
  about each other's work. The one deliberate nuance: a short numeric prefix
  (`0053`) or a long timestamp-style prefix must be unique, and an 8-digit date
  prefix WITH a disambiguating letter (`20260901b`) must be unique, but an
  8-digit date prefix with NO letter is allowed to repeat — several files on one
  bare same-day date is an established, intentional convention in repos that use
  this style, not a defect, and failing on it would fire on every pre-existing
  same-day group and teach everyone to ignore the gate. Only a
  repeated disambiguating LETTER on the same date is a real collision.
  Deliberately does not decide the fix (rename vs. leave alone) — a migration
  already applied may have its filename recorded verbatim in the runner's own
  ledger, so renaming after the fact can desync it from that record, which is
  worse than the original labelling fault. Waivers are
  `.migration-prefix-baseline` (one prefix per line, `# reason` required — a
  bare entry does not suppress). Plain Node, no dependencies.

- `check-legal-placeholders.mjs` — **a production build must not ship placeholder
  legal pages.** Scans the `/privacy`, `/terms` and `/disclaimer` page files (any
  route group, `app/` or `src/app/`) and a `lib/seller.ts` seller-identity module
  for `TODO`, `[BRAND]`/`[CONTACT EMAIL]`-style brackets and `REPLACE_WITH_*`,
  with comments blanked first. FAILS only when `VERCEL_ENV=production` or with
  `--strict`; anywhere else it prints `::warning::` findings and exits 0, so work
  in progress is visible but never blocked. The deliberate complement to
  `check-scaffold-metadata.mjs`, which skips legal body copy because it runs in
  every environment. Self-skips (announced) for a `*-template` package. Waiver:
  `// legal-placeholder-ok: <why>`. Needs no git (runs as a `prebuild` step,
  where `vercel --prod` uploads without `.git`). Opt-in: a consumer wires it
  into its own `prebuild`; it is NOT fetched by any CI job, so adding it here
  changes nothing for a repo that has not chosen it. Tested in
  `check-legal-placeholders.test.ts`.

- `check-icon-rgba.mjs` — **app-router icon files must be RGBA.** Next.js rejects
  a non-RGBA `icon.png`/`apple-icon.png` at build time, and on Vercel a failed
  build leaves production silently on the previous deploy. Checks every
  `favicon*.ico`, `icon*.png`, `apple-icon*.png` under `app/`/`src/app/` (PNG
  colour type 6; every ICO entry an RGBA PNG or a 32bpp BMP). `public/` is not
  Next's icon pipeline and is ignored. Opt-in `prebuild` step, no git needed.
  Tested in `check-icon-rgba.test.ts`.

- `check-landing-page-events.mjs` — **every listed landing route counts its visits
  server-side in `after()`.** Opt-in via a `.landing-routes` manifest at the repo
  root: one URL route (`/`, `/offer`, `/[slug]`; route groups ignored) or file path
  per line, `#` comments, and an optional `calls: a, b` line naming the repo's own
  wrapper, plus `wrapper: <fn> <file>` for a repo whose pages call one helper that
  schedules the `after()` itself (the helper file must pass the full check; a page
  then passes by calling `<fn>(`). Otherwise each listed page must import `after` from `next/server` and call
  `recordPageEvent`/`trackServerEvent` (or a `calls:` name) inside an `after(...)`
  argument. Comments are blanked first; arguments are found by paren balancing.
  Fails on a missing call, on an entry that resolves to no file (a renamed page
  must not drop out of coverage silently) and on an empty manifest (an empty
  manifest is a disabled gate that looks enabled). No manifest = announced pass.
  It proves the call is PRESENT, never that the env vars are set: code without
  env is the common real failure, so pair it with a runtime monitor on the event
  store. `--self-test` proves it both ways (18 cases, run in this repo's CI).
  Consumers fetch it pinned by `WEB_CORE_REF`, like the other gates. Plain Node,
  no dependencies.
