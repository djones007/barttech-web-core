// ---------------------------------------------------------------------------
// Barttech shared BartMail client — THE canonical lead-write path for the estate.
// Writes optins directly to BartMail's Supabase (per the BartMail optin standard:
// direct Supabase write, never the HTTP API; always `await` inside try/catch).
// Brand-agnostic — the CALLER passes `brand` (looked up by slug at runtime), so
// every consuming site uses the same code and its own brand value. Copied from
// a long-standing canonical implementation on one of the estate's brand sites.
//
// Imports @supabase/supabase-js at module scope; each consumer resolves it from
// its own node_modules (web-core is source-only, no deps). `node:crypto` is
// deliberately NOT imported at module scope — it is lazily imported only where
// needed (bartmailPurchase's HMAC signing, and resolveBartmailUrl's host-hash
// check on the non-default path). That keeps the optin path (bartmailOptin,
// all most consumers use) free of node:crypto, so this module stays usable
// from runtimes and packages that cannot take that dependency.
// Do not hoist it back to a top-level import. Requires env: BARTMAIL_SUPABASE_URL,
// BARTMAIL_SUPABASE_SERVICE_ROLE_KEY (+ BARTMAIL_URL / BARTMAIL_PURCHASES_SECRET
// for bartmailPurchase/Verify, CONTACT_EVENTS_SECRET for bartmailEvent) — set in
// each app's env, NEVER committed here.
// Exports: bartmailOptin, bartmailPurchase, bartmailEvent, bartmailVerify.
// ---------------------------------------------------------------------------
import { createClient } from "@supabase/supabase-js";

const BARTMAIL_URL_DEFAULT = "https://bartmail.vercel.app";
const BARTMAIL_URL_RAW = process.env.BARTMAIL_URL ?? BARTMAIL_URL_DEFAULT;
// SSRF guard: BARTMAIL_URL is an env var, so an allowlist (not a "looks like a
// URL" check) decides where signed request bodies may be sent. Two hosts are
// allowed and both serve the same deployment: the default above, and the
// canonical custom domain — matched by SHA-256 of the hostname rather than as
// a plaintext literal, so this public source does not name the internal host.
// Guard strength is unchanged (still an exact-match allowlist); only what a
// reader of this file learns changes. Resolved lazily because hashing needs
// node:crypto, which this module must not import at module scope (see the
// header note) — and only the three HTTP-path functions below use the URL.
const BARTMAIL_CANONICAL_HOST_SHA256 =
  "5ed8bef53a76235f8f2fd5e465300af56bd3cfbfd96cec20e2e3b15dab3a3bad";
let bartmailUrlResolved: string | null = null;
async function resolveBartmailUrl(): Promise<string> {
  if (bartmailUrlResolved !== null) return bartmailUrlResolved;
  let ok = false;
  try {
    const u = new URL(BARTMAIL_URL_RAW);
    if (u.protocol === "https:" && u.port === "" && !u.username && !u.password) {
      const host = u.hostname.toLowerCase();
      if (host === "bartmail.vercel.app") {
        ok = true;
      } else {
        const { createHash } = await import("node:crypto");
        ok = createHash("sha256").update(host).digest("hex") === BARTMAIL_CANONICAL_HOST_SHA256;
      }
    }
  } catch {
    ok = false;
  }
  bartmailUrlResolved = ok ? BARTMAIL_URL_RAW : BARTMAIL_URL_DEFAULT;
  return bartmailUrlResolved;
}

const BARTMAIL_SUPABASE_SERVICE_ROLE_KEY =
  process.env.BARTMAIL_SUPABASE_SERVICE_ROLE_KEY ?? "";

