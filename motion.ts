/**
 * Shared scroll motion — reveal-on-entry, staggered siblings and count-up
 * numbers — driven by data attributes and styled by `motion.css`.
 *
 * Framework-free on purpose (golden rule 6): one `initMotion()` call from a
 * single client component in the consumer's root layout wires up every page,
 * and the markup side is plain attributes, so the elements that animate can
 * stay server components. No animation library is loaded — the transitions are
 * CSS, and parallax / scroll-progress (see `motion.css`) are CSS scroll-driven
 * animations with no JavaScript at all.
 *
 * Markup contract:
 *   data-reveal                 rise + fade on entry (default)
 *   data-reveal="fade|left|right|scale"   variant
 *   data-reveal-stagger="60"    on a PARENT: its [data-reveal] children get
 *                               increasing delays (ms per step, capped)
 *   data-count-to="1250"        on an element whose server-rendered text is
 *                               ALREADY the final value; counts up from 0 on
 *                               entry. Optional data-count-decimals,
 *                               data-count-prefix, data-count-suffix.
 *
 * Three properties are load-bearing, and each exists because the naive version
 * is worse than no motion at all:
 *
 * 1. PROGRESSIVE ENHANCEMENT. The hidden start state only applies once
 *    `initMotion()` has put `wc-motion` on <html>. Without JavaScript — a
 *    crawler, a failed chunk, a blocked script — every element is simply
 *    visible. The obvious CSS (`[data-reveal] { opacity: 0 }`) ships a blank
 *    page to anything that does not run the script.
 *
 * 2. ABOVE THE FOLD NEVER ANIMATES. Elements already in the viewport when they
 *    are first seen are marked revealed synchronously, before the class that
 *    hides things is added. Hiding the hero and fading it in delays Largest
 *    Contentful Paint — on the pages paid traffic lands on — and flashes
 *    content the visitor was already looking at.
 *
 * 3. REDUCED MOTION IS HONOURED HERE, NOT JUST IN CSS. When the user asks for
 *    reduced motion nothing is hidden and no count-up runs; the server-rendered
 *    text stands.
 *
 * New content from client-side navigation is picked up by a MutationObserver,
 * so a single init in the root layout covers every route.
 */

export const MOTION_READY_CLASS = "wc-motion";
export const REVEAL_SELECTOR = "[data-reveal]";
export const COUNT_SELECTOR = "[data-count-to]";
/** Set on an element once it has been revealed. An attribute, not a class, so it can never collide with a site's own `.is-visible`. */
export const REVEALED_ATTR = "data-revealed";

/** Stagger steps are capped so a 20-item list does not take 1.2s to finish appearing. */
export const MAX_STAGGER_STEPS = 8;

export function staggerDelay(index: number, stepMs: number, maxSteps = MAX_STAGGER_STEPS): number {
  if (!Number.isFinite(index) || !Number.isFinite(stepMs) || index < 0 || stepMs <= 0) return 0;
  return Math.min(Math.floor(index), maxSteps) * stepMs;
}

export function easeOutCubic(t: number): number {
  const c = Math.min(1, Math.max(0, t));
  return 1 - Math.pow(1 - c, 3);
}

export interface CountFormat {
  decimals?: number;
  prefix?: string;
  suffix?: string;
  locale?: string;
}

