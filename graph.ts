// ---------------------------------------------------------------------------
// Microsoft Graph (client-credentials) — the estate's one way to send a
// notification email or create an Outlook draft.
//
// WHY THIS EXISTS
// Several routes each hand-rolled the same OAuth-token-then-sendMail dance, and
// most of them had NO retry of any kind. That is the exact failure that lost a
// customer's quote email in a real incident: a single transient rejection, one
// dropped message, no error surfaced to anyone. When these sends fail, the
// operator simply never hears that a lead came in — there is no bounce, no
// alert, and the visitor still sees a success screen. Silence is the failure
// mode, which is why the retry belongs here rather than in whichever route
// remembers it.
//
// WHAT IS RETRIED, AND WHAT IS NOT
//   * fetch() itself throwing — Graph intermittently resets the TLS socket
//     mid-handshake. Retried (this reuses the only correct handling of it that
//     existed anywhere in the estate before this module was written).
//   * 429 and 5xx — retried, honouring `Retry-After` when Graph sends one.
//   * every other 4xx — NOT retried. A malformed message or a bad credential
//     fails identically the second time; retrying just delays the error.
//
// ENV VARS: the same Azure app is configured under THREE different names
// across the estate's consumers — `GRAPH_*`, `MS_GRAPH_*` and `MS_*`. All
// three are read, in that order. This is deliberate: renaming them would mean
// editing several separate hosting projects for zero functional gain, and a
// missed one silently stops that brand's notifications. Set whichever the
// repo already uses.
//
// NOT framework-coupled — no `server-only` import (this module is consumed by
// non-Next code too). Consumers that want that guard add it in their own shim.
// ---------------------------------------------------------------------------

/**
 * The one sending mailbox for the estate. Notifications are sent as, and by
 * default to, this address. Configure via a `GRAPH_MAILBOX` env var in each
 * consuming app — never hardcode an address in a public module.
 */
export const GRAPH_MAILBOX = env("MAILBOX") ?? "";

const MAX_ATTEMPTS = 3;

// Consuming apps in this estate variously use `GRAPH_`, `MS_GRAPH_` and `MS_`
// prefixes, which is why every lookup goes through here. The mailbox used to
// read `process.env.GRAPH_MAILBOX` directly and so honoured only ONE of the
// three — an app that set `MS_GRAPH_MAILBOX` (a real pattern here) had an
// empty mailbox and every send threw.
function env(
  suffix: "TENANT_ID" | "CLIENT_ID" | "CLIENT_SECRET" | "MAILBOX"
): string | undefined {
  return (
    process.env[`GRAPH_${suffix}`] ??
    process.env[`MS_GRAPH_${suffix}`] ??
    process.env[`MS_${suffix}`]
  );
}

/**
 * True when this environment can actually send. Callers that must degrade
 * quietly (a form that still has to succeed without a notification) check this
 * first.
 *
 * The mailbox is part of "configured" on purpose. This used to check only the
 * three credentials while `sendMail` additionally throws on an unset mailbox —
 * so an app holding credentials but no mailbox passed the check, then threw
 * straight into the caller's catch. Every consumer that gates on this swallows
 * that throw by design, which turned a missing env var into permanently silent
 * notifications. Reporting "not configured" honestly is what lets a caller log
 * it once instead.
 */
export function isGraphConfigured(): boolean {
  return Boolean(env("TENANT_ID") && env("CLIENT_ID") && env("CLIENT_SECRET") && env("MAILBOX"));
}

function backoffMs(attempt: number, retryAfter: string | null): number {
  const seconds = retryAfter ? Number(retryAfter) : NaN;
  // Graph's Retry-After is authoritative when present — guessing shorter just
  // earns another 429. Cap it so a pathological value can't hang a request.
  if (Number.isFinite(seconds) && seconds > 0) return Math.min(seconds * 1000, 10_000);
  return 300 * 2 ** attempt;
}

