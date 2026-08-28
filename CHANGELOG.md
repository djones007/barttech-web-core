# Changelog

All notable changes to this project are documented here. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) — grouped by date, newest first. Entries use **Added** (new features), **Changed** (behavior changes), **Fixed** (bug fixes), **Removed** (deleted features).

## [2026-08-28]

### Added

- `EmailitSendMessage.tracking` — optional per-message override of the sending
  domain's tracking defaults (`boolean` or `{ loads, clicks }`). With click
  tracking on, the provider rewrites links to redirect through its own tracking
  host; some mail clients and link scanners warn the reader on a redirect
  through an unfamiliar host, which costs a click on a transactional message
  whose destination is already first-party. Keep click tracking for marketing,
  disable it per-message for transactional with `{ loads: true, clicks: false }`.
  Absent by default, so every existing caller keeps the domain default it has
  always used.

## [2026-08-24] — CI gate scripts: containment check on every path built from an enumerated file list

### Fixed

A SAST scan flagged a "potential file inclusion" pattern (Medium) across several of this repo's
own CI gate scripts (`scripts/*.mjs`): a file path built by joining a scan root with a value that
came from a loop — over `git ls-files` output or a local directory walk — then passed straight to
a file read. In every case the loop variable is enumerated from a trusted local source inside the
same run, never external or network input, so the practical risk was low. Static analysis cannot
see that provenance, though, and the containment check is cheap, so every flagged read site (and
one raw-descriptor open in the same family) now resolves the joined path and refuses to proceed if
it falls outside the scan root, before the read happens. No script's actual checking logic changed;
each modified script was run against a real repository before and after and produced byte-identical
output. These scripts are fetched as single standalone files by consumer CI, so the fix is inlined
into each one rather than factored into a shared module that consumers can't see.

## [2026-08-24] — Storage path-traversal: single sanitiser reused, new CI gate

### Fixed

A SAST scan flagged a grouped path-traversal finding (High, "path traversal in Supabase Storage"),
7 subissues across two consumer apps: user- or DB-controlled strings reaching a storage key
without going through the estate's existing guard. One site hand-rolled a duplicate of
`safeUploadFilename` with a subtly different truncation rule (`.slice(-100)` — last 100 chars,
instead of first-`100-ext.length`-chars-plus-extension); the other built a key from a narrower,
worse regex that didn't strip directory components. Both are now `safeUploadFilename` call sites.

### Added

- `sanitizeStorageSegment` — a documented alias of `safeUploadFilename` in `uploads.ts`, for call
  sites sanitising something that isn't an uploaded file's original name (a DB id, a constructed
  filename segment) where "upload" reads oddly. Same implementation, same guarantees — not a second
  sanitiser.
- `scripts/check-storage-path-traversal.mjs` — new CI gate. Flags a file that calls
  `.storage.from(...)` chained with `.upload(`/`.remove(`/`.createSignedUrl(s)`/`.download(`/`.move(`/`.copy(`
  and does not also import `safeUploadFilename` (or the new alias) from `@/web-core/uploads` or
  `@/lib/uploads`. Same file-level-heuristic tradeoff as this repo's other regex gates — a
  `.storage-path-baseline` file (mirrors `.web-core-baseline`) is the ratchet for a genuine
  compile-time-constant false positive. Rolled out via
  `tools/storage-path-traversal-gate-rollout.py` in the private root repo.

## [2026-08-17] — Security review findings survive a failed issue create

### Fixed

The weekly security review filed its critical findings through a single
`gh issue create --label security`. If that one call failed, the step aborted and no issue was
created at all. On 2026-08-17 `barttech-web-core` had no `security` label, so a review that found 5
critical issues produced nothing but a red badge on a scheduled run — and nothing alerts on those,
so it went unnoticed. Findings now fall back to an unlabelled issue so they always reach the
tracker, and the job still exits non-zero so the missing label gets fixed rather than tolerated.

## [2026-08-16] — `cronHeartbeat.ts` accepts `degraded`

A scheduled job had only two states it could report about its own run: `ok` and `error`. That made
one field do two jobs, so a run that DID its work but took a documented fallback — an optional
source down, one item of a batch skipped — had to claim outright failure to report the fact at all.
The consequence is that honest reporting becomes the thing that raises false alarms, and an alarm
that is always on is one nobody reads.

`degraded` is the third state: recorded, visible, raises nothing. `error` now means only "the run
did not do its job", and it alone should drive an exit code or a page.

### Added
- **`HeartbeatStatus`** — exported type alias (`"ok" | "degraded" | "error" | "pending"`), so a
  caller can type its own variable without restating the union and a future state is one edit here
  rather than a sweep across consumers.

### Changed
- **`HeartbeatOptions.status` and the internal history writer now accept `"degraded"`.** Purely
  additive and backwards-compatible: every existing call passing `"ok"`/`"error"`/`"pending"`
  typechecks and behaves exactly as before. Both fields reference the new alias rather than an
  inline union.
- Doc comment now describes all four states and states the `error`-means-failure rule explicitly.
  The existing "a reader treating anything-not-`error` as healthy stays correct" guarantee is
  unchanged and now called out as covering `degraded` too.

**No storage change is needed, and this was verified rather than assumed** before the type moved:
in BOTH projects that hold these tables, `cron_heartbeats.last_status` is unconstrained `text` and
`cron_runs.status`'s CHECK already lists `degraded`. So the database has accepted this value all
along and the type was the only thing preventing an in-app cron from reporting it — which is why
this is a type-only change with no migration attached.

`POST /api/support/form-ticket` moved from the CDP app to a standalone support app, which now
owns the support domain end to end.

