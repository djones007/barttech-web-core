import { test } from "node:test";
import assert from "node:assert/strict";
import { extractZightLinks, imageUrlsFromHtml, isAllowedZightUrl, resolveZightPictures } from "./zightLinks";

const check = (name: string, got: unknown, want: unknown) => assert.equal(JSON.stringify(got), JSON.stringify(want), name);
const ID = "01a134cd-7f8f-7349-9f1d-50455d89107a";

test("zightLinks: extraction, safety allow-list, redirects, caps, timeouts, ordering", async () => {
  // ── extraction ──
  check("plain link", extractZightLinks([`see https://share.zight.com/${ID} thanks`]).map((l) => l.id), [ID]);
  check("trailing punctuation and markdown are not part of the link", extractZightLinks([`(https://share.zight.com/${ID}).`, `[shot](https://share.zight.com/Abc123xy)`]).map((l) => l.id), [ID, "Abc123xy"]);
  check("annotate/download suffix still the same id, duplicates collapse", extractZightLinks([`https://share.zight.com/${ID}/annotate and https://share.zight.com/${ID}`]).length, 1);
  check("http and look-alike hosts are not extracted", extractZightLinks([`http://share.zight.com/${ID} https://share.zight.com.evil.com/${ID} https://evil.com/share.zight.com/${ID}`]).map((l) => l.url), []);
  check("max 0 extracts nothing", extractZightLinks([`https://share.zight.com/${ID}`], 0), []);
  check("capped at 3", extractZightLinks(["https://share.zight.com/aaaa https://share.zight.com/bbbb https://share.zight.com/cccc https://share.zight.com/dddd"]).length, 3);
  check("null and empty texts are fine", extractZightLinks([null, undefined, ""]), []);

  // ── SSRF gate ──
  const allowed = (u: string) => isAllowedZightUrl(u);
  check("allowed: zight hosts over https", [allowed("https://share.zight.com/x"), allowed("https://p448.p4.n0.cdn.zight.com/items/a.jpg?v=1"), allowed("https://zight.com/")], [true, true, true]);
  check("refused: http, other hosts, tricks, ips, ports, credentials", [
    allowed("http://share.zight.com/x"), allowed("https://evilzight.com/x"), allowed("https://share.zight.com.evil.com/x"), allowed("https://127.0.0.1/x"),
    allowed("https://169.254.169.254/latest/meta-data"), allowed("https://share.zight.com:8443/x"), allowed("https://user:pw@share.zight.com/x"), allowed("not a url"), allowed("https://localhost/x"),
  ], [false, false, false, false, false, false, false, false, false]);

  // ── html parsing ──
  const page = (head: string) => `<html><head>${head}</head><body></body></html>`;
  check("og:image, either attribute order, entities decoded", imageUrlsFromHtml(page(`<meta property="og:image" content="https://p1.cdn.zight.com/items/a/x.jpg?v=1&amp;w=2"><meta content="https://p1.cdn.zight.com/items/b/y.png" name="twitter:image">`)).urls,
    ["https://p1.cdn.zight.com/items/a/x.jpg?v=1&w=2", "https://p1.cdn.zight.com/items/b/y.png"]);
  check("an og:image on another host is ignored", imageUrlsFromHtml(page(`<meta property="og:image" content="https://evil.example/x.jpg">`)).urls, []);
  check("image path found in embedded JSON (escaped slashes)", imageUrlsFromHtml(`<script>{"content_url":"https:\\/\\/p448.p4.n0.cdn.zight.com\\/items\\/u\\/f.jpg?v=9"}</script>`).urls, ["https://p448.p4.n0.cdn.zight.com/items/u/f.jpg?v=9"]);
  check("video detected", imageUrlsFromHtml(page(`<meta property="og:type" content="video.other"><meta property="og:image" content="https://t.cdn.zight.com/p.jpg">`)).isVideo, true);

  // ── end to end with a fake network ──
  const PNG = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0]);
  const html = (img: string) => `<meta property="og:image" content="${img}">`;
  const mk = (routes: Record<string, () => Response | Promise<Response>>) => async (u: string) => { const f = routes[u]; if (!f) throw new Error(`unexpected fetch ${u}`); return f(); };
  const R = (body: BodyInit | null, init: ResponseInit & { ct?: string } = {}) => new Response(body, { status: init.status ?? 200, headers: { "content-type": init.ct ?? "text/html", ...(init.headers as Record<string, string> | undefined) } });

  let r = await resolveZightPictures([`https://share.zight.com/${ID}`], { slots: 4, maxBytes: 1_000_000, fetchImpl: mk({
    [`https://share.zight.com/${ID}`]: () => R(html("https://p.cdn.zight.com/items/a/s.png")),
    "https://p.cdn.zight.com/items/a/s.png": () => R(PNG, { ct: "image/png" }),
  }) });
  check("share page -> og:image -> picture attached", [r.pictures.length, r.pictures[0]?.file.type, r.pictures[0]?.file.size, r.pictures[0]?.source, r.problems], [1, "image/png", 12, `https://share.zight.com/${ID}`, []]);

  r = await resolveZightPictures([`https://share.zight.com/${ID}`], { slots: 4, maxBytes: 1_000_000, fetchImpl: mk({
    [`https://share.zight.com/${ID}`]: () => R(null, { status: 302, headers: { location: "https://evil.example/steal" } }),
  }) });
  check("a redirect off zight.com is refused and nothing else is fetched", [r.pictures.length, r.problems[0]?.reason], [0, "redirected outside zight.com"]);

  r = await resolveZightPictures([`https://share.zight.com/${ID}`], { slots: 4, maxBytes: 1_000_000, fetchImpl: mk({
    [`https://share.zight.com/${ID}`]: () => R(null, { status: 302, headers: { location: "/other" } }),
    "https://share.zight.com/other": () => R(html("https://p.cdn.zight.com/i.png")),
    "https://p.cdn.zight.com/i.png": () => R(PNG, { ct: "image/png" }),
  }) });
  check("a redirect within zight.com is followed", r.pictures.length, 1);

  r = await resolveZightPictures([`https://share.zight.com/${ID}`], { slots: 4, maxBytes: 10, fetchImpl: mk({
    [`https://share.zight.com/${ID}`]: () => R(html("https://p.cdn.zight.com/i.png")),
    "https://p.cdn.zight.com/i.png": () => R(new Uint8Array(500), { ct: "image/png" }),
  }) });
  check("an oversize picture is refused while reading", [r.pictures.length, r.problems[0]?.reason], [0, "too large"]);

  r = await resolveZightPictures([`https://share.zight.com/${ID}`], { slots: 4, maxBytes: 1e6, fetchImpl: mk({
    [`https://share.zight.com/${ID}`]: () => R(html("https://p.cdn.zight.com/i.png")),
    "https://p.cdn.zight.com/i.png": () => R("<html>login</html>", { ct: "text/html" }),
  }) });
  check("a picture URL that returns a web page is refused", [r.pictures.length, r.problems[0]?.reason], [0, "not an image (text/html)"]);

  r = await resolveZightPictures([`https://share.zight.com/${ID}`], { slots: 4, maxBytes: 1e6, fetchImpl: mk({ [`https://share.zight.com/${ID}`]: () => R("<html>nothing here</html>") }) });
  check("a page with no picture says why, does not throw", [r.pictures.length, /no picture found/.test(r.problems[0]?.reason ?? "")], [0, true]);

  r = await resolveZightPictures([`https://share.zight.com/${ID}`], { slots: 4, maxBytes: 1e6, fetchImpl: mk({ [`https://share.zight.com/${ID}`]: () => R("nope", { status: 403 }) }) });
  check("a private link (403) is reported", r.problems[0]?.reason, "HTTP 403");

  r = await resolveZightPictures([`https://share.zight.com/${ID}`], { slots: 4, maxBytes: 1e6, timeoutMs: 20, fetchImpl: (_u, i) => new Promise((_, rej) => { setTimeout(() => {}, 300);   // AbortSignal.timeout() timers are unref'd; keep the loop alive so the abort can fire
    (i.signal as AbortSignal).addEventListener("abort", () => rej(Object.assign(new Error("x"), { name: "TimeoutError" }))); }) });
  check("a hung server times out instead of hanging the report", r.problems[0]?.reason, "timed out");

  r = await resolveZightPictures([`https://share.zight.com/${ID}`], { slots: 0, maxBytes: 1e6, fetchImpl: mk({}) });
  check("no free picture slots: nothing fetched, the overflow is reported", [r.pictures.length, r.problems[0]?.reason], [0, "1 more Zight link(s) not attached (limit reached)"]);

  r = await resolveZightPictures([`https://share.zight.com/aaaa1111 https://share.zight.com/bbbb2222`], { slots: 4, maxBytes: 1e6, fetchImpl: mk({
    "https://share.zight.com/aaaa1111": () => new Promise<Response>((res) => setTimeout(() => res(R(html("https://p.cdn.zight.com/a.png"))), 30)),
    "https://share.zight.com/bbbb2222": () => R(html("https://p.cdn.zight.com/b.png")),
    "https://p.cdn.zight.com/a.png": () => R(PNG, { ct: "image/png" }), "https://p.cdn.zight.com/b.png": () => R(PNG, { ct: "image/png" }),
  }) });
  check("pictures come back in the reporter's order even when the second link answers first", r.pictures.map((p) => p.source), ["https://share.zight.com/aaaa1111", "https://share.zight.com/bbbb2222"]);

});
