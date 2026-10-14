/**
 * zightLinks.ts — Zight share links in a bug report's text become attached pictures.
 *
 * WHY. A reporter pastes https://share.zight.com/<id> into the description instead of uploading a file. Nothing used to open that
 * link, so triage saw a bare URL, not the picture. Filing now fetches the image behind each link and the consumer attaches it exactly
 * as if it had been uploaded (same validation and re-encode its own upload path applies), so every reader sees a normal picture.
 * The URL stays in the text.
 *
 * SAFETY. This is a server fetching a URL a user typed, so it is a textbook SSRF surface. Only https and only hosts that ARE zight.com or
 * a subdomain of it are ever requested, redirects are followed by hand and re-checked at every hop, the size is capped while reading, and
 * each request has a timeout. Anything else is refused. Everything fails soft: a link that cannot be read is reported in `problems`.
 *
 * No credential and no API: it reads the public share page (an unlisted link is readable by anyone who has it). A private link fails
 * with a reason; the text link is kept.
 *
 * Pure functions plus one fetch (injectable as `fetchImpl` for tests); no imports, no React, no `server-only` (golden rule 5).
 * The consumer owns what happens to the returned `File`s: validation, re-encoding and storage.
 */

const SHARE_HOST = "share.zight.com";
/** share.zight.com/<id>, optionally followed by a path (annotate, download...). The id is a uuid or a short slug. */
const ZIGHT_LINK = /https:\/\/share\.zight\.com\/([A-Za-z0-9][A-Za-z0-9_-]{3,63})(?:\/[A-Za-z0-9._~%/-]*)?/g;
const IMAGE_EXT = /\.(?:jpe?g|png|gif|webp)(?:\?|$)/i;

export const ZIGHT_LIMITS = { maxLinks: 3, timeoutMs: 8000, pageMaxBytes: 1_500_000, hops: 3 } as const;

/** Is this URL one we are willing to request? https only, host is zight.com or a subdomain, no credentials, default port. */
export function isAllowedZightUrl(raw: string): boolean {
  let u: URL;
  try { u = new URL(raw); } catch { return false; }
  if (u.protocol !== "https:" || u.username || u.password || (u.port && u.port !== "443")) return false;
  const h = u.hostname.toLowerCase();
  return h === "zight.com" || h.endsWith(".zight.com");
}

/** Distinct Zight share links in some text, in order of appearance, capped. Trailing punctuation from prose or markdown is not part of the link. */
export function extractZightLinks(texts: (string | null | undefined)[], max: number = ZIGHT_LIMITS.maxLinks): { url: string; id: string }[] {
  const seen = new Set<string>(); const out: { url: string; id: string }[] = [];
  if (max <= 0) return out;
  for (const t of texts) {
    if (!t) continue;
    for (const m of String(t).matchAll(ZIGHT_LINK)) {
      const id = m[1];
      if (seen.has(id.toLowerCase())) continue;
      seen.add(id.toLowerCase());
      out.push({ url: `https://${SHARE_HOST}/${id}`, id });
      if (out.length >= max) return out;
    }
  }
  return out;
}

