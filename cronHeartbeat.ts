// ---------------------------------------------------------------------------
// Cron heartbeat writer.
//
// A scheduled job that dies quietly — a bad deploy, a rotated secret, the
// platform's cron silently disabled — produces no error to capture, because
// nothing runs. Per-run error reporting cannot see it. The only signal is the
// ABSENCE of an expected write, so every scheduled route records one, and an
// external watcher alerts when a row goes stale or records a failure.
//
// Deliberately generic: a table name, a URL and a key. No product, brand or
// business logic — the calling app supplies its own connection details from its
// own env. That is what makes it safe to live in this shared, public repo.
//
// SERVER-SIDE ONLY. It writes with a service-role key.
// ---------------------------------------------------------------------------

export interface HeartbeatOptions {
  /** REST endpoint of the project holding the table, e.g. https://<ref>.supabase.co */
  url: string;
  /** Service-role key. Never a publishable/anon key — this table is not client-writable. */
  key: string;
  /** Unique job identifier. Must match what the watcher expects, exactly. */
  jobName: string;
  /**
   * `ok` / `error` are written by the job itself.
   *
   * `pending` is for a WATCHER seeding a baseline: it means "this job is known
   * but has never been observed running". It exists so a newly-deployed job
   * does not alarm before its first tick, and so an infrequent one does not
   * alarm daily for a month — while still going stale at its real threshold if
   * it genuinely never runs. Deliberately not `ok`: that would claim a run
   * happened. A reader treating anything-not-`error` as healthy stays correct.
   */
  status: "ok" | "error" | "pending";
  /** Small JSON blob — counts processed, error message. Keep it short. */
  detail?: Record<string, unknown>;
  /** Defaults to `cron_heartbeats`. */
  table?: string;
  /**
   * When the run began. Pass `Date.now()` (ms) or an ISO string captured at the
   * top of the handler. Used only to compute `duration_ms` on the history row —
   * omit it and the duration is recorded as null, which means "not measured",
   * not "instant".
   */
  startedAt?: number | string;
  /**
   * Append-only per-run history table. Defaults to `cron_runs`.
   *
   * Pass `null` to skip the history write entirely — for a project that has no
   * such table yet. The heartbeat upsert is unaffected either way: history is
   * strictly additive, and a project without the table keeps working exactly as
   * before (it would otherwise log a 404 on every single run).
   */
  historyTable?: string | null;
}

/**
 * Writes (upserts) one heartbeat row.
 *
 * NEVER THROWS, and never rejects. A heartbeat is an observation of a job, not
 * part of it — a monitoring write that took down the thing it monitors would be
 * a strictly worse outcome than no monitoring at all. Callers should `await` it
 * but need not guard it.
 *
 * Returns whether the write landed, so a caller that wants to log the failure
 * can. Ignoring the return is fine and is the common case.
 */