// SSRF guard on the Supabase host — NORMALISE FIRST, THEN VALIDATE.
//
// A service-role key (unrestricted database access) is sent to whatever
// BARTMAIL_SUPABASE_URL resolves to, so a tampered or mistyped value must not be
// able to redirect it. Adopted estate-wide 2026-07-29 from one consumer's
// corporate site, whose hand-written REST client was the only one in the
// estate that had it.
//
// The normalise step is the whole reason this is safe to roll out without first
// reading 13 production env values that Vercel will not disclose. The realistic
// mismatch was never a hostile host — it was a harmless trailing slash, which
// works fine today and would fail a strict regex, taking a live lead form down.
// Trailing slashes and casing are corrected rather than rejected; only a
// genuinely foreign host throws.
function normaliseSupabaseUrl(raw: string): string {
  return raw.trim().replace(/\/+$/, "").toLowerCase();
}

const SUPABASE_HOST_ALLOWED = /^https:\/\/[a-z0-9-]+\.supabase\.co$/;

const BARTMAIL_SUPABASE_URL = normaliseSupabaseUrl(process.env.BARTMAIL_SUPABASE_URL ?? "");

/**
 * The single BartMail Supabase client factory (service-role, no session
 * persistence). Used internally by the optin write, and exported for consumers
 * that need the raw client for other server-side work (e.g. one consumer's
 * durable rate limiter). Throws if credentials are missing — callers that must
 * fail open should check the env vars first. Also exported as `getBartmailClient`.
 */
export function getBartmailSupabase() {
  if (!BARTMAIL_SUPABASE_URL || !BARTMAIL_SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error("BartMail Supabase credentials not configured");
  }
  // See normaliseSupabaseUrl above. The message deliberately names the env var
  // and shows the normalised value: this can only fire on a genuine
  // misconfiguration, and whoever hits it needs to know which value is wrong.
  // It is not user input, so there is nothing sensitive to leak — the KEY is
  // never included.
  if (!SUPABASE_HOST_ALLOWED.test(BARTMAIL_SUPABASE_URL)) {
    throw new Error(
      `BARTMAIL_SUPABASE_URL is not a Supabase host: ${BARTMAIL_SUPABASE_URL}`
    );
  }
  return createClient(BARTMAIL_SUPABASE_URL, BARTMAIL_SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
  });
}

/** Alias of {@link getBartmailSupabase} for consumers that named it `getBartmailClient`. */
export { getBartmailSupabase as getBartmailClient };

export interface BartmailOptinParams {
  email: string;
  brand: string;
  form_type?: string;
  first_name?: string;
  last_name?: string;
  utm_source?: string;
  utm_medium?: string;
  utm_campaign?: string;
  utm_content?: string;
  utm_term?: string;
  referrer?: string;
  source_page?: string;
  country?: string;
  /**
   * The lead's personalised quote link, stored on `contacts.quote_url` for use
   * as an email merge field. Unlike the attribution fields below it is
   * LAST-write-wins, not fill-blanks-only: it points at current state, so a
   * returning lead with a fresh quote must get the fresh link, never the stale
   * one from their first visit. (It was silently dropped by this module until
   * 2026-07-29, so contacts optin'd before then have no quote_url.)
   */
  quote_url?: string;
  tags?: string[];
  /**
   * Extra structured fields stored on the contact record (e.g. a scorecard
   * score). Merged into any existing custom_fields on re-optin, never dropped.
   */
  custom_fields?: Record<string, string>;
  /**
   * When false, skips adding the default `${brand}-optin` / `${brand}-${form_type}`
   * tags AND does not clear existing suppression — for a form whose opt-in
   * checkbox was left unticked (the visitor did NOT consent to marketing). The
   * contact record + custom_fields are still stored, so the lead is retained for
   * internal segmentation but is not enrolled or un-suppressed. Defaults to true
   * (existing behaviour for every other caller).
   */
  applyOptinTags?: boolean;
}

