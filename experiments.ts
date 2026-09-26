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
 * WHAT LIVES HERE (all of it, so a fix reaches every site): config reading,
 * the pick (`assignVariant` / `assignSticky`), the per-request page
 * assignment (`assignPageRequest`, the proxy->page header codec,
 * `experimentEventTag`), price tests (`createVariantOfferResolver`: variant ->
 * offer -> that offer's own prices), and the buy click
 * (`createCheckoutClickHandler`: the whole click route). A site keeps only a
 * thin shim naming its site, header, default offer and event logger.
 *
 * Framework-free, no React, no `server-only` (golden rules 5 and 6): the
 * consumer's own shim adds `import "server-only"` and bakes in its site. No
 * runtime imports either, so a plain `node --test` can load this file directly.
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

// ---------------------------------------------------------------------------
// PER-REQUEST ASSIGNMENT for a server-rendered page (the proxy/middleware
// half). Every site used to carry its own copy of this in a local shim, and the
// copies drifted: one learned "a crawler gets the WINNER of a concluded test",
// "several experiments on one page" and "sticky per visitor", the other did
// not. It lives here so the next fix reaches every site.
// ---------------------------------------------------------------------------

type HeaderGetter = { get(name: string): string | null };

/** An assignment plus the page path the visitor actually requested (what events are logged under). */
export type PageAssignment = ExperimentAssignment & { path: string };

/**
 * One assignment per experiment configured on `pathname` (empty when none).
 *
 *   - Sticky per visitor while a test runs (`assignSticky`, salted with `salt`).
 *   - `?v=` forces the RUNNING test on the page; when none is running it may
 *     force any test that has that variant (QA of a concluded one).
 *   - An automated request (crawler, link preview, prefetch: the caller passes
 *     its own `isAutomatedRequest(headers)` verdict) is never tagged: it gets
 *     the control while a test runs or is paused, and the WINNER once one is
 *     concluded, so the indexed page is the page real visitors see. A forced
 *     variant still wins, for QA.
 *
 * `automated` is an input, not an import, so this file stays free of runtime
 * imports and can be loaded directly by a plain `node --test`.
 */
export async function assignPageRequest(
  configs: ExperimentConfig[],
  req: { pathname: string; searchParams: URLSearchParams | Record<string, string | string[] | undefined>; headers: HeaderGetter; automated: boolean; salt?: string },
): Promise<PageAssignment[]> {
  const onPage = configs.filter((c) => c.path === req.pathname);
  if (!onPage.length) return [];
  const anyRunning = onPage.some((c) => c.status === "running");
  const visitorKey = requestVisitorKey(req.headers);
  return Promise.all(
    onPage.map(async (config): Promise<PageAssignment> => {
      const forced = !anyRunning || config.status === "running" ? forcedVariant(config, req.searchParams) : null;
      if (!forced && req.automated) {
        const fallback = assignVariant({ ...config, status: config.status === "concluded" ? "concluded" : "paused" });
        return { ...fallback, path: req.pathname };
      }
      return { ...(await assignSticky(config, { forced, visitorKey, salt: req.salt })), path: req.pathname };
    }),
  );
}

/** One assignment as a request-header token: `key;variant;forced;live;path`. */
export function encodeAssignment(a: PageAssignment): string {
  return [a.key, a.variant, a.forced ? "1" : "0", a.live ? "1" : "0", encodeURIComponent(a.path)].join(";");
}

/** Up to 5 assignments, comma-separated, for the proxy to hand the page in a request header. */
export function encodeAssignments(list: PageAssignment[]): string {
  return list.slice(0, 5).map(encodeAssignment).join(",");
}

function decodeAssignmentToken(raw: string): PageAssignment | null {
  const [key, variant, forced, live, path] = raw.split(";");
  if (!isExperimentKey(key) || !isVariantId(variant)) return null;
  let p = "/";
  try {
    p = decodeURIComponent(path ?? "/");
  } catch {
    return null;
  }
  if (!p.startsWith("/")) return null;
  return { key, variant, forced: forced === "1", live: live === "1", path: p };
}

/**
 * Parse the header value `encodeAssignments` produced. Strict: a malformed
 * token is dropped (that experiment renders its control), never half-trusted.
 * The proxy must always overwrite or delete the header, so a client cannot
 * send its own assignment in.
 */
export function decodeAssignments(raw: string | null | undefined): PageAssignment[] {
  if (!raw) return [];
  return raw
    .split(",")
    .slice(0, 5)
    .map(decodeAssignmentToken)
    .filter((a): a is PageAssignment => a !== null);
}

/** The LIVE assignment (the one running test on the page), if any: what events are tagged with. */
export function liveAssignment(list: PageAssignment[]): PageAssignment | null {
  return list.find((a) => a.live) ?? null;
}

/**
 * What a page event (`trackServerEvent`) is tagged with on a tested page: the
 * live variant, logged under the path the visitor actually REQUESTED. A variant
 * rendered from another page's component (variant b of `/` built from the
 * `/v2` page) must count as a landing on `/`, or the report compares a variant
 * against nothing. Empty when nothing is live, so the event is untouched.
 */
export function experimentEventTag(list: PageAssignment[]): { path?: string; experiment?: ParsedExperiment } {
  const a = liveAssignment(list);
  return a ? { path: a.path, experiment: { key: a.key, variant: a.variant, forced: a.forced } } : {};
}

// ---------------------------------------------------------------------------
// PRICE TESTS: which checkout offer a variant sells, and at what price.
//
// ONE rule: the price on the page is read from the SAME checkout offer the buy
// click goes to, in the SAME currency the checkout will pick, so a visitor can
// never see one price on the page and another at checkout. No page types a
// price; it is read from the offer's own price rows.
// ---------------------------------------------------------------------------

export type Money = { currency: "GBP" | "USD"; value: number };
/** One price row of an offer: ISO currency (lower case) + amount in minor units. */
export type OfferPrice = { currency: string; amount: number };

/**
 * A checkout URL from a split-test config, accepted only on the trusted
 * checkout host (the host of `fallback`, the site's default offer), over https,
 * as a bare offer path (`https://<host>/<slug>`), with no query or fragment.
 * Anything else returns `fallback`, so a bad config row can never send a buyer
 * somewhere unexpected.
 */
export function trustedCheckoutUrl(candidate: string | null | undefined, fallback: string): string {
  if (!candidate) return fallback;
  try {
    const u = new URL(candidate);
    const f = new URL(fallback);
    if (u.protocol !== "https:" || u.host !== f.host || !/^\/[a-z0-9-]{1,60}$/.test(u.pathname) || u.search || u.hash) return fallback;
    return `${u.origin}${u.pathname}`;
  } catch {
    return fallback;
  }
}

/** The offer slug of a checkout URL (`https://host/play-p` -> `play-p`). */
export function offerSlugOf(url: string): string {
  return new URL(url).pathname.replace(/^\/+/, "").split("/")[0];
}

/**
 * The currency the checkout will charge this visitor: US -> usd, GB -> gbp
 * when the offer has it, else `fallback` (the brand default). Mirrors the
 * checkout's own detection; change both together.
 */
export function checkoutCurrency(country: string | null | undefined, available: string[], fallback = "gbp"): string {
  const pref = country?.toUpperCase() === "US" ? "usd" : country?.toUpperCase() === "GB" ? "gbp" : undefined;
  if (pref && available.includes(pref)) return pref;
  return fallback;
}

/** "£24.99" / "$29.99" from minor units. Only GBP and USD; anything else is null (leave the price out). */
export function formatPrice(minor: number, currency: string): string | null {
  const sym = currency === "gbp" ? "£" : currency === "usd" ? "$" : null;
  if (!sym || !Number.isInteger(minor) || minor <= 0) return null;
  return `${sym}${(minor / 100).toFixed(2)}`;
}

/** The price line for a visitor from the offer's own price rows. Null = show no price rather than guess. */
export function priceFor(currencies: OfferPrice[], country: string | null | undefined, fallbackCurrency = "gbp"): { price: string; money: Money } | null {
  const cur = checkoutCurrency(country, currencies.map((c) => c.currency), fallbackCurrency);
  const row = currencies.find((c) => c.currency === cur);
  if (!row) return null;
  const price = formatPrice(row.amount, cur);
  if (!price) return null;
  return { price, money: { currency: cur === "usd" ? "USD" : "GBP", value: row.amount / 100 } };
}

/** What a tested page sells to this visitor: the offer the buy buttons go to and the price shown for it. */
export type VariantOffer = {
  checkoutUrl: string;
  offer: string;
  price: string | null;
  money: Money | null;
};

export type VariantOfferResolverOptions = {
  /** The site's default offer: used when no variant names one, and the host every variant URL must share. */
  defaultCheckoutUrl: string;
  /** The site's cached config reader (`createExperimentConfigReader`). */
  readConfigs: () => Promise<ExperimentConfig[]>;
  /** Where an offer's price rows are read. Default `<checkout origin>/api/offer?offer=<slug>`, answering `{ currencies: [{ currency, amount }] }`. */
  offerPricesUrl?: (checkoutUrl: string) => string;
  /** Extra fetch options, e.g. a framework's data-cache hints. */
  fetchInit?: RequestInit & Record<string, unknown>;
  /** In-memory reuse of a successful price read. Default 60s; 0 = off (e.g. when `fetchInit` already caches). */
  ttlMs?: number;
  timeoutMs?: number;
  fallbackCurrency?: string;
  fetchImpl?: FetchLike;
  now?: () => number;
};

/**
 * The variant -> offer -> price resolver for price tests. Build once per site
 * at module scope. Never throws: an unreadable offer gives `price: null` (the
 * page leaves the price out) and an unusable variant URL gives the default
 * offer.
 */
export function createVariantOfferResolver(opts: VariantOfferResolverOptions) {
  const ttl = opts.ttlMs ?? 60_000;
  const timeout = opts.timeoutMs ?? 3_000;
  const now = opts.now ?? Date.now;
  const pricesUrl =
    opts.offerPricesUrl ?? ((checkoutUrl: string) => `${new URL(checkoutUrl).origin}/api/offer?offer=${encodeURIComponent(offerSlugOf(checkoutUrl))}`);
  const cache = new Map<string, { at: number; rows: OfferPrice[] }>();

  /** The first assignment whose variant names a trusted offer wins; else the default offer. */
  async function checkoutUrlFor(assignments: { key: string; variant: string }[]): Promise<string> {
    if (!assignments.length) return opts.defaultCheckoutUrl;
    const configs = await opts.readConfigs();
    for (const a of assignments) {
      const config = configs.find((c) => c.key === a.key);
      const url = config ? variantCheckoutUrl(config, a.variant) : null;
      if (url) return trustedCheckoutUrl(url, opts.defaultCheckoutUrl);
    }
    return opts.defaultCheckoutUrl;
  }

  /** The offer's own price rows, or null if they cannot be read. */
  async function offerPrices(checkoutUrl: string): Promise<OfferPrice[] | null> {
    const hit = cache.get(checkoutUrl);
    if (hit && ttl > 0 && now() - hit.at < ttl) return hit.rows;
    try {
      const doFetch = opts.fetchImpl ?? (fetch as FetchLike);
      const res = await doFetch(pricesUrl(checkoutUrl), { ...(opts.fetchInit ?? {}), signal: AbortSignal.timeout(timeout) });
      if (!res.ok) return null;
      const d = (await res.json()) as { currencies?: unknown };
      if (!Array.isArray(d.currencies)) return null;
      const rows = d.currencies.flatMap((c): OfferPrice[] => {
        const r = c as { currency?: unknown; amount?: unknown } | null;
        return r && typeof r === "object" && typeof r.currency === "string" && Number.isInteger(r.amount)
          ? [{ currency: r.currency, amount: r.amount as number }]
          : [];
      });
      if (ttl > 0) cache.set(checkoutUrl, { at: now(), rows });
      return rows;
    } catch {
      return null;
    }
  }

  /** The offer and price for this visitor's assignments, in the currency the checkout will charge them. */
  async function offerFor(assignments: { key: string; variant: string }[], country: string | null | undefined): Promise<VariantOffer> {
    const checkoutUrl = await checkoutUrlFor(assignments);
    const rows = await offerPrices(checkoutUrl);
    const p = rows ? priceFor(rows, country, opts.fallbackCurrency) : null;
    let offer = "";
    try {
      offer = offerSlugOf(checkoutUrl);
    } catch {
      // No usable default offer configured: no offer, no price.
    }
    return { checkoutUrl, offer, price: p?.price ?? null, money: p?.money ?? null };
  }

  return { checkoutUrlFor, offerPrices, offerFor };
}

// ---------------------------------------------------------------------------
// THE BUY CLICK: `GET /go/checkout` (or wherever a site mounts it).
//
// The page's buy links point here while a test is live. The handler logs one
// server-side click tagged with the variant (consent-independent: no cookie,
// no identifier), then 302s to the checkout with every query param passed
// through (UTMs, click ids, and the exp/v/xf the checkout stamps on the order).
// The destination is the variant's own offer (a price test) or the site's
// default, and is only ever accepted on the default offer's host as a bare
// offer path: the query can pick WHICH offer, never WHERE, so this is not an
// open redirect. Standard Request/Response only, so any framework can mount it.
// ---------------------------------------------------------------------------

/** What the click handler hands the site's event logger (e.g. `trackServerEvent` via the site's shim). */
export type CheckoutClickEvent = {
  event: "reserve_click";
  /** The page the click came from: same-site referrer path only, else "/". */
  path: string;
  headers: Headers;
  searchParams: Record<string, string>;
  experiment: ParsedExperiment | null;
};

export type CheckoutClickHandlerOptions = {
  /** The site's default offer (read per request, so an env var set later is picked up). Unset = 404. */
  checkoutUrl: string | null | undefined | (() => string | null | undefined);
  /** The variant's own offer (price tests). Its result is still checked against the default offer's host. */
  variantCheckoutUrl?: (experiment: ParsedExperiment | null) => Promise<string | null | undefined> | string | null | undefined;
  /**
   * A query param naming the offer the page PRICED (a bare slug, e.g. `o`), so
   * the click lands on exactly that offer even if the config changed in
   * between. Accepted only as a slug on the default offer's host; stripped
   * before the params are passed on. Unset = not read.
   */
  offerParam?: string;
  /** Logs the click. Runs in `defer`, so it can never delay or break the redirect. */
  onClick?: (event: CheckoutClickEvent) => unknown;
  /** Runs work after the response (Next: `after`). Default: fire and forget. */
  defer?: (task: () => Promise<void>) => void;
};

const OFFER_SLUG_RE = /^[a-z0-9-]{1,60}$/;

/** Build the click endpoint's GET handler. Export it from the site's route file as `GET`. */
export function createCheckoutClickHandler(opts: CheckoutClickHandlerOptions): (req: Request) => Promise<Response> {
  return async function GET(req: Request): Promise<Response> {
    const base = typeof opts.checkoutUrl === "function" ? opts.checkoutUrl() : opts.checkoutUrl;
    let baseUrl: URL;
    try {
      if (!base) throw new Error("unset");
      baseUrl = new URL(base);
    } catch {
      return new Response("Not found", { status: 404 });
    }
    const reqUrl = new URL(req.url);
    const params = reqUrl.searchParams;
    const exp = parseExperimentParams(params);

    let dest = baseUrl.toString();
    if (opts.variantCheckoutUrl) {
      let variantUrl: string | null | undefined = null;
      try {
        variantUrl = await opts.variantCheckoutUrl(exp);
      } catch {
        variantUrl = null;
      }
      dest = trustedCheckoutUrl(variantUrl, base as string);
    }
    if (opts.offerParam) {
      const o = params.get(opts.offerParam) ?? "";
      if (OFFER_SLUG_RE.test(o)) dest = trustedCheckoutUrl(`${baseUrl.origin}/${o}`, dest);
    }
    const out = new URL(dest);
    params.forEach((value, key) => {
      if (key !== opts.offerParam && key.length <= 64 && value.length <= 500) out.searchParams.append(key, value);
    });

    // The page the click came from, same-site only (a referrer is a host + path, never its query).
    let path = "/";
    try {
      const ref = req.headers.get("referer");
      if (ref) {
        const u = new URL(ref);
        if (u.host === reqUrl.host) path = u.pathname.slice(0, 300);
      }
    } catch {
      // keep "/"
    }

    if (opts.onClick) {
      const event: CheckoutClickEvent = {
        event: "reserve_click",
        path,
        headers: req.headers,
        searchParams: Object.fromEntries(params.entries()),
        experiment: exp,
      };
      const onClick = opts.onClick;
      const task = async () => {
        try {
          await onClick(event);
        } catch {
          // A missing click row is a smaller problem than a broken checkout redirect.
        }
      };
      if (opts.defer) opts.defer(task);
      else void task();
    }

    return new Response(null, { status: 302, headers: { Location: out.toString() } });
  };
}
