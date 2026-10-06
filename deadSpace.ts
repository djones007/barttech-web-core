// ---------------------------------------------------------------------------
// Dead-space / padding audit — the shared measurement every repo's mobile spec calls.
//
// WHY: playthestillroom.com/v3 on a phone showed ~150px of empty black under the hero
// (84px of hero bottom padding stacked on 72px of next-section top padding) and no
// audit caught it: every other check in a mobile spec measures things that are THERE;
// none measured the absence of anything. Dead space also cannot be found by reading
// CSS — two harmless paddings add up — so it is measured on the rendered page.
//
// HOW: at 390x844 and 1440x900, freeze animations, scroll the whole page so
// reveal-on-scroll lands, collect rects of visible text ranges, img, video, iframe,
// buttons and form controls, and merge their vertical extents. An uncovered stretch
// between two blocks is a gap. A gap over the limit fails UNLESS the band has texture
// (stddev of luma > FLAT_STDDEV in a screenshot of the band — a background image or
// graphic is showing; a FLAT band is dead space whatever the CSS says) or holds a
// decorative svg/canvas. Also fails: content still at opacity 0 after the scroll pass
// (a reveal that never fires) and empty elements taller than EMPTY_BOX_MAX_PX.
//
// CANONICAL SOURCE of the thresholds: the root barttech-os repo —
//   tools/page-readability-audit.py (GAP_LIMITS, FLAT_STDDEV, band_stats)
//   tools/playwright/scripts/readability-capture.js (SPACING walk, empty_boxes)
// If you change a threshold or the block walk, change those first and mirror here.
// This module is the ONE TypeScript copy; repos import it, they never paste it —
// the copy that was pasted into the starter template's spec on 2026-10-01 is what
// this replaces.
//
// FRAMEWORK-AGNOSTIC: no Playwright import (golden rule 1d — web-core takes no test
// runner dependency). The helpers take a structural `DeadSpacePage`, which a
// Playwright `Page` satisfies. The two `page.evaluate` callbacks are SERIALISED to
// the browser as source, so they close over nothing from module scope — see
// deadSpace.test.ts, which fails if someone factors a constant out of them.
//
// USAGE (a repo's tests/mobile.spec.ts):
//   await page.setViewportSize({ width: v.w, height: v.h });
//   await page.goto(route, { waitUntil: "load" }); await waitForDomStable(page);
//   const r = await auditDeadSpace(page, v);
//   expect(r.blocks, DEAD_SPACE_NO_BLOCKS_MESSAGE).toBeGreaterThan(0);
//   expect.soft(r.bad, deadSpaceGapMessage(v)).toEqual([]);
//   expect.soft(r.revealStuck, deadSpaceRevealMessage(v)).toEqual([]);
//   expect.soft(r.emptyBoxes, deadSpaceEmptyBoxMessage(v)).toEqual([]);
// ---------------------------------------------------------------------------

/** The slice of a Playwright `Page` this module uses. */
export interface DeadSpacePage {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  evaluate: (fn: any, arg?: any) => Promise<any>;
  screenshot: (opts: {
    fullPage: boolean;
    clip: { x: number; y: number; width: number; height: number };
  }) => Promise<{ toString(encoding: "base64"): string }>;
  addStyleTag: (opts: { content: string }) => Promise<unknown>;
  waitForTimeout: (ms: number) => Promise<void>;
}

/** px gap that fails: [phone 390, desktop 1440]. Canonical: GAP_LIMITS in page-readability-audit.py */
export const DEAD_SPACE_FAIL_PX = { phone: 120, desktop: 200 } as const;
/** Mean within-row luma stddev above this = something is drawn in the band. Canonical: FLAT_STDDEV */
export const FLAT_STDDEV = 9;
/** Empty-element height that fails. Canonical: empty_boxes in readability-capture.js */
export const EMPTY_BOX_MAX_PX = 40;

export interface DeadSpaceViewport {
  w: number;
  h: number;
  name: string;
  failPx: number;
}
export const DEAD_SPACE_VIEWPORTS: readonly DeadSpaceViewport[] = [
  { w: 390, h: 844, name: "phone", failPx: DEAD_SPACE_FAIL_PX.phone },
  { w: 1440, h: 900, name: "desktop", failPx: DEAD_SPACE_FAIL_PX.desktop },
];

