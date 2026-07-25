// ---------------------------------------------------------------------------
// Barttech shared ad-platform registry — the estate's advertising + remarketing
// plumbing, in one place.
//
// The rule this module encodes: adding a new ad platform must be ONE ENTRY IN A
// REGISTRY, never another estate-wide sweep. Every platform declares the same
// four things — what gates it (consent category), what hosts its CSP needs (per
// directive), how its tag loads, and what a valid tag id looks like — so a
// consumer's banner, CSP and tag-loading code are written once against
// `AD_PLATFORMS` and never touched again when TikTok or LinkedIn is added here.
//
// **NO IDs LIVE IN THIS FILE.** barttech-web-core is a PUBLIC repo. Every tag id
// (`AW-…`, a Meta pixel id) is passed in by the consuming app from its own env
// vars — `NEXT_PUBLIC_*`, set in Vercel + Doppler. Never hardcode one here, and
// never add a brand-identifying default.
//
// Nothing here loads without consent: `loadAdPlatforms` checks the
// `ConsentState` it is given and no-ops otherwise. Browser-oriented but
// SSR-safe — every function no-ops when `window`/`document` is undefined.
// Import as `@/web-core/adPlatforms`.
// ---------------------------------------------------------------------------
import type { ConsentCategory, ConsentState } from "./consent";

/**
 * A platform's hosts, split by the CSP directive each belongs in. Kept per
 * directive rather than one flat list because a host in the wrong directive
 * fails silently — the page renders, the build passes, and only the pixel is
 * missing.
 */
export interface AdPlatformCsp {
  /** Hosts serving the tag's JavaScript → `script-src`. */
  scriptSrc: readonly string[];
  /** Hosts the tag XHR/fetch/beacons to → `connect-src`. */
  connectSrc: readonly string[];
  /**
   * Hosts the tag loads 1×1 tracking pixels from → `img-src`.
   *
   * **This is the directive everyone forgets.** Ad platforms do a large part of
   * their conversion and remarketing work through IMAGE requests, not fetch:
   * Meta's `tr?id=…` beacon and Google's `ga-audiences` / conversion pings are
   * `<img>` loads. Allowlist them only in `script-src`/`connect-src` and the
   * tag "works" with no console error worth noticing, while the remarketing
   * audience never fills up.
   */
  imgSrc: readonly string[];
}

/**
 * One advertising platform. Add a new one by adding a single object to
 * {@link AD_PLATFORMS} — no other file in the estate should need editing.
 */
export interface AdPlatform {
  /** Stable registry key, also the config key callers pass ids under. */
  key: string;
  /** Human label, for a consent-preferences UI. */
  label: string;
  /**
   * The consent category that gates this platform — normally `"marketing"`.
   * Nothing here should ever be `"necessary"`: an ad tag is never strictly
   * necessary, and claiming otherwise is exactly the PECR breach the ICO acts on.
   */
  category: ConsentCategory;
  /** Every host this platform touches, deduped — the union of {@link csp}. */
  cspHosts: readonly string[];
  /** Those same hosts, split by directive. */
  csp: AdPlatformCsp;
  /**
   * Shape a valid tag id must match. Ids arrive from env vars, so this is
   * defence in depth: it stops a mis-set (or tampered) value being interpolated
   * into a script URL. A rejected id is a warn + no-op, never a thrown error.
   */
  idPattern: RegExp;
  /**
   * Inject the platform's tag. **Must be idempotent** — a SPA re-render, a
   * second consent event and a route change all re-enter this; injecting the
   * Meta pixel twice double-counts every PageView and corrupts the audience.
   */
  load(id: string): void;
}

// --- injection helpers -----------------------------------------------------

type TagFn = (...args: unknown[]) => void;

interface AdWindow {
  dataLayer?: unknown[];
  gtag?: TagFn;
  fbq?: TagFn & { callMethod?: TagFn; queue?: unknown[]; push?: unknown; loaded?: boolean; version?: string };
  _fbq?: unknown;
}

