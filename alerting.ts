/**
 * Decide which failures are worth sending a notification about.
 *
 * THE PROBLEM THIS SOLVES
 * ----------------------------------------------------------------------------
 * A monitor typically runs far more often than the things it watches. A daily
 * check looking at a weekly job will see the same failed run seven times. If it
 * emails on every sighting, six of those emails carry no new information — and
 * they keep arriving after the problem has already been fixed, because the job
 * has had no opportunity to run again and prove itself healthy.
 *
 * That is not a cosmetic annoyance. An alert channel that repeats itself trains
 * its reader to skim and then to ignore, and an ignored alert channel is worse
 * than none: it costs the same to run while providing false assurance that
 * someone is watching. The failure mode is reached gradually and is invisible
 * from inside the monitor, which reports itself as working perfectly throughout.
 *
 * THE DISTINCTION THAT MATTERS
 * ----------------------------------------------------------------------------
 * Two kinds of failure look identical in a list and must be treated differently:
 *
 *   - A PAST OCCURRENCE. Something failed at a specific moment. That fact cannot
 *     change until the thing runs again, so repeating it says nothing new. Give
 *     it an `occurrence` — any value that changes when a genuinely new instance
 *     happens, typically the failing run's timestamp or id.
 *
 *   - A LIVE CONDITION. Something is re-tested from scratch on every pass — a
 *     reachability probe, a credential validity check, a current-state query.
 *     "Still failing" here is a fresh measurement, not an echo, and must never
 *     be suppressed. Leave `occurrence` undefined.
 *
 * Getting this backwards in either direction is harmful: suppressing a live
 * condition hides an ongoing outage, and repeating a past occurrence is the
 * fatigue problem above.
 *
 * FAILS OPEN, ALWAYS
 * ----------------------------------------------------------------------------
 * When previous state is missing or unreadable, everything is treated as new and
 * is sent. Over-notifying is recoverable; silently not notifying is the one
 * outcome a monitor must never produce on its own. Callers should preserve this
 * property — read prior state defensively and pass `null` on any error rather
 * than aborting.
 *
 * SUPPRESSION APPLIES TO THE NOTIFICATION, NOT TO STATE
 * ----------------------------------------------------------------------------
 * A suppressed failure has not gone away. Callers must keep recording it in
 * whatever health status, dashboard or heartbeat they maintain, so the current
 * picture stays truthful while the notification stream stays quiet. Use
 * `suppressed.length` to say "N other things are still failing, unchanged" so
 * nothing is hidden outright.
 */

/** The minimum a caller must supply. Extra fields are preserved on the way out. */
export interface AlertCandidate {
  /**
   * Stable identity of the thing that is wrong — the same string on every run
   * for the same underlying subject. If this drifts between runs (a timestamp,
   * a counter, a formatted duration), nothing will ever match and every run
   * notifies, which silently reintroduces the problem this module exists to fix.
   */
  key: string;
  /**
   * Identity of the SPECIFIC occurrence, when the failure is a past event.
   *
   * Undefined means "live condition, re-measured this run" and is never
   * suppressed. Anything that changes per genuine occurrence works; a run
   * timestamp is the usual choice.
   */
  occurrence?: string;
}

export interface AlertSelection<T> {
  /** Notify about these. */
  fresh: T[];
  /** Real, still failing, already notified about. Summarise; do not repeat. */
  suppressed: T[];
  /**
   * Keys that were failing at the last decision and are absent now. Useful for
   * an "it recovered" note; safe to ignore.
   */
  recovered: string[];
  /** Persist verbatim and hand back as `previous` on the next run. */
  state: Record<string, string>;
}

/**
 * Split candidate failures into those worth notifying about and those already
 * reported and unchanged.
 *
 * @param candidates Everything currently failing.
 * @param previous   The `state` returned by the previous decision, or null/
 *                   undefined if unavailable — which makes everything fresh.
 */
export function selectNewAlerts<T extends AlertCandidate>(
  candidates: readonly T[],
  previous?: Record<string, string> | null,
): AlertSelection<T> {
  const seen = previous ?? {};

  // Built from the CURRENT set only, so anything that stops failing drops out
  // and a later recurrence is correctly treated as new rather than matching a
  // stale entry forever.
  const state: Record<string, string> = {};
  for (const c of candidates) {
    if (c.occurrence !== undefined) state[c.key] = c.occurrence;
  }

  const fresh: T[] = [];
  const suppressed: T[] = [];
  for (const c of candidates) {
    // No occurrence => live condition => always fresh.
    if (c.occurrence === undefined || seen[c.key] !== c.occurrence) fresh.push(c);
    else suppressed.push(c);
  }

  const stillFailing = new Set(candidates.map((c) => c.key));
  const recovered = Object.keys(seen).filter((k) => !stillFailing.has(k));

  return { fresh, suppressed, recovered, state };
}