export interface DeadSpaceGap {
  kind: string;
  y: number;
  h: number;
  above: string;
  below: string;
  /** a neighbouring block sits in a viewport-filling (min-h-screen) section */
  vfill: boolean;
}
export interface DeadSpaceScan {
  gaps: DeadSpaceGap[];
  decor: { kind: string; top: number; bottom: number }[];
  revealStuck: string[];
  emptyBoxes: string[];
  blocks: number;
}

/** Port of readability-capture.js SPACING (measurement only; judgement is in the test). */
export async function scanDeadSpace(page: DeadSpacePage, emptyBoxMaxPx: number): Promise<DeadSpaceScan> {
  return page.evaluate((emptyMax: number) => {
    const MIN_REPORT = 48;
    const pageH = document.documentElement.scrollHeight;
    const label = (el: Element) =>
      el.tagName.toLowerCase() +
      (el.id ? "#" + el.id : "") +
      (typeof (el as HTMLElement).className === "string" && (el as HTMLElement).className.trim()
        ? "." + (el as HTMLElement).className.trim().split(/\s+/).slice(0, 2).join(".")
        : "");
    const effOpacity = (el: Element) => {
      let e = 1;
      for (let n: Element | null = el; n && n.nodeType === 1; n = n.parentElement)
        e *= parseFloat(getComputedStyle(n).opacity);
      return e;
    };
    const clipped = (el: Element, r: { top: number; bottom: number; left: number; right: number }) => {
      for (let n = el.parentElement; n && n !== document.body; n = n.parentElement) {
        const s = getComputedStyle(n);
        if (s.overflow !== "visible" || s.overflowY !== "visible" || s.overflowX !== "visible") {
          const pr = n.getBoundingClientRect();
          if (pr.height <= 1 || pr.width <= 1) return true;
          if (r.bottom <= pr.top + 1 || r.top >= pr.bottom - 1 || r.right <= pr.left + 1 || r.left >= pr.right - 1)
            return true;
        }
      }
      return false;
    };
    const toAbs = (r: { top: number; bottom: number; left: number; right: number }) => ({
      top: r.top + scrollY,
      bottom: r.bottom + scrollY,
      left: r.left + scrollX,
      right: r.right + scrollX,
    });
    const visible = (el: Element) => {
      const cs = getComputedStyle(el);
      return cs.display !== "none" && cs.visibility !== "hidden" && effOpacity(el) >= 0.05;
    };

    type Block = { top: number; bottom: number; kind: string; el: string; text: string; vfill: boolean };
    const blocks: Block[] = [];
    const add = (el: Element, r: { top: number; bottom: number; left: number; right: number }, kind: string, text: string) => {
      if (r.right - r.left < 8 || r.bottom - r.top < 8) return;
      if (r.right <= 0 || r.left >= innerWidth || r.bottom <= 0) return;
      if (clipped(el, r)) return;
      const a = toAbs(r);
      // DIVERGENCE FROM CANONICAL (port back): content inside a section whose min-height
      // fills the viewport (min-h-screen / 100vh) is centred or pinned on purpose; the
      // slack around it is layout, not stacked padding.
      let vfill = false;
      for (let n: Element | null = el; n && n !== document.body; n = n.parentElement)
        if (parseFloat(getComputedStyle(n).minHeight) >= innerHeight * 0.9) { vfill = true; break; }
      blocks.push({ top: a.top, bottom: a.bottom, kind, el: label(el), text: (text || "").slice(0, 40), vfill });
    };
    const SKIP = ["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "SVG", "PATH", "DEFS", "OPTION", "BR", "HEAD"];
    document.querySelectorAll("body *").forEach((el) => {
      const tag = el.tagName;
      if (SKIP.includes(tag.toUpperCase()) || el.closest("svg")) return;
      if (!visible(el)) return;
      const cs = getComputedStyle(el);
      if (["IMG", "VIDEO", "IFRAME"].includes(tag)) {
        add(el, el.getBoundingClientRect(), tag.toLowerCase(), (el as HTMLImageElement).alt || "");
        return;
      }
      if (["INPUT", "SELECT", "TEXTAREA"].includes(tag)) {
        if ((el as HTMLInputElement).type !== "hidden") add(el, el.getBoundingClientRect(), "form", "");
        return;
      }
      const own = Array.from(el.childNodes).filter((n) => n.nodeType === 3 && (n.textContent || "").trim().length);
      if (!own.length) return;
      if (parseFloat(cs.fontSize) < 1 || /rgba\(\d+, \d+, \d+, 0\)/.test(cs.color)) return;
      const boxed =
        tag === "BUTTON" ||
        (tag === "A" && /btn|button|cta/i.test((el as HTMLElement).className + "")) ||
        el.getAttribute("role") === "button" ||
        ((tag === "A" || tag === "LABEL" || tag === "SPAN") &&
          cs.display !== "inline" &&
          (cs.backgroundColor !== "rgba(0, 0, 0, 0)" || parseFloat(cs.borderTopWidth) > 0));
      if (boxed) {
        add(el, el.getBoundingClientRect(), tag === "BUTTON" || tag === "A" ? "button" : "text", (own[0].textContent || "").trim());
        return;
      }
      // Union of the element's OWN text nodes only (not descendants' text).
      const range = document.createRange();
      let top = Infinity, bottom = -Infinity, left = Infinity, right = -Infinity;
      for (const n of own) {
        range.selectNodeContents(n);
        for (const rc of Array.from(range.getClientRects())) {
          if (rc.width < 1 || rc.height < 1) continue;
          top = Math.min(top, rc.top); bottom = Math.max(bottom, rc.bottom);
          left = Math.min(left, rc.left); right = Math.max(right, rc.right);
        }
      }
      if (top === Infinity) return;
      add(el, { top, bottom, left, right }, "text", (own[0].textContent || "").trim());
    });
    blocks.sort((a, b) => a.top - b.top);

    // Sweep: merge overlapping vertical extents; a gap is an uncovered stretch between two blocks.
    const gaps: DeadSpaceGap[] = [];
    let cur: Block | null = null;
    const first = blocks[0];
    if (first && first.top >= MIN_REPORT)
      gaps.push({ kind: "top", y: 0, h: Math.round(first.top), above: "page top", below: `${first.el} '${first.text}'`, vfill: first.vfill });
    for (const b of blocks) {
      if (cur && b.top - cur.bottom >= MIN_REPORT)
        gaps.push({
          kind: "between",
          y: Math.round(cur.bottom),
          h: Math.round(b.top - cur.bottom),
          above: `${cur.el} '${cur.text}'`,
          below: `${b.el} '${b.text}'`,
          vfill: cur.vfill || b.vfill,
        });
      if (!cur || b.bottom > cur.bottom) cur = b;
    }
    if (cur && pageH - cur.bottom >= MIN_REPORT)
      gaps.push({ kind: "tail", y: Math.round(cur.bottom), h: Math.round(pageH - cur.bottom), above: `${cur.el} '${cur.text}'`, below: "page end", vfill: cur.vfill });

    // Decorative svg/canvas: a gap that holds one is deliberate.
    const decor: { kind: string; top: number; bottom: number }[] = [];
    document.querySelectorAll("body *").forEach((el) => {
      const tag = el.tagName.toLowerCase();
      if ((tag !== "svg" && tag !== "canvas") || (tag === "svg" && el.parentElement?.closest("svg"))) return;
      if (!visible(el)) return;
      const r = el.getBoundingClientRect();
      if (r.width >= 40 && r.height >= 40 && !clipped(el, r)) {
        const a = toAbs(r);
        decor.push({ kind: tag, top: a.top, bottom: a.bottom });
      }
    });

    // Reveal-on-scroll content still invisible after the scroll pass.
    const revealStuck: string[] = [];
    document.querySelectorAll("body *").forEach((el) => {
      const cs = getComputedStyle(el);
      if (cs.display === "none" || cs.visibility === "hidden" || parseFloat(cs.opacity) >= 0.05) return;
      if (el.closest('[aria-hidden="true"],[hidden],dialog:not([open]),details:not([open]),[inert],svg,select,[role=tooltip],[role=dialog]')) return;
      const r = el.getBoundingClientRect();
      if (r.width < 40 || r.height < 20 || r.right <= 0 || r.left >= innerWidth) return;
      if (el.parentElement && parseFloat(getComputedStyle(el.parentElement).opacity) < 0.05) return;
      if (clipped(el, r)) return;
      const text = ((el as HTMLElement).innerText || "").trim();
      if (text.length > 2 || el.querySelector("img,video,button,a,input"))
        revealStuck.push(`${label(el)} '${text.slice(0, 50)}' y=${Math.round(r.top + scrollY)} h=${Math.round(r.height)}`);
    });

    // Empty boxes: no text/media/form content, no paint of their own, still taking height.
    const MEDIA = "img,video,iframe,canvas,svg,input,select,textarea,button,picture,object,embed,audio";
    const paints = (el: Element) => {
      const s = getComputedStyle(el);
      return s.backgroundColor !== "rgba(0, 0, 0, 0)" || s.backgroundImage !== "none" ||
        parseFloat(s.borderTopWidth) > 0 || parseFloat(s.borderBottomWidth) > 0 || s.boxShadow !== "none";
    };
    const emptyBoxes: string[] = [];
    document.querySelectorAll("body div,body section,body span,body p,body li,body aside,body article,body header,body main").forEach((el) => {
      const cs = getComputedStyle(el);
      if (cs.display === "none" || cs.visibility === "hidden" || /absolute|fixed/.test(cs.position)) return;
      const r = el.getBoundingClientRect();
      if (r.height <= emptyMax || r.width < 8) return;
      if ((el.textContent || "").trim().length || el.querySelector(MEDIA)) return;
      if (paints(el) || Array.from(el.querySelectorAll("*")).some(paints)) return;
      const p = el.parentElement;
      if (p && p !== document.body && !(p.textContent || "").trim().length && !p.querySelector(MEDIA)) {
        // Report only the topmost empty ancestor.
        if (!paints(p) && !/absolute|fixed/.test(getComputedStyle(p).position) && p.getBoundingClientRect().height > emptyMax) return;
      }
      emptyBoxes.push(`${label(el)} y=${Math.round(r.top + scrollY)} h=${Math.round(r.height)}`);
    });

    return { gaps, decor, revealStuck, emptyBoxes, blocks: blocks.length };
  }, emptyBoxMaxPx);
}

/**
 * Mean within-row luma stddev of a horizontal band — port of band_stats() in
 * page-readability-audit.py (4% trimmed each edge, downscaled to <=240x120).
 * Decoded in the browser via canvas so no image dependency is needed.
 */
export async function bandTextureStddev(page: DeadSpacePage, y: number, h: number): Promise<number> {
  const width = await page.evaluate(() => document.documentElement.clientWidth);
  const buf = await page.screenshot({ fullPage: true, clip: { x: 0, y, width, height: h } });
  return page.evaluate(async (b64: string) => {
    const img = new Image();
    img.src = "data:image/png;base64," + b64;
    await img.decode();
    const m = Math.floor(img.height * 0.04);
    const sh = img.height - 2 * m;
    if (sh < 4) return 0;
    const cw = Math.min(img.width, 240), ch = Math.min(sh, 120);
    const c = document.createElement("canvas");
    c.width = cw; c.height = ch;
    const ctx = c.getContext("2d")!;
    ctx.drawImage(img, 0, m, img.width, sh, 0, 0, cw, ch);
    const d = ctx.getImageData(0, 0, cw, ch).data;
    let total = 0;
    for (let r = 0; r < ch; r++) {
      const row: number[] = [];
      for (let x = 0; x < cw; x++) {
        const i = (r * cw + x) * 4;
        row.push(0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]);
      }
      const mu = row.reduce((s, v) => s + v, 0) / cw;
      total += Math.sqrt(row.reduce((s, v) => s + (v - mu) ** 2, 0) / cw);
    }
    return total / ch;
  }, buf.toString("base64"));
}