### Changed
- `createSupportTicketFromForm()` now POSTs to `${SUPPORT_ENGINE_URL}/api/support/form-ticket`
  instead of `${BARTMAIL_URL}/api/support/form-ticket`. **`SUPPORT_ENGINE_URL` has no hardcoded
  default** — the old default URL is gone, deliberately: a consuming app's production URL is
  estate-architecture detail this public repo should not carry (golden rule at the top of this
  file's CLAUDE.md). Every consumer must set `SUPPORT_ENGINE_URL` in its own env before bumping
  to this commit, or the call fails closed with `"SUPPORT_ENGINE_URL not configured"` (same
  fail-closed shape as a missing `SUPPORT_FORM_SECRET`). `SUPPORT_FORM_SECRET` itself is
  unchanged — same shared secret, new destination.

**Cross-repo note:** every consumer that calls this module must add `SUPPORT_ENGINE_URL` to its
deployment env in the same change as bumping this pointer.

## [2026-08-15] — One sanitiser engine: `renderSafeHtml` is now `renderSafeHtmlNoDom`

### Changed
- **`safeHtml.ts` no longer carries its own DOMPurify implementation** — `renderSafeHtml` is an alias of `renderSafeHtmlNoDom`, so both exported names resolve to the single `sanitize-html` implementation and jsdom is gone from this repo's dependency chain entirely. The 2026-08-12 entry below explains why jsdom is unusable in serverless runtimes; consolidating retires that hazard for every consumer instead of only the ones that had already migrated.
- **Consolidation was corpus-verified, and the verification caught a real bug**: rendering every consumer's full published content through both engines and DOM-diffing (tags, every attribute, text, JSON-LD data) showed the allowlist silently stripping `data-*` attributes and `<img decoding>` from 13 of 64 posts in one consumer. Fixed before shipping: `data-*`/`aria-*` wildcards, `decoding`, and `video`/`audio`/`track` (+ their attributes) added for DOMPurify parity, each pinned in `safeHtmlNoDom.test.ts`.
- **`parseStyleAttributes: false`** — inline `style` passes through verbatim as DOMPurify did, instead of being re-serialised by postcss (which was rewriting bytes on 5 real posts and turning corpus diffs into noise).
- `safeHtmlNoDom.test.ts`'s byte-for-byte equivalence test now asserts the single-implementation invariant (`renderSafeHtml === renderSafeHtmlNoDom`) — a reintroduced second engine fails a test rather than passing vacuously.

### Removed
- `isomorphic-dompurify` devDependency. **Cross-repo note (golden rule 1b):** consumers importing `safeHtml` must have `sanitize-html` (+ `@types/sanitize-html`) installed and can drop `isomorphic-dompurify` — do both in the same commit as the pointer bump.

## [2026-08-12b] — `safeHtmlNoDom`: sanitising without jsdom

### Added
- **`safeHtmlNoDom.ts`** exporting `renderSafeHtmlNoDom()` — the same contract as `renderSafeHtml`, backed by `sanitize-html` instead of DOMPurify, so nothing in its chain touches jsdom. Use it in any serverless or edge runtime.
- **`safeHtmlNoDom.test.ts`** — the same cases as `safeHtml.test.ts`, plus URL-scheme tests the allowlist model has to earn (`javascript:`, `data:`, case and whitespace variants), plus an equivalence test asserting the two implementations agree **byte-for-byte** on ten representative inputs. That last one is the real claim: a consumer can move between them without its rendered output changing.

### Why both exist
jsdom 30 requires `html-encoding-sniffer` 6, which does a CommonJS `require()` of `@exodus/bytes` — ESM-only in every published version, so no dependency pin can fix it. On Next 16 + Turbopack + Vercel serverless that throws at **module load**, 500-ing every request to the route.

Golden rule 1c already described this and `safeHtml.ts` claimed "rendering paths (pages, views) are unaffected". That was wrong: a consumer's help page 500'd on every signed-in request from 2026-08-08 to 2026-08-12. The verification recorded at the time — load the page and check for the auth redirect rather than a 500 — could not have caught it, because the redirect happens in the layout **before** the page body runs, so it never reached the import. Rule 1c's advice is now sharper: an auth-gated route must be checked **signed in**.

`renderSafeHtml` is kept and unchanged because several consumers render published blog content through it. The two agree on the tested contract, but a subtle difference on real-world markup would silently rewrite live posts — which is the exact failure (`target` dropped from 34 links across 20 posts) those tests were written for. Migrating the rest is a deliberate, verified step, not a side effect of fixing a 500.

### ⚠️ This adds a NEW EXTERNAL IMPORT — cross-repo change, read before bumping
Per golden rule 1b. Checked across all 19 consumers on 2026-08-12: **only one has `sanitize-html` installed.** Thirteen exclude this mount from their `tsconfig.json` and are therefore unaffected. **Six do not exclude it and do not have the package** — they will fail `tsc` on the next bump unless they either add the exclusion rule 1b already requires, or install `sanitize-html`. The exclusion is the correct fix and is being applied to those six.

### Changed
- `scripts/check-unsanitised-html.mjs` recognises `renderSafeHtmlNoDom(...)` as a sanitising call. Without this every consumer using the new function would fail the gate.
- `shared-modules.json` registers the new module (CI fails on an unregistered one). Deliberately no resource match on `sanitizeHtml(`: a direct call is not a re-implementation of this module — it is the same primitive it wraps, and at least one consumer route calls it directly for exactly this runtime reason.


## [2026-08-12] — Add check-scaffold-metadata gate

### Added
- `scripts/check-scaffold-metadata.mjs` — scaffold placeholders must not reach production. Fails when a root layout's `title`/`description` still carries a `TODO` or a generic "<framework> Template" stand-in, or when a `REPLACE_WITH_*` token survives in live code. Comments are blanked before matching, because the repos that fixed this bug documented it with a comment quoting the old placeholder — matching raw text would flag the fix. Placeholder body copy on legal pages is deliberately out of scope for now: same family, but it needs real content rather than a rename. Waivers are `// scaffold-metadata-ok: <reason>`, and a bare annotation with no reason is itself a failure.

## [2026-08-12] — Add check-sentry-instrumentation gate

### Added
- `scripts/check-sentry-instrumentation.mjs` — a repo that installs `@sentry/nextjs` must actually be wired to report server-side errors. Requires the instrumentation file to export `onRequestError = Sentry.captureRequestError`, and flags orphaned legacy `sentry.{server,edge,client}.config.*` files the current SDK no longer loads. `Sentry.init()` only arms the SDK; without the export every server-side error is dropped while client errors keep arriving, so nothing looks wrong. An audit found no repo had ever exported it — a 3.5-day 500 outage on one site raised no alert at all. A server/edge config imported from inside `register()` is a supported layout and is deliberately not flagged.

## [2026-08-11] — Security hardening (Aikido audit)

### Fixed
- `scripts/check-heartbeat-status.mjs`: import `resolve` from `node:path` and wrap the `process.argv[2]` root in `path.resolve()`. The script only runs in trusted CI/dev environments, but using an explicit absolute path eliminates the ambiguity a static analyser reads as a file-inclusion risk (Aikido issue 1).
- Added `persist-credentials: false` to all `actions/checkout` steps in CI, public-hygiene, and security-review workflows (Aikido issue 11).

## [2026-08-10] — Fix security-review CI: validate array types, not just key presence

### Fixed
- **`security-review.yml`** validation check used `has("critical") and has("warnings")`, which passes when the model returns string-encoded arrays instead of actual arrays. The "Open issue" step then failed on `.critical[]` with "Cannot iterate over string". Validation now checks `(.critical | type) == "array" and (.warnings | type) == "array"` — if either is a string, the review step exits 1 with a clear diagnostic rather than letting the issue step fail cryptically.

## [2026-08-09] — Added `telegram.ts`: a second alert channel that reports whether it delivered

### Added
- **`telegram.ts`** — `sendTelegramAlert()`. Email is the primary alert path and its failure mode is silent (expired credential, mailbox rule, provider outage), so a second channel over completely different infrastructure means one dead path does not mean one unheard alert.
- Every failure mode here is silent, so all of them are tested. Telegram answers **200 with `{ok:false}`** for some errors and **404** for a revoked token, and both resolve the fetch promise happily — a caller checking only for a thrown exception would treat either as delivered.
- **Over-length messages are truncated, not dropped.** Telegram rejects anything over 4096 characters outright, so without this the longest and most detailed alerts would be exactly the ones that vanished. The truncation says so, pointing the reader at the email.
- **No parse mode is set, deliberately.** Alert bodies carry error text, stack fragments and URLs; Markdown/HTML parsing rejects the whole message on one unbalanced character. An alert failing to send because the error it reported contained an underscore is the wrong trade — delivery beats formatting.
- Never throws and always returns a boolean, because it runs on a job's failure path and the caller must be able to tell "sent" from "silently did nothing".

## [2026-08-09] — Added `scripts/check-heartbeat-status.mjs`: a monitor must not report success while counting failures

### Added
- **`check-heartbeat-status.mjs`** — flags a bare success literal passed to a run-status writer when the same file tallies `errors`/`failed`/`skipped` earlier in the file. That combination means the recorded outcome cannot disagree with the code, so a run in which every unit of work failed is byte-identical, on every dashboard, to a perfect one. This failure mode points towards *silence*, which is why it survives for months: the surfaces built to reveal it are the ones showing green.
- **Position is the discriminator.** Routes legitimately record "ok" on an early return ("feature disabled", "nothing due") *before* attempting any work, and a healthy skip must still be recorded or a run of correct answers looks like a dead job. Only writes occurring after counting begins are considered. An earlier file-scoped version put three waivers into one file whose author had done nothing wrong — a gate that fires on correct code is one people disable.
- Derived statuses (`errors.length ? "error" : "ok"`, a variable, a call) are never flagged; that is the desired form. Waivers use `// heartbeat-status-ok: <reason>`, and a bare annotation with no reason is itself a failure. Repos may tune call and counter names via `.heartbeat-status.json`.
- Validated against six real consumer repos before shipping: it independently reproduced every instance a separate manual audit had found, plus one the audit missed, and reported clean on a repo with no scheduled jobs.

## [2026-08-09] — Declare `alerting` in shared-modules.json (CI fix)

### Fixed
- `alerting.ts` shipped without a `shared-modules.json` entry, so the manifest gate failed the build — correctly: the gate exists so that "owns nothing" is a stated decision rather than an oversight, and the two must not look the same. Added with empty `resources` and a `why`. No resource match: the thing worth forbidding is hand-rolled alert suppression, which has no reliable textual signature, and a regex broad enough to catch it would fire on every ordinary timestamp comparison.

## [2026-08-09] — Added `alerting.ts`: decide which failures are worth notifying about

### Added
- **`alerting.ts`** — `selectNewAlerts()`, the shared rule for notification suppression. A monitor usually runs more often than the things it watches, so a daily check looking at a weekly job sees the same failed run seven times; notifying on every sighting means six messages carrying no new information, arriving after the problem was already fixed. An alert channel that repeats itself trains its reader to ignore it, and that degrades gradually while the monitor reports itself as working perfectly.
- The module draws the distinction that matters: a **past occurrence** (carries an `occurrence` id — cannot change until the subject runs again, so it is notified once) versus a **live condition** (no `occurrence` — re-measured every pass, so "still failing" is a fresh fact and is never suppressed). Getting it backwards either way is harmful, so both directions are covered by tests.
- Fails **open** by design: missing or unreadable previous state makes everything fresh. Over-notifying is recoverable; a monitor silently deciding not to notify is not.
- Returns `suppressed` and `recovered` alongside `fresh`, so callers can say "N others still failing, unchanged" rather than hiding anything, and can note recoveries. Suppression is for the notification only — callers must keep recording suppressed failures in their health status and dashboards.
- `alerting.test.ts` — 9 tests, including the full seven-day weekly-job cycle, live-condition non-suppression, fail-open, and recover-then-fail-again. Added to the `test` script.

## [2026-08-09] — Public hygiene: strip consumer-specific names from comments

### Fixed
- `scripts/check-unsanitised-html.mjs` and `CHANGELOG.md` referred to specific internal project and template names, tripping the public-hygiene denylist gate. Replaced with generic descriptions — mechanism only, no consumer detail.

## [2026-08-09] — unsanitised-html gate: three fixes found by running it estate-wide

### Fixed
- **Filename regex truncated `.tsx` to `.ts`.** `(?:ts|tsx|…)` is ordered alternation, so `ts` matched first and the gate reported "named file not found" against `LessonPlayer.tsx`, which was right there. Longest-first now.
- **`sanitize: true` counts as a sanitiser.** `remark-html`'s own sanitiser is a legitimate implementation — the LMS engine uses it — and the verification only looked for `renderSafeHtml`/`DOMPurify`/`sanitize-html`. Matching on the **value** rather than the key is the whole point of this gate, so `sanitize:\s*true` passes and `sanitize: false` still does not.
- **Skips `out/`, `.output/`, `storybook-static/`.** A static-export directory is untracked build output; per this repo's own rule, scope by what is committed. One repo's committed-looking `out/` produced two findings inside minified chunks.

### Notes
- All three surfaced by running the gate against **every repo with a `ci.yml`** (22) rather than the 19 web-core submodule consumers — two repos have CI but no submodule and were outside the earlier sweep. That is the same partial-coverage mistake this gate's own tooling exists to prevent, caught this time before rollout rather than after.

## [2026-08-08e] — Tests, and a gate for unsanitised HTML

### Added
- **`safeHtml.test.ts` — this repo's first tests, and `npm test` in CI.** 27 assertions covering every attribute the module must preserve and every tag/handler it must strip. It exists because `safeHtml` shipped a content regression (`target` dropped from every anchor, 34 live links) that lint and typecheck cannot see and that a tag-and-text comparison passed. This repo is vendored into ~19 consumers: a behaviour change here is a behaviour change everywhere, so it needs assertions, not a clean compile.
- **`scripts/check-unsanitised-html.mjs`** — requires every `dangerouslySetInnerHTML` in a consumer to have a visible reason to be safe: a `renderSafeHtml`/`jsonLd` call, a SCREAMING_CASE constant, a local variable assigned from one of those, or an inline `// safe-html-ok: <where it is sanitised>` annotation. An annotation naming a file is **verified**, not trusted.

### Fixed
- The "every module is declared" CI gate globbed `*.ts`, so the first test file added here would have failed it on its own name. `*.test.ts` is now excluded — a test is not a module and owns no resources.
- ESLint now ignores `.testbuild/`, the CommonJS output `npm test` compiles so `node --test` runs against real module resolution.

### Notes
- Three findings from building the gate, each after it returned a false result — all the same shape as the bugs it exists to catch: comments must be blanked before matching (the two repos that handled this *correctly* did so with a comment explaining they avoid the API); a stale annotation must fail rather than read as verified; and the verification itself must blank comments, because the first version was fooled by the named file's own comment mentioning `renderSafeHtml` after the call had been deleted.

## [2026-08-08d] — Document the consumer-typecheck rule `safeHtml` exposed

### Changed
- `CLAUDE.md` gains golden rules **1b** and **1c**, and step **3b** of "Adding a new consumer".

### Notes
- **`safeHtml.ts` is the first module here to import a package not every consumer installs.** Until now the only external import was `@supabase/supabase-js`, which every consumer happens to have — so the problem was invisible. Consumers vendor this repo as source and typecheck it with their own `tsc`, so `isomorphic-dompurify` being absent is a *build failure in a repo that never imports the module*. It broke one consumer's template on the first bump, and 10 of 19 consumers would have failed the next propagate run.
- The fix is for consumers to exclude the mount path from `tsconfig.json`'s root file set, mirroring the ESLint exclusion that already exists for the same reason. Verified this does **not** stop a consumer's own misuse being caught — an imported file is still type-analysed, and passing a wrong option type still errors.
- Rule 1c records that a dependency can be unusable in a *particular* consumer (jsdom vs Next 16 + Turbopack + serverless), and that a green build proves nothing for a `ƒ` route — the failure mode was at request-time module load.

## [2026-08-08c] — safeHtml: stop stripping `target` from links

### Fixed
- `renderSafeHtml` silently removed `target` from every anchor, so `<a target="_blank">` became a same-tab link. DOMPurify's standard HTML profile drops the attribute; `ADD_ATTR: ["target"]` restores it.
- **Caught only after it shipped.** A consumer deployed this across 20 editorial posts (34 links) whose authors had deliberately opened external references in a new tab. It is invisible to any check that counts tags or compares visible text — both were identical — which is why the verification that missed it looked green.

### Notes
- Re-allowing `target` is not a security regression. Reverse tabnabbing, the reason it was ever treated as risky, is mitigated by every current browser applying implicit `noopener` to `target="_blank"`; `rel` survives sanitisation, so content that sets `rel="noopener"` keeps it too.
- `FORBID_ATTR` still wins over `ADD_ATTR`, so a caller that wants `target` gone can pass `forbidAttr: ["target"]`.
- Verified `script`, `onclick`, `iframe`, `style`, `object`, `embed` and `form` are all still removed.

## [2026-08-08b] — safeHtml: one sanitiser for `dangerouslySetInnerHTML`

### Added
- `safeHtml.ts` — `renderSafeHtml(raw, opts)`, the shared DOMPurify pass for HTML bound into
  `dangerouslySetInnerHTML`. Standard forbid-lists (`script`/`style`/`iframe`/`object`/`embed`/`form`,
  `onerror`/`onload`/`onclick`), extendable per call, plus the optional JSON-LD carve-out: extract every
  `ld+json` block, require it to parse as pure JSON, sanitise the rest, then re-attach each schema
  through `jsonLd()` so a crafted `</script>` inside a schema string is inert.
- `isomorphic-dompurify` as a devDependency (consumers already provide it at runtime; this is so lint
  and typecheck resolve here).
- A `safeHtml` entry in `shared-modules.json` matching `DOMPurify.sanitize(` — two consumers had each
  written this logic separately, one noting in its own comment that it mirrored the other, which is
  precisely the drift the manifest exists to catch. Sanitisers with no jsdom dependency are a different
  operation for a different runtime constraint and are deliberately **not** matched.

### Changed
- `preserveJsonLd` defaults to **false**, not true as originally drafted. Re-attaching `<script>` tags
  is the one thing a function called "safe" should not do silently: a caller sanitising genuinely
  untrusted input would otherwise re-emit attacker-supplied schema. Not script execution — `ld+json` is
  data and `jsonLd()` blocks the tag breakout — but it hands over arbitrary structured data on the page,
  which is worth an explicit opt-in.

### Notes
- **Import this module only in the file that sanitises — never from a barrel.** It pulls in jsdom, and
  a consumer on Next 16 + Turbopack + a serverless runtime hit an ESM/CommonJS conflict in that chain
  that threw at module-load time, 500-ing every request to the route rather than only those with HTML
  to clean. Rendering paths are unaffected; verify with a local production build before importing it
  into a serverless API route on that stack. This repo has no `index.ts`, so nothing is pulled in by
  default — keep it that way.

## [2026-08-08] — Security audit fixes

### Added
- `.nvmrc` (Node 22) and `engines.node` (`>=22.0.0`) in `package.json` so local dev matches the
  Node version CI already pinned — a contributor on an older Node previously had no signal.
- `npm audit --audit-level=high` as a CI step, `if: always()` alongside lint/typecheck, so a newly
  disclosed high/critical advisory in a dependency fails the build instead of going unnoticed
  between manual audit runs.

### Changed
- `.gitignore` now covers `.env`, `.env.*`, `.env.local` and `.env.*.local` (previously only
  `node_modules/`, `.DS_Store`, `*.log`, `.vercel`) — no env file was ever committed, but the guard
  itself was missing, so a future `.env.local` had nothing stopping it from being staged.

### Fixed
- Bumped the transitive `js-yaml` devDependency (pulled in via eslint) off the 4.0.0–4.3.0 range
  affected by a high-severity quadratic-CPU-consumption advisory. Lint-only dependency, not part of
  the shipped module — `npm audit fix`, lint and typecheck all verified clean afterward.

## [2026-08-08z] — CI gate hardening

### Fixed
- **Security Review crashed instead of reviewing, on any repo younger than a week.**
  `git rev-parse "$OLDEST~1" 2>/dev/null` echoes the *unresolved argument* to stdout as well as
  exiting non-zero, so the `||` fallback ran too and appended its answer — `BEFORE_SHA` came out two
  lines long, `git diff` got one argument containing a newline, exit 128. Fixed with
  `--verify --quiet`. The fallback was independently wrong too: "second commit from HEAD" would have
  reviewed one commit while looking like a clean pass, so the base is now the empty tree.

- **Security Review threw away its own findings.** It asked for JSON as text, and the reviewer quotes
  code: with this workflow file in the diff, the model described the extraction regex and wrote `\{`
  inside a JSON string. `\{` is not a legal JSON escape, so the response was malformed and every
  finding was discarded as "Model did not return parseable JSON". Self-referential and silent — it
  fired precisely when the security tooling changed. Findings now come back as a forced tool call
  against a declared schema, so the API serialises and validates the JSON.

## [2026-08-08c] — `crossSiteRequestError`: refuse state changes another site initiated

### Added
- `crossSiteRequestError(req)` in `validation.ts`. Returns a 403 error object when a browser made
  this request on behalf of another site, else null. For handlers that MUTATE — a read-only GET does
  not need it, and applying it there breaks ordinary links and bookmarks.

  `Sec-Fetch-Site` is the primary signal: the browser sets it and page script cannot forge it, so
  `cross-site` is refused while `same-origin`, `same-site` and `none` pass. `Origin` compared against
  the forwarded host is the fallback for clients that omit it. An absent Origin is allowed on purpose:
  server-to-server callers and curl send neither header and are not the threat — CSRF needs a browser
  holding the victim's cookies, and every browser sends at least one of the two.

  Chosen over a CSRF token because a token needs somewhere to live, a route to every form, and a
  rotation story; for a cookie-authenticated JSON API this closes the same hole with none of that. It
  is a third layer, not a replacement for auth or SameSite — and it is the layer that still holds if a
  cookie is ever widened to SameSite=None for an embed or a payment return.

## [2026-08-08b] — Fixed: the hygiene gate was failing on this repo

### Fixed
- `nextRedirects.ts` and `supportTicket.ts` carried content this repo must not publish, and the
  Public Hygiene gate had been red on every push since they landed.

  `nextRedirects.ts` explained itself with a full incident narrative — how many live sites were
  affected, named individually, and the exact path pattern that returned 200 on each. That is a
  ready-made probe list for every other site built the same way, and this repo is public. The
  rewrite keeps the whole mechanism and every design note (why a redirect and not a header, why
  `permanent: false`, why a pattern rather than a list of known files) and states the structural
  cause generically: a web-served directory and a convention that writes docs into directories
  are in conflict wherever both apply.

  `supportTicket.ts` used a real brand slug as its example value. Replaced with a description of
  what the field is.

  The `.vercel.app` default host was left alone — `bartmail.ts` already carries it and the gate
  has always passed on it, so it is not what was failing. Worth recording, because it was changed
  and reverted while diagnosing this: that module hashes the *custom* domain rather than naming it,
  which is the actual line between what may and may not appear here.

## [2026-08-08] — `supportTicket`: raise a helpdesk ticket from a contact form

### Added
- **`supportTicket.ts`** — `createSupportTicketFromForm()`. Brand contact forms emailed a notification
  and wrote an optin; none created a TICKET, so enquiries lived in an inbox while the helpdesk sat
  empty — and the helpdesk is where the spam gate, AI triage, SLAs and the audit trail live.

  **It calls BartMail; it does not write the tables.** The first version INSERTed into
  `support_tickets` directly. That worked and was wrong: the spam gate — denylist, allowlist, AI
  sender classification, daily cost cap — lives in BartMail beside the tables it protects, so a direct
  write from six websites skipped every bit of it and would have filled the helpdesk with exactly the
  rubbish the gate exists to stop.

  Note this points the OPPOSITE way to `bartmail.ts` next door, deliberately: an optin is a direct
  Supabase write because there is no server-side decision to make. A support ticket has one — whether
  it should exist at all — so it must go through the code that makes it.

  Auth is a shared secret, not the service-role key: a website able to read every contact in the CDP
  in order to file a support ticket is far more authority than the job needs.


## [2026-08-07b] — `nextRedirects`: stop sites serving their own documentation

### Added
- **`nextRedirects.ts`**, exporting `SHARED_REDIRECTS` — redirect rules every estate site must
  carry, spread into each repo's `redirects()`. Currently one rule: never serve markdown from
  `public/`.

  Five live customer-facing sites were found returning their internal `CLAUDE.md` files with HTTP 200
  and `Content-Type: text/markdown`. It is structural rather than careless — the estate convention
  puts a `CLAUDE.md` in every folder, and `public/` is web-served, so the two rules are in direct
  conflict and it recurs for as long as both hold. Hence one shared rule rather than five fixes.

  **A redirect, not a header**: Next checks redirects before the filesystem, so this intercepts the
  static file — a header would leave the bytes being served. `permanent: false` throughout, because a
  308 on a path someone later wants to serve legitimately is very hard to take back.

  Imported by **relative path** (`./web-core/…` or `./src/web-core/…`) like `adPlatforms`' CSP
  constants — the Next config loader does not resolve tsconfig path aliases.

### Notes
Enforcement is deliberately NOT a resource match: the thing worth catching is a site that fails to
spread `SHARED_REDIRECTS`, which is an absence, and the inlining gate can only see presence. Live
verification lives in the estate's security-audit agent, which probes the real URLs — a config that
exists is not proof of a config that works.

## [2026-08-07] — `check-id-list-filters.mjs`: the second PostgREST cap

### Added
- **`scripts/check-id-list-filters.mjs`** — flags an unbounded id array used as a PostgREST
  query filter (the interpolated `.not('id', 'in', `(${…})`)` form).

  PostgREST has **two** caps, and fixing the well-known one leads straight into the other.
  Paginating a read to escape the 1000-row cap yields an id array; that array then goes into
  the request URL, which breaks at ~1,000 ids (39KB → HTTP 400) and fails at the connection
  level past ~100KB. So the standard fix relocates the failure instead of removing it. The
  answer is to move the whole predicate into an RPC.

  Two consumer repos shipped exactly that two-stage shape — one live, one dormant behind an
  empty table. Verified non-vacuous against the pre-fix code: 4 hits, exit 1; clean tree, exit 0.

  Also documents that a `returns setof <type>` RPC is **not** exempt from the 1000-row cap —
  only a single-row `jsonb` aggregate escapes it — and that set-returning RPCs must be verified
  through PostgREST, not the SQL editor, where the truncation is invisible.

  Literal and page-scoped lists are deliberately not flagged. The gate cannot see
  `.in('id', ids)` where `ids` came from a pagination loop; that still needs review.
## [2026-08-07] — cronHeartbeat: per-run history alongside the heartbeat

### Added
- **`cron_runs` history write.** `cron_heartbeats` holds ONE row per job, overwritten every run, so it
  answers "is this healthy now?" and nothing else. `writeCronHeartbeat` now also appends an
  append-only row per run — status, started/finished, duration, detail — restoring the run history
  the estate lost when its previous scheduler was retired. Controlled by `historyTable`
  (default `cron_runs`); pass `null` to opt out in a project that has no such table yet, otherwise it
  would log a 404 on every run.
- **`startedAt`** option (ms or ISO). Used only to compute `duration_ms`. Omit it and duration is
  `null`, which records "not measured" rather than claiming the run was instant.

### Changed
- The heartbeat's `last_run_at`/`updated_at` now reuse the same timestamp as the history row's
  `finished_at`, so the two tables agree about when a run ended instead of differing by however long
  the history write took.

### Notes — why the history write goes first
The heartbeat is what watchers alarm on, so it is the write that must land. Doing history first means
a full or erroring history table cannot consume the request budget, or throw, before the heartbeat is
recorded — the reverse order would let a broken history table silence the alarm. The history write has
its own try/catch and its own return value, and that value is deliberately NOT folded into what this
function returns: callers ask "was I monitored?", and the answer to that is the heartbeat. It logs at
`console.warn`, not `console.error`, so a missing history table cannot drown the signal that a
HEARTBEAT failed.

## [2026-08-06g] — `shared-modules.json`: nothing checked that you registered

### Added
- **`shared-modules.json`** — the single declaration of what every module owns. Written by whoever
  promotes a module; read by every consumer's CI.
- **`scripts/check-resource-registration.mjs`** — runs in a consumer, works out which web-core
  modules that repo actually imports, and fails if a consumed module's resources are not in its
  `.shared-resources.json`. This closes the remaining hole: the inlining gate enforces *registered*
  resources, but is opt-in and silent without a config, so **nothing checked that you registered**.
  A module promoted without downstream registration passed every gate in the estate.
- **A manifest gate in this repo's own CI** — every module must have an entry, including modules
  that own nothing, which must say so with a `why`. An empty `resources` is a decision; a missing
  entry is an oversight, and if those look the same the manifest rots into a list of what someone
  remembered. This is the ONE gate that belongs here; the consumer-side gates deliberately are not.

### Notes — the rollout measured itself first, and that changed the design
- Arming all 15 modules' resources across 19 repos produced **20 violations. 17 were my own
  `adPlatforms` rule and every one was legitimate**: the cookie-banner component (deliberately
  per-repo — and it is what actually loads the tags), the CSP host lists this module exports
  constants for, and Playwright assertions naming hosts they expect to be absent before consent.
- **`adPlatforms` now declares no resources, with the reasoning recorded.** Its real contract —
  "adding a platform is ONE entry in `AD_PLATFORMS`" — is about where a registry entry goes, not
  who may name a hostname. A gate cannot see that distinction, and a rule firing on 17 correct sites
  is one people would disable. It broke the estate's own tuning rule (match the operation, not the
  name) which had been written down hours earlier — worth recording precisely because the rule was
  already known.
