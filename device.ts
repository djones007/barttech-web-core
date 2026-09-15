/**
 * Device classification from request headers — no imports, deliberately.
 *
 * Promoted here 2026-09-15 from a consumer site's `lib/device.ts` (extracted
 * there the same day so this function was directly unit-testable with plain
 * `node --test`, no bundler and no path aliases in the way). That split was
 * itself the fix for the bug this function exists to prevent: its FIRST
 * version shipped with nine cases proven in a throwaway script that was never
 * committed, so the exact classifier meant to catch an unproven-input bug was
 * — for three days — an unproven classifier itself. See `device.test.ts` for
 * the real, permanent proof, and `scripts/check-classifier-tests.mjs` (added
 * the same day) for the CI gate this incident produced.
 *
 * Client hint first, user agent as the fallback.
 *
 * The hint alone was the original implementation and it FAILED IN PRACTICE:
 * measured on the first day live, 66 of 69 rows came back null, because
 * Safari and every iOS browser send no Client Hints at all — and the paid
 * traffic this was built to measure is overwhelmingly an in-app browser on
 * iOS. A column that is 96% null is not data.
 *
 * We still store NO user agent string, only this two-value classification —
 * this function identifies nothing about a person or a device, only a coarse
 * form factor, and callers must keep it that way.
 *
 * ORDER IS LOAD-BEARING: check mobile markers before desktop ones. An Android
 * UA contains "Linux" and an iPhone UA contains "Mac OS X", so a desktop-first
 * test would misfile most of the traffic this exists to measure.
 *
 * Known and accepted: modern iPadOS Safari identifies as "Macintosh", so those
 * land as desktop. Not worth defeating — it is a small slice and every
 * workaround is a fingerprinting-shaped heuristic.
 */
export function device(headers: Headers): "mobile" | "desktop" | null {
  const hint = headers.get("sec-ch-ua-mobile");
  if (hint === "?1") return "mobile";
  if (hint === "?0") return "desktop";

  const ua = headers.get("user-agent");
  if (!ua) return null;
  if (/Mobi|Android|iPhone|iPod|iPad|Tablet|Windows Phone/i.test(ua)) return "mobile";
  if (/Macintosh|Windows NT|X11|Linux|CrOS/i.test(ua)) return "desktop";
  return null;
}