/** What {@link auditDeadSpace} reports; every list empty (and blocks > 0) means pass. */
export interface DeadSpaceResult {
  /** Content blocks found. 0 means the page did not render and nothing was judged. */
  blocks: number;
  /** Over-limit flat gaps, one legible line each. */
  bad: string[];
  revealStuck: string[];
  emptyBoxes: string[];
}

/**
 * Judge a scan. Pure apart from the `texture` callback, so it is unit-tested with
 * canned scans. `scrolls` = the document is taller than the viewport.
 */
export async function judgeDeadSpace(
  scan: DeadSpaceScan,
  opts: { scrolls: boolean; failPx: number },
  texture: (y: number, h: number) => Promise<number>
): Promise<DeadSpaceResult> {
  const bad: string[] = [];
  for (const g of scan.gaps) {
    // DIVERGENCE FROM CANONICAL (port back): a page that does not scroll at all has
    // slack from viewport-filling layouts (min-h-screen, a centred card, a sticky
    // footer), not from padding; so does any gap beside a min-h-screen section.
    if (!opts.scrolls || g.vfill) continue;
    if (g.h <= opts.failPx) continue;
    const holdsDecor = scan.decor.some((d) => Math.min(d.bottom, g.y + g.h) - Math.max(d.top, g.y) >= 0.4 * g.h);
    if (holdsDecor) continue;
    const sd = await texture(g.y, g.h);
    if (sd > FLAT_STDDEV) continue;
    bad.push(`${g.h}px of dead space at y=${g.y} (${g.kind}) between ${g.above} and ${g.below} (band stddev ${sd.toFixed(1)})`);
  }
  return { blocks: scan.blocks, bad, revealStuck: scan.revealStuck, emptyBoxes: scan.emptyBoxes };
}