async function fetchWithRetry(url: string, init: RequestInit): Promise<Response> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    try {
      const res = await fetch(url, init);
      if (res.status === 429 || res.status >= 500) {
        if (attempt < MAX_ATTEMPTS - 1) {
          await new Promise((r) => setTimeout(r, backoffMs(attempt, res.headers.get("retry-after"))));
          continue;
        }
      }
      return res;
    } catch (err) {
      // Transport-level failure (TLS reset). Retry — but if this was the last
      // attempt, rethrow rather than returning something the caller can't read.
      lastErr = err;
      if (attempt < MAX_ATTEMPTS - 1) {
        await new Promise((r) => setTimeout(r, backoffMs(attempt, null)));
        continue;
      }
      throw lastErr;
    }
  }
  throw lastErr ?? new Error("Graph request failed after retries");
}

/** Acquire a client-credentials token. Throws when credentials are missing or rejected. */
export async function getGraphToken(): Promise<string> {
  const tenantId = env("TENANT_ID");
  const clientId = env("CLIENT_ID");
  const clientSecret = env("CLIENT_SECRET");
  if (!tenantId || !clientId || !clientSecret) {
    throw new Error("Microsoft Graph credentials are not configured");
  }

  const res = await fetchWithRetry(`https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: "client_credentials",
      scope: "https://graph.microsoft.com/.default",
    }).toString(),
  });

  if (!res.ok) throw new Error(`Graph token failed: ${res.status}`);
  const data = (await res.json()) as { access_token?: string };
  if (!data.access_token) throw new Error("Graph token response had no access_token");
  return data.access_token;
}

export interface SendMailOptions {
  subject: string;
  /** Body HTML. Escape every user-supplied value before it gets here — this module does not escape for you. */
  html: string;
  /** Defaults to GRAPH_MAILBOX (a self-notification). */
  to?: string;
  /** Reply-To, e.g. the person who submitted the form. */
  replyTo?: string;
  /** Pre-fetched token, to overlap acquisition with other async work. */
  token?: string;
}

/**
 * Send an HTML email, saved to Sent Items. Throws on failure **after** retries
 * — callers decide whether that is fatal. For a public form it should not be:
 * capture the lead first, then notify, and let a notification failure be logged
 * rather than 500 the visitor.
 */
export async function sendMail(opts: SendMailOptions): Promise<void> {
  // Fail loudly, not with a 400 against an empty users// path: an unset
  // mailbox means the consuming app's env is missing GRAPH_MAILBOX, and the
  // whole point of this module is that notification failures must be
  // diagnosable, never silent.
  if (!GRAPH_MAILBOX) throw new Error("GRAPH_MAILBOX env var is not set — cannot send Graph mail");
  const token = opts.token ?? (await getGraphToken());
  const message: Record<string, unknown> = {
    subject: opts.subject,
    body: { contentType: "HTML", content: opts.html },
    toRecipients: [{ emailAddress: { address: opts.to ?? GRAPH_MAILBOX } }],
  };
  // Raw address, deliberately not HTML-escaped: this is a JSON field, and
  // escaping it produces reply addresses containing &amp;.
  if (opts.replyTo) message.replyTo = [{ emailAddress: { address: opts.replyTo } }];

  const res = await fetchWithRetry(`https://graph.microsoft.com/v1.0/users/${GRAPH_MAILBOX}/sendMail`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ message, saveToSentItems: true }),
  });

  if (!res.ok) throw new Error(`sendMail failed: ${res.status} — ${(await res.text()).slice(0, 300)}`);
}

/**
 * Create an Outlook **draft** (`POST /messages`). Never sends. Used for
 * hand-off flows a human reviews and sends themself — do not "improve" this
 * into a sendMail call.
 */
export async function createDraft(opts: {
  subject: string;
  html: string;
  to: string[];
  token?: string;
}): Promise<void> {
  if (!GRAPH_MAILBOX) throw new Error("GRAPH_MAILBOX env var is not set — cannot create Graph draft");
  const token = opts.token ?? (await getGraphToken());
  const res = await fetchWithRetry(`https://graph.microsoft.com/v1.0/users/${GRAPH_MAILBOX}/messages`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      subject: opts.subject,
      body: { contentType: "HTML", content: opts.html },
      toRecipients: opts.to.map((address) => ({ emailAddress: { address } })),
    }),
  });

  if (!res.ok) throw new Error(`draft creation failed: ${res.status} — ${(await res.text()).slice(0, 300)}`);
}
