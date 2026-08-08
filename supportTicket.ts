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
// protects. A direct write from six websites skipped every bit of it, so the
// forms would have filled the helpdesk with exactly the rubbish the gate exists
// to stop. BartMail owns the support pipeline; sites ask, they do not write.
//
// (Note the direction of travel here differs from `bartmail.ts` next door, and
// deliberately: optins are a DIRECT Supabase write because there is no
// server-side decision to make. A support ticket has one — whether it should
// exist at all — so it has to go through the code that makes it.)
//
// Auth is a shared secret, NOT the service-role key: a website able to read
// every contact in the CDP in order to file a support ticket is far more
// authority than the job needs. Requires SUPPORT_FORM_SECRET, and BARTMAIL_URL
// if the default host is wrong for an environment.
//
// NEVER THROWS. A contact form must return 200 to the visitor whether or not
// the helpdesk accepted the enquiry — the notification email and the optin are
// separate paths and still carry it.
// ---------------------------------------------------------------------------

const BARTMAIL_URL = (process.env.BARTMAIL_URL ?? "https://bartmail.vercel.app").replace(/\/+$/, "");
const SUPPORT_FORM_SECRET = process.env.SUPPORT_FORM_SECRET ?? "";

export interface SupportTicketInput {
  /** BartMail brand slug, e.g. "cloud-plus". */
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

  const email = (input.email ?? "").trim().toLowerCase().slice(0, 254);
  const message = (input.message ?? "").trim().slice(0, 20_000);
  if (!email || !message) return { ok: false, error: "email and message are required" };

  try {
    const res = await fetch(`${BARTMAIL_URL}/api/support/form-ticket`, {
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
