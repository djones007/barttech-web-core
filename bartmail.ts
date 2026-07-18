// ---------------------------------------------------------------------------
// Barttech shared BartMail client — THE canonical lead-write path for the estate.
// Writes optins directly to BartMail's Supabase (per the BartMail optin standard:
// direct Supabase write, never the HTTP API; always `await` inside try/catch).
// Brand-agnostic — the CALLER passes `brand` (looked up by slug at runtime), so
// every consuming site uses the same code and its own brand value. Copied from
// the long-standing canonical `be-more-boundless/lib/bartmail.ts`.
//
// Node-runtime only (imports @supabase/supabase-js + node:crypto). Each consumer
// resolves @supabase/supabase-js from its own node_modules (web-core is
// source-only, no deps). Requires env: BARTMAIL_SUPABASE_URL,
// BARTMAIL_SUPABASE_SERVICE_ROLE_KEY (+ BARTMAIL_URL / BARTMAIL_PURCHASES_SECRET
// for bartmailPurchase/Verify) — set in each app's env, NEVER committed here.
// Exports: bartmailOptin, bartmailPurchase, bartmailVerify.
// ---------------------------------------------------------------------------
import { createClient } from "@supabase/supabase-js";
import crypto from "crypto";

const BARTMAIL_URL_RAW = process.env.BARTMAIL_URL ?? "https://bartmail.vercel.app";
const ALLOWED_BARTMAIL = /^https:\/\/bartmail\.vercel\.app(\/|$)/i;
const BARTMAIL_URL = ALLOWED_BARTMAIL.test(BARTMAIL_URL_RAW) ? BARTMAIL_URL_RAW : "https://bartmail.vercel.app";

const BARTMAIL_SUPABASE_URL = process.env.BARTMAIL_SUPABASE_URL ?? "";
const BARTMAIL_SUPABASE_SERVICE_ROLE_KEY =
  process.env.BARTMAIL_SUPABASE_SERVICE_ROLE_KEY ?? "";

function getBartmailSupabase() {
  if (!BARTMAIL_SUPABASE_URL || !BARTMAIL_SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error("BartMail Supabase credentials not configured");
  }
  return createClient(BARTMAIL_SUPABASE_URL, BARTMAIL_SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
  });
}

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
  tags?: string[];
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
    tags: extraTags,
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
      "id, first_name, last_name, utm_source, utm_medium, utm_campaign, utm_content, utm_term, referrer, source_page, country"
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
      })
      .select("id")
      .single();

    if (insertError || !contact) {
      throw new Error(`BartMail contact insert failed: ${insertError?.message ?? "no data"}`);
    }
    contactId = (contact as { id: string }).id;
  } else {
    const ex = existing as Record<string, string | null> & { id: string };
    const updates: Record<string, string> = {};
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

    if (Object.keys(updates).length > 0) {
      const { error: updateError } = await supabase
        .from("contacts")
        .update(updates)
        .eq("id", ex.id);
      if (updateError) throw new Error(`BartMail contact update failed: ${updateError.message}`);
    }

    contactId = ex.id;
  }

  // Remove any brand-level suppression (resubscribe)
  await supabase
    .from("contact_suppressions")
    .delete()
    .eq("contact_id", contactId)
    .eq("tenant_id", tenantId)
    .eq("brand_id", brandId);

  // Build tag list
  const tagsToInsert = [`${brand}-optin`];
  if (form_type) tagsToInsert.push(`${brand}-${form_type}`);
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
    const sig = secret
      ? `sha256=${crypto.createHmac("sha256", secret).update(bodyStr).digest("hex")}`
      : undefined;
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (sig) headers["x-bartmail-signature"] = sig;
    await fetch(`${BARTMAIL_URL}/api/purchases`, {
      method: "POST",
      headers,
      body: bodyStr,
    });
  } catch {
    // fire-and-forget
  }
}

// Confirm a contact carries a given tag (e.g. the buyer tag) before serving a download.
export async function bartmailVerify(email: string, tag: string): Promise<boolean> {
  try {
    const res = await fetch(
      `${BARTMAIL_URL}/api/contacts/verify?email=${encodeURIComponent(email)}&tag=${encodeURIComponent(tag)}`,
      { cache: "no-store" }
    );
    if (!res.ok) return false;
    const data = (await res.json()) as { verified?: boolean };
    return !!data.verified;
  } catch {
    return false;
  }
}
