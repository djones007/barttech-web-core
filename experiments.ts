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
 * when the page renders, and carried in the URL of the visitor's next
 * internal step (for example the buy click, as `?exp=<key>&v=<variant>`).
 *
 * ACROSS VISITS (`assignSticky`): the random number is replaced by a hash of
 * the experiment key and the request's own network address + user agent, so
 * the same browser on the same connection gets the same variant on every
 * visit. Nothing is written to or read from the device beyond the headers
 * every request already carries, and the hash is computed per request and
 * discarded: no identifier is stored anywhere, so it works identically when
 * cookies are rejected. A visitor who changes network or browser may land in
 * the other variant; that dilutes an effect rather than inventing one. Use it
 * for anything the visitor would notice changing between visits (a PRICE
 * test above all). Changing weights mid-test moves some visitors; set them
 * before starting.
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
 *
 * Estate-wide runbook (recipes, CC /split-tests, price tests, auto-conclude, traps):
 * memory/reference_split_testing.md in barttech-os.
 */

export type ExperimentStatus = "running" | "paused" | "concluded";

export type ExperimentVariant = {
  /** Short stable id carried in URLs and stored on rows, e.g. "a", "b". */
  id: string;
  /** Relative weight. Weights need not sum to 100; 0 means never assigned while running. */
  weight: number;
  label?: string;
  /**
   * Optional: where this variant's buy click goes (an absolute https URL, e.g.
   * a checkout offer). Lets a test send each variant to its own offer (a price
   * test). The consumer must still check the host is one it trusts.
   */
  checkoutUrl?: string;
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

/** An absolute https URL with no credentials, or null. */
export function safeHttpsUrl(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 500) return null;
  try {
    const u = new URL(value);
    if (u.protocol !== "https:" || u.username || u.password) return null;
    return u.toString();
  } catch {
    return null;
  }
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
    const checkoutUrl = safeHttpsUrl(vv.checkoutUrl);
    variants.push({
      id: vv.id,
      weight,
      ...(typeof vv.label === "string" ? { label: vv.label.slice(0, 100) } : {}),
      ...(checkoutUrl ? { checkoutUrl } : {}),
    });
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
 * The request's own network address + user agent, as one string, for
 * `stickyBucket`. Null when neither is present (the caller then falls back to
 * a per-view random pick). Read only from headers every request carries.
 */
export function requestVisitorKey(headers: { get(name: string): string | null }): string | null {
  const ip = (headers.get("x-forwarded-for")?.split(",")[0] ?? headers.get("x-real-ip") ?? "").trim().slice(0, 100);
  const ua = (headers.get("user-agent") ?? "").trim().slice(0, 400);
  if (!ip && !ua) return null;
  return `${ip}|${ua}`;
}

/**
 * A stable number in [0, 1) for (experiment, visitor): SHA-256 of both, first
 * 4 bytes. The key is in the hash so a visitor's position in one test says
 * nothing about their position in another. Web Crypto, so it runs in the
 * Node and edge runtimes alike.
 */
export async function stickyBucket(experimentKey: string, visitorKey: string, salt = ""): Promise<number> {
  const data = new TextEncoder().encode(`${salt}\n${experimentKey}\n${visitorKey}`);
  const digest = new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", data));
  const n = ((digest[0] << 24) >>> 0) + (digest[1] << 16) + (digest[2] << 8) + digest[3];
  return n / 0x1_0000_0000;
}

/**
 * `assignVariant`, but the same visitor gets the same variant on every visit
 * while the test runs (see the header comment). No visitor key = a per-view
 * random pick, exactly as `assignVariant`.
 */
export async function assignSticky(
  config: ExperimentConfig,
  opts: { forced?: string | null; visitorKey: string | null; salt?: string },
): Promise<ExperimentAssignment> {
  if (config.status !== "running" || !opts.visitorKey) return assignVariant(config, { forced: opts.forced });
  const r = await stickyBucket(config.key, opts.visitorKey, opts.salt);
  return assignVariant(config, { forced: opts.forced, random: () => r });
}

/** The variant's own checkout URL, if the config gives it one. */
export function variantCheckoutUrl(config: ExperimentConfig, variant: string): string | null {
  return config.variants.find((v) => v.id === variant)?.checkoutUrl ?? null;
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