/**
 * The window, structurally typed — or null on the server.
 *
 * As in `consent.ts`, web-core does NOT `declare global` for `gtag`/`fbq`:
 * several consumers already declare those themselves, and a second global
 * augmentation with a different signature is a hard TS error that would break
 * them the moment this file is mounted.
 */
function adWindow(): AdWindow | null {
  return typeof window === "undefined" || typeof document === "undefined"
    ? null
    : (window as unknown as AdWindow);
}

/** Platform keys already loaded in this page's lifetime. */
const loaded = new Set<string>();

/**
 * Inject a `<script src>` once, keyed by a stable DOM id. Checks the DOM as well
 * as the module-level set, because a consumer can end up with two module
 * instances (a re-mounted submodule copy, a client/server bundle split) while
 * sharing one document.
 */
function injectScript(domId: string, src: string, attrs: Record<string, string> = {}): boolean {
  if (document.getElementById(domId)) return false;
  const script = document.createElement("script");
  script.id = domId;
  script.async = true;
  script.src = src;
  for (const [name, value] of Object.entries(attrs)) script.setAttribute(name, value);
  document.head.appendChild(script);
  return true;
}

/** `window.gtag`, creating Google's standard stub if gtag.js hasn't loaded. */
function ensureGtag(w: AdWindow): TagFn {
  const layer = (w.dataLayer = w.dataLayer ?? []);
  if (typeof w.gtag !== "function") {
    // Pushes the raw `arguments` object, exactly as Google's snippet does —
    // gtag.js replays Arguments objects off the dataLayer, not plain arrays.
    w.gtag = function gtagStub() {
      // eslint-disable-next-line prefer-rest-params
      layer.push(arguments);
    };
  }
  return w.gtag;
}

/** Build the deduped flat host list for a platform from its per-directive CSP. */
function flattenCsp(csp: AdPlatformCsp): readonly string[] {
  return Array.from(new Set([...csp.scriptSrc, ...csp.connectSrc, ...csp.imgSrc]));
}

/** Fill in `cspHosts` so each registry entry states its hosts exactly once. */
function definePlatform(platform: Omit<AdPlatform, "cspHosts">): AdPlatform {
  return { ...platform, cspHosts: flattenCsp(platform.csp) };
}

// --- the registry ----------------------------------------------------------

/**
 * Every ad platform the estate can run. **Adding a platform is one entry here.**
 *
 * See the commented skeleton below this object for the exact shape of a new
 * entry (TikTok/LinkedIn/Reddit).
 */
