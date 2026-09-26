// ---------------------------------------------------------------------------
// Raise an in-app notification on a central notification centre from ANOTHER
// app's server code — one call, never a hand-rolled fetch per consumer.
//
// The receiving app exposes a token-gated ingest (`POST <base>/api/notifications`,
// `Authorization: Bearer <token>`). The token can create a notification and do
// nothing else, which is why a producer holds it instead of the receiving
// app's database key. Whether the notification ALSO emails or pushes is decided
// by the receiver's own per-category preferences, never by the caller.
//
// Generic by design (public repo): the base URL and token come from the
// consumer's own env. No hostnames, categories-per-product or business logic
// live here — the category list below is the receiver's fixed vocabulary and
// is validated there too (an unknown value is a 400, never silently dropped).
//
// NEVER THROWS. An alert that crashes the job it reports on turns a degraded
// run into a lost one. The result says whether the notification landed, and
// callers that care (a pause that must be seen) should record it.
// ---------------------------------------------------------------------------

import { isSafeOutboundUrl } from "./security";

export const CC_NOTIFICATION_CATEGORIES = [
  "content_creative",
  "campaigns_publishing",
  "agent_runs",
  "money",
  "customers_inbound",
  "products_marketplace",
  "platform_security",
  "reports_ready",
] as const;
export type CcNotificationCategory = (typeof CC_NOTIFICATION_CATEGORIES)[number];
export type CcNotificationSeverity = "info" | "success" | "warning" | "critical";

export interface CcNotificationOptions {
  /** Receiver origin, e.g. from an env var. */
  baseUrl: string | undefined | null;
  /** Ingest token, from an env var. */
  token: string | undefined | null;
  category: CcNotificationCategory;
  title: string;
  /** Producer name, shown on the card. */
  source: string;
  severity?: CcNotificationSeverity;
  /** Plain detail — facts as " • " lines. Never a pre-rendered alert. */
  body?: string;
  /** Same-origin RELATIVE path on the receiver (validated there). */
  href?: string;
  business?: string;
  sourceId?: string;
  /** Identical key inside the window → deduped by the receiver. */
  dedupeKey?: string;
  dedupeWindowMinutes?: number;
  timeoutMs?: number;
}

export interface CcNotificationResult {
  ok: boolean;
  status?: number;
  /** "created" | "deduped" when the receiver answered. */
  outcome?: string;
  error?: string;
}

export async function raiseCcNotification(opts: CcNotificationOptions): Promise<CcNotificationResult> {
  const label = `[cc-notify] ${opts.source}`;
  if (!opts.baseUrl || !opts.token) {
    console.error(`${label}: base URL or token not configured — notification NOT raised: ${opts.title}`);
    return { ok: false, error: "not configured" };
  }
  const base = opts.baseUrl.replace(/\/$/, "");
  if (!isSafeOutboundUrl(base)) {
    console.error(`${label}: base URL failed host safety check — notification NOT raised`);
    return { ok: false, error: "unsafe base url" };
  }
  try {
    const res = await fetch(`${base}/api/notifications`, {
      method: "POST",
      headers: { Authorization: `Bearer ${opts.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        category: opts.category,
        title: opts.title.slice(0, 300),
        source: opts.source,
        severity: opts.severity ?? "info",
        ...(opts.body ? { body: opts.body.slice(0, 8000) } : {}),
        ...(opts.href ? { href: opts.href } : {}),
        ...(opts.business ? { business: opts.business } : {}),
        ...(opts.sourceId ? { source_id: opts.sourceId } : {}),
        ...(opts.dedupeKey ? { dedupe_key: opts.dedupeKey } : {}),
        ...(opts.dedupeWindowMinutes ? { dedupe_window_minutes: opts.dedupeWindowMinutes } : {}),
      }),
      signal: AbortSignal.timeout(opts.timeoutMs ?? 8000),
    });
    const text = await res.text().catch(() => "");
    if (!res.ok) {
      console.error(`${label}: ingest answered ${res.status}: ${text.slice(0, 200)}`);
      return { ok: false, status: res.status, error: text.slice(0, 200) };
    }
    let outcome: string | undefined;
    try {
      outcome = (JSON.parse(text) as { status?: string }).status;
    } catch {
      outcome = undefined;
    }
    return { ok: true, status: res.status, outcome };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`${label}: ingest request failed: ${msg}`);
    return { ok: false, error: msg };
  }
}