export async function bartmailOptin(params: BartmailOptinParams): Promise<void> {
  const {
    email,
    brand,
    form_type,
    first_name,
    last_name,
    utm_source,
    utm_medium,
    utm_campaign,
    utm_content,
    utm_term,
    referrer,
    source_page,
    country,
    quote_url,
    tags: extraTags,
    custom_fields,
    applyOptinTags = true,
  } = params;

  const supabase = getBartmailSupabase();

  // Look up brand by slug
  const { data: brandRecord, error: brandError } = await supabase
    .from("brands")
    .select("id, tenant_id")
    .eq("slug", brand)
    .single();

  if (brandError || !brandRecord) {
    throw new Error(`BartMail brand not found: ${brand}`);
  }

  const { id: brandId, tenant_id: tenantId } = brandRecord as {
    id: string;
    tenant_id: string;
  };

  // Find or create contact — fill blanks only on existing
  const { data: existing, error: lookupError } = await supabase
    .from("contacts")
    .select(
      "id, first_name, last_name, utm_source, utm_medium, utm_campaign, utm_content, utm_term, referrer, source_page, country, custom_fields"
    )
    .eq("email", email)
    .eq("tenant_id", tenantId)
    .maybeSingle();

  if (lookupError) throw new Error(`BartMail contact lookup failed: ${lookupError.message}`);

  let contactId: string;

  if (!existing) {
    const { data: contact, error: insertError } = await supabase
      .from("contacts")
      .insert({
        email,
        tenant_id: tenantId,
        first_name: first_name ?? null,
        last_name: last_name ?? null,
        utm_source: utm_source ?? null,
        utm_medium: utm_medium ?? null,
        utm_campaign: utm_campaign ?? null,
        utm_content: utm_content ?? null,
        utm_term: utm_term ?? null,
        referrer: referrer ?? null,
        source_page: source_page ?? null,
        country: country ?? null,
        quote_url: quote_url ?? null,
        // NOT NULL with a '{}' default in BartMail's schema — an explicit null
        // overrides the default and fails the insert, silently killing every
        // optin from a caller that doesn't pass custom_fields. Never send null.
        custom_fields: custom_fields ?? {},
      })
      .select("id")
      .single();

    if (insertError || !contact) {
      throw new Error(`BartMail contact insert failed: ${insertError?.message ?? "no data"}`);
    }
    contactId = (contact as { id: string }).id;
  } else {
    const ex = existing as Record<string, string | null> & {
      id: string;
      custom_fields: Record<string, string> | null;
    };
    const updates: Record<string, unknown> = {};
    if (first_name && !ex.first_name) updates.first_name = first_name;
    if (last_name && !ex.last_name) updates.last_name = last_name;
    if (utm_source && !ex.utm_source) updates.utm_source = utm_source;
    if (utm_medium && !ex.utm_medium) updates.utm_medium = utm_medium;
    if (utm_campaign && !ex.utm_campaign) updates.utm_campaign = utm_campaign;
    if (utm_content && !ex.utm_content) updates.utm_content = utm_content;
    if (utm_term && !ex.utm_term) updates.utm_term = utm_term;
    if (referrer && !ex.referrer) updates.referrer = referrer;
    if (source_page && !ex.source_page) updates.source_page = source_page;
    if (country && !ex.country) updates.country = country;
    // Last-write-wins, deliberately unlike the fill-blanks-only fields above:
    // a returning lead's newest quote link must replace the stale one.
    if (quote_url) updates.quote_url = quote_url;
    if (custom_fields) {
      // Custom fields always merge in fresh values (e.g. a re-taken scorecard score)
      updates.custom_fields = { ...(ex.custom_fields ?? {}), ...custom_fields };
    }

    if (Object.keys(updates).length > 0) {
      const { error: updateError } = await supabase
        .from("contacts")
        .update(updates)
        .eq("id", ex.id);
      if (updateError) throw new Error(`BartMail contact update failed: ${updateError.message}`);
    }

    contactId = ex.id;
  }

  if (applyOptinTags) {
    // Remove any brand-level suppression (resubscribe). Skipped when consent
    // wasn't given — an unticked opt-in must not silently un-suppress a contact.
    await supabase
      .from("contact_suppressions")
      .delete()
      .eq("contact_id", contactId)
      .eq("tenant_id", tenantId)
      .eq("brand_id", brandId);
  }

  // Build tag list — skip the default optin tags when consent wasn't given.
  // extraTags (explicit non-optin tags) are still applied regardless.
  const tagsToInsert = applyOptinTags ? [`${brand}-optin`] : [];
  if (applyOptinTags && form_type) tagsToInsert.push(`${brand}-${form_type}`);
  if (Array.isArray(extraTags)) {
    for (const t of extraTags) {
      if (typeof t === "string" && t.trim()) tagsToInsert.push(`${brand}-${t.trim()}`);
    }
  }
  const uniqueTags = Array.from(new Set(tagsToInsert));

  // Upsert tags
  for (const tagName of uniqueTags) {
    await supabase.from("contact_tags").upsert(
      { contact_id: contactId, tenant_id: tenantId, brand_id: brandId, name: tagName },
      { onConflict: "contact_id,name", ignoreDuplicates: true }
    );
  }

  // Sequence enrolment: NOT triggered here. The AFTER INSERT trigger on
  // contact_tags feeds tag_enrolment_outbox, drained every 2 min by
  // bartmail's process-tag-outbox cron — any tag insert reliably enrols
  // without the caller doing anything. The old direct Trigger.dev call
  // (bartmail-enrol-sequence) was removed 2026-07-13 — that task no
  // longer exists post Vercel-Cron-cutover; it was silently failing.
}

