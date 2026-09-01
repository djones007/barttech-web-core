// ---------------------------------------------------------------------------
// Raise a support ticket from a website contact form.
//
// Every brand site had a contact form that emailed a notification and wrote an
// optin. None created a TICKET, so form enquiries lived only in an inbox while
// the helpdesk sat empty — and the helpdesk is where the spam gate, AI triage,
// SLAs, assignment and the audit trail live.
//
// THIS CALLS BARTMAIL; IT DOES NOT WRITE THE TABLES.
//
// The first version of this module INSERTed into `support_tickets` directly.
// That worked and was wrong: the spam gate — denylist, allowlist, AI sender
// classification, daily cost cap — lives in BartMail beside the tables it
// protects. A direct write from a consuming site skipped every bit of it, so
// the forms would have filled the helpdesk with exactly the rubbish the gate
// exists to stop. BartMail owns the support pipeline; sites ask, they do not
// write.
//
// (Note the direction of travel here differs from `bartmail.ts` next door, and
// deliberately: optins are a DIRECT Supabase write because there is no
// server-side decision to make. A support ticket has one — whether it should
// exist at all — so it has to go through the code that makes it.)
//
// Auth is a shared secret, NOT the service-role key: a website able to read
// every contact in the CDP in order to file a support ticket is far more
// authority than the job needs. Requires SUPPORT_FORM_SECRET and
// SUPPORT_ENGINE_URL (no default — see below).
//
// NEVER THROWS. A contact form must return 200 to the visitor whether or not
// the helpdesk accepted the enquiry — the notification email and the optin are
// separate paths and still carry it.
//
// MOVED 2026-08-15: this used to POST to the CDP app's own
// `/api/support/form-ticket`. That route — and the spam gate/ticket pipeline
// behind it — moved to a standalone support app, which now owns the support
// domain end to end; the CDP is delivery transport only. `SUPPORT_ENGINE_URL`
// has deliberately NO hardcoded default (unlike the `BARTMAIL_URL` default it
// replaced) — this repo is public, and a consuming app's production URL is
// exactly the kind of estate-architecture detail that does not belong here
// (see this repo's own CLAUDE.md). Every consumer must set it.
// ---------------------------------------------------------------------------

import { isSafeOutboundUrl } from "./security";

const SUPPORT_ENGINE_URL = (process.env.SUPPORT_ENGINE_URL ?? "").replace(/\/+$/, "");
const SUPPORT_FORM_SECRET = process.env.SUPPORT_FORM_SECRET ?? "";

// SSRF guard: SUPPORT_ENGINE_URL is env-sourced config, and every request to
// it carries SUPPORT_FORM_SECRET plus the visitor's name/email/message — so a
// poisoned or mistyped value must not be able to redirect that secret (and
// their PII) to an attacker-controlled host. Resolved once at module load;
// `createSupportTicketFromForm` fails closed (returns an error, never
// throws) when the URL does not pass.
const SAFE_SUPPORT_ENGINE_URL = isSafeOutboundUrl(SUPPORT_ENGINE_URL) ? SUPPORT_ENGINE_URL : null;

export interface SupportTicketInput {
  /** Brand slug as registered in the destination system. */
  brandSlug: string;
  email: string;
  name?: string | null;
  subject?: string | null;
  message: string;
  /** Which form it came from — used for the subject when none is supplied. */
  formName?: string | null;
}

export interface SupportTicketResult {
  ok: boolean;
  ticketId?: string;
  /** True when the gate suppressed it. NOT a failure — the system working. */
  blocked?: boolean;
  error?: string;
}

/**
 * File a contact-form enquiry as a support ticket, via BartMail's gate.
 *
 * A `blocked: true` result means the spam gate suppressed it. Callers should
 * treat that as SUCCESS and show the visitor the normal confirmation — telling a
 * spammer their message was filtered only teaches them to try again differently.
 */
export async function createSupportTicketFromForm(
  input: SupportTicketInput
): Promise<SupportTicketResult> {
  if (!SUPPORT_FORM_SECRET) return { ok: false, error: "SUPPORT_FORM_SECRET not configured" };
  if (!SUPPORT_ENGINE_URL) return { ok: false, error: "SUPPORT_ENGINE_URL not configured" };
  if (!SAFE_SUPPORT_ENGINE_URL) {
    return { ok: false, error: "SUPPORT_ENGINE_URL is not a valid public https host" };
  }

  const email = (input.email ?? "").trim().toLowerCase().slice(0, 254);
  const message = (input.message ?? "").trim().slice(0, 20_000);
  if (!email || !message) return { ok: false, error: "email and message are required" };

  try {
    const res = await fetch(`${SAFE_SUPPORT_ENGINE_URL}/api/support/form-ticket`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-support-form-secret": SUPPORT_FORM_SECRET,
      },
      body: JSON.stringify({
        brandSlug: (input.brandSlug ?? "").trim().slice(0, 64),
        email,
        name: input.name ?? null,
        subject: input.subject ?? null,
        message,
        formName: input.formName ?? null,
      }),
      // Bounded: a contact form must not hang on the helpdesk being slow. The
      // visitor's confirmation matters more than the ticket, which the
      // notification email backs up anyway.
      signal: AbortSignal.timeout(8_000),
    });

    const body = (await res.json().catch(() => ({}))) as {
      ok?: boolean;
      ticketId?: string;
      blocked?: boolean;
      error?: string;
    };

    if (!res.ok) return { ok: false, error: body.error ?? `HTTP ${res.status}` };
    return { ok: true, ticketId: body.ticketId, blocked: body.blocked === true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