- The 3 real violations that survived are all genuine and now explicit exceptions with reasons: one
  consumer's local `audit.ts` (it is itself a submodule engine, so it cannot resolve `@/web-core/*`),
  another's Deno edge function (cannot import a git submodule at all), and that same repo's
  transactional-send call — a **deliberate** divergence the code already documents, because its
  claim-then-send guarantee depends on retrying only 429s.

## [2026-08-06f] — Registering a resource is now part of promoting a module

### Changed
- **`CLAUDE.md`'s "Adding a new consumer" gains a step 5: register the resources the new module
  owns in that repo's `.shared-resources.json`.** The shim gate matches on FILENAME and is blind to
  the same logic written inline in a normally-named file. `check-shared-module-inlining.mjs` closes
  that, but it is opt-in and **silent without a config** — so an unregistered resource is an
  unguarded one, and the gate will happily report OK over it. Promotion without registration leaves
  the door open that promotion was meant to shut.
- Notes the tuning rule learned building the first one: **match the operation, not just the name.**
  The initial cron-heartbeat rule matched any mention of the table and flagged two legitimate
  readers; the module owned the write.

Docs-only, so not force-propagated — it rides along on the next pointer bump.

## [2026-08-06e] — Shared-module inlining gate: the drift the filename gate cannot see

