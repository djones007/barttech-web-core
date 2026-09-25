/**
 * Consent-independent split testing (A/B) for server-rendered pages.
 *
 * WHY THIS EXISTS. Client-side A/B tools assign a visitor with a cookie or
 * local storage, and that needs consent. A test run that way only ever sees
 * the visitors who tapped Accept, which is a small and unrepresentative slice
 * once a cookie banner is sized properly. This module assigns on the SERVER,
 * per page view, and stores nothing on the device.
 *
 * HOW A VISIT IS KEPT ON ONE VARIANT without a cookie: the assignment is made
 * once when the page renders, and carried in the URL of the visitor's next
 * internal step (for example the buy click, as `?exp=<key>&v=<variant>`). A
 * returning visitor may see the other variant on a later visit; that is the
 * accepted cost of storing nothing, and it dilutes a real effect rather than
 * inventing one.
 *
 * CONFIG IS DATA, NOT CODE. Experiments (key, page path, variants + weights,
 * status, control, winner) live in the operator's database and are read live
 * through a token-gated endpoint, cached briefly in memory. A paused or
 * concluded experiment gives everyone the winner (or the control), so a test
 * can be stopped without a deploy. Any failure to read the config means
 * "no experiment": everyone sees the control. A split test must never be able
 * to break the page it is testing.
 *
 * QA: `?v=<variant>` forces a variant. A forced view is flagged `forced` all
 * the way through (landing, click, order) so reporting can exclude it.
 *
 * Framework-free, no React, no `server-only` (golden rules 5 and 6): the
 * consumer's own shim adds `import "server-only"` and bakes in its site.
 */

export type ExperimentStatus = "running" | "paused" | "concluded";

export type ExperimentVariant = {
  /** Short stable id carried in URLs and stored on rows, e.g. "a", "b". */
  id: string;
  /** Relative weight. Weights need not sum to 100; 0 means never assigned while running. */
  weight: number;
  label?: string;
};

export type ExperimentConfig = {
  key: string;
  /** The page path the experiment runs on, e.g. "/". */
  path: string;
  status: ExperimentStatus;
  variants: ExperimentVariant[];
  /** The variant everyone gets when the experiment is not running and has no winner. */
  control: string;
  winner: string | null;
};

export type ExperimentAssignment = {
  key: string;
  variant: string;
  /** Chosen by a `?v=` override (QA). Exclude from results. */
  forced: boolean;
  /** True only when a running experiment made a random assignment (or it was forced). */
  live: boolean;
};

const KEY_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;
const VARIANT_RE = /^[a-z0-9][a-z0-9_-]{0,19}$/;
const STATUSES: readonly ExperimentStatus[] = ["running", "paused", "concluded"];

export function isExperimentKey(value: unknown): value is string {
  return typeof value === "string" && KEY_RE.test(value);
}

export function isVariantId(value: unknown): value is string {
  return typeof value === "string" && VARIANT_RE.test(value);
}

/**
 * Validate one config object from the wire. Anything malformed returns null
 * (treated as "no experiment"), never a partially-trusted object.
 */
export function normaliseExperimentConfig(raw: unknown): ExperimentConfig | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (!isExperimentKey(r.key)) return null;
  if (typeof r.path !== "string" || !r.path.startsWith("/") || r.path.length > 300) return null;
  if (typeof r.status !== "string" || !STATUSES.includes(r.status as ExperimentStatus)) return null;
  if (!Array.isArray(r.variants)) return null;
  const variants: ExperimentVariant[] = [];
  const seen = new Set<string>();
  for (const v of r.variants.slice(0, 10)) {
    if (!v || typeof v !== "object") return null;
    const vv = v as Record<string, unknown>;
    if (!isVariantId(vv.id) || seen.has(vv.id)) return null;
    const weight = typeof vv.weight === "number" && Number.isFinite(vv.weight) && vv.weight >= 0 ? vv.weight : 0;
    seen.add(vv.id);
    variants.push({ id: vv.id, weight, ...(typeof vv.label === "string" ? { label: vv.label.slice(0, 100) } : {}) });
  }
  if (variants.length < 2) return null;
  if (!isVariantId(r.control) || !seen.has(r.control)) return null;
  const winner = isVariantId(r.winner) && seen.has(r.winner) ? r.winner : null;
  return { key: r.key, path: r.path, status: r.status as ExperimentStatus, variants, control: r.control, winner };
}

/**
 * Weighted pick. `r` is a uniform number in [0, 1). Zero-weight variants are
 * never picked; if every weight is zero the first variant is returned (the
 * caller only reaches here for a running test, and a running test with no
 * weight is a config mistake that should fail safe, not throw).
 */
export function pickWeighted(variants: ExperimentVariant[], r: number): string {
  const total = variants.reduce((sum, v) => sum + Math.max(0, v.weight), 0);
  if (total <= 0) return variants[0].id;
  let point = Math.min(Math.max(r, 0), 0.999999999) * total;
  for (const v of variants) {
    const w = Math.max(0, v.weight);
    if (w === 0) continue;
    if (point < w) return v.id;
    point -= w;
  }
  // Floating-point tail: the last variant with weight.
  return [...variants].reverse().find((v) => v.weight > 0)!.id;
}

/** First value of a query param, whether from a Next.js `searchParams` object or URLSearchParams. */
function firstParam(
  input: Record<string, string | string[] | undefined> | URLSearchParams,
  name: string,
): string | null {
  if (input instanceof URLSearchParams) return input.get(name);
  const v = input[name];
  if (Array.isArray(v)) return v[0] ?? null;
  return v ?? null;
}

