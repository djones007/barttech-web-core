/**
 * bugReport.ts — the server half of a staff "Report a bug" button (the button itself is a React
 * component and lives in the shared app-shell UI repo, not here: golden rule 6).
 *
 * The flow it serves: a signed-in staff user clicks the bug icon, the browser freezes a picture of
 * the page and the context needed to reproduce it (URL, route, viewport, recent errors, the last few
 * clicks and navigations, a Sentry event id), the user types what went wrong, and the app's own
 * route posts it here. From here it goes to a central issue tracker, which stores the pictures in a
 * private bucket and opens an issue that an automated fixer can reproduce.
 *
 * What this module owns:
 *   - `cleanBugReport`: allow-list + bound everything the browser sent. A report route is reachable
 *     by any signed-in user and whatever a client adds that we did not ask for never reaches the row.
 *   - `bugReportToIssue`: the one mapping from a cleaned report to issue-tracker fields (title,
 *     actual/expected behaviour, numbered steps to reproduce built from the breadcrumbs, a context
 *     block), so every app files issues that read the same.
 *   - `forwardBugReport`: post a cleaned report plus its pictures to the tracker's token-gated ingest
 *     (`POST <base>/api/bug-reports/ingest`). NEVER THROWS, same stance as ccNotify.ts.
 *
 * What it deliberately does NOT own: auth (the consumer's route checks the session and decides who is
 * staff), image re-encoding (the receiver does it with its own `sharp`), storage, and the tracker's
 * table. No hostnames, repo names or tokens here: the base URL and token come from the consumer's env.
 */

import { cleanClientBasics, cleanPlainText, type ClientBasics } from "./problemReport";
import { isSafeOutboundUrl } from "./security";

export const BUG_REPORT_MAX_BREADCRUMBS = 25;
export const BUG_REPORT_MAX_IMAGES = 3; // the automatic page picture + up to two of the user's own
export const BUG_REPORT_IMAGE_MAX_BYTES = 4 * 1024 * 1024;
export const BUG_REPORT_IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp"] as const;

export type BugBreadcrumb = { at: number | null; kind: "click" | "nav" | "error"; detail: string };

export type BugReport = {
  description: string;
  expected: string;
  url: string;
  path: string;
  pageTitle: string;
  basics: ClientBasics;
  breadcrumbs: BugBreadcrumb[];
  /** Milliseconds since the page loaded, when the button was clicked. */
  capturedAt: number | null;
  screenshotIncluded: boolean;
};

export type CleanResult = { ok: true; report: BugReport } | { ok: false; error: string };

const obj = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

/** A URL is kept only if it is http(s); query strings are dropped (they can carry tokens or PII). */
function cleanUrl(v: unknown): string {
  if (typeof v !== "string") return "";
  try {
    const u = new URL(v);
    if (u.protocol !== "https:" && u.protocol !== "http:") return "";
    return `${u.origin}${u.pathname}`.slice(0, 500);
  } catch {
    return "";
  }
}

function cleanPath(v: unknown): string {
  const s = cleanPlainText(v, 300);
  return s.startsWith("/") ? s.split("?")[0] : "";
}

export function cleanBugReport(raw: unknown): CleanResult {
  const r = obj(raw);
  const description = cleanPlainText(r.description, 2000);
  if (description.length < 3) return { ok: false, error: "description_required" };
  const crumbs = Array.isArray(r.breadcrumbs) ? r.breadcrumbs.slice(-BUG_REPORT_MAX_BREADCRUMBS) : [];
  const breadcrumbs: BugBreadcrumb[] = crumbs
    .map((c) => {
      const o = obj(c);
      const kind = o.kind === "click" || o.kind === "nav" || o.kind === "error" ? o.kind : null;
      const at = typeof o.at === "number" && Number.isFinite(o.at) && o.at >= 0 ? Math.round(o.at) : null;
      const detail = cleanPlainText(o.detail, 200);
      return kind && detail ? { at, kind, detail } : null;
    })
    .filter((c): c is BugBreadcrumb => c !== null);
  const url = cleanUrl(r.url);
  return {
    ok: true,
    report: {
      description,
      expected: cleanPlainText(r.expected, 1000),
      url,
      path: cleanPath(r.path) || (url ? new URL(url).pathname : ""),
      pageTitle: cleanPlainText(r.pageTitle, 200),
      basics: cleanClientBasics(r.context),
      breadcrumbs,
      capturedAt: typeof r.capturedAt === "number" && Number.isFinite(r.capturedAt) && r.capturedAt >= 0 ? Math.round(r.capturedAt) : null,
      screenshotIncluded: r.screenshotIncluded === true,
    },
  };
}

export type BugReportMeta = {
  /** The reporting app's repo name, as the tracker knows it. */
  repo: string;
  /** Who clicked the button (an email or a display name). */
  reporter: string | null;
  /** The deployed commit, when known. */
  appVersion?: string | null;
  /** Coarse browser family (problemReport.browserFamily), never the user-agent string. */
  browser?: string | null;
};

