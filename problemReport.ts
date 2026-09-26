/**
 * problemReport.ts — the generic half of an in-app "Report a problem" (no imports, deliberately).
 *
 * Extracted 2026-09-26 from the first consumer's in-app report form: the pieces that are useful in
 * ANY app (an admin dashboard, a checkout, a marketing site) live here, so a second "something's
 * wrong on this screen" form never grows its own copy of the cleaning rules. What stays in the
 * consumer is everything specific to it: its own report kinds, the state snapshot shape, the table,
 * the thank-you line and the admin page.
 *
 * What this module owns:
 *   - `cleanPlainText`: the one plain-text cleaner for player/customer free text (control chars
 *     stripped, tags removed, angle brackets dropped, whitespace collapsed, capped). Mirror it in
 *     the database's own cleaning trigger: the app check is the first line, never the only one.
 *   - `browserFamily`: coarse browser family + major version. The user-agent string itself is
 *     never stored (same stance as `device.ts`).
 *   - `fitJsonSnapshot`: shrink a JSON state snapshot under a size cap by trimming, then dropping,
 *     the named non-essential keys; null if it still does not fit (store the report without it
 *     rather than refuse it).
 *   - `cleanClientBasics`: the bounded, allow-listed client context every report carries
 *     (viewport, recent client errors, a Sentry event id, elapsed time, reduced motion). Unknown
 *     keys are DROPPED — a report route is a public endpoint, and whatever a client sends that we
 *     did not ask for must never reach the row.
 *
 * What it deliberately does NOT own: storage (the caller's private bucket and client), image
 * re-encoding (needs `sharp`, which web-core does not depend on — validate with `uploads.ts`
 * `validateUpload`, then re-encode in the consumer to strip EXIF), rate limiting (put it in the
 * database trigger so every insert path obeys it), and replies (`supportTicket.ts`, only when the
 * person asked for one — a report is feedback, never an implied promise of a reply).
 */

export const MAX_CLIENT_ERRORS = 5;
export const CLIENT_CONTEXT_MAX = 20_000;

/** Plain text: no control characters, no HTML, whitespace collapsed, capped at `max` characters. */
export function cleanPlainText(v: unknown, max: number): string {
  if (typeof v !== "string") return "";
  return v
    // eslint-disable-next-line no-control-regex -- stripping control characters is the point
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/[<>]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

/**
 * Coarse browser family and major version ("Chrome 128", "Safari 17", "iOS in-app"). Never the
 * user-agent string itself. ORDER IS LOAD-BEARING: Edge, Samsung and Opera all also say "Chrome",
 * and every iOS browser also says "Safari", so the specific ones are tested first.
 */
export function browserFamily(ua: string | null | undefined): string | null {
  if (!ua) return null;
  const m = (re: RegExp) => re.exec(ua)?.[1];
  let v: string | undefined;
  if ((v = m(/Edg(?:e|A|iOS)?\/(\d+)/))) return `Edge ${v}`;
  if ((v = m(/SamsungBrowser\/(\d+)/))) return `Samsung ${v}`;
  if ((v = m(/(?:OPR|Opera)\/(\d+)/))) return `Opera ${v}`;
  if ((v = m(/FxiOS\/(\d+)/)) || (v = m(/Firefox\/(\d+)/))) return `Firefox ${v}`;
  if ((v = m(/CriOS\/(\d+)/)) || (v = m(/Chrome\/(\d+)/))) return `Chrome ${v}`;
  if (/Safari\//.test(ua) && (v = m(/Version\/(\d+)/))) return `Safari ${v}`;
  if (/AppleWebKit/.test(ua) && /Mobile\//.test(ua)) return "iOS in-app";
  return "Other";
}

export type FitOptions = {
  /** Array keys to trim to their last `keepLast` entries first (e.g. a recent-events log). */
  trim?: readonly string[];
  keepLast?: number;
  /** Keys to empty/drop if trimming was not enough. Arrays become [], anything else is removed. */
  drop?: readonly string[];
};

/**
 * Shrink a JSON object snapshot to at most `maxChars` of JSON: trim the `trim` arrays, then drop the
 * `drop` keys. Returns null for a non-object or when it still does not fit, so the caller stores the
 * report without a snapshot rather than refusing the report.
 */
export function fitJsonSnapshot(state: unknown, maxChars: number, opts: FitOptions = {}): Record<string, unknown> | null {
  if (!state || typeof state !== "object" || Array.isArray(state)) return null;
  const size = (x: unknown) => JSON.stringify(x).length;
  let s = state as Record<string, unknown>;
  if (size(s) <= maxChars) return s;
  const keepLast = opts.keepLast ?? 10;
  if (opts.trim?.length) {
    s = { ...s };
    for (const k of opts.trim) if (Array.isArray(s[k])) s[k] = (s[k] as unknown[]).slice(-keepLast);
    if (size(s) <= maxChars) return s;
  }
  if (opts.drop?.length) {
    s = { ...s };
    for (const k of opts.drop) {
      if (Array.isArray(s[k])) s[k] = [];
      else delete s[k];
    }
  }
  return size(s) <= maxChars ? s : null;
}

const int = (v: unknown, lo: number, hi: number) => (typeof v === "number" && Number.isInteger(v) && v >= lo && v <= hi ? v : null);

export type ClientBasics = {
  viewport: { w: number | null; h: number | null; dpr: number | null };
  errors: { message: string; source: string; at: number | null }[];
  sentryEventId: string | null;
  elapsedMs: number | null;
  reducedMotion: boolean;
};

/**
 * The allow-listed, bounded client context every report carries. Anything else in `raw` is ignored:
 * a consumer adds its own keys explicitly, each validated, never by spreading the client's object.
 */
export function cleanClientBasics(raw: unknown): ClientBasics {
  const c = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const vp = c.viewport && typeof c.viewport === "object" ? (c.viewport as Record<string, unknown>) : {};
  const errors = Array.isArray(c.errors)
    ? c.errors.slice(-MAX_CLIENT_ERRORS).map((e) => {
        const o = e && typeof e === "object" ? (e as Record<string, unknown>) : {};
        return { message: cleanPlainText(o.message, 300), source: cleanPlainText(o.source, 200), at: int(o.at, 0, 9e15) };
      })
    : [];
  return {
    viewport: {
      w: int(vp.w, 0, 20000),
      h: int(vp.h, 0, 20000),
      dpr: typeof vp.dpr === "number" && vp.dpr > 0 && vp.dpr < 10 ? Math.round(vp.dpr * 100) / 100 : null,
    },
    errors,
    sentryEventId: typeof c.sentryEventId === "string" && /^[0-9a-f]{32}$/.test(c.sentryEventId) ? c.sentryEventId : null,
    elapsedMs: int(c.elapsedMs, 0, 1e9),
    reducedMotion: c.reducedMotion === true,
  };
}
