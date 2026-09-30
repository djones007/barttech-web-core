// ---------------------------------------------------------------------------
// Cron pause switch — read at the START of a scheduled route.
//
// A scheduled job can be switched off without a deploy: one row per job in a
// `cron_controls` table (mode `on` | `paused` | `auto_when_ads_live`), read
// through the service-role RPC `cron_control_check(p_job)`. No row means `on`.
//
// FAIL OPEN, ALWAYS. If the switch cannot be read — missing config, a timeout,
// an HTTP error, an unknown mode — the job RUNS and a caveat is attached to its
// next heartbeat (noteCronCaveat), so the run records `degraded` instead of
// `ok`: visible, never alarming. A switch that silently stops jobs whenever a
// database blinks is strictly worse than having no switch at all.
//
// `auto_when_ads_live` ("only run while an ad platform has a live campaign")
// needs platform credentials a web route does not hold, so a route in that mode
// also fails open, with a caveat saying so. The live-campaign check belongs to
// whatever runner has the credentials.
//
// When paused, this writes the job's heartbeat with status `paused` (healthy,
// intentional, never a notification) through writeCronHeartbeat, so a watcher's
// staleness check still sees the job firing on schedule.
//
// Deliberately generic, like cronHeartbeat.ts: URLs and keys come from the
// calling app's own env. SERVER-SIDE ONLY — it uses a service-role key.
// ---------------------------------------------------------------------------

import { isSafeOutboundUrl } from "./security";
import { writeCronHeartbeat, noteCronCaveat } from "./cronHeartbeat";

export type CronControlMode = "on" | "paused" | "auto_when_ads_live";

export interface CronPauseOptions {
  /** Project holding `cron_controls` + the `cron_control_check` RPC. */
  controlUrl: string;
  /** Service-role key for that project. */
  controlKey: string;
  /** The job's heartbeat name — exactly what the route passes to writeCronHeartbeat. */
  jobName: string;
  /** Where this job's heartbeat lives. Defaults to the control project. */
  heartbeat?: { url: string; key: string; table?: string; historyTable?: string | null };
  /** Abort the switch read after this long (ms). Default 5000. */
  timeoutMs?: number;
}

export interface CronPauseDecision {
  paused: boolean;
  mode: CronControlMode | "unknown";
  reason: string;
  /** Set when the switch could not be decided and the job runs anyway. */
  caveat: string | null;
}

const MODES: CronControlMode[] = ["on", "paused", "auto_when_ads_live"];

/** Decide. Never throws. Writes the `paused` heartbeat when it says paused. */
export async function checkCronPause(opts: CronPauseOptions): Promise<CronPauseDecision> {
  const { controlUrl, controlKey, jobName, timeoutMs = 5000 } = opts;
  const startedAt = Date.now();
  const runAnyway = (why: string): CronPauseDecision => {
    const caveat = `pause switch unreadable (${why}); ran anyway`;
    console.error(`[cron-pause] ${jobName}: ${caveat}`);
    noteCronCaveat(jobName, caveat);
    return { paused: false, mode: "unknown", reason: "switch unreadable — running (fail-open)", caveat };
  };

  if (!controlUrl || !controlKey) return runAnyway("control url/key not configured");
  if (!isSafeOutboundUrl(controlUrl)) return runAnyway("control url failed host safety check");

  let row: { mode?: string } | undefined;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(`${controlUrl.replace(/\/$/, "")}/rest/v1/rpc/cron_control_check`, {
      method: "POST",
      headers: {
        apikey: controlKey,
        Authorization: `Bearer ${controlKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ p_job: jobName }),
      signal: ac.signal,
    });
    if (!res.ok) return runAnyway(`HTTP ${res.status}`);
    const rows: unknown = await res.json();
    if (!Array.isArray(rows)) return runAnyway("non-list response");
    row = rows[0] as { mode?: string } | undefined;
  } catch (err) {
    return runAnyway(err instanceof Error ? err.message : String(err));
  } finally {
    clearTimeout(timer);
  }

  if (!row) return { paused: false, mode: "on", reason: "no switch row (on)", caveat: null };
  const mode = row.mode as CronControlMode;
  if (!MODES.includes(mode)) return runAnyway(`unknown mode "${String(row.mode)}"`);
  if (mode === "on") return { paused: false, mode, reason: "switch on", caveat: null };
  if (mode === "auto_when_ads_live") {
    const caveat = "auto mode is not checkable from a web route; ran anyway";
    noteCronCaveat(jobName, caveat);
    return { paused: false, mode, reason: "auto mode — running (fail-open)", caveat };
  }

  const hb = opts.heartbeat ?? { url: controlUrl, key: controlKey };
  await writeCronHeartbeat({
    url: hb.url,
    key: hb.key,
    table: hb.table,
    historyTable: hb.historyTable,
    jobName,
    status: "paused",
    detail: { paused: true, output: "Paused — switched off in Command Centre" },
    startedAt,
  });
  return { paused: true, mode, reason: "paused", caveat: null };
}

/**
 * One-line form for a route: call right after the cron auth check.
 *   const paused = await cronPauseResponse({ ... }); if (paused) return paused;
 * Returns a 200 JSON Response when paused, otherwise null.
 */
export async function cronPauseResponse(opts: CronPauseOptions): Promise<Response | null> {
  const d = await checkCronPause(opts);
  if (!d.paused) return null;
  return new Response(JSON.stringify({ ok: true, paused: true, job: opts.jobName }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}