export const AD_PLATFORMS: Record<string, AdPlatform> = {
  /**
   * Google Ads — conversion tracking + remarketing audiences, via gtag.js with
   * an `AW-` id. Shares the gtag/dataLayer plumbing with GA4, so if the site
   * already loads a GA4 tag this only pushes an extra `config`.
   */
  google_ads: definePlatform({
    key: "google_ads",
    label: "Google Ads",
    category: "marketing",
    idPattern: /^AW-[A-Za-z0-9_-]{5,30}$/,
    csp: {
      scriptSrc: [
        "https://www.googletagmanager.com",
        "https://www.googleadservices.com",
        "https://googleads.g.doubleclick.net",
      ],
      connectSrc: [
        "https://googleads.g.doubleclick.net",
        "https://www.googleadservices.com",
        "https://stats.g.doubleclick.net",
        // Cross-domain conversion measurement (`/ccm/s/collect`). NOT the same
        // host as googleads.g.doubleclick.net, and easy to miss because the tag
        // only calls it once the `_gcl_au` linker cookie exists — so a quick
        // first-load test passes and a returning visitor gets a CSP error.
        // Found in a real browser 2026-07-25 while rolling ads out to the
        // brand sites; vendor docs do not list it.
        "https://ad.doubleclick.net",
        "https://www.google.com",
        "https://www.google.co.uk",
      ],
      // Conversion pings and the `pagead/1p-user-list` remarketing beacon are
      // IMAGE requests to google.com / google.<ccTLD> — hence the country host
      // too. Confirmed live: with both present, the remarketing user-list call
      // fires on google.com AND google.co.uk; drop either and half the audience
      // signal is silently blocked.
      imgSrc: [
        "https://googleads.g.doubleclick.net",
        "https://stats.g.doubleclick.net",
        "https://ad.doubleclick.net",
        "https://www.google.com",
        "https://www.google.co.uk",
        "https://www.googleadservices.com",
      ],
    },
    load(id: string) {
      const w = adWindow();
      if (!w) return;

      // gtag.js may already be present for GA4. Loading it again under a
      // different id is harmless but pointless, so key the script on the id.
      injectScript(
        "barttech-gtag-ads",
        `https://www.googletagmanager.com/gtag/js?id=${encodeURIComponent(id)}`
      );

      const gtag = ensureGtag(w);
      gtag("js", new Date());
      // `conversion_linker` is what writes the `_gcl_*` first-party cookie that
      // links an ad click to a later conversion. Without it, cross-domain and
      // ITP-restricted journeys lose attribution entirely.
      gtag("config", id, { conversion_linker: true });
    },
  }),

  /**
   * Meta (Facebook/Instagram) — pixel init + PageView. Server-side CAPI events
   * are a per-repo concern (they need the app's own access token and event
   * dedup id) and stay in that repo's `lib/meta-capi.ts`.
   */
  meta: definePlatform({
    key: "meta",
    label: "Meta (Facebook & Instagram)",
    category: "marketing",
    idPattern: /^\d{10,20}$/,
    csp: {
      scriptSrc: ["https://connect.facebook.net"],
      connectSrc: ["https://www.facebook.com"],
      // `https://www.facebook.com/tr?id=…` is an <img>, not a fetch. Miss this
      // and the pixel silently records nothing.
      imgSrc: ["https://www.facebook.com"],
    },
    load(id: string) {
      const w = adWindow();
      if (!w) return;

      // Meta's standard stub queues calls until fbevents.js replays them.
      if (typeof w.fbq !== "function") {
        const fbq = function fbqStub(...args: unknown[]) {
          const self = fbq as unknown as { callMethod?: TagFn; queue: unknown[] };
          if (self.callMethod) self.callMethod(...args);
          else self.queue.push(args);
        } as AdWindow["fbq"] & { queue: unknown[]; loaded: boolean; version: string; push: unknown };

        fbq.queue = [];
        fbq.loaded = true;
        fbq.version = "2.0";
        fbq.push = fbq;
        w.fbq = fbq;
        w._fbq = w._fbq ?? fbq;
      }

      injectScript("barttech-meta-pixel", "https://connect.facebook.net/en_US/fbevents.js");

      // Guarded by `loadAdPlatforms`' own once-per-key set as well — a second
      // init+PageView double-counts every visit and skews the audience.
      w.fbq?.("init", id);
      w.fbq?.("track", "PageView");
    },
  }),

  // -------------------------------------------------------------------------
  // ADDING A PLATFORM — copy this skeleton, fill it in, done. No other file in
  // the estate changes: the banner, the CSP builder and `loadAdPlatforms` all
  // read this registry. The consuming app then passes its id from an env var:
  //   loadAdPlatforms({ tiktok: process.env.NEXT_PUBLIC_TIKTOK_PIXEL_ID }, state)
  //
  // tiktok: definePlatform({
  //   key: "tiktok",
  //   label: "TikTok",
  //   category: "marketing",
  //   idPattern: /^[A-Z0-9]{15,25}$/,
  //   csp: {
  //     scriptSrc: ["https://analytics.tiktok.com"],
  //     connectSrc: ["https://analytics.tiktok.com"],
  //     imgSrc: ["https://analytics.tiktok.com"],
  //   },
  //   load(id: string) {
  //     const w = adWindow();
  //     if (!w) return;
  //     injectScript("barttech-tiktok-pixel", `https://analytics.tiktok.com/i18n/pixel/events.js?sdkid=${encodeURIComponent(id)}`);
  //     // …platform's own init + PageView call here.
  //   },
  // }),
  //
  // Same shape for LinkedIn Insight (`snap.licdn.com` + `px.ads.linkedin.com`
  // — the LinkedIn conversion beacon is an <img>, so it needs `imgSrc`) and
  // Reddit (`www.redditstatic.com` + `alb.reddit.com`). VERIFY each host list
  // against a real browser network tab before committing it; vendor docs are
  // routinely incomplete about the image endpoints.
  // -------------------------------------------------------------------------
};