export interface BartmailPurchaseParams {
  email: string;
  brand: string;
  product: string;
  amount: number; // cents
  currency?: string;
  stripe_session_id?: string; // idempotency key — duplicate deliveries ignored
}

// Log a purchase against the contact record. The contact must already exist
// (call bartmailOptin first). Idempotent on stripe_session_id.
export async function bartmailPurchase(params: BartmailPurchaseParams): Promise<void> {
  try {
    const bodyStr = JSON.stringify(params);
    const secret = process.env.BARTMAIL_PURCHASES_SECRET;
    // Lazy, INSIDE the function: importing this module must not pull node:crypto
    // into the graph. See the header note — do not hoist this to a top-level
    // import. Only reached when a signing secret is configured.
    let sig: string | undefined;
    if (secret) {
      const { createHmac } = await import("node:crypto");
      sig = `sha256=${createHmac("sha256", secret).update(bodyStr).digest("hex")}`;
    }
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (sig) headers["x-bartmail-signature"] = sig;
    await fetch(`${await resolveBartmailUrl()}/api/purchases`, {
      method: "POST",
      headers,
      body: bodyStr,
    });
  } catch {
    // fire-and-forget
  }
}

// ---------------------------------------------------------------------------
// Contact timeline events
// ---------------------------------------------------------------------------
// The "what did this person DO" half of the contact record. Email activity
// already lives in `email_events` and purchases in `purchases`; `contact_events`
// is deliberately NOT a copy of either — BartMail's contact page UNIONs the
// three at read time. This holds touchpoints that otherwise have nowhere to go:
// a quote request, an order, an enquiry, an onboarding submission, a hand-typed
// note. It replaced the retired Teable "Brand Interaction" table on 2026-07-29.
//
// Posted over HTTP rather than written direct to Supabase (unlike bartmailOptin)
// because the route owns rules the caller shouldn't reimplement: the event-type
// vocabulary, brand-slug → brand_id/tenant_id resolution, and the
// contact-not-found → skip decision. One producer, one set of rules.

/**
 * The fixed event vocabulary, mirroring BartMail's `/api/contacts/event`.
 * Not free text: these drive segmentation later ("requested a quote but never
 * accepted"), and an open string becomes forty spellings of "quote" that no
 * query can group. Adding a type means adding it in BOTH places — here and in
 * the route — and the route is the authority; an unknown value is rejected 400.
 */