/**
 * Run the whole audit on a page the caller has ALREADY navigated to and settled at
 * the viewport (setViewportSize + goto + the repo's own waitForDomStable — those stay
 * per-repo because routes and stability rules differ).
 */
export async function auditDeadSpace(
  page: DeadSpacePage,
  viewport: Pick<DeadSpaceViewport, "h" | "failPx">
): Promise<DeadSpaceResult> {
  // Freeze animations so reveals and transforms land in their FINAL state.
  await page.addStyleTag({
    content: "*,*::before,*::after{animation:none!important;transition:none!important;scroll-behavior:auto!important}",
  });
  await page.evaluate(() => document.querySelectorAll("video").forEach((v) => v.pause()));
  // Scroll the whole page in viewport steps so IntersectionObserver reveals fire, then return to top.
  const pageH: number = await page.evaluate(() => document.documentElement.scrollHeight);
  for (let y = 0; y < pageH; y += Math.max(200, viewport.h - 100)) {
    await page.evaluate((yy: number) => scrollTo(0, yy), y);
    await page.waitForTimeout(120);
  }
  await page.evaluate(() => scrollTo(0, 0));
  await page.waitForTimeout(300);
  // Fixed bars (consent banner, sticky CTA) are viewport furniture, not page flow.
  await page.evaluate(() => {
    document.querySelectorAll<HTMLElement>("body *").forEach((el) => {
      if (getComputedStyle(el).position === "fixed") el.style.setProperty("visibility", "hidden", "important");
    });
  });

  const scan = await scanDeadSpace(page, EMPTY_BOX_MAX_PX);
  const scrolls: boolean = await page.evaluate(() => document.documentElement.scrollHeight > innerHeight + 1);
  return judgeDeadSpace(scan, { scrolls, failPx: viewport.failPx }, (y, h) => bandTextureStddev(page, y, h));
}

export const DEAD_SPACE_NO_BLOCKS_MESSAGE = "dead-space walk found no content blocks — the page did not render";

export function deadSpaceGapMessage(v: Pick<DeadSpaceViewport, "w" | "failPx">): string {
  return `gap over ${v.failPx}px at ${v.w}px with no texture or graphic in it — usually stacked section padding. Fix the padding; do not fill the gap`;
}
export function deadSpaceRevealMessage(v: Pick<DeadSpaceViewport, "w">): string {
  return `content still at opacity 0 after scrolling the whole page at ${v.w}px — a reveal that never fires`;
}
export function deadSpaceEmptyBoxMessage(v: Pick<DeadSpaceViewport, "w">): string {
  return `empty elements taller than ${EMPTY_BOX_MAX_PX}px at ${v.w}px — content-free boxes taking height`;
}
