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
  const { url, key, jobName, status, detail, table = "cron_heartbeats" } = opts;

  // A missing URL or key is a configuration mistake, not a runtime error. Say
  // so on the console — silently skipping would make an unmonitored job look
  // identical to a monitored one, which is the exact failure this file exists
  // to prevent.
  if (!url || !key) {
    console.error(`[cron-heartbeat] ${jobName}: url/key not configured — heartbeat NOT written, this job is unmonitored`);
    return false;
  }

  try {
    const res = await fetch(`${url.replace(/\/$/, "")}/rest/v1/${table}?on_conflict=job_name`, {
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
        last_run_at: new Date().toISOString(),
        last_detail: detail ?? null,
        // Set explicitly. A column default fires on INSERT only, and every run
        // after the first is the UPDATE half of the upsert — so leaving this to
        // the default would freeze it at the row's creation time while
        // last_run_at kept advancing. Harmless for a watcher reading
        // last_run_at, quietly wrong for anything reading updated_at.
        updated_at: new Date().toISOString(),
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