export const BARTMAIL_EVENT_TYPES = [
  "quote_requested",
  "quote_viewed",
  "quote_accepted",
  "order_placed",
  "enquiry_submitted",
  "onboarding_submitted",
  "form_submitted",
  /** A touchpoint no automated producer saw (e.g. mail to a shared support@
   *  inbox, which is outside BartMail's inbound reply pipeline). Describe it in
   *  `metadata.summary`. */
  "note",
] as const;

export type BartmailEventType = (typeof BARTMAIL_EVENT_TYPES)[number];

export interface BartmailEventParams {
  email: string;
  /** Brand SLUG (e.g. "acme-brand"), resolved to brand_id/tenant_id by the route. */
  brand: string;
  event_type: BartmailEventType;
  /** Free-form context. Undefined/null/empty values are dropped before sending. */
  metadata?: Record<string, unknown>;
}

/**
 * Record a non-email touchpoint against a contact.
 *
 * Returns `true` only when BartMail accepted the event. Never throws, and never
 * rejects — a timeline write must not be able to break the lead capture or
 * checkout it is attached to. Callers should still `await` it: on Vercel the
 * isolate can be frozen the moment the response is returned, which silently
 * kills an un-awaited promise (the fire-and-forget failure mode that hid the
 * 25–29 July optin outage for four days).
 *
 * A missing `CONTACT_EVENTS_SECRET` is a no-op returning `false`, not a throw,
 * so a site that hasn't been given the secret yet degrades to "no timeline"
 * rather than 500s on every form.
 *
 * Note the contact must already exist — call `bartmailOptin` FIRST. An unknown
 * contact is a no-op on BartMail's side (200 `skipped: contact_not_found`),
 * which this reports as `true`: the event was handled as intended, and the
 * missing contact means the optin write failed, which the optin health monitor
 * already alerts on.
 */
export async function bartmailEvent(params: BartmailEventParams): Promise<boolean> {
  // Same env var name as the internal CDP's own route and a payments-side
  // edge function — one secret, one name estate-wide. A second alias would be
  // exactly the drift this module exists to prevent.
  const secret = process.env.CONTACT_EVENTS_SECRET;
  if (!secret || !params?.email || !params?.brand || !params?.event_type) return false;

  try {
    // Strip empty values so stored metadata stays queryable rather than a
    // scatter of nulls every later read has to special-case.
    const metadata: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(params.metadata ?? {})) {
      if (v !== undefined && v !== null && v !== "") metadata[k] = v;
    }

    const bodyStr = JSON.stringify({
      email: String(params.email).trim().toLowerCase(),
      brand: params.brand,
      event_type: params.event_type,
      metadata,
    });

    // Lazy import, INSIDE the function — see the module header. Importing this
    // module must not pull node:crypto into the optin path's graph.
    const { createHmac } = await import("node:crypto");
    const sig = `sha256=${createHmac("sha256", secret).update(bodyStr).digest("hex")}`;

    const res = await fetch(`${await resolveBartmailUrl()}/api/contacts/event`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-bartmail-signature": sig },
      body: bodyStr,
    });

    if (!res.ok) {
      // Logged, not thrown. Silence here is what let the last write failure run
      // undetected for four days.
      console.error(
        `[bartmailEvent] ${params.event_type} rejected: ${res.status} ${(await res.text()).slice(0, 200)}`
      );
      return false;
    }
    return true;
  } catch (err) {
    console.error("[bartmailEvent]", err instanceof Error ? err.message : String(err));
    return false;
  }
}

// Confirm a contact carries a given tag (e.g. the buyer tag) before serving a download.
export async function bartmailVerify(email: string, tag: string): Promise<boolean> {
  try {
    const res = await fetch(
      `${await resolveBartmailUrl()}/api/contacts/verify?email=${encodeURIComponent(email)}&tag=${encodeURIComponent(tag)}`,
      { cache: "no-store" }
    );
    if (!res.ok) return false;
    const data = (await res.json()) as { verified?: boolean };
    return !!data.verified;
  } catch {
    return false;
  }
}