### Added
- **`scripts/check-shared-module-inlining.mjs`** — flags direct use of a resource a shared module
  owns, anywhere outside that module.

  The existing web-core shim gate matches on **filename**: it catches a stray local `security.ts` or
  `bartmail.ts`. It is structurally blind to how drift actually happens — the logic written *inline*,
  in a file with a perfectly ordinary name. Three repos each grew their own `writeHeartbeat` inside
  `lib/cron.ts`, no file was ever called `cronHeartbeat.ts`, so nothing flagged it; two of the copies
  then diverged on `updated_at` and it went unnoticed for as long as the column was only written and
  never read.

  Content-based, opt-in per repo via `.shared-resources.json`, and **skips silently where that file
  is absent** — so it can be rolled everywhere and a repo that later adds a config picks it up with
  no rollout. An unparseable config fails loudly rather than degrading to "clean".

### Notes
- **The rule matches the WRITE, not the table.** The first version matched any mention of
  `cron_heartbeats` and immediately flagged two legitimate readers — a status dashboard and the
  staleness watcher. Reading is not the drift shape; the module owns the write. Narrowed before
  rollout, on the same principle as the lead-store gate: a check that fires on correct code is one
  people learn to skim past.
- Verified by replaying the pre-consolidation commit in a detached worktree — it flags
  `src/lib/cron.ts:83`, the exact copy the filename gate could not see — and is clean across all
  three consumers afterwards.

## [2026-08-06d] — `cronHeartbeat.ts`: prove a scheduled job is still alive

### Added
- **`writeCronHeartbeat()`** — upserts one row per scheduled job recording its last run time, status
  and a small detail blob. An external watcher alerts when a row goes stale or records a failure.

A job that dies quietly produces NO error to capture, because nothing runs. Per-run error reporting
is structurally blind to it; the only available signal is the absence of an expected write. Seven
scheduled routes across four consumers were found in exactly that state on 2026-08-06 — no way to
tell a healthy job from one that had not run in weeks.

Two deliberate properties:
- **It never throws and never rejects.** A monitoring write that took down the thing it monitors
  would be strictly worse than no monitoring. It returns a boolean for callers that want to log.
- **A missing URL/key logs loudly rather than skipping.** Silently doing nothing would make an
  unmonitored job look identical to a monitored one, which is the failure this file exists to remove.

Generic by construction — a table name, a URL and a key, supplied by the caller from its own env.
No product or business specifics, which is what makes it appropriate here.

## [2026-08-06d] — `cronHeartbeat.ts`: the shared silent-death signal

### Added
- **`cronHeartbeat.ts` — `writeCronHeartbeat()`.** A scheduled job that dies quietly produces no error
  to capture, because nothing runs; per-run error reporting is structurally blind to it. The only
  signal is the **absence** of an expected write. Every scheduled route records a heartbeat and an
  external watcher alerts when a row goes stale or records a failure.
- **Uses raw `fetch` against PostgREST, not `@supabase/supabase-js`.** This repo is framework-agnostic
  source with no runtime dependencies, and two existing local copies each take a Supabase client —
  a shared version that demanded one would drag a dependency into every consumer. Table, URL and key
  are all parameters; there is no product, brand or business logic in the file, which is what makes
  it safe here (golden rule 1, and the public-repo warning at the top of `CLAUDE.md`).
- **Never throws and never rejects.** A monitoring write that took down the thing it monitors is
  strictly worse than no monitoring. It returns a boolean so a caller that wants to log the failure
  can, and ignoring it is the common case. A missing url/key logs loudly rather than skipping
  silently — an unmonitored job must never look identical to a monitored one.

### Fixed
- **`updated_at` is now written explicitly** (found while reviewing the file before its first commit).
  It was absent, and the column's `default now()` fires on INSERT only — so every run after the first,
  being the UPDATE half of the upsert, would have left `updated_at` frozen at row-creation time while
  `last_run_at` advanced. Harmless for the current watcher, which reads `last_run_at`, but quietly
  wrong for anything reading `updated_at`, and it made the shared module a slightly worse replacement
  than the local copies it exists to replace. Both of those set it.

### Notes
- **No consumer imports this yet.** Two local implementations exist and are untouched; migrating them
  is a separate, deliberate change, because a pointer bump redeploys every consumer. Their signatures
  differ from this one (`writeHeartbeat(supabase, jobName, …)` and `writeHeartbeat(jobName, …)` vs
  `writeCronHeartbeat({ url, key, jobName, … })`), so migration is a real edit per call site, not a
  rename.

## [2026-08-06c] — lint: the scripts had no environment declared

### Fixed
- **CI has been red since the CLI scripts landed.** The eslint config declares globals for
  `files: ["*.ts"]`, and in flat config that matches top-level `.ts` files only — not
  `scripts/*.mjs`. So those files were linted with NO environment, and every `process`, `console`,
  `Buffer` and `fetch` in them was a `no-undef` error. Added a config block for `scripts/**` with
  the Node globals.
- **Node globals only, not browser.** These scripts run standalone in consumer CI where there is no
  DOM; including the browser set would let a `window` or `document` reference pass lint and fail at
  runtime, which is the wrong direction for a gate.
- `no-explicit-any` is off for `scripts/**`. That rule protects the repos that import this as a
  typed library; a CLI parsing argv and JSON is a different concern and nothing imports it.

## [2026-08-06b] — a module was added here and reverted the same hour

### Removed
- **A customer-order lookup module was added and immediately removed.** It read order and
  subscription records from two internal systems, and was written around named products, table
  names and specific env vars. **This repo is public.** The hygiene gate rejected it on the very
  first push, which is exactly what that gate exists for.

  The rule it broke is golden rule 1 above, and the public-repo warning at the top of :
  **only generic mechanism belongs here; product-specific logic stays in the consuming repo.** A
  lookup that branches on a particular product and names a particular storefront is not a shared
  primitive. Genericising it would have meant passing every table and identifier in as config, at
  which point it stops being a shared module and becomes an awkward wrapper around one caller.

  The fix was architectural rather than cosmetic: the consumer that needed it was moved to sit
  alongside the private code that already had those credentials, so the lookup never needed to be
  shared at all — and a second private app was able to hand back credentials it had briefly been
  given.

  Worth recording because the reasoning generalises: **"two repos need this" is not on its own a
  reason to promote something here.** Ask first whether the two callers belong in the same place.

## [2026-08-06] — Ordering gate: the primary lead store must be written first

### Added
- **`scripts/check-lead-store-ordering.mjs`** — a dependency-free static gate that rejects a form
  route whose primary contact write sits below an early return or an unguarded third-party await
  in the same handler. Consumers fetch and run it in CI; it is not imported by app code.

  Whichever system a route writes **first** is the only one guaranteed to run. Everything after it
  is conditional on nothing above it ending the request, and a request ends two ways — it returns
  or it throws. So above the primary write the gate rejects a success-shaped return (2xx/3xx,
  `ok: true`, `success: true`, redirect) and an `await` of a secondary system that is not inside a
  nested try/catch closing before the write. Validation guards returning 4xx/5xx are not flagged:
  the request was refused outright, so no lead exists to lose.

  Two live incidents, six days apart, both this shape:
  1. The primary write sat below an ESP's graceful-degrade `return json({...}, { status: 200 })`.
     The ESP was misconfigured and failed on **every** request, so for roughly six weeks every
     signup hit that early return — recorded in no system at all, no notification email, and a
     success screen shown to the visitor. Because the response was a 200, nothing reported it.
  2. The primary write sat below an awaited, individually-unguarded mailbox send. A provider
     outage throws past it to the handler's outer catch, so the request 500s having stored nothing
     that was already fully received and validated.

  In both, the write was present, correctly awaited and correctly try/caught. Only its position
  was wrong — which is precisely what a human reading the diff does not notice, and a machine does.

### Notes
- Deliberate exceptions are annotated inline as `// primary-store-ordering-ok: <reason>`, read from
  the statement's own comment block. **The reason is required** — a bare suppression is "it looked
  fine" with fewer words, which is how both incidents shipped.
- Repos override the primary/secondary call-name patterns with `.lead-store-ordering.json`. The
  shipped `secondary` pattern names *actions* on other systems, never nouns: a broad
  `\w*[Ww]ebhook\w*` was tried first and matched `getWebhookSecretForBrand`, a local secret lookup.
  A gate that cries wolf on config reads is one people learn to skim past.
- **Not wired into this repo's own CI**, per the standing rule that a gate belongs on the repos that
  could drift, never on the canonical source they are measured against.
- Verified against both incidents by running it over the pre-fix commits in a detached worktree: it
  flags both, and is clean across all 20 consumer repos afterwards.

## [2026-08-05c] — Document the two non-obvious consequences of a tag write

### Changed
- **`bartmail.ts` now documents that a tag write can SEND EMAIL, and that the tags it writes make a contact findable but not necessarily reachable.** Comment-only; no behaviour change, no export-surface change.
- **(1) A tag write can send.** Outbox matching is on tag NAME + tenant, **not brand** — so passing a `tags` value equal to the `trigger_tag` of any active sequence anywhere in the tenant enrols the contact and sends within minutes, even under a different brand. Bulk tools should refuse outright rather than trust the caller.
- **(2) Association is not reach.** Everything this writes is a brand-association tag. Audiences can be resolved either by brand or by an explicit pool/segment tag list; where the real send path resolves by pool, a contact holding only these tags is filed correctly and skipped by every send — visible in the admin UI, absent from the audience.
- **Why it is worth a comment in the shared module:** both cost real production time on 2026-08-05, and neither is discoverable from the call site. A caller reading this function sees a contact row and tags appear and reasonably concludes the optin works. One consumer's optin route was correct by that standard for weeks while reaching nobody.
- Docs-only, so **not force-propagated** — 15+ consumer redeploys for a comment is not proportionate. It rides along on the next pointer bump.

## [2026-08-05a] — Add vendored-library audit (the lockfile blind spot)

### Added
- **`scripts/check-vendored-libs.mjs` — audits third-party libraries COPIED into a repo rather than installed.** `npm audit`, Dependabot and Socket all read the lockfile, so a `.min.js` dropped under `public/` during a migration off an older stack is invisible to every one of them — while still shipping to every visitor on every page that loads it. A CVE can land against that exact version and nothing anywhere will say so. This reads the version from the banner comment the distribution ships with and asks OSV.dev whether it has known advisories. No API key, no auth; only a package name and version leave the machine.
- **An unidentifiable bundle FAILS rather than being skipped.** A check that quietly ignores what it does not understand reports success while missing the thing it was written to catch. Small hand-written scripts stay quiet; a large minified blob with no banner does not.
- **Only git-tracked files are in scope.** That is the discriminator between a vendored library (committed — which is exactly why the lockfile tools miss it) and an app's own build artifact (gitignored, rebuilt from source that IS in the lockfile, already covered by `npm audit`). Without it, an app's own bundled output is reported as an unidentifiable library on every run — a permanently red check for a non-issue, which is how a gate stops being read.
- Detection is by CONTENT, not filename. The first version keyed off `jquery*.js` / `*.min.js` and missed an 829 KB vendored bundle named `theme.js` — what a library is called tells you nothing.
- Verified before shipping: correctly flags jQuery 3.4.1 (2 advisories) and Bootstrap 3.3.7 (7), passes jQuery 3.7.1, fails an unidentifiable bundle, and stays silent on ordinary source. Exit 1 on any finding.

## [2026-08-05b] — Add `jsonLd()`: safe serialisation for embedded structured data

### Added
- **`jsonLd.ts` — `jsonLd(data)`, the escaping replacement for `JSON.stringify` inside a `<script type="application/ld+json">` block.** Plain `JSON.stringify` is unsafe there: a `</script>` sequence in any string value terminates the tag early and everything after it parses as markup, turning a generated title or description into script injection. Escaping `<`, `>` and `&` to `\\uXXXX` is inert inside JSON — parsers read the original characters back — so the structured data is equivalent while the breakout is impossible.
- Framework-free and runtime-agnostic (pure string work, no Node built-ins, no React), so it is safe for every consumer including non-Next ones.
- **Why it is here rather than per-repo:** one consumer had solved this correctly and the fix was never propagated, leaving two others on raw `JSON.stringify` — exactly the silent drift this module exists to prevent. Consumers should re-export it from their own `lib/` shim and delete their local copy.

