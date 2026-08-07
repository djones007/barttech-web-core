// ---------------------------------------------------------------------------
// Shared Next.js redirect rules that every estate site must carry.
//
// Imported by each repo's `next.config.ts` **by relative path** (`./web-core/…`
// or `./src/web-core/…`), the same way `adPlatforms`' CSP host lists are — the
// Next config loader does not resolve tsconfig path aliases.
//
// Why this exists at all: on 2026-08-07 FIVE live customer-facing sites were
// found serving internal documentation — a-client-site.example/CLAUDE.md,
// a-client-site.example/logos/CLAUDE.md, a-client-site.example/images/CLAUDE.md and
// /logos/CLAUDE.md, a-client-site.example/images/blog/CLAUDE.md — every one returning
// HTTP 200 with `Content-Type: text/markdown`.
//
// It was nobody's mistake. It is STRUCTURAL: the estate's folder-documentation
// convention says every folder gets a CLAUDE.md, and `public/` is web-served.
// Those two rules are in direct conflict, so it will keep recurring for as long
// as both hold. Hence a shared rule rather than five separate fixes.
// ---------------------------------------------------------------------------

export interface NextRedirect {
  source: string;
  destination: string;
  permanent: boolean;
}

/**
 * Redirects that must be present on every site.
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
    // Any markdown under public/. Covers nested paths (`/images/blog/CLAUDE.md`)
    // and, deliberately, files nobody has written yet — a rule, not a list of
    // the five that happened to exist when this was written.
    //
    // Nothing in the estate legitimately serves markdown: blog posts are read
    // from `content/posts/` at build/request time and rendered as HTML, never
    // fetched as .md by a browser. If a site ever genuinely needs to, serve it
    // from a route handler with an explicit content type rather than loosening
    // this.
    source: "/:path*.md",
    destination: "/",
    permanent: false,
  },
];
