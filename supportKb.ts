import { getBartmailSupabase } from "./bartmail";

// ---------------------------------------------------------------------------
// Public knowledge-base reader for brand sites.
//
// The KB lives on the internal CDP's Supabase (`support_kb_articles`), written
// by an internal support-admin tool. Brand sites only ever READ, and only
// ever `published` rows — a draft is grounding material for AI-drafted replies
// as much as it is public content, so an unpublished article must not be
// reachable by either.
//
// SERVER-SIDE ONLY. These use BartMail's service-role key, which bypasses RLS.
// Call them from a Server Component or a route handler, NEVER from client code
// and never behind a public API route that echoes arbitrary filters — the
// website security standard's "admin data via server-side authed routes, never
// anon client + RLS alone" applies in reverse here: this key must not leak.
// ---------------------------------------------------------------------------

export interface KbArticleSummary {
  id: string;
  slug: string;
  title: string;
  updated_at: string;
}

export interface KbArticle extends KbArticleSummary {
  body: string;
  brand_id: string | null;
}

const LIST_LIMIT = 200;

/**
 * Published articles for a brand, plus the global ones (`brand_id IS NULL`).
 *
 * Global articles exist so genuinely shared answers — shipping, returns,
 * privacy — are written once rather than copied per brand, which is how five
 * slightly-different answers to one question appear.
 */
export async function listPublishedArticles(brandId: string): Promise<KbArticleSummary[]> {
  const supabase = getBartmailSupabase();
  const { data, error } = await supabase
    .from("support_kb_articles")
    .select("id, slug, title, updated_at")
    .eq("published", true)
    .or(`brand_id.eq.${brandId},brand_id.is.null`)
    .order("title", { ascending: true })
    .limit(LIST_LIMIT);
  if (error) {
    console.error("[supportKb] listPublishedArticles failed:", error.message);
    return [];
  }
  return (data ?? []) as KbArticleSummary[];
}

/** A single published article. Returns null for unknown or unpublished slugs. */
export async function getPublishedArticle(
  brandId: string,
  slug: string
): Promise<KbArticle | null> {
  const supabase = getBartmailSupabase();
  const { data, error } = await supabase
    .from("support_kb_articles")
    .select("id, slug, title, body, brand_id, updated_at")
    .eq("published", true)
    .eq("slug", slug)
    .or(`brand_id.eq.${brandId},brand_id.is.null`)
    // A brand-specific article and a global one can share a slug, and the
    // brand's own answer should win. Order puts non-null brand_id first.
    .order("brand_id", { ascending: false, nullsFirst: false })
    .limit(1)
    .maybeSingle();
  if (error) {
    console.error("[supportKb] getPublishedArticle failed:", error.message);
    return null;
  }
  return (data as KbArticle | null) ?? null;
}

/**
 * Full-text search over published articles, LOGGED.
 *
 * The logging is the point, not a side effect: rows with `results_count = 0`
 * are the knowledge-base writing backlog — precisely what customers asked for
 * and could not find — surfaced in the Support Engine admin and in Command
 * Centre. A search box that does not log its misses throws away the single
 * most useful signal a knowledge base produces.
 *
 * `websearch_to_tsquery` tolerates the quotes and operators people actually
 * type and, unlike `to_tsquery`, never throws on malformed input. A search box
 * that 500s on an apostrophe is not a search box.
 */
export async function searchPublishedArticles(
  brandId: string,
  rawQuery: string,
  source: "public" | "agent" | "chat" = "public"
): Promise<KbArticleSummary[]> {
  const query = rawQuery.trim().slice(0, 200);
  if (!query) return [];

  const supabase = getBartmailSupabase();
  const { data, error } = await supabase
    .from("support_kb_articles")
    .select("id, slug, title, updated_at")
    .eq("published", true)
    .or(`brand_id.eq.${brandId},brand_id.is.null`)
    .textSearch("search_vector", query, { type: "websearch", config: "english" })
    .limit(20);

  const results = (data ?? []) as KbArticleSummary[];
  if (error) console.error("[supportKb] searchPublishedArticles failed:", error.message);

  // Awaited, never voided — an un-awaited insert dies with the response and the
  // row silently vanishes, which would quietly empty the very backlog this
  // exists to build. Logged even on error: a search that failed is still a
  // question that went unanswered.
  const { error: logError } = await supabase.from("support_kb_searches").insert({
    brand_id: brandId,
    query,
    results_count: error ? 0 : results.length,
    source,
  });
  if (logError) console.error("[supportKb] search log failed:", logError.message);

  return results;
}
