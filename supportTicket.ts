// ---------------------------------------------------------------------------
// Raise a support ticket from a website contact form.
//
// Every brand site already had a contact form that emailed a notification and
// wrote an optin. None of them created a TICKET, so form enquiries lived only
// in an inbox while the helpdesk sat empty — and the helpdesk is where SLAs,
// assignment, AI drafting and the audit trail live.
//
// SHARED, not per-repo, deliberately. Six sites need identical behaviour, and
// the alternative is six copies of a ticket INSERT drifting apart on required
// columns — which is exactly the failure this submodule exists to prevent. The
// same reasoning as `bartmail.ts` next door.
//
// Credentials come from the environment, never from this file: this repo is
// PUBLIC. Requires BARTMAIL_SUPABASE_URL and BARTMAIL_SUPABASE_SERVICE_ROLE_KEY,
// the same pair `bartmail.ts` already uses, so a consuming site needs no new
// secret.
//
// NEVER THROWS. A contact form must return 200 to the visitor whether or not
// the helpdesk accepted the ticket — the notification email and the optin are
// separate paths and still carry the enquiry. Failures are returned, and logged
// by the caller.
// ---------------------------------------------------------------------------

const SUPABASE_URL = (process.env.BARTMAIL_SUPABASE_URL ?? "").replace(/\/+$/, "");
const SERVICE_KEY = process.env.BARTMAIL_SUPABASE_SERVICE_ROLE_KEY ?? "";

export interface SupportTicketInput {
  /** BartMail brand slug, e.g. "cloud-plus". Resolved to brand_id here. */
  brandSlug: string;
  email: string;
  name?: string | null;
  subject?: string | null;
  message: string;
  /** Where it came from, for the ticket subject when none is supplied. */
  formName?: string | null;
}

export interface SupportTicketResult {
  ok: boolean;
  ticketId?: string;
  error?: string;
}

function headers(): Record<string, string> {
  return {
    apikey: SERVICE_KEY,
    Authorization: `Bearer ${SERVICE_KEY}`,
    "Content-Type": "application/json",
  };
}

/** Trim and cap. A contact form is public input; nothing here trusts its length. */
function clip(s: string | null | undefined, max: number): string {
  return (s ?? "").toString().trim().slice(0, max);
}

/**
 * Create a ticket with the enquiry as its first inbound message.
 *
 * Two rows, and the message is written SECOND on purpose: a ticket with no
 * message reads as an empty enquiry an agent can still see and chase, whereas a
 * message with no ticket is orphaned and invisible. If the second insert fails
 * the ticket still exists, which is the recoverable direction.
 */
export async function createSupportTicketFromForm(
  input: SupportTicketInput
): Promise<SupportTicketResult> {
  if (!SUPABASE_URL || !SERVICE_KEY) {
    return { ok: false, error: "BartMail Supabase env not configured" };
  }

  const email = clip(input.email, 254).toLowerCase();
  const message = clip(input.message, 20_000);
  if (!email || !message) return { ok: false, error: "email and message are required" };

  try {
    // Brand slug -> id. An unknown slug is a configuration error in the calling
    // site, and creating the ticket under a guessed brand would put a customer's
    // enquiry in another brand's queue.
    const brandRes = await fetch(
      `${SUPABASE_URL}/rest/v1/brands?slug=eq.${encodeURIComponent(clip(input.brandSlug, 64))}&select=id&limit=1`,
      { headers: headers() }
    );
    if (!brandRes.ok) return { ok: false, error: `brand lookup failed: ${brandRes.status}` };
    const brands = (await brandRes.json()) as { id: string }[];
    const brandId = brands?.[0]?.id;
    if (!brandId) return { ok: false, error: `unknown brand slug: ${input.brandSlug}` };

    const subject =
      clip(input.subject, 200) ||
      `Website enquiry${input.formName ? ` — ${clip(input.formName, 60)}` : ""}`;

    const now = new Date().toISOString();
    const ticketRes = await fetch(`${SUPABASE_URL}/rest/v1/support_tickets`, {
      method: "POST",
      headers: { ...headers(), Prefer: "return=representation" },
      body: JSON.stringify({
        brand_id: brandId,
        subject,
        status: "open",
        priority: "normal",
        // 'form' already exists in the channel vocabulary — the schema
        // anticipated this path before anything used it.
        channel: "form",
        requester_email: email,
        requester_name: clip(input.name, 120) || null,
        last_message_at: now,
      }),
    });
    if (!ticketRes.ok) {
      return { ok: false, error: `ticket insert failed: ${ticketRes.status} ${(await ticketRes.text()).slice(0, 200)}` };
    }
    const created = (await ticketRes.json()) as { id: string }[];
    const ticketId = created?.[0]?.id;
    if (!ticketId) return { ok: false, error: "ticket insert returned no id" };

    const msgRes = await fetch(`${SUPABASE_URL}/rest/v1/support_messages`, {
      method: "POST",
      headers: { ...headers(), Prefer: "return=minimal" },
      body: JSON.stringify({
        ticket_id: ticketId,
        direction: "inbound",
        author: "customer",
        author_email: email,
        // Stored as TEXT. The body is public input and is rendered as text
        // everywhere it appears; writing it into body_html would make a contact
        // form a stored-XSS path into the agent's own console.
        body_text: message,
        body_html: null,
        status: "received",
      }),
    });
    if (!msgRes.ok) {
      return { ok: true, ticketId, error: `ticket created but message insert failed: ${msgRes.status}` };
    }

    return { ok: true, ticketId };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
