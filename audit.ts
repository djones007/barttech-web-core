// ---------------------------------------------------------------------------
// Barttech shared audit log — append-only record of privileged actions.
//
// The rule this module encodes: if something goes wrong and there is no record
// of WHO did it, WHEN, and FROM WHERE, there is no case. Deletions, role
// changes, refunds, exports and admin actions all need a row, written at the
// moment the action succeeds.
//
// Writes one row per action into an `audit_log` table in the app's OWN Supabase
// (service-role). Never blocks or breaks the action being audited — see the
// non-throwing contract on `writeAuditLog`.
//
// Node-runtime only (imports @supabase/supabase-js, resolved from each
// consumer's node_modules — web-core is source-only and dependency-free).
// Requires env: SUPABASE_URL (or NEXT_PUBLIC_SUPABASE_URL) +
// SUPABASE_SERVICE_ROLE_KEY, set in each app's env, NEVER committed here.
// Import as `@/web-core/audit`.
//
// Expected table (create per app, service-role writes only, no UPDATE/DELETE
// grants — it is append-only by design):
//   audit_log(id, created_at, action, actor_id, actor_email, target_type,
//             target_id, metadata jsonb, ip, user_agent)
// ---------------------------------------------------------------------------
import { createClient } from "@supabase/supabase-js";

/**
 * Stable action slugs. The VALUE is what lands in the database, so treat these
 * as permanent — renaming one orphans every historic row. Apps may pass their
 * own slug string (see {@link AuditAction}); use `domain.verb` to match.
 */
export const AUDIT_ACTIONS = {
  USER_DELETE: "user.delete",
  USER_ROLE_CHANGE: "user.role_change",
  USER_LOGIN: "user.login",
  USER_LOGIN_FAILED: "user.login_failed",
  PAYMENT_CHARGE: "payment.charge",
  PAYMENT_REFUND: "payment.refund",
  DATA_EXPORT: "data.export",
  DATA_DELETE: "data.delete",
  ADMIN_ACTION: "admin.action",
  SETTINGS_CHANGE: "settings.change",
} as const;

/**
 * One of the shared slugs, or any app-specific string. The `(string & {})` arm
 * keeps editor autocomplete for the known slugs while still accepting a bespoke
 * one (e.g. `"course.publish"`) without a web-core change.
 */
export type AuditAction = (typeof AUDIT_ACTIONS)[keyof typeof AUDIT_ACTIONS] | (string & {});

export interface AuditEntry {
  /** What happened — a `AUDIT_ACTIONS` slug or an app-specific `domain.verb`. */
  action: AuditAction;
  /** Who did it (user/session id). Omit for anonymous or system actions. */
  actor_id?: string;
  /** Who did it, in human-readable form — survives a later user deletion. */
  actor_email?: string;
  /** What it was done to, e.g. `"user"`, `"order"`, `"course"`. */
  target_type?: string;
  /** The id of the thing acted on. */
  target_id?: string;
  /**
   * Small, non-sensitive context only — e.g. `{ from: "member", to: "admin" }`.
   * NEVER put secrets, passwords, tokens, API keys, card data or a full request
   * body in here. The audit log is read by more people than the app itself and
   * is not an appropriate home for anything confidential.
   */
  metadata?: Record<string, unknown>;
  /** Caller IP — use {@link requestAuditContext} rather than parsing headers yourself. */
  ip?: string;
  /** Caller user-agent — likewise. */
  user_agent?: string;
}

/**
 * Append one row to the audit log.
 *
 * **This function never throws.** An audit-write failure must not break the
 * action being audited — a refund that succeeded should not 500 because the log
 * insert did. Failures are swallowed and reported with `console.error` logging
 * `err.message` ONLY (estate error-handling standard — never log raw error
 * objects, they can carry user input).
 *
 * **You MUST `await` this call.** An un-awaited promise in a serverless function
 * is killed the instant the response returns (website security standard §20), so
 * the insert never lands and the audit row silently vanishes — precisely the
 * failure this module exists to prevent. `void writeAuditLog(...)` is a bug.
 * Because it never throws, awaiting it costs you nothing but the round trip.
 *
 * No-ops with a single `console.warn` when Supabase env vars are absent, so a
 * site that hasn't provisioned its own Supabase yet doesn't crash on every
 * privileged action.
 *
 * ```ts
 * await writeAuditLog({
 *   action: AUDIT_ACTIONS.USER_ROLE_CHANGE,
 *   actor_id: session.userId,
 *   actor_email: session.email,
 *   target_type: "user",
 *   target_id: targetId,
 *   metadata: { from: "member", to: "admin" },
 *   ...requestAuditContext(req),
 * });
 * ```
 */
export async function writeAuditLog(entry: AuditEntry): Promise<void> {
  // Read env at call time, not module scope — a serverless cold start may
  // populate env after this module is first evaluated.
  const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || "";
  // The service-role key has NO public fallback — never read a NEXT_PUBLIC_ var
  // for a secret. Anon-key writes to an append-only table would fail anyway.
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY || "";

  if (!url || !serviceRoleKey) {
    console.warn("[audit] SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set — audit log skipped");
    return;
  }

  try {
    // Built lazily, per call: a module-scope client would capture stale env and
    // open a connection in every route that merely imports this file.
    const supabase = createClient(url, serviceRoleKey, {
      auth: { persistSession: false },
    });

    const { error } = await supabase.from("audit_log").insert({
      action: entry.action,
      actor_id: entry.actor_id ?? null,
      actor_email: entry.actor_email ?? null,
      target_type: entry.target_type ?? null,
      target_id: entry.target_id ?? null,
      metadata: entry.metadata ?? null,
      ip: entry.ip ?? null,
      user_agent: entry.user_agent ?? null,
    });

    if (error) console.error("[audit] write failed:", error.message);
  } catch (err) {
    console.error("[audit] write failed:", err instanceof Error ? err.message : String(err));
  }
}

/**
 * Pull the caller's IP and user-agent off a request, so routes don't each
 * reimplement the header dance. `x-forwarded-for` is a comma-separated chain —
 * the FIRST entry is the client (the rest are proxies). Spread the result
 * straight into an {@link AuditEntry}.
 *
 * Typed against the web-standard `Request` (a Next.js `NextRequest` is one), so
 * web-core stays framework-agnostic.
 */
export function requestAuditContext(req: Request): { ip?: string; user_agent?: string } {
  const forwarded = req.headers.get("x-forwarded-for");
  const ip = forwarded ? forwarded.split(",")[0]?.trim() : req.headers.get("x-real-ip") ?? undefined;
  const userAgent = req.headers.get("user-agent") ?? undefined;

  return {
    ...(ip ? { ip } : {}),
    ...(userAgent ? { user_agent: userAgent } : {}),
  };
}