export async function writeCronHeartbeat(opts: HeartbeatOptions): Promise<boolean> {
  const {
    url,
    key,
    jobName,
    status,
    detail,
    table = "cron_heartbeats",
    startedAt,
    historyTable = "cron_runs",
  } = opts;

  // A missing URL or key is a configuration mistake, not a runtime error. Say
  // so on the console — silently skipping would make an unmonitored job look
  // identical to a monitored one, which is the exact failure this file exists
  // to prevent.
  if (!url || !key) {
    console.error(`[cron-heartbeat] ${jobName}: url/key not configured — heartbeat NOT written, this job is unmonitored`);
    return false;
  }

  const base = url.replace(/\/$/, "");
  const finishedAt = new Date().toISOString();

  // Append the history row FIRST, then upsert the heartbeat.
  //
  // Order matters on failure. The heartbeat is what watchers alarm on, so it is
  // the write that must land; doing it last means a history failure cannot
  // consume the request budget or throw before the heartbeat is recorded. The
  // reverse order would let a full/erroring history table silence the alarm.
  //
  // Fully independent: its own try/catch, its own return value, and its result
  // is deliberately NOT folded into the one this function returns — callers ask
  // "was I monitored?", and the answer is the heartbeat.
  if (historyTable) {
    await writeRunHistory({ base, key, historyTable, jobName, status, detail, startedAt, finishedAt });
  }

  try {
    const res = await fetch(`${base}/rest/v1/${table}?on_conflict=job_name`, {
      method: "POST",
      headers: {
        apikey: key,
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
        // merge-duplicates = upsert on the job_name conflict target, so each
        // job keeps exactly one row rather than accumulating one per run.
        Prefer: "resolution=merge-duplicates,return=minimal",
      },
      body: JSON.stringify({
        job_name: jobName,
        last_status: status,
        // Same timestamp as the history row's finished_at, so the two tables
        // agree about when this run ended. Two separate new Date() calls would
        // differ by however long the history write took.
        last_run_at: finishedAt,
        last_detail: detail ?? null,
        // Set explicitly. A column default fires on INSERT only, and every run
        // after the first is the UPDATE half of the upsert — so leaving this to
        // the default would freeze it at the row's creation time while
        // last_run_at kept advancing. Harmless for a watcher reading
        // last_run_at, quietly wrong for anything reading updated_at.
        updated_at: finishedAt,
      }),
    });

    if (!res.ok) {
      // Read the body: PostgREST answers 4xx for a missing table or column with
      // a specific message, and "heartbeat silently not written" is precisely
      // the state that makes a watcher useless.
      const body = await res.text().catch(() => "");
      console.error(`[cron-heartbeat] ${jobName}: HTTP ${res.status} — ${body.slice(0, 200)}`);
      return false;
    }
    return true;
  } catch (err) {
    console.error(`[cron-heartbeat] ${jobName}: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}

/**
 * Appends one row to the per-run history table.
 *
 * NEVER THROWS — same contract as the heartbeat itself, and for the same
 * reason. History is the nice-to-have half of this module: losing a row costs
 * you a gap in a chart, whereas throwing would cost you the job.
 *
 * A missing history table is not treated as an error worth shouting about on
 * every run: projects adopt this at different times, and a repo that has the
 * heartbeat but not yet the history table is a valid intermediate state. It
 * logs once-per-run at debug volume rather than console.error, so it cannot
 * drown the signal that a HEARTBEAT failed — which is the thing that matters.
 */
async function writeRunHistory(args: {
  base: string;
  key: string;
  historyTable: string;
  jobName: string;
  status: "ok" | "error" | "pending";
  detail?: Record<string, unknown>;
  startedAt?: number | string;
  finishedAt: string;
}): Promise<boolean> {
  const { base, key, historyTable, jobName, status, detail, startedAt, finishedAt } = args;

  // Normalise whatever the caller passed. An unparseable value yields null
  // rather than NaN or 1970 — a wrong duration is worse than no duration,
  // because it silently poisons any average built on top of it.
  let startedIso: string | null = null;
  let durationMs: number | null = null;
  if (startedAt !== undefined) {
    const ms = typeof startedAt === "number" ? startedAt : Date.parse(startedAt);
    if (Number.isFinite(ms)) {
      startedIso = new Date(ms).toISOString();
      const d = Date.parse(finishedAt) - ms;
      // Guard against a clock skew or a bad input producing a negative span.
      durationMs = d >= 0 ? d : null;
    }
  }

  try {
    const res = await fetch(`${base}/rest/v1/${historyTable}`, {
      method: "POST",
      headers: {
        apikey: key,
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
        Prefer: "return=minimal",
      },
      body: JSON.stringify({
        job_name: jobName,
        status,
        started_at: startedIso,
        finished_at: finishedAt,
        duration_ms: durationMs,
        detail: detail ?? null,
      }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      console.warn(`[cron-history] ${jobName}: HTTP ${res.status} — ${body.slice(0, 160)}`);
      return false;
    }
    return true;
  } catch (err) {
    console.warn(`[cron-history] ${jobName}: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}