// --- CSP constants ---------------------------------------------------------

/** Merge a list of host lists into one deduped, sorted array. */
function mergeHosts(...lists: readonly (readonly string[])[]): readonly string[] {
  return Array.from(new Set(lists.flat())).sort();
}

/**
 * Every ad-platform host in the registry, deduped and split by CSP directive.
 * Build the consuming app's `next.config.ts` CSP from these constants rather
 * than hand-maintaining hostname lists — that is how the estate's GA4 hosts
 * drifted wrong in seven repos at once.
 *
 * ```ts
 * const csp = [
 *   `script-src 'self' 'unsafe-inline' ${[...ANALYTICS_CSP_HOSTS.scriptSrc, ...AD_CSP_HOSTS.scriptSrc].join(" ")}`,
 *   `connect-src 'self' ${[...ANALYTICS_CSP_HOSTS.connectSrc, ...AD_CSP_HOSTS.connectSrc].join(" ")}`,
 *   `img-src 'self' data: ${[...ANALYTICS_CSP_HOSTS.imgSrc, ...AD_CSP_HOSTS.imgSrc].join(" ")}`,
 * ].join("; ");
 * ```
 *
 * **Only add these to a site that actually runs ads AND discloses advertising /
 * remarketing cookies in its `/privacy`.** Several estate sites deliberately
 * block the doubleclick hosts because their privacy policy is analytics-only
 * (website security standard §2) — allowlisting ad-tech a policy says isn't
 * there is a compliance problem, not a convenience.
 *
 * Never remove `'unsafe-inline'` from `script-src` while adding these: Next.js
 * App Router injects inline hydration scripts and no estate repo issues a
 * per-request nonce. Dropping it blanks the site in a real browser while curl
 * still returns 200.
 */
export const AD_CSP_HOSTS: AdPlatformCsp = {
  scriptSrc: mergeHosts(...Object.values(AD_PLATFORMS).map((p) => p.csp.scriptSrc)),
  connectSrc: mergeHosts(...Object.values(AD_PLATFORMS).map((p) => p.csp.connectSrc)),
  imgSrc: mergeHosts(...Object.values(AD_PLATFORMS).map((p) => p.csp.imgSrc)),
};

/**
 * GA4 + Google Tag Manager hosts, by directive. Here so a consumer builds its
 * WHOLE analytics+ads CSP from these constants instead of copying hostnames
 * between repos.
 *
 * **The wildcards are mandatory and the near-identical pair is a trap.** GA4
 * does not post to one fixed host — gtag picks a REGIONAL collection endpoint
 * and sends `/g/collect` to e.g. `https://region1.analytics.google.com`. A bare
 * host in CSP does not cover subdomains, so `https://analytics.google.com`
 * never matches `region1.analytics.google.com`.
 *
 * The killer detail: `region1.google-analytics.com` and
 * `region1.analytics.google.com` are DIFFERENT DOMAINS. Almost every repo in
 * this estate allowlisted the first — which looks right at a glance and matches
 * nothing GA4 actually sends. The build passed, `tsc` passed, `curl -I` returned
 * a valid-looking CSP header, and the only symptom was missing GA4 data, easily
 * misread as a traffic drought. It survived multiple CSP audits across 7 repos
 * until it was found and fixed on 2026-07-25. Only a real browser shows it, as
 * `Refused to connect to 'https://region1.analytics.google.com/g/collect…'`.
 *
 * Verify on the LIVE served header after every deploy, not just in the config:
 * `curl -sI "https://<domain>" | tr -d '\r' | grep -i '^content-security-policy'`
 * — it must contain `https://*.analytics.google.com`.
 */