## [2026-08-05] — Notification failures can no longer be silent

Found while auditing every consumer for one class of bug: a notification path that fails and
tells nobody. Three instances lived in this module, so every consuming app inherited them.

### Fixed
- **`bartmailPurchase()` never checked the response and swallowed everything in a bare
  `catch {}`.** A 401 from a drifted signing secret, a 404 from an unknown brand, a 429 or a 500
  were all indistinguishable from success, and produced no output anywhere — not even a log line.
  Because the function could never reject, a `.catch()` around it was dead code that made the drop
  look handled. It now checks `res.ok`, logs a rejection, and **returns `boolean` instead of
  `void`** so callers can react. Additive: existing callers that ignore the result are unaffected.
  This is the treatment `bartmailEvent()` already had, for the reason recorded there — silence is
  what let a write failure run undetected for four days.
- **`bartmailEvent()` returned `false` silently when `CONTACT_EVENTS_SECRET` was absent.** The
  degrade-rather-than-500 behaviour is deliberate and unchanged, but it now warns. Without it an
  app never given the secret records zero timeline events forever, indistinguishable from simply
  having none.
- **`isGraphConfigured()` ignored the mailbox while `sendMail()` throws on it.** An app holding
  credentials but no mailbox passed the check and then threw straight into the caller's catch —
  and every consumer that gates on this swallows that throw by design, so a missing env var meant
  permanently silent notifications. The mailbox is now part of "configured".
- **`GRAPH_MAILBOX` honoured only one of the three env prefixes this estate uses.** It read
  `process.env.GRAPH_MAILBOX` directly while credentials go through a helper accepting `GRAPH_`,
  `MS_GRAPH_` and `MS_`. An app setting `MS_GRAPH_MAILBOX` had an empty mailbox and every send
  threw. It now uses the same helper.## [2026-08-01 — later 2] — Host allowlist no longer names the canonical domain

### Changed
- **`bartmail.ts`'s outbound-URL allowlist now matches the canonical custom host by SHA-256 of
  the hostname instead of a plaintext literal in a regex.** The guard is unchanged in strength —
  still an exact-match allowlist over the same two hosts, with the same fall-back-to-default
  behaviour on any mismatch — but this public source no longer names the internal hostname (the
  one string the post-scrub sweep found remaining, hidden from fixed-string greps by regex
  escaping). Validation moved into a lazy resolver so `node:crypto` stays out of the module
  scope per the header rule; the hash only computes on the non-default path. Also now rejects
  URLs carrying credentials, and accepts an explicit `:443` (previously rejected; same host,
  default port).

## [2026-08-01 — later] — Public-hygiene CI gate

### Added
- **`.github/workflows/public-hygiene.yml`** — on every push to main, scans the whole tree
  against a denylist of terms that must never appear in this public repo. The list itself
  lives in a repo secret (committing it would republish the strings it polices); the job
  fails closed if the secret is unset, and reports offending files by term number only.

## [2026-08-01d] — Add weekly Claude security review CI

### Added
- **`.github/workflows/security-review.yml`** — this repo was previously excluded from the
  wider estate's weekly automated review because it's public and had no `ANTHROPIC_API_KEY`
  secret. Neither reason holds up: this trigger shape is `schedule` + `workflow_dispatch` only,
  never `pull_request`, so it never runs in a fork's context and public-repo secrets
  aren't exposed to non-collaborators regardless. Added the secret and the workflow, with a
  system prompt adapted for a shared auth/validation library consumed via git submodule by many
  sites (fail-open error paths and silent propagation of a vulnerability on the next pointer
  bump are the specific risks reviewed for here, not generic app security).

## [2026-08-01c] — Fix `safeRedirectPath()` backslash open-redirect

### Fixed
- **`safeRedirectPath()` in `security.ts` was prefix-based (`startsWith("/") && !startsWith("//")`)
  and missed backslash normalisation** — browsers turn a leading `\` into `/` before navigating, so
  `/\evil.com` "starts with /" but resolves to the third-party origin `https://evil.com`. Live
  exploit: a consumer's post-payment redirect handler accepts a `next` query param and sends the
  buyer there — a crafted `?next=/\attacker.example` link redirects a paying customer to an
  attacker's domain with a payment reference in the query string after a real payment (the
  sensitive client secret is correctly stripped beforehand, so this is not a charge-capability
  leak, but it defeats the same-site allowlist that redirect handler's own docs describe). Found
  live 2026-08-01.
- **Rewritten to parse-based:** resolves `next` against a fixed fake origin with the WHATWG `URL`
  parser (the same spec browsers implement for navigation) and only accepts the result if it
  resolved to that same origin. This rejects `//evil.com`, `https://evil.com`, every backslash
  variant, and any future normalisation trick the same way — by checking "did the origin change",
  not by pattern-matching a list of known-bad strings. Verified against all four bypasses from the
  finding plus ordinary paths (query strings and hashes both preserved correctly).
- Consumers: any repo importing `safeRedirectPath` picks this up on its next submodule bump.
  The rule "any `next`/`redirect`/`returnTo` param must go through `safeRedirectPath()`" is
  documented in the estate's internal scaffolding, so every login flow built from that scaffold
  inherits the fix automatically.

## [2026-08-01b] — Add `admin.ts` (`isAppAdmin`)

### Added
- **`isAppAdmin(email)` in a new `admin.ts`** — fail-closed check of whether an email is a member of
  the app's own `app_admins` table, via an `is_app_admin()` RPC that is only `service_role`-executable.
  Never throws; every error path (missing env, network failure, RPC error) returns `false`.
- **Why it belongs here rather than being reinvented per app:** three separate internal apps
  independently built the same allow-list-table-plus-SECURITY-DEFINER-function pattern within days
  of each other. Found live 2026-08-01 when one internal dashboard discovered its ONLY gate on a
  set of admin actions that write through a service-role client into a live checkout's own
  database, changing what it charges, was a plain session check with no role check at all —
  despite the app already having a working RLS-based admin role for its own dashboard. That role
  checks nothing for a service-role client, and nothing at all for a different project; there was
  no existing mechanism that could have gated this action correctly, so one had to be built from
  scratch that day.
- Deliberately just the primitive: web-core has no `requireUser()` of its own (framework/session
  mechanism varies per app), so each app composes `isAppAdmin()` with its own session check into a
  local `requireAdmin()`. A reference implementation and the matching migration (`app_admins` table
  + `is_app_admin()` function, RLS on, zero grants to anon/authenticated) exist in the estate's
  internal scaffolding — see the private consumer notes for the exact location.

## [2026-08-01] — Add `isSafePublicHost()`

### Added
- **`isSafePublicHost(host)` in `security.ts`** — validates a hostname before it is used to build an
  OUTBOUND URL (a `fetch` your own server makes, or a link emailed to a customer) when the host comes
  from configuration rather than a literal.
- Rejects empty values, anything smuggling a scheme/credentials/port/path/query, bare IP literals,
  `localhost` / `.local` / `.internal`, and anything without a real dotted public name — including
  `169.254.169.254` and `metadata.google.internal`, the endpoints an SSRF usually aims at.
- **Why it belongs here rather than in one repo:** several consumers build URLs from a DB column or
  env var. One consumer's uptime cron was found fetching a host/slug pair from a config table with
  no validation, and its abandonment cron put the same unvalidated value into a customer-facing
  recovery link. Config is not user input, so this is defence in depth — but the check is a pure
  string predicate with no framework coupling, which is exactly what this module is for.
- Unit-checked against 14 real and hostile values before promotion.

## [2026-07-31] — Document why `server-only` must NOT be added here

### Changed
- **Golden rule 5 added: never add `import "server-only"` to this repo.** A recent estate-wide
  security sweep flagged its absence in `bartmail.ts` as a missing guard and recommended adding it
  here. That would have broken every consuming build: this module is consumed by non-Next code, and
  `server-only` appears in no consumer's `package.json` or lockfile — it resolves in a Next app only
  because Next aliases it internally. `graph.ts` already carried this reasoning inline; it is now a
  stated rule so the next review does not re-propose it.
- The guard belongs one level up, as the first line of each consumer's own shim over this module.
  That was rolled out across the estate the same week.

No code change — `escHtml`, `isSafePathSegment`, `timingSafeTokenEqual` and `isUuid` all already
existed and were what the sweep's downstream fixes consumed.

## [2026-07-31z] — Dependency security: brace-expansion DoS patched

### Fixed
- **`brace-expansion` bumped to the patched 1.1.18 / 5.0.9 lines** (GHSA-mh99-v99m-4gvg,
  GHSA-3jxr-9vmj-r5cp — DoS via unbounded/exponential expansion). Reached transitively through the
  ESLint and build toolchain, so not reachable from a web request, but it was the largest single
  source of `npm audit` highs across the estate.
- **Lockfile-only change — `package.json` is untouched.** The declared ranges (`^1.1.7`, `^5.0.5`)
  already permitted the patched versions, so no override, no dependency bump, and no ESLint major
  was needed. Both patches were published 2026-07-30; Socket and the npm advisory DB still reported
  "no patch available" because their data predates them.
- Rejected during triage: `npm audit fix` (would have pulled unrelated majors into a consumer's
  payments SDK) and an ESLint v10 / eslint-config-next v12 upgrade (the latter a four-major
  *downgrade* against Next 16, and ESLint majors are on deliberate estate-wide hold).

Found in a routine estate security sweep. This repo now reports 0 critical and 0 high.

## [2026-07-31d] — Docs: internal consumer registry reconciled

### Fixed
- Internal documentation of which repos consume this module (kept outside this public repo) had
  drifted from the actual propagation tooling in both directions — a real consumer had been picked
  up by the propagation run before being recorded in the docs, and vice versa on an earlier
  occasion. Reconciled so the two move together in one commit going forward.
- The email-verification module's consumer notes were also brought up to date, verified by
  grepping each consumer for its import path rather than assumed.

Docs only — no module source changed, so no propagate run was needed.

## [2026-07-31c] — `supportKb.ts`: public knowledge-base reader for brand sites

### Added
- **`listPublishedArticles`, `getPublishedArticle`, `searchPublishedArticles`** — the read side of
  the estate's internal support knowledge base, for brand sites to render public help pages. Written
  once here rather than per brand site, which is the whole point of this module.
- **Only `published` rows are ever returned.** A draft is grounding material for AI-drafted replies
  as much as it is public content, so an unpublished article must be unreachable by both.
- **Global articles (`brand_id IS NULL`) are included alongside the brand's own**, so genuinely
  shared answers — shipping, returns, privacy — are written once instead of copied per brand. When
  a brand-specific article and a global one share a slug, the brand's own wins.
- **`searchPublishedArticles` logs every search**, and that is the point rather than a side effect:
  rows with `results_count = 0` are the knowledge-base writing backlog — exactly what customers
  asked for and could not find — surfaced in the internal admin tools that read this table. A
  search box that does not log its misses throws away the single most useful signal a knowledge
  base produces. The insert is awaited (an un-awaited one dies with the response and the row
  vanishes) and is written even when the search itself errored, since a failed search is still an
  unanswered question.
- Uses `websearch_to_tsquery`, which tolerates the quotes and operators people type and never throws
  on malformed input — unlike `to_tsquery`. A search box that 500s on an apostrophe is not a search
  box.

### Security note
These use the internal CDP's **service-role** key via `getBartmailSupabase()` and therefore bypass
RLS. Server Components and route handlers only — never client code, and never behind a public API
route that passes arbitrary caller-supplied filters through.

## [2026-07-31b] — `htmlToText`: table cells and more entities

### Fixed
- **Table cells no longer run together.** `</td>`/`</th>` become `" | "`, so a data table (quote
  line items, order summaries) reads as `Managed IT support | 2 | £299.00` instead of
  `Managed IT support2£299.00`. Reported from a quote-email template, but it affects every
  table-based template across the estate — which is most of them.
- **Layout tables do not gain pipe noise from that change**, which is the part that needed care.
  HTML email uses tables for layout as much as for data, and a single-cell wrapper row would
  otherwise render as `| Your order |`. A cleanup pass after tag-stripping collapses repeated
  separators and removes any left at a line edge — exactly what a layout row produces — then trims
  the leading indentation that removing a separator leaves behind. Verified against both shapes.
