import { test } from "node:test";
import assert from "node:assert/strict";
import { selectNewAlerts } from "./alerting";

// ---------------------------------------------------------------------------
// These tests encode the two directions this module can get wrong, because both
// are silent in production and neither shows up as an error anywhere.
//
// Suppressing too much hides an ongoing outage. Suppressing too little rebuilds
// the alert fatigue the module exists to prevent — and that one degrades
// gradually, so nothing ever looks broken while the channel stops being read.
//
// The weekly-job cycle below is the case worth protecting: a daily monitor
// watching a job that runs once a week sees the same failed run seven times.
// ---------------------------------------------------------------------------

const RUN_1 = "2026-01-05T10:00:00Z";
const RUN_2 = "2026-01-12T10:00:00Z";

test("first sighting of a past occurrence is notified", () => {
  const r = selectNewAlerts([{ key: "job-a", occurrence: RUN_1 }], {});
  assert.deepEqual(r.fresh.map((f) => f.key), ["job-a"]);
  assert.equal(r.suppressed.length, 0);
  assert.deepEqual(r.state, { "job-a": RUN_1 });
});

test("the same occurrence is not notified again, however many times it is seen", () => {
  let state: Record<string, string> = {};
  const candidates = [{ key: "job-a", occurrence: RUN_1 }];

  const first = selectNewAlerts(candidates, state);
  assert.equal(first.fresh.length, 1);
  state = first.state;

  // Six further daily passes before the weekly job next runs.
  for (let day = 0; day < 6; day++) {
    const r = selectNewAlerts(candidates, state);
    assert.equal(r.fresh.length, 0, `day ${day} should be silent`);
    assert.equal(r.suppressed.length, 1, `day ${day} should still count it as failing`);
    state = r.state;
  }
});

test("a NEW occurrence of the same subject is notified again", () => {
  const state = selectNewAlerts([{ key: "job-a", occurrence: RUN_1 }], {}).state;
  const r = selectNewAlerts([{ key: "job-a", occurrence: RUN_2 }], state);
  assert.equal(r.fresh.length, 1, "a second, distinct failure is new information");
  assert.deepEqual(r.state, { "job-a": RUN_2 });
});

test("a live condition with no occurrence is never suppressed", () => {
  const probe = [{ key: "endpoint-x" }];
  let state = selectNewAlerts(probe, {}).state;
  for (let i = 0; i < 5; i++) {
    const r = selectNewAlerts(probe, state);
    assert.equal(r.fresh.length, 1, "re-measured each run, so still failing is a fresh fact");
    state = r.state;
  }
  // Carries no occurrence, so it must not accumulate state either.
  assert.deepEqual(state, {});
});

test("missing previous state fails OPEN — everything is notified", () => {
  const candidates = [{ key: "job-a", occurrence: RUN_1 }];
  for (const prev of [null, undefined]) {
    const r = selectNewAlerts(candidates, prev);
    assert.equal(r.fresh.length, 1, "unreadable state must never silence an alert");
  }
});

test("recovery is reported and clears the state", () => {
  const state = selectNewAlerts(
    [{ key: "job-a", occurrence: RUN_1 }, { key: "job-b", occurrence: RUN_1 }],
    {},
  ).state;

  const r = selectNewAlerts([{ key: "job-b", occurrence: RUN_1 }], state);
  assert.deepEqual(r.recovered, ["job-a"]);
  assert.equal(r.fresh.length, 0, "job-b is unchanged and stays quiet");
  assert.deepEqual(r.state, { "job-b": RUN_1 }, "job-a must not linger in state");
});

test("a subject that recovers and fails again is treated as new", () => {
  const first = selectNewAlerts([{ key: "job-a", occurrence: RUN_1 }], {}).state;
  const cleared = selectNewAlerts([], first).state;
  assert.deepEqual(cleared, {});
  const r = selectNewAlerts([{ key: "job-a", occurrence: RUN_2 }], cleared);
  assert.equal(r.fresh.length, 1);
});

test("extra caller fields survive the split", () => {
  const r = selectNewAlerts(
    [{ key: "job-a", occurrence: RUN_1, detail: "boom", severity: "high" }],
    {},
  );
  assert.equal(r.fresh[0].detail, "boom");
  assert.equal(r.fresh[0].severity, "high");
});

test("mixed live and past failures are split independently", () => {
  const state = selectNewAlerts(
    [{ key: "job-a", occurrence: RUN_1 }, { key: "endpoint-x" }],
    {},
  ).state;

  const r = selectNewAlerts(
    [{ key: "job-a", occurrence: RUN_1 }, { key: "endpoint-x" }],
    state,
  );
  assert.deepEqual(r.fresh.map((f) => f.key), ["endpoint-x"]);
  assert.deepEqual(r.suppressed.map((f) => f.key), ["job-a"]);
});