export function formatCount(value: number, fmt: CountFormat = {}): string {
  const decimals = fmt.decimals ?? 0;
  const n = value.toLocaleString(fmt.locale ?? "en-GB", {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
  return `${fmt.prefix ?? ""}${n}${fmt.suffix ?? ""}`;
}

/** Parses `data-count-to`, tolerating thousands separators. Returns null for anything that is not a finite number, so a typo leaves the server text alone rather than counting to NaN. */
export function parseCountTarget(raw: string | null | undefined): number | null {
  if (raw == null) return null;
  const cleaned = raw.replace(/[,\s_]/g, "");
  if (cleaned === "") return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

/** True when any part of the rect is inside a viewport of the given height. */
export function isInViewport(rect: { top: number; bottom: number }, viewportHeight: number): boolean {
  return rect.bottom > 0 && rect.top < viewportHeight;
}

export interface MotionOptions {
  /** Where to look for motion elements. Defaults to `document`. */
  root?: ParentNode;
  /** Count-up duration in ms. */
  countDurationMs?: number;
  /** IntersectionObserver rootMargin — negative bottom means "a little way in", not "the first pixel". */
  rootMargin?: string;
}

/**
 * Wires up every motion element under `root`, now and as content is added.
 * Returns a cleanup function. Safe to call on the server or in a non-DOM
 * runtime — it no-ops.
 */
export function initMotion(opts: MotionOptions = {}): () => void {
  if (typeof window === "undefined" || typeof document === "undefined") return () => {};

  const root: ParentNode = opts.root ?? document;
  const countDurationMs = opts.countDurationMs ?? 1400;
  const reduced =
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  // Reduced motion, or a browser with no IntersectionObserver: never hide
  // anything, never count. The server-rendered page is the page.
  if (reduced || typeof IntersectionObserver === "undefined") return () => {};

  const seen = new WeakSet<Element>();
  const frames = new Set<number>();

  const reveal = (el: Element) => el.setAttribute(REVEALED_ATTR, "");

  const runCount = (el: HTMLElement) => {
    const to = parseCountTarget(el.getAttribute("data-count-to"));
    if (to === null) return;
    const fmt: CountFormat = {
      decimals: parseCountTarget(el.getAttribute("data-count-decimals")) ?? 0,
      prefix: el.getAttribute("data-count-prefix") ?? "",
      suffix: el.getAttribute("data-count-suffix") ?? "",
    };
    const start = performance.now();
    const step = (now: number) => {
      const t = (now - start) / countDurationMs;
      el.textContent = formatCount(to * easeOutCubic(t), fmt);
      if (t < 1) {
        const id = requestAnimationFrame(step);
        frames.add(id);
      } else {
        el.textContent = formatCount(to, fmt);
      }
    };
    el.textContent = formatCount(0, fmt);
    frames.add(requestAnimationFrame(step));
  };

  const io = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        const el = entry.target as HTMLElement;
        io.unobserve(el);
        if (el.matches(REVEAL_SELECTOR)) reveal(el);
        if (el.matches(COUNT_SELECTOR)) runCount(el);
      }
    },
    { rootMargin: opts.rootMargin ?? "0px 0px -8% 0px", threshold: 0.05 },
  );

  const applyStagger = (scope: ParentNode) => {
    scope.querySelectorAll<HTMLElement>("[data-reveal-stagger]").forEach((parent) => {
      const step = parseCountTarget(parent.getAttribute("data-reveal-stagger")) ?? 60;
      let i = 0;
      parent.querySelectorAll<HTMLElement>(REVEAL_SELECTOR).forEach((child) => {
        if (child.closest("[data-reveal-stagger]") !== parent) return;
        if (!child.style.getPropertyValue("--wc-reveal-delay")) {
          child.style.setProperty("--wc-reveal-delay", `${staggerDelay(i, step)}ms`);
        }
        i += 1;
      });
    });
  };

  const register = (scope: ParentNode) => {
    applyStagger(scope);
    const vh = window.innerHeight;
    const els: Element[] = [];
    if (scope instanceof Element && scope.matches(`${REVEAL_SELECTOR}, ${COUNT_SELECTOR}`)) els.push(scope);
    scope.querySelectorAll(`${REVEAL_SELECTOR}, ${COUNT_SELECTOR}`).forEach((el) => els.push(el));
    for (const el of els) {
      if (seen.has(el)) continue;
      seen.add(el);
      // Property 2: already on screen → shown as-is, no animation, no count.
      if (isInViewport(el.getBoundingClientRect(), vh)) {
        if (el.matches(REVEAL_SELECTOR)) reveal(el);
        continue;
      }
      io.observe(el);
    }
  };

  register(root);
  // Only now is it safe to hide what has not been revealed (property 1 + 2).
  document.documentElement.classList.add(MOTION_READY_CLASS);

  const mo =
    typeof MutationObserver === "undefined"
      ? null
      : new MutationObserver((records) => {
          for (const r of records) {
            r.addedNodes.forEach((node) => {
              if (node.nodeType === 1) register(node as Element);
            });
          }
        });
  mo?.observe(root instanceof Document ? root.body : (root as Node), { childList: true, subtree: true });

  return () => {
    io.disconnect();
    mo?.disconnect();
    frames.forEach((id) => cancelAnimationFrame(id));
    frames.clear();
    document.documentElement.classList.remove(MOTION_READY_CLASS);
  };
}