export const ANALYTICS_CSP_HOSTS: AdPlatformCsp = {
  scriptSrc: ["https://www.googletagmanager.com"],
  connectSrc: [
    // Wildcards first — these are the ones that actually match what GA4 sends.
    "https://*.analytics.google.com",
    "https://*.google-analytics.com",
    // Kept explicit for readability; both are covered by the wildcards above.
    "https://analytics.google.com",
    "https://www.google-analytics.com",
    "https://www.googletagmanager.com",
  ],
  imgSrc: ["https://www.google-analytics.com", "https://www.googletagmanager.com"],
};

// --- loading ---------------------------------------------------------------

/**
 * Tag ids keyed by {@link AD_PLATFORMS} key. Values come from the consuming
 * app's env vars — an absent/empty value simply means "this brand doesn't run
 * that platform", which is the normal case for most keys.
 */
export type AdPlatformConfig = Partial<Record<string, string | undefined>>;

/**
 * Load every configured platform whose gating consent category has been
 * granted. No-ops for anything unconsented, unconfigured, unknown, or already
 * loaded — and entirely on the server.
 *
 * Safe to call on every render/route change and on every consent event: each
 * platform loads at most once per page lifetime. Returns the keys it loaded THIS
 * call (useful in tests; ignore it in app code).
 *
 * Withdrawal note: a tag already injected stays in the document until the next
 * navigation. Stopping it is Consent Mode's job (`updateConsentMode` in
 * `consent.ts`, called for you by `writeConsent`) plus the natural page reload —
 * do not try to "unload" a pixel, there is no supported way to do it.
 *
 * ```ts
 * loadAdPlatforms(
 *   {
 *     google_ads: process.env.NEXT_PUBLIC_GOOGLE_ADS_ID,
 *     meta: process.env.NEXT_PUBLIC_META_PIXEL_ID,
 *   },
 *   readConsent()
 * );
 * ```
 */
export function loadAdPlatforms(
  config: AdPlatformConfig,
  state: ConsentState | null
): readonly string[] {
  if (!adWindow()) return [];
  // No recorded choice = no consent. Never treat a missing state as a grant.
  if (!state) return [];

  const justLoaded: string[] = [];

  for (const [key, id] of Object.entries(config)) {
    if (!id) continue;

    const platform = AD_PLATFORMS[key];
    if (!platform) {
      console.warn(`[ads] unknown platform "${key}" — add it to AD_PLATFORMS`);
      continue;
    }

    if (!isCategoryGranted(platform.category, state)) continue;
    if (loaded.has(key)) continue;

    if (!platform.idPattern.test(id)) {
      // Never interpolate an unexpected value into a script URL, and never
      // print the id itself — this runs in the browser console on a live site.
      console.warn(`[ads] "${key}" tag id is not in the expected format — skipped`);
      continue;
    }

    try {
      platform.load(id);
      loaded.add(key);
      justLoaded.push(key);
    } catch (err) {
      // A failed ad tag must never break the page.
      console.error(`[ads] "${key}" failed to load:`, err instanceof Error ? err.message : String(err));
    }
  }

  return justLoaded;
}

/** Is this consent category granted by the given state? */
function isCategoryGranted(category: ConsentCategory, state: ConsentState): boolean {
  if (category === "necessary") return true;
  return category === "analytics" ? state.analytics : state.marketing;
}

/**
 * Platforms that would load for a given config + consent state, without loading
 * them. For a preferences UI ("you have consented to: Google Ads, Meta") or a
 * debug panel.
 */
export function eligibleAdPlatforms(
  config: AdPlatformConfig,
  state: ConsentState | null
): readonly AdPlatform[] {
  if (!state) return [];
  return Object.entries(config)
    .filter(([key, id]) => Boolean(id) && AD_PLATFORMS[key])
    .map(([key]) => AD_PLATFORMS[key] as AdPlatform)
    .filter((platform) => isCategoryGranted(platform.category, state));
}