- **More entities decoded**: `&rarr;` `&larr;` `&middot;` `&bull;` `&copy;` `&reg;` `&trade;`
  `&times;`. One brand's templates use `&rarr;` and `&middot;`, which previously survived into the
  text part as literal `&rarr;`. `&amp;` is still decoded last, so `&amp;lt;` cannot double-decode
  into a tag.

### Note for consumers
- Purely additive, no call-site changes. Consumers pick it up on their next pointer bump. Both
  fixes were raised during a routine estate-wide propagation and deliberately made here rather than
  forked locally — a local copy is the drift this module exists to prevent.

## [2026-07-31] — Every Emailit send is now multipart/alternative

### Fixed
- **`sendEmailitEmail` now always sends a plain-text part.** `text` stays optional on
  `EmailitSendMessage` for callers' convenience, but omitting it no longer produces an HTML-only
  email — the module derives one from the HTML. HTML-only mail scores worse with every major
  filter, is unreadable in plain-text clients, and is worse for screen readers.
- Derived **here** rather than left to each caller because "optional and usually forgotten" is
  exactly how it went wrong: an audit found the estate had been sending HTML-only mail across its
  entire history. The internal CDP's own sender had no `text` field in its payload at all (every
  broadcast, every sequence, every brand), and of the handful of other callers that plumb `text`
  through, all of them leave it undefined in practice. A default that has to be remembered is not a
  default.

### Added
- **`htmlToText(html)`**, exported. Deliberately not a parser and dependency-free — anything pulled
  in here is carried by every consumer. Strips `script`/`style`, unwraps links as
  `text (url)` so a text-only reader still gets the destination, turns block tags into breaks, and
  decodes the named and numeric entities our templates emit. `&amp;` is decoded **last**, so
  `&amp;lt;` cannot double-decode into a tag.

### Note for consumers
- Purely additive — no call site changes. Consumers pick this up on their next submodule pointer
  bump. Nothing is broken until then; sends are simply still HTML-only.


## [2026-07-31] — Dependency updates (Dependabot #1, #2)