const decodeEntities = (s: string) => s.replace(/&amp;/g, "&").replace(/&#x2F;/gi, "/").replace(/&#47;/g, "/").replace(/&quot;/g, '"');

/** Candidate picture URLs from a share page, best first: og:image, twitter:image, image_src, then any Zight-hosted image path in the page. */
export function imageUrlsFromHtml(html: string, base = `https://${SHARE_HOST}/`): { urls: string[]; isVideo: boolean } {
  const urls: string[] = [];
  const add = (v: string | undefined) => {
    if (!v) return;
    try { const abs = new URL(decodeEntities(v.trim()), base).toString(); if (isAllowedZightUrl(abs) && !urls.includes(abs)) urls.push(abs); } catch { /* skip */ }
  };
  const metaRe = /<meta\s+[^>]*?(?:property|name)=["'](og:image(?::secure_url)?|twitter:image)["'][^>]*?>/gi;
  for (const m of html.matchAll(metaRe)) add(/content=["']([^"']+)["']/i.exec(m[0])?.[1]);
  // attribute order can be content-first
  const metaRe2 = /<meta\s+[^>]*?content=["']([^"']+)["'][^>]*?(?:property|name)=["'](?:og:image(?::secure_url)?|twitter:image)["'][^>]*?>/gi;
  for (const m of html.matchAll(metaRe2)) add(m[1]);
  add(/<link\s+[^>]*rel=["']image_src["'][^>]*href=["']([^"']+)["']/i.exec(html)?.[1]);
  // Embedded JSON escapes slashes (https:\/\/host\/path); undo that once, then look for any Zight-hosted image path.
  const unescaped = html.replace(/\\\//g, "/");
  for (const m of unescaped.matchAll(/https:\/\/[a-z0-9.-]*zight\.com\/[^"'\s<>\\]*?\.(?:jpe?g|png|gif|webp)[^"'\s<>\\]*/gi)) add(m[0]);
  const isVideo = /<meta\s+[^>]*(?:property|name)=["']og:type["'][^>]*content=["']video/i.test(html) || /<meta\s+[^>]*og:video/i.test(html);
  return { urls, isVideo };
}

export type ZightProblem = { url: string; reason: string };
export type ZightPicture = { file: File; source: string; note?: string };

type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

/** One GET that never leaves zight.com: redirects are followed by hand and every hop is checked. Reads at most `maxBytes`. */
async function getBounded(url: string, o: { fetchImpl: FetchLike; maxBytes: number; timeoutMs: number; accept: string }): Promise<{ res: Response; bytes: Uint8Array; finalUrl: string }> {
  let cur = url;
  for (let hop = 0; hop <= ZIGHT_LIMITS.hops; hop++) {
    if (!isAllowedZightUrl(cur)) throw new Error("redirected outside zight.com");
    const res = await o.fetchImpl(cur, { method: "GET", redirect: "manual", headers: { Accept: o.accept, "User-Agent": "BarttechCommandCentre/1.0 (+bug-report zight attach)" }, signal: AbortSignal.timeout(o.timeoutMs) });
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get("location");
      if (!loc) throw new Error(`redirect ${res.status} with no location`);
      cur = new URL(loc, cur).toString();
      continue;
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const declared = Number(res.headers.get("content-length") ?? 0);
    if (declared > o.maxBytes) throw new Error("too large");
    const reader = res.body?.getReader();
    if (!reader) { const b = new Uint8Array(await res.arrayBuffer()); if (b.length > o.maxBytes) throw new Error("too large"); return { res, bytes: b, finalUrl: cur }; }
    const chunks: Uint8Array[] = []; let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > o.maxBytes) { await reader.cancel().catch(() => {}); throw new Error("too large"); }
      chunks.push(value);
    }
    const bytes = new Uint8Array(total); let off = 0;
    for (const c of chunks) { bytes.set(c, off); off += c.length; }
    return { res, bytes, finalUrl: cur };
  }
  throw new Error("too many redirects");
}

/**
 * Resolve every Zight link in `texts` to at most `slots` pictures. Never throws; problems come back with a reason.
 * The returned Files go straight into the normal upload pipeline (validateUpload sniffs the real type, sharp re-encodes).
 */
export async function resolveZightPictures(
  texts: (string | null | undefined)[],
  o: { slots: number; maxBytes: number; fetchImpl?: FetchLike; timeoutMs?: number },
): Promise<{ pictures: ZightPicture[]; problems: ZightProblem[] }> {
  const pictures: ZightPicture[] = []; const problems: ZightProblem[] = [];
  const fetchImpl: FetchLike = o.fetchImpl ?? ((u, i) => fetch(u, i));
  const timeoutMs = o.timeoutMs ?? ZIGHT_LIMITS.timeoutMs;
  const links = extractZightLinks(texts, Math.min(ZIGHT_LIMITS.maxLinks, Math.max(0, o.slots)));
  const overflow = extractZightLinks(texts, 99).length - links.length;
  if (overflow > 0) problems.push({ url: "", reason: `${overflow} more Zight link(s) not attached (limit reached)` });

  await Promise.all(links.map(async (l) => {
    try {
      const page = await getBounded(l.url, { fetchImpl, maxBytes: ZIGHT_LIMITS.pageMaxBytes, timeoutMs, accept: "text/html,application/xhtml+xml" });
      const ct = page.res.headers.get("content-type") ?? "";
      let imgUrl: string | undefined; let note: string | undefined;
      if (/^image\//i.test(ct)) imgUrl = page.finalUrl;                                   // the link was straight to an image
      else {
        const { urls, isVideo } = imageUrlsFromHtml(new TextDecoder().decode(page.bytes), page.finalUrl);
        imgUrl = urls.find((u) => IMAGE_EXT.test(u)) ?? urls[0];
        if (imgUrl && isVideo) note = "poster frame of a video; the link is kept in the text";
      }
      if (!imgUrl) { problems.push({ url: l.url, reason: "no picture found on the share page (private, expired, or a type with no preview)" }); return; }
      const img = await getBounded(imgUrl, { fetchImpl, maxBytes: o.maxBytes, timeoutMs, accept: "image/*" });
      const type = (img.res.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
      if (!/^image\//.test(type)) { problems.push({ url: l.url, reason: `not an image (${type || "unknown type"})` }); return; }
      pictures.push({ file: new File([img.bytes as BlobPart], `zight-${l.id.slice(0, 12)}`, { type }), source: l.url, note });
    } catch (e) {
      problems.push({ url: l.url, reason: e instanceof Error ? (e.name === "TimeoutError" ? "timed out" : e.message) : "failed" });
    }
  }));
  // Promise.all finishes in completion order; keep the reporter's order.
  const order = new Map(links.map((l, i) => [l.url, i]));
  pictures.sort((a, b) => (order.get(a.source) ?? 0) - (order.get(b.source) ?? 0));
  return { pictures, problems };
}
