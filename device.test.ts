import { test } from "node:test";
import assert from "node:assert/strict";

import { device } from "./device";

// ---------------------------------------------------------------------------
// These are the nine cases that proved the `sec-ch-ua-mobile` fix on the day
// this classifier was first shipped, run at the time from a throwaway script
// and never committed — so the exact function this file tests was itself,
// for three days, an unproven classifier in a live campaign. Recreated here
// as the real, permanent test. See lib/device.ts's own header comment for
// the original failure: 66 of 69 rows had no device at all, because the
// client hint alone is null for Safari and every iOS browser, and the paid
// traffic this exists to measure is overwhelmingly an in-app browser on iOS.
//
// Order is load-bearing in `device()` — mobile markers are checked before
// desktop ones, because an Android UA contains "Linux" and an iPhone UA
// contains "Mac OS X". The two traps below exist to pin that ordering, not
// just the happy path.
// ---------------------------------------------------------------------------

function hdrs(fields: Record<string, string>): Headers {
  const h = new Headers();
  for (const [k, v] of Object.entries(fields)) h.set(k, v);
  return h;
}

test("iOS Instagram in-app browser — the dominant real case, sends no client hints", () => {
  assert.equal(
    device(
      hdrs({
        "user-agent":
          "Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Instagram 361.0.0.31.88",
      })
    ),
    "mobile"
  );
});

test("iOS Facebook in-app browser", () => {
  assert.equal(
    device(
      hdrs({
        "user-agent":
          "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 [FBAN/FBIOS;FBAV/468.0]",
      })
    ),
    "mobile"
  );
});

test("iPhone Safari", () => {
  assert.equal(
    device(
      hdrs({
        "user-agent":
          "Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1",
      })
    ),
    "mobile"
  );
});

test("Android Chrome — the UA contains 'Linux', which is also a desktop marker", () => {
  assert.equal(
    device(
      hdrs({
        "user-agent":
          "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Mobile Safari/537.36",
      })
    ),
    "mobile"
  );
});

test("Android tablet with no 'Mobi' token", () => {
  assert.equal(
    device(
      hdrs({
        "user-agent":
          "Mozilla/5.0 (Linux; Android 13; SM-X710) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125 Safari/537.36",
      })
    ),
    "mobile"
  );
});

test("macOS Chrome desktop", () => {
  assert.equal(
    device(
      hdrs({
        "user-agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152 Safari/537.36",
      })
    ),
    "desktop"
  );
});

test("Windows Edge desktop", () => {
  assert.equal(
    device(
      hdrs({
        "user-agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36 Edg/126",
      })
    ),
    "desktop"
  );
});

test("client hint wins over the user agent when both are present", () => {
  assert.equal(
    device(
      hdrs({
        "sec-ch-ua-mobile": "?0",
        "user-agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X)",
      })
    ),
    "desktop"
  );
});

test("no headers at all is honestly null, not a guess", () => {
  assert.equal(device(new Headers()), null);
});