export type BugIssueFields = {
  title: string;
  description: string;
  area: string | null;
  actual_behavior: string;
  expected_behavior: string | null;
  steps_to_reproduce: string;
  context: string;
  related_links: string[];
};

function clock(ms: number | null): string {
  if (ms === null) return "";
  const s = Math.round(ms / 1000);
  return `+${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")} `;
}

export function bugReportToIssue(r: BugReport, meta: BugReportMeta): BugIssueFields {
  const firstLine = r.description.split(/(?<=[.!?])\s/)[0] ?? r.description;
  const title = `${meta.repo}${r.path ? ` ${r.path}` : ""}: ${firstLine}`.slice(0, 200);
  const steps: string[] = [];
  const trail = r.breadcrumbs.filter((b) => b.kind !== "error");
  trail.forEach((b, i) => steps.push(`${i + 1}. ${clock(b.at)}${b.kind === "nav" ? "Went to" : "Clicked"} ${b.detail}`));
  steps.push(`${trail.length + 1}. On ${r.url || r.path || "the page"}${r.pageTitle ? ` ("${r.pageTitle}")` : ""}: ${r.description}`);
  const v = r.basics.viewport;
  const errors = [
    ...r.basics.errors.map((e) => `${e.message}${e.source ? ` (${e.source})` : ""}`),
    ...r.breadcrumbs.filter((b) => b.kind === "error").map((b) => b.detail),
  ];
  const context = [
    `Reported with the in-app bug button${meta.reporter ? ` by ${meta.reporter}` : ""}.`,
    `App: ${meta.repo}${meta.appVersion ? ` @ ${meta.appVersion.slice(0, 12)}` : ""}`,
    `Page: ${r.url || r.path || "unknown"}`,
    `Viewport: ${v.w ?? "?"}x${v.h ?? "?"} @${v.dpr ?? "?"}x${meta.browser ? `, ${meta.browser}` : ""}${r.basics.reducedMotion ? ", reduced motion" : ""}`,
    r.basics.sentryEventId ? `Sentry event: ${r.basics.sentryEventId}` : null,
    r.capturedAt !== null ? `Page open for ${Math.round(r.capturedAt / 1000)}s before the report` : null,
    errors.length ? `Recent client errors:\n${errors.map((e) => `- ${e}`).join("\n")}` : "No client errors recorded.",
    r.screenshotIncluded ? "A picture of the page is attached to this issue." : "No picture of the page was sent.",
  ]
    .filter(Boolean)
    .join("\n");
  return {
    title,
    description: r.description,
    area: r.path || null,
    actual_behavior: r.description,
    expected_behavior: r.expected || null,
    steps_to_reproduce: steps.join("\n"),
    context,
    related_links: r.url ? [r.url] : [],
  };
}

export type ForwardImage = { blob: Blob; name: string; kind: "page" | "upload" };

export type ForwardOptions = {
  /** Tracker origin, from an env var. */
  baseUrl: string | undefined | null;
  /** Ingest token, from an env var. */
  token: string | undefined | null;
  report: BugReport;
  meta: BugReportMeta;
  images?: ForwardImage[];
  timeoutMs?: number;
};

export type ForwardResult = { ok: boolean; status?: number; issueId?: string; error?: string };

/** Post a cleaned report and its pictures to the tracker. Never throws. */
export async function forwardBugReport(opts: ForwardOptions): Promise<ForwardResult> {
  const label = `[bug-report] ${opts.meta.repo}`;
  if (!opts.baseUrl || !opts.token) {
    console.error(`${label}: tracker URL or token not configured — report NOT filed`);
    return { ok: false, error: "not configured" };
  }
  const base = opts.baseUrl.replace(/\/$/, "");
  if (!isSafeOutboundUrl(base)) {
    console.error(`${label}: tracker URL failed host safety check — report NOT filed`);
    return { ok: false, error: "unsafe base url" };
  }
  try {
    const form = new FormData();
    form.set("report", JSON.stringify({ report: opts.report, meta: opts.meta }));
    for (const img of (opts.images ?? []).slice(0, BUG_REPORT_MAX_IMAGES)) form.append(img.kind, img.blob, img.name);
    const res = await fetch(`${base}/api/bug-reports/ingest`, {
      method: "POST",
      headers: { Authorization: `Bearer ${opts.token}` },
      body: form,
      signal: AbortSignal.timeout(opts.timeoutMs ?? 15000),
    });
    const text = await res.text().catch(() => "");
    if (!res.ok) {
      console.error(`${label}: ingest answered ${res.status}: ${text.slice(0, 200)}`);
      return { ok: false, status: res.status, error: text.slice(0, 200) };
    }
    let issueId: string | undefined;
    try {
      issueId = (JSON.parse(text) as { id?: string }).id;
    } catch {
      issueId = undefined;
    }
    return { ok: true, status: res.status, issueId };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`${label}: ingest request failed: ${msg}`);
    return { ok: false, error: msg };
  }
}
