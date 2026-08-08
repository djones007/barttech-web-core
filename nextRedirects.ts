// ---------------------------------------------------------------------------
// Shared Next.js redirect rules that every consuming site carries.
//
// Imported by each repo's `next.config.ts` **by relative path** (`./web-core/…`
// or `./src/web-core/…`), the same way `adPlatforms`' CSP host lists are — the
// Next config loader does not resolve tsconfig path aliases.
//
// Why this exists: a Next.js `public/` directory is served verbatim at the web
// root, so any file placed there is published, including files put there by a
// convention that never considered the web. Where a repo convention writes
// documentation into directories that are also web-served, the two rules are in
// direct conflict and the conflict recurs — so the fix belongs in one shared
// rule rather than in each repo that trips over it.
// ---------------------------------------------------------------------------

export interface NextRedirect {
  source: string;
  destination: string;
  permanent: boolean;
}

/**
 * Redirects that must be present on every consuming site.
 *
 * A REDIRECT, not a header, and the distinction matters: Next checks redirects
 * BEFORE the filesystem, so this intercepts the static file. A header would be
 * attached to the response and the bytes would still be served.
 *
 * Spread it into `redirects()`:
 *
 * ```ts
 * import { SHARED_REDIRECTS } from "./src/web-core/nextRedirects";
 *
 * async redirects() {
 *   return [...SHARED_REDIRECTS, ...yourOwnRules];
 * }
 * ```
 *
 * `permanent: false` throughout. A 308 is cached hard by browsers and CDNs, and
 * these are safety rules that may need to change — a permanent redirect on a
 * path someone later wants to serve legitimately is very hard to take back.
 */
export const SHARED_REDIRECTS: NextRedirect[] = [
  {
    // Any markdown under public/. Covers nested paths and, deliberately, files
    // nobody has written yet — a rule, not a list of the ones that happen to
    // exist today.
    //
    // A consuming site should not be serving markdown to a browser at all:
    // content is rendered to HTML at build or request time, never fetched as
    // .md by the client. If a site ever genuinely needs to, serve it from a
    // route handler with an explicit content type rather than loosening this.
    source: "/:path*.md",
    destination: "/",
    permanent: false,
  },
];