/** The QA override (`?v=b`), if it names a real variant of this experiment. */
export function forcedVariant(
  config: ExperimentConfig,
  searchParams: Record<string, string | string[] | undefined> | URLSearchParams,
  param = "v",
): string | null {
  const v = firstParam(searchParams, param)?.toLowerCase() ?? null;
  return v && config.variants.some((x) => x.id === v) ? v : null;
}

/**
 * Decide which variant this page view gets.
 *   forced (valid ?v=)  → that variant, flagged forced
 *   running             → weighted random
 *   paused              → control
 *   concluded           → winner, or control if none was recorded
 */
export function assignVariant(
  config: ExperimentConfig,
  opts: { forced?: string | null; random?: () => number } = {},
): ExperimentAssignment {
  const forced = opts.forced && config.variants.some((v) => v.id === opts.forced) ? opts.forced : null;
  if (forced) return { key: config.key, variant: forced, forced: true, live: true };
  if (config.status === "running") {
    const r = (opts.random ?? Math.random)();
    return { key: config.key, variant: pickWeighted(config.variants, r), forced: false, live: true };
  }
  const fallback = config.status === "concluded" && config.winner ? config.winner : config.control;
  return { key: config.key, variant: fallback, forced: false, live: false };
}

/**
 * Query params that carry an assignment to the visitor's next step. Empty for
 * a non-live assignment (paused/concluded): there is nothing to measure, so
 * nothing is appended and the next step behaves exactly as without a test.
 */
export function experimentParams(a: ExperimentAssignment | null | undefined): Record<string, string> {
  if (!a || !a.live) return {};
  return { exp: a.key, v: a.variant, ...(a.forced ? { xf: "1" } : {}) };
}

export type ParsedExperiment = { key: string; variant: string; forced: boolean };

/**
 * Read `exp` / `v` / `xf` back off a request (the click endpoint, the
 * checkout). Validated shape only: null for anything missing or malformed, so
 * a caller that never sends them is completely unaffected.
 */
export function parseExperimentParams(
  input: Record<string, string | string[] | undefined> | URLSearchParams,
): ParsedExperiment | null {
  const key = firstParam(input, "exp")?.toLowerCase() ?? null;
  const variant = firstParam(input, "v")?.toLowerCase() ?? null;
  if (!isExperimentKey(key) || !isVariantId(variant)) return null;
  return { key, variant, forced: firstParam(input, "xf") === "1" };
}

/**
 * Super-properties for a product-analytics tool (for example PostHog's
 * `register()`), so recordings and heatmaps can be filtered by variant.
 * Only loaded for visitors who consented; the split itself never depends on it.
 */
export function experimentSuperProperties(assignments: (ExperimentAssignment | null | undefined)[]): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {};
  for (const a of assignments) {
    if (!a || !a.live) continue;
    out[`exp_${a.key}`] = a.variant;
    out.experiment = a.key;
    out.experiment_variant = a.variant;
    if (a.forced) out.experiment_forced = true;
  }
  return out;
}

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export type ExperimentConfigReaderOptions = {
  /** The token-gated config endpoint. Unset = no experiments (control everywhere). */
  url: string | undefined;
  token: string | undefined;
  /** Which site's experiments to read; passed as `?site=`. */
  site: string;
  /** How long a successful read is reused. Default 30s: a pause takes effect within this. */
  ttlMs?: number;
  /** How long the last good read may stand in for a failing endpoint. Default 5 min, then control. */
  maxStaleMs?: number;
  timeoutMs?: number;
  fetchImpl?: FetchLike;
  now?: () => number;
};

/**
 * Build a cached reader for one site's experiment configs. Call once at module
 * scope in the consumer's shim; the cache lives per server instance.
 * Never throws: every failure path resolves to the last good list (within
 * `maxStaleMs`) or to `[]`.
 */
export function createExperimentConfigReader(opts: ExperimentConfigReaderOptions): () => Promise<ExperimentConfig[]> {
  const ttl = opts.ttlMs ?? 30_000;
  const maxStale = opts.maxStaleMs ?? 300_000;
  const timeout = opts.timeoutMs ?? 1_500;
  const now = opts.now ?? Date.now;
  let good: { at: number; list: ExperimentConfig[] } | null = null;
  let inflight: Promise<ExperimentConfig[]> | null = null;

  async function load(): Promise<ExperimentConfig[]> {
    const doFetch = opts.fetchImpl ?? (fetch as FetchLike);
    try {
      const sep = opts.url!.includes("?") ? "&" : "?";
      const res = await doFetch(`${opts.url}${sep}site=${encodeURIComponent(opts.site)}`, {
        headers: { Authorization: `Bearer ${opts.token}` },
        cache: "no-store",
        signal: AbortSignal.timeout(timeout),
      });
      if (!res.ok) throw new Error(`status ${res.status}`);
      const body = (await res.json()) as { experiments?: unknown };
      const list = Array.isArray(body.experiments)
        ? body.experiments.map(normaliseExperimentConfig).filter((x): x is ExperimentConfig => x !== null)
        : [];
      good = { at: now(), list };
      return list;
    } catch {
      if (good && now() - good.at <= maxStale) return good.list;
      return [];
    }
  }

  return async function read(): Promise<ExperimentConfig[]> {
    if (!opts.url || !opts.token) return [];
    if (good && now() - good.at < ttl) return good.list;
    if (!inflight) inflight = load().finally(() => { inflight = null; });
    return inflight;
  };
}
