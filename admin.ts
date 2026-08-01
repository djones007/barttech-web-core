// ---------------------------------------------------------------------------
// Barttech shared admin-role check — a second, independent gate for actions
// that "a session exists" does not cover.
//
// THE BUG THIS EXISTS TO PREVENT: an RLS-based role check (a `cp_has_role`-
// style function, checked via policies on the app's OWN Supabase project)
// protects nothing for a service-role client — service_role bypasses RLS
// entirely — and protects nothing at all when the privileged action writes
// into a DIFFERENT Supabase project than the one the role table lives in.
// Found live 2026-08-01: an app with a working RLS admin role on its own
// tables still had zero role check on a server action that wrote through a
// service-role client into another app's live database. The RLS role check
// looked like it covered "admin", and did not reach that action at all.
//
// This module is the explicit, non-RLS-dependent alternative: a plain table
// keyed on email, checked server-side via a SECURITY DEFINER function that
// is NOT executable by anon/authenticated (nothing client-side needs it, and
// an authenticated-callable version is a free membership oracle). Presence
// in the table = may perform the action; there is no `role` column, because
// a column nothing reads is not access control, it just reads like it is.
//
// FAILS CLOSED, always. A missing table, an unset env var, a network error —
// every one of them returns false, never true. This is the opposite failure
// mode from audit.ts's writeAuditLog(), which never throws because an audit
// failure must not block the action being audited. An admin check that
// returns true when it cannot prove the caller is an admin is not a check.
//
// Node-runtime only (imports @supabase/supabase-js, resolved from each
// consumer's node_modules). Requires env: SUPABASE_URL (or
// NEXT_PUBLIC_SUPABASE_URL) + SUPABASE_SERVICE_ROLE_KEY — the same pair
// audit.ts reads, so an app with audit logging working already has this
// working. Import as `@/web-core/admin`.
//
// Expected table + function (create per app — see the estate's internal
// scaffold repo for the exact, live-tested migration statements):
//   app_admins(id, email unique lowercase, created_at)
//   is_app_admin(_email text) returns boolean, SECURITY DEFINER,
//     search_path locked to '', EXECUTE granted to service_role only
//
// This module provides the PRIMITIVE (`isAppAdmin`). Each app composes it
// with its own `requireUser()` locally (web-core doesn't know the app's
// session mechanism) — see the template's `src/lib/auth.ts` for the pattern:
//
//   export async function requireAdmin(req: Request) {
//     const auth = await requireUser(req);
//     if (!auth.ok) return auth;
//     if (!(await isAppAdmin(auth.user.email))) {
//       return { ok: false, status: 403, error: "Not authorised" } as const;
//     }
//     return auth;
//   }
// ---------------------------------------------------------------------------
import { createClient } from "@supabase/supabase-js";

/**
 * Is this email a member of the app's `app_admins` table?
 *
 * **Fails closed on every error path** — missing env, network failure, RPC
 * error, or no matching row all return `false`. Never throws.
 *
 * Reads through the SERVICE-ROLE client on purpose: `app_admins` should grant
 * nothing to `anon`/`authenticated` and `is_app_admin()` should not be
 * `authenticated`-executable either, so a caller's own session client could
 * never answer this question — membership is not discoverable from the
 * browser, only provable server-side.
 */
export async function isAppAdmin(email: string | null | undefined): Promise<boolean> {
  if (!email) return false;

  const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || "";
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY || "";

  if (!url || !serviceRoleKey) {
    console.error("[admin] SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set — denying by default");
    return false;
  }

  try {
    const supabase = createClient(url, serviceRoleKey, {
      auth: { persistSession: false },
    });

    const { data, error } = await supabase.rpc("is_app_admin", {
      _email: email.toLowerCase(),
    });

    if (error) {
      console.error("[admin] check failed:", error.message);
      return false;
    }

    return data === true;
  } catch (err) {
    console.error("[admin] check failed:", err instanceof Error ? err.message : String(err));
    return false;
  }
}