### Changed
- `actions/checkout` v5 → v7 and `actions/setup-node` v5 → v7 in `.github/workflows/ci.yml` (#1).
- `@types/node` 22.20.1 → 26.1.1 and `globals` 16.5.0 → 17.7.0 (#2) — both **devDependencies only**. This package ships TypeScript source with no runtime dependencies, so neither reaches a consumer: repos that mount this as a submodule vendor the `.ts` files and resolve their own `node_modules`. Consumers picking up this pointer get no functional change from this bump.
- Recorded retrospectively during a session wrap; both were merged the day before without an entry, because a squash-merged Dependabot PR touches only manifest and workflow files and nothing forces a changelog entry the way an ordinary commit does.

## [2026-07-30] — emailit.ts: shared transactional SEND transport

### Added
- `emailit.ts` — `sendEmailitEmail(apiKey, msg, opts?)`: the one implementation of "POST an email to Emailit and survive its rate limit". Retries 429/5xx/thrown fetches; treats Emailit's `retry_after` (always 1s) as a **floor under exponential backoff with jitter**, so concurrent callers stop waking simultaneously and re-colliding — the thundering herd that exhausted the internal CDP's retry budget at only 500 sends/day. Never throws; returns `{ok, attempts, status?, body?, transportError?}` so consumers layer their own reporting. Framework-free, fetch-only — no Node imports, so it works in edge/Deno runtimes too.

### Why
- Several call sites across the estate had independently hand-written the same 429 retry after a lost-email incident, and none had jitter — the exact defect just diagnosed in the internal CDP's own sender. One module means the next fix lands everywhere.
- **This is NOT a revival of a previously reverted audience-subscribe module.** That was removed because the internal CDP owns contacts and Emailit is delivery only. This module is delivery only and must never grow an audience/contact operation.
- **Claim-then-send flows must NOT use it** (header comment explains): retrying a thrown fetch is unsafe when the caller marked something "sent" before dispatch — one consumer's quote-send route keeps its own local confirmed-429-only retry deliberately.

## [2026-07-29g] — validation.ts: isOptinHealthSentinel()

### Added
- `isOptinHealthSentinel(email)` — true for the internal CDP's optin-health monitor addresses (a fixed `dom+optin-health-<brand>@…` pattern).

### Why
The monitor POSTs through each brand's **real** optin route on a schedule, which is exactly what makes it worth having. But some of those routes email an internal notification on a new signup, so several fake lead notifications were arriving daily — indistinguishable at a glance from a real one, which is worse than noise because it trains you to ignore the alert.

### Contract
Routes skip the **notification email only**. Never skip the contact write: that is the thing being tested, and short-circuiting it would turn the monitor into a check that proves nothing.

## [2026-07-29f] — emailit.ts REMOVED (added earlier the same day)

### Removed
- `emailit.ts`, added a few hours earlier the same day. It shared the transport for **adding contacts to Emailit audiences** — and that is a banned operation across the estate: **the internal CDP owns contacts; Emailit is delivery transport only.** The rule was already recorded in this repo's own standing documentation; it simply was not enforced, so two consumers were still doing it.
- Adding a retry to a banned operation made it *more reliable* instead of removing it — worse than leaving it broken, since it entrenches the pattern. The right fix was to delete the calls, which is what happened in both consumers the same day.
- No shared helper for audience-subscribe should exist here, because its presence invites the pattern back. One consumer keeps a LOCAL equivalent for now: its purchase-confirmation emails are Emailit automations triggered by a contact-added-to-audience event, so removing the audience add there would stop customers receiving confirmation after a purchase. That needs the confirmations moved to the internal CDP's own sequences first — a migration, not a deletion.

### Kept
- `graph.ts` (added the same week) is unaffected — Microsoft Graph notification email is a transactional send to an internal mailbox, not list management.

## [2026-07-29e] — emailit.ts: shared transport for direct audience calls

### Added
- `emailit.ts` — `emailitPost()`, `subscribeToAudience()`, `subscribeViaToken()`.

### What it shares, and what it deliberately doesn't
Emailit rate-limits at ~2 msg/sec and answers a breach with `429` plus a `retry_after` **in the body, not a header**. Several call sites never inspected the response at all, so a 429 resolved normally, the code carried on, and the subscribe simply never happened — the same silent-drop class that lost a real customer's transactional email a day earlier. The retry, the `retry_after` handling, and the "409 = already subscribed = success" rule now live here.

It is **not** one subscribe function for everyone. The estate genuinely uses two endpoints with different auth — a Bearer-key endpoint for most brands and a public token-based endpoint with no key at all for one brand's waitlist — plus different API versions per brand. Each keeps a thin wrapper; they share the part that actually matters. Merging them would be the flag-riddled function golden rule 1 exists to prevent.

### Out of scope
Broadcast and sequence sends. Those go through the internal CDP's own send-pacing gate using per-brand rate/cap settings. Never route a bulk send through this module, and never hardcode a rate.

## [2026-07-29d] — graph.ts: one Microsoft Graph client, with the retry several routes were missing

### Added
- `graph.ts` — `getGraphToken()`, `sendMail()`, `createDraft()`, `isGraphConfigured()`, `GRAPH_MAILBOX`.

### The problem
Several routes hand-rolled the same OAuth-then-sendMail dance and most had no retry at all. That is the exact failure that lost a customer's transactional email a day earlier — one transient rejection, one dropped message, nothing surfaced. These sends are how an internal notification recipient learns a lead arrived: when one fails there is no bounce, no alert, and the visitor still sees a success screen. Silence is the failure mode, so the retry belongs in the shared module rather than in whichever route remembers it.

### Retry policy (tested before shipping)
- `fetch()` throwing — retried. Graph intermittently resets the TLS socket mid-handshake; a hand-rolled retry helper in one consumer was the only correct handling of this anywhere in the estate, and it is now everyone's.
- `429` and `5xx` — retried, honouring `Retry-After` when present, capped at 10s so a pathological value can't hang a request.
- **Every other 4xx — not retried.** A malformed message or bad credential fails identically the second time.
- Three attempts, 300ms exponential backoff.

### Env vars — all three schemes read
The same Azure app is configured under three different naming schemes across different consumers. The module reads all three in that order rather than standardising them: renaming would mean editing several separate hosting projects for no functional gain, and one missed rename silently kills that brand's notifications.

### Note
No `server-only` import — this module must stay framework-free. Consumers wanting that guard add it in their own shim.

## [2026-07-29c] — reoon.ts: one optin-time email-verification rule

### Added
- `reoon.ts` — `verifyEmail()`, `isBlocked()`, `isConfirmedGood()`, `REOON_BLOCKED_STATUSES`, `REOON_GOOD_STATUSES`. Scope is deliberately narrow: **one address, checked live during a form submission, to decide whether to accept the signup.**

### The bug this fixes
Three separate consumer routes asked that question and gave three different answers — two used a blocklist of `invalid`/`disposable`/`unsafe`; a third used an allowlist of `safe`/`valid` for its ESP subscribe. **Neither of the first two blocked `spamtrap`, so those addresses were accepted outright.** Spamtraps exist to catch senders who don't clean their lists, and one brand was already dealing with a mailbox-provider IP-pool demotion — it was one of the two accepting them. The blocked set is now the union of every rule that was in production: no brand is looser than before, two are correctly stricter. Verified as strictly tightening before shipping — every Reoon status either behaves identically or moves from accepted to blocked, and only `spamtrap` and `unsafe` move.

### Added shortly after
- A `mode` parameter (`quick` | `power`). It is an API depth setting, not a policy knob: `power` probes the mailbox and is the only mode that returns `safe`, which is why one B2B contact route uses it and the high-volume consumer forms use `quick`. Shipped in its own commit without a changelog entry; recorded here during a session wrap audit.

### Deliberate non-changes
- `unknown` still passes. It means Reoon could not decide, which is a verification failure, not evidence of a bad address; treating it as bad throws away real leads on the verifier's bad day.
- Fail-open is preserved exactly — no API key, non-2xx, timeout and malformed responses all return `valid: true`.
- One B2B consumer keeps its stricter ESP gate through `isConfirmedGood()` rather than being flattened into the common rule. Protecting list quality is a stricter question than admitting a form submission.
- **The internal CDP's own bulk-suppression verifier was NOT folded in.** It answers "should we stop emailing an existing contact?" via the bulk API and Reoon's boolean fields. It already blocks spamtraps and deliberately keeps catch-all/unknown/role accounts. Merging the two would be one flag-riddled function serving two policies — golden rule 1.

### Not done here
The wider "consolidate every optin route into one shared handler" idea was **abandoned after inventory**: dozens of routes call the shared optin function, most of them public forms, and they run well beyond a hundred lines with genuinely different jobs (quiz mapping, e-signature, webhook intake, referral codes). One handler for all of them is the monolith golden rule 1 exists to prevent. The real duplication is per-external-system, and this is the first of those. Remaining, measured: dozens of routes hand-roll the 32KB body cap that `validation.ts` already exports, several duplicate the Microsoft Graph OAuth-and-send dance, and several call Emailit directly.

## [2026-07-29b] — bartmail.ts: SSRF guard on the Supabase host

### Added
- `getBartmailSupabase()` now normalises `BARTMAIL_SUPABASE_URL` (trim, strip trailing slashes, lowercase) and then requires it to match `https://<ref>.supabase.co`, throwing otherwise. A service-role key — unrestricted database access — is sent to whatever that env var resolves to, so a tampered or mistyped value must not be able to redirect it.
- Lifted from a consumer whose hand-written REST client was the only one in the estate that had this check. It came to light when that client was folded onto this module the same day and the guard was nearly deleted as "duplicate code" — it wasn't a duplicate, it was the only copy.

### Why normalise before validating
The first attempt validated a raw string and was **backed out before shipping**. It would have thrown on any consumer whose production value merely *looked* different — a trailing slash works perfectly today and fails a strict regex — and the hosting platform does not disclose stored env values, so the live values across every consumer could not be checked first. Shipping an unverifiable hard-fail across every lead path in the estate is precisely the class of mistake that has previously cost several days of lost leads. Normalising first removes the entire realistic false-positive class, leaving only genuinely foreign hosts to throw. Rollout is staged for the same reason: lowest-traffic lead site first (its optin is load-bearing so a failure is loud and immediate), verified with a real submission, then the rest.

### Note
One consumer keeps its own local guard until this has propagated everywhere; it becomes a genuine duplicate at that point and can be dropped.

## [2026-07-29] — bartmail.ts: `bartmailEvent` — contact timeline events for every repo

### Added
- `bartmailEvent(params)` — posts a non-email touchpoint to the internal CDP's contact-events endpoint (HMAC-SHA256 over the body with a shared secret, same scheme as `bartmailPurchase`). Plus `BARTMAIL_EVENT_TYPES` and the `BartmailEventType` union, mirroring the route's fixed vocabulary.
- Why: the contact-events table shipped with exactly ONE producer — a payments-side edge function that hand-rolls WebCrypto signing because that runtime can't import this module. Every other repo in the estate had no path to the contact timeline at all, so the CDP could only ever show activity from that one source. This is that path.
- Returns `boolean`, never throws and never rejects: a timeline write must not be able to break the lead capture or checkout it hangs off. Callers still `await` it — an un-awaited promise dies when the serverless platform freezes the isolate on response, which is precisely the fire-and-forget failure mode that hid a multi-day optin outage previously.
- A missing signing secret is a no-op returning `false`, not a throw, so a repo that hasn't been given the secret degrades to "no timeline" rather than 500s on every form. Same env var name as the route and the edge function — deliberately no second alias.
- `node:crypto` is imported lazily inside the function, matching `bartmailPurchase`. The optin path must stay free of it (see the module header) — do not hoist.

### Changed
- `ALLOWED_BARTMAIL` now also permits the CDP's canonical custom domain alongside its default hosting domain. Both hosts serve the same deployment; previously a consumer setting the URL env var to the custom domain was silently rewritten to the default host, which worked but made the env var a lie. The allowlist (rather than a shape check) stays — it is the SSRF guard on where signed bodies may be sent.

## [2026-07-25h] — charts.ts: shared chart presentation for internal dashboards

### Added
- `charts.ts` — `SERIES_COLORS` (the slate→blue ramp lifted from one internal dashboard's existing chart palette, the estate's only chart palette in real production use at the time), `SIGNAL_COLORS`, `CHART_GRID`, `CHART_AXIS`, plus `asChartNumber`, `compactNumber`, `chartCurrency`, `chartPercent`.
- `asChartNumber` exists because recharts 3 widened its Tooltip/axis formatter value to `ValueType`, so a `(v: number) => …` callback no longer type-checks. Narrowing beats casting: a cast would silently hide a genuinely non-numeric series. Non-numeric returns `null`, so formatters render an em dash instead of NaN.

### Why only the constants, not a ChartCard
One internal dashboard already defined its own chart-card wrapper **three times** across different views, and two of them had already drifted — two wrap a shared UI-library card, one hand-rolls a `div`, and all three pick a different fixed height. So the duplication is real. But the card shell is ~15 lines of JSX coupled to each app's own card primitive and spacing, and this repo is deliberately React-free (same reason the cookie banner stays per-repo). The parts that actually drift and matter are the colours and formatting — those are here. Charts are for INTERNAL dashboards only; brand marketing sites follow their own per-brand palettes.

## [2026-07-25k] — docs: record a submodule-less consumer pattern

### Changed
- Internal documentation (kept outside this public repo) records a consumer that mounts web-core *without* its own submodule — it imports `@/web-core/*` through its host's path alias, because it is itself a submodule and nesting would compound a known stale-cache bug in its hosts.

Docs only, no code change. Logged because the change was pushed as its own commit and the changelog rule has no size exemption.

## [2026-07-25j] — validation: export `EMAIL_RE` / `UUID_RE`

### Added
- `validation.ts` — `EMAIL_RE` and `UUID_RE` are now exported. Purely additive; no existing export changed. The doc comment steers new code to `isValidEmail`/`isUuid` instead, since those also narrow the type and reject non-strings.

### Why
A shared engine repo tests these patterns directly in several route handlers rather than going through the guards. Exporting them lets that repo drop its own duplicate `validation.ts` — whose regexes were already byte-identical to these — and consume this module instead. Adding an export was the least invasive option: the alternative was rewriting those call sites, which changes behaviour rather than just wiring.

## [2026-07-25i] — bartmail: the optin path no longer pulls in `node:crypto`

### Changed
- `bartmail.ts` — `node:crypto` is no longer imported at module scope. It is imported lazily **inside** `bartmailPurchase`, the only function that uses it (HMAC-signing the purchase webhook body), and only when the signing secret is actually set. The header and the call site both carry a "do not hoist this back" note.

### Why
Importing this module dragged `node:crypto` into the graph for every consumer, even though almost all of them only ever call `bartmailOptin`. That module-scope import was one of **two** blockers stopping a shared engine repo from consuming this module: it deliberately carried a hand-maintained partial copy of `bartmailOptin` in order to stay free of `node:crypto`, and that copy silently missed every fix made here to suppression and consent handling. This removes that blocker.

The second blocker still stands — that engine repo is itself a submodule of more than one brand site, so consuming web-core there would mean nested submodules, compounding the empty-worktree/stale-cache bug those hosts already carry workarounds for. Folding it in is therefore still a separate decision, not an automatic follow-on.

Behaviour is unchanged. With no signing secret the signature was `undefined` before and is `undefined` now, and the import never executes. `tsc --noEmit` and `eslint` both stay clean.

## [2026-07-25h] — adPlatforms: document that the `next.config.ts` import works

### Changed
- `adPlatforms.ts` — the `AD_CSP_HOSTS` doc block now shows the exact `next.config.ts` import line and states plainly that a relative `.ts` import from `next.config.ts` **works**, so the hostnames must never be copied inline again.

### Why
Two consumer repos replaced the import with hand-copied host lists, on the belief that Next's `next-config-ts` loader emits relative imports as bare `require()` calls that cannot resolve a `.ts` file. That is not true on the Next version in use — the loader bundles them. Every other consumer had been importing this module from `next.config.ts` in production the entire time. Re-verified on both with a full `npm run build` **and** a served `content-security-policy` header check before reverting them to the import.

That second hand-maintained copy is not a cosmetic issue: it is the exact mechanism by which a third-party ad host reached live headers on some sites and not others. The rule is now written where the data lives — if an import ever genuinely fails to resolve, fix the resolution; never fork the list.

## [2026-07-25g] — Dependabot for the dev toolchain

### Added
- `.github/dependabot.yml` — grouped monthly npm + github-actions updates (limit 5 each), matching the estate baseline. This repo ships no runtime dependencies; the npm block covers only the dev-only toolchain that lets web-core check itself. Without it that toolchain would silently rot, which matters more here than in a normal app — a stale checker on the estate's shared module is a blind spot everywhere it's used at once.
- Same major holds as the rest of the estate (`typescript`, `eslint`, `@eslint/*`), though for a slightly different reason: web-core deliberately does not use `eslint-config-next`, so the `eslint-plugin-react` breakage does not apply — but it uses `typescript-eslint` directly, and that is the package that hard-refuses TS 7.
- No deploy config needed: this repo has no Vercel project (it is a submodule library, not a deployable app), so Dependabot branches cannot trigger a preview build.

## [2026-07-25f] — web-core gets its own lint + typecheck CI

### Added
- `.github/workflows/ci.yml` — one job running `npm ci` → `npm run lint` → `npm run typecheck` on push and PR (`if: always()` on typecheck so a lint failure never hides a type error). This repo is public, so its Actions minutes are free.
- `tsconfig.json` (noEmit, `strict`, `noUnusedLocals`/`noUnusedParameters`) and `eslint.config.mjs` (plain `typescript-eslint`, deliberately NOT `eslint-config-next` — this library ships no React). `@typescript-eslint/no-explicit-any` is an **error** here rather than a warning: an implicit any in a module consumed by many repos becomes an untyped value in all of them.
- Dev-only devDependencies + `lint`/`typecheck` scripts. Consumers never install these; `node_modules/` stays gitignored, so the submodule checkout remains source-only.

### Why
Until now web-core was linted only as a **side effect** of being vendored into consuming repos. A lint error introduced here reddened every consuming build at once, against files none of those repos is permitted to edit — a fix made in a consumer copy is discarded on the next submodule pointer bump. The gate now sits where the source lives, and consumers exclude their vendored web-core path from their own lint. Both checks passed clean on the first run across all 2,220 lines, so the gate ships strict with no baseline.

## [2026-07-25e] — consent.ts: consent travels across a brand's subdomains (cookie-backed)

### Changed
- **The consent record now lives in a cookie scoped to the registrable domain**, with `localStorage` kept as a mirror. `localStorage` is per-origin, so a buyer who accepted on a brand's main site was invisible to that brand's checkout subdomain and got a **second banner mid-purchase** — friction at the worst possible moment, and a re-prompt caused by blindness rather than by law. A `Domain=.<brand>.com` cookie is readable by both, same controller and same site, so the choice carries lawfully and the checkout shows no banner at all.
- **Domain resolved by attempt-and-verify, not by parsing.** Stripping the first label gets a checkout subdomain back to its parent domain right but turns a `.co.uk`-style domain into the public suffix `co.uk`, which browsers reject. Instead each candidate is written and read back, keeping the broadest that actually sticks — no public-suffix list, no per-app config, correct on apex domains, `.co.uk`, subdomains, IP literals and `localhost`.
- Cookie attributes: `SameSite=Lax` (must survive a top-level navigation from an ad click or an email — `Strict` would break exactly the visitor we care about), `Secure` off-localhost, `Path=/`, 12-month `Max-Age`, and deliberately **not** `HttpOnly` — the banner and the head snippet are client-side and must read it, and nothing secret is stored (it is the visitor's own choice).
- `CONSENT_MODE_HEAD_SNIPPET` now reads the **cookie first**, falling back to the mirror. This is the point of the change: on a checkout subdomain the cookie is the only place the grant exists, and replaying it before `wait_for_update` expires is what stops the first checkout pageview — the conversion event itself — being *modelled* instead of *measured*.

### Fixed
- `clearConsent()` now calls `deleteConsentCookieEverywhere()` **before** touching the mirror. It previously cleared `localStorage` only, which — once the cookie became the source of truth — would have left a visitor who clicked **Reject all** still consented, on every sibling subdomain, invisibly from the host that "cleared" it. The module's own comments already called this out as the worst failure it could have; the deletion helper existed but was never wired up.

### Notes
- **Does not carry to a shared, multi-tenant checkout domain that isn't a brand's own subdomain** — a different registrable domain from any brand site, so consent cannot and must not travel there. That host still shows a banner. A shared checkout app resolves tenants by host, so behaviour differs between a brand's own checkout subdomain and the generic shared domain by design.
- `onConsentChange` still does not fire across subdomains (`storage` is origin-scoped and never fires for cookie writes). The consent itself travels; a live in-page callback in an already-open tab on another subdomain does not. Documented on the export rather than papered over — Consent Mode's own signal is what actually gates Google there.
- Cookies are blocked more often than `localStorage`, so every cookie path fails soft to the mirror and no storage failure can break a banner.

## [2026-07-25d] — adPlatforms.ts: add ad.doubleclick.net to the Google Ads CSP hosts

### Fixed
- `AD_PLATFORMS.google_ads.csp` now allowlists `https://ad.doubleclick.net` in **both** `connectSrc` and `imgSrc`. The Google Ads tag posts cross-domain conversion measurement to `https://ad.doubleclick.net/ccm/s/collect`, which is a different host from `googleads.g.doubleclick.net` and appears in no vendor doc. Caught in a real browser while wiring the first consumer, a local production build: `Refused to connect to 'https://ad.doubleclick.net/ccm/s/collect…'`.
- **Why it survives a casual test:** the call only fires once the `_gcl_au` linker cookie exists, so a clean-profile first load passes and a returning visitor gets the violation. `tsc`, the build and `curl -I` all stay green either way — this is only ever visible in a browser console, which is exactly the failure mode the `imgSrc` comment in this file warns about.
- Confirmed working in the same session with the host added: `googleads.g.doubleclick.net/pagead/viewthroughconversion`, `www.google.com/ccm/collect`, `www.google.com/rmkt/collect` and the `pagead/1p-user-list` remarketing beacon on **both** `www.google.com` and `www.google.co.uk` all fire un-blocked, as does Meta's `facebook.com/tr` PageView.

## [2026-07-25c] — consent.ts: CONSENT_MODE_HEAD_SNIPPET (the head-first ordering guarantee)

### Added
- `CONSENT_MODE_HEAD_SNIPPET` — the same Consent Mode v2 default as `initConsentMode()`, as a raw inline script string for the root layout's `<head>`, plus a replay of any stored choice. The storage key and version are interpolated from `CONSENT_STORAGE_KEY`/`CONSENT_VERSION`, so the snippet cannot drift from `readConsent()` — which is the whole point of it living here instead of being hand-copied into every consumer's root layout.
- **Why a string and not just the function:** `initConsentMode()` is module code and cannot run until the client bundle parses and the tree mounts. That is early enough only while every Google/Meta tag on the page is client-injected and consent-gated; the moment one `<Script src="…gtag/js">` is rendered server-side the ordering silently inverts, Google discards the late `default`, and remarketing audiences stop building — with no error anywhere. Emitting the default as a parser-blocking inline script makes the ordering a property of the HTML, which is the only version that can actually be verified. Consumers still call `initConsentMode()` on mount (idempotent): the snippet covers the pre-hydration window, the call covers everything after it.
- **Do not substitute `next/script` `strategy="beforeInteractive"`** for this. In the App Router an inline `beforeInteractive` script is not emitted as a `<script>` at all — Next wraps the body in `(self.__next_s=…).push(…)` and replays it from its own runtime, so what reaches the HTML is a queue entry rather than an executed consent default (verified against Next's own client script handling). Documented in the export's doc comment so it isn't "simplified" back later.

### Notes
- Purely additive; the export surface is unchanged for existing consumers.

## [2026-07-25b] — Add consent.ts (Consent Mode v2) + adPlatforms.ts (ad/remarketing registry)

### Added
- `consent.ts` — `ConsentCategory` (`necessary`/`analytics`/`marketing`), `ConsentState`, `ConsentChoice`, `ConsentListener`, `CONSENT_VERSION`, `CONSENT_STORAGE_KEY`, `LEGACY_CONSENT_KEYS`, `readConsent`, `writeConsent`, `hasConsent`, `onConsentChange`, `initConsentMode`, `updateConsentMode`, `grantAll`, `denyAll`, `clearConsent`. Encodes UK PECR/GDPR: advertising consent is a **separate opt-in** from analytics, nothing but strictly-necessary may fire before a choice, and rejecting must be as easy as accepting (ICO equal prominence — the banner UI's job, but documented here). State is versioned + timestamped, so a policy change re-prompts; a stale-version or corrupt record reads as "no choice", never as a grant. `onConsentChange` fires across tabs via the `storage` event (a withdrawal in one tab must stop tracking in the others). Every export is SSR-safe.
- **Google Consent Mode v2** in `consent.ts` — `initConsentMode()` pushes `default` with `ad_storage`/`ad_user_data`/`ad_personalization`/`analytics_storage` all `denied` plus `wait_for_update: 500`, `ads_data_redaction` and `url_passthrough`, then replays any stored choice inside the wait window. **Must run before any gtag/ads script loads** — Google ignores a late `default` and there is no error when you get it wrong. This is what makes remarketing *work*, not compliance overhead: without Consent Mode v2, Google will not build remarketing/Customer Match audiences from UK/EEA traffic at all and conversion modelling is off — less data than running it denied.
- `adPlatforms.ts` — `AdPlatform`/`AdPlatformCsp`/`AdPlatformConfig`, `AD_PLATFORMS` (`google_ads`: gtag `AW-` config + `conversion_linker`; `meta`: fbq init + PageView), `AD_CSP_HOSTS`, `ANALYTICS_CSP_HOSTS`, `loadAdPlatforms`, `eligibleAdPlatforms`. **Adding a future ad platform is one entry in the registry** — the banner, CSP builder and loader all read `AD_PLATFORMS` — with a commented TikTok/LinkedIn/Reddit skeleton in place. Each platform declares its consent gate, per-directive CSP hosts, an `idPattern` (defence in depth: a malformed env value is never interpolated into a script URL) and an idempotent `load(id)`. `loadAdPlatforms` no-ops on the server, on a null/unconsented state, on an unknown key and on a repeat call — a double `fbq` init double-counts every PageView.
- `AD_CSP_HOSTS`/`ANALYTICS_CSP_HOSTS` are split into `scriptSrc`/`connectSrc`/**`imgSrc`** so a consumer builds its whole CSP from these constants instead of hand-maintaining hostnames. `imgSrc` is the usual omission: Meta's `tr?id=` beacon and Google's `ga-audiences`/conversion pings are `<img>` loads, so allowlisting only script/connect leaves the tag "working" with an audience that never fills. Carries the GA4 wildcard fix from earlier that day plus a subtle host-naming trap (`region1.google-analytics.com` vs `region1.analytics.google.com`) that cost several sites their GA4 data until diagnosed.
- **No tag IDs and no React in either file** — this repo is public and framework-agnostic. IDs come from the consuming app's env vars; the cookie-banner component stays per-repo (brand styling differs).

### Notes
- `CONSENT_STORAGE_KEY` is `cookie_consent_v2`. The old binary keys are **deliberately not migrated**: that banner offered analytics cookies only, so reading it to auto-grant `marketing` would be unlawful — analytics-only consent cannot be silently upgraded to advertising consent. Existing visitors must re-consent; `clearConsent()` deletes the legacy keys but nothing ever reads them as a grant.
- Neither module `declare global`s `gtag`/`fbq` — several consumers already do, and a second augmentation with a different signature is a hard TS error. Both use a local structural type + one cast.
- No consumer wired up yet (additive; the export surface is unchanged for existing consumers). Type-checked against the estate's internal scaffold repo (`tsc --noEmit`, clean) plus a runtime smoke test of the consent/injection paths.

## [2026-07-25] — Add uploads.ts (magic-byte upload validation) + audit.ts (privileged-action audit log)

### Added
- `uploads.ts` — `UPLOAD_LIMITS` (image/document/avatar/video size ceilings), `IMAGE_MIME_TYPES`, `DOCUMENT_MIME_TYPES`, `sniffMimeType`, `safeUploadFilename`, `validateUpload`. Encodes the rule that a route must NEVER trust `file.type` or the filename extension — both are attacker-controlled — and must decide from the magic bytes (JPEG/PNG/GIF/WebP/AVIF/PDF/ZIP; unrecognised = reject). `safeUploadFilename` is the path-traversal guard for storage keys (strips directory components + leading dots, collapses to `[a-zA-Z0-9._-]`, caps at 100 chars preserving the extension). `validateUpload` never throws — size → sniff → allowlist → extension, returning `{ok:false,error,status}` (413/415) instead. One reconciliation is permitted: docx/xlsx are ZIP containers, so a genuine one sniffs as `application/zip` and is accepted only when the declared type is that exact OOXML type AND it is on the route's allowlist. Typed against the web-standard `File` so web-core stays framework-agnostic.
- `audit.ts` — `AUDIT_ACTIONS` (stable `domain.verb` slugs), `AuditAction` (the slug union, widened with `(string & {})` so apps can add their own), `writeAuditLog`, `requestAuditContext`. Appends one row per privileged action (deletion, role change, refund, export, admin action) to the app's own Supabase `audit_log` table via `SUPABASE_URL`/`NEXT_PUBLIC_SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` (the key has no public fallback), client built lazily per call. **Never throws** — an audit-write failure must not break the action being audited; it logs `err.message` only, and no-ops with a `console.warn` when the env vars are absent. **Must be awaited** by callers: an un-awaited call is killed the moment a serverless function returns, so the row silently vanishes — the exact failure this module exists to prevent. `metadata` is for small non-sensitive context only, never secrets, tokens or full request bodies.
- No consumer wired up yet (both modules are additive; the export surface is unchanged for existing consumers).

## [2026-07-19] — bartmail.ts: export the client factory (getBartmailSupabase / getBartmailClient)

### Added
- Exported the internal CDP's Supabase client factory as `getBartmailSupabase`, plus a `getBartmailClient` alias — so consumers needing the raw client for other server-side work (one personal-brand site's durable rate limiter) can adopt the shared module. Unblocks folding that site's own bartmail.ts into this one.

## [2026-07-19] — validation.ts: add parse-with-cap dialect (superset for a checkout consumer)

### Added
- `readBodyWithSizeLimit<T>(req)` — reads, caps, AND JSON-parses to a typed body with `{error,status}` returns. Distinct from `readBodyWithCap` (raw text + bool, for HMAC-over-raw-body routes) — both are legitimate, kept as separate primitives.
- `checkFieldLengths(body, limits)` — the `{error,status}`-returning sibling of `fieldLengthError` (string-returning). `checkBodySize(req)` (deprecated header check). `DEFAULT_MAX_LENGTHS` (common field-length map).
- All typed against the web-standard `Request` (a Next `NextRequest` is a valid `Request`) so web-core stays framework-agnostic. Union of one checkout consumer's validation dialect with the existing one so that consumer can fold its own `validation.ts`.

## [2026-07-19] — bartmail.ts: add applyOptinTags (consent) + custom_fields (superset)

### Added
- `applyOptinTags?: boolean` (default **true**) to `BartmailOptinParams` — when false, `bartmailOptin` stores the contact but SKIPS the default `${brand}-optin`/`${brand}-${form_type}` tags and does NOT clear brand suppression (for a form whose opt-in checkbox was left unticked — the visitor did not consent to marketing). Default true = byte-identical behaviour for existing consumers.
- `custom_fields?: Record<string,string>` — stored on insert, merged (not overwritten) on re-optin. Ported verbatim from a production consumer's existing implementation.

### Why
- A checkout consumer and a personal-brand site both carried this consent capability locally, blocking them from adopting the shared module. Adding it (backwards-compatible) makes the canonical a true superset so both can fold. The internal CDP's contacts table already has a `custom_fields` column.

## [2026-07-19] — security.ts: add isTestModeToken (superset for a checkout consumer)

### Added
- `isTestModeToken(token)` to `security.ts` — a Stripe TEST-mode gate (constant-time compares a shared test token), restoring the one export a checkout consumer's original `security.ts` had that web-core lacked. web-core is now a true superset of that repo's origin security module (it was already safer on `escHtml` [+`'`] and `timingSafeTokenEqual` [null/undefined + try/catch]), so that consumer can adopt the shared module without losing anything. Returns false when the test token env var is unset — inert in every other consumer.

## [2026-07-19] — Add bartmail.ts (canonical BartMail lead-write path)

### Added
- `bartmail.ts` — `bartmailOptin`, `bartmailPurchase`, `bartmailVerify`, copied verbatim from a long-standing canonical implementation on one personal-development brand's site (verified brand-agnostic — brand is a caller parameter, no hardcoded values). Imports `@supabase/supabase-js` (resolved from each consumer's node_modules; web-core stays dependency-free). Carries the SSRF allowlist on the CDP URL env var. Node-runtime only. Consumers whose local `bartmailOptin` was verified byte-identical shim to this. **Deliberately NOT folded:** a corporate site (bespoke REST variant with its own health-ping helper), one internal dashboard (a small read-only client factory), and a shared engine repo's own copy (private submodule) — different shapes/purposes.

## [2026-07-19] — Add validation.ts (shared request-validation guards)

### Added
- `validation.ts` — `MAX_BODY_BYTES`/`BODY_BYTE_CAP` (32 KB), `readBodyWithCap`, `exceedsBodyCap`, `isValidEmail`, `isUuid`, `fieldLengthError`. Union of two per-repo copies that used the same underlying byte-length check with no divergent semantics. Per-form field-length maps stay local to each route. Two brand sites' local `validation.ts` became re-export shims onto this module.

## [2026-07-18] — Initial scaffold + security.ts pilot

### Added
- Repo created as the estate's shared web-helper submodule (`@barttech/web-core`), mirroring an existing private-submodule pattern already in use elsewhere in the estate. Source-only, no build.
- `security.ts` — canonical security primitives (`escHtml` [full superset: `& < > " '`], `timingSafeTokenEqual` [length-guard + try/catch, accepts null/undefined], `verifyHmacSignature`, `isSafePathSegment`, `safeRedirectPath`, `isHoneypotTripped`). Consolidated from a checkout consumer's own `security.ts` and the other per-site copies.
- Pilot consumers: two brand sites, each mounting the submodule at a different path depending on their own `@/*` alias convention. Each site's local `lib/security.ts` now re-exports this module; one additionally keeps its own brand-specific upsell-token helpers locally.
