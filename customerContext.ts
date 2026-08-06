
import { createClient } from "@supabase/supabase-js";

// SERVER-SIDE ONLY. Uses the checkout-engine service-role key and a Shopify
// admin token — never import this into a client component.
//
// Promoted out of `repos/support-engine/src/lib/support/customer-context.ts` on
// 2026-08-06 (that file is now a shim). It moved because a SECOND consumer
// appeared: the AI-draft step in `repos/bartmail` needs exactly the orders and
// subscriptions the ticket page already shows, so that a draft can answer "where
// is my order" instead of emitting "[NEEDS: a human to go and look this up]" —
// which was the whole complaint. Two copies of a lookup that decides what gets
// quoted back to a customer is precisely the drift `feedback_shared_modules_standard`
// exists to stop.

// ---------------------------------------------------------------------------
// Customer context for the ticket view — the things you'd otherwise go and look
// up in another system before you could answer.
//
// Spec step 3 ("Context assembly"): orders, subscriptions and history attached
// to the ticket BEFORE anyone reads it, so answering "where is my order" does
// not mean opening Shopify in another tab and searching by email.
//
// EVERY SOURCE FAILS SOFT AND INDEPENDENTLY. A ticket must always render: if
// Shopify is down or the checkout key is unset, that section shows as
// unavailable and the rest still loads. A support tool that white-screens
// because a third-party API is slow is worse than one showing less.
//
// Server-only — these use service-role keys and a Shopify admin token.
// ---------------------------------------------------------------------------

export interface CheckoutOrder {
  id: string;
  amount: number;
  currency: string;
  status: string;
  invoiceNumber: string | null;
  refundedAmount: number;
  test: boolean;
  createdAt: string;
}

export interface CheckoutSubscription {
  id: string;
  status: string;
  currentPeriodEnd: string | null;
  cancelAtPeriodEnd: boolean;
  createdAt: string;
}

export interface ShopifyOrder {
  name: string;
  createdAt: string;
  financialStatus: string | null;
  fulfillmentStatus: string | null;
  totalPrice: string;
  currency: string;
  trackingNumbers: string[];
  trackingUrls: string[];
  shippingCity: string | null;
  shippingCountry: string | null;
}

export interface CustomerContext {
  checkoutOrders: CheckoutOrder[];
  subscriptions: CheckoutSubscription[];
  shopifyOrders: ShopifyOrder[];
  /** Per-source failure, so the UI can say "unavailable" rather than "none". */
  errors: { checkout?: string; shopify?: string };
}

const EMPTY: CustomerContext = { checkoutOrders: [], subscriptions: [], shopifyOrders: [], errors: {} };

function checkoutClient() {
  const url = process.env.CHECKOUT_SUPABASE_URL;
  const key = process.env.CHECKOUT_SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  return createClient(url, key, { auth: { persistSession: false } });
}

/**
 * Orders and subscriptions from the Checkout Engine, matched on the customer's
 * email.
 *
 * Matched by email rather than by a stored id because a support ticket only
 * ever gives us an email address — the person writing in has no idea what their
 * customer_id is, and neither do we until we look it up.
 */
async function getCheckoutContext(
  email: string
): Promise<Pick<CustomerContext, "checkoutOrders" | "subscriptions"> & { error?: string }> {
  const supabase = checkoutClient();
  if (!supabase) return { checkoutOrders: [], subscriptions: [], error: "not configured" };

  try {
    // One person can have several customer rows — one per brand — so collect
    // every id for the address rather than assuming a single match.
    const { data: customers, error: custErr } = await supabase
      .from("customers")
      .select("id")
      .ilike("email", email)
      .limit(20);
    if (custErr) return { checkoutOrders: [], subscriptions: [], error: custErr.message };

    const ids = (customers ?? []).map((c) => c.id as string);
    if (ids.length === 0) return { checkoutOrders: [], subscriptions: [] };

    const [ordersRes, subsRes] = await Promise.all([
      supabase
        .from("orders")
        .select("id, amount, currency, status, invoice_number, refunded_amount, test, created_at")
        .in("customer_id", ids)
        .order("created_at", { ascending: false })
        .limit(20),
      supabase
        .from("subscriptions")
        .select("id, status, current_period_end, cancel_at_period_end, created_at")
        .in("customer_id", ids)
        .order("created_at", { ascending: false })
        .limit(10),
    ]);

    return {
      checkoutOrders: (ordersRes.data ?? []).map((o) => ({
        id: o.id as string,
        amount: Number(o.amount ?? 0),
        currency: String(o.currency ?? "gbp"),
        status: String(o.status ?? "unknown"),
        invoiceNumber: (o.invoice_number as string | null) ?? null,
        refundedAmount: Number(o.refunded_amount ?? 0),
        test: !!o.test,
        createdAt: o.created_at as string,
      })),
      subscriptions: (subsRes.data ?? []).map((s) => ({
        id: s.id as string,
        status: String(s.status ?? "unknown"),
        currentPeriodEnd: (s.current_period_end as string | null) ?? null,
        cancelAtPeriodEnd: !!s.cancel_at_period_end,
        createdAt: s.created_at as string,
      })),
    };
  } catch (err) {
    return {
      checkoutOrders: [],
      subscriptions: [],
      error: err instanceof Error ? err.message : "unknown error",
    };
  }
}

/**
 * Shopify orders for Nutty Orange, including tracking numbers.
 *
 * Tracking is the whole point: "where is my order" is the single most common
 * support question, and the answer lives in the fulfilment record. Pulling it
 * here means the answer is on screen before the ticket is read.
 *
 * Nutty Orange only — it is the one brand with a Shopify storefront. Called
 * with any other brand this returns empty rather than pretending to search.
 */
async function getShopifyOrders(email: string): Promise<{ orders: ShopifyOrder[]; error?: string }> {
  const token = process.env.SHOPIFY_NUTTY_ORANGE_ACCESS_TOKEN;
  const shop = process.env.SHOPIFY_NUTTY_ORANGE_SHOP; // e.g. nuttyorange.myshopify.com
  if (!token || !shop) return { orders: [], error: "not configured" };

  try {
    const url =
      `https://${shop}/admin/api/2024-10/orders.json` +
      `?email=${encodeURIComponent(email)}&status=any&limit=10` +
      `&fields=name,created_at,financial_status,fulfillment_status,total_price,currency,fulfillments,shipping_address`;
    const res = await fetch(url, {
      headers: { "X-Shopify-Access-Token": token, "Content-Type": "application/json" },
      cache: "no-store",
    });
    if (!res.ok) return { orders: [], error: `HTTP ${res.status}` };

    const json = (await res.json()) as {
      orders?: {
        name: string;
        created_at: string;
        financial_status: string | null;
        fulfillment_status: string | null;
        total_price: string;
        currency: string;
        fulfillments?: { tracking_numbers?: string[]; tracking_urls?: string[] }[];
        shipping_address?: { city?: string; country?: string } | null;
      }[];
    };

    return {
      orders: (json.orders ?? []).map((o) => ({
        name: o.name,
        createdAt: o.created_at,
        financialStatus: o.financial_status,
        fulfillmentStatus: o.fulfillment_status,
        totalPrice: o.total_price,
        currency: o.currency,
        // Flattened across fulfilments: a split shipment has one entry each,
        // and the agent wants every tracking number, not just the first.
        trackingNumbers: (o.fulfillments ?? []).flatMap((f) => f.tracking_numbers ?? []),
        trackingUrls: (o.fulfillments ?? []).flatMap((f) => f.tracking_urls ?? []),
        shippingCity: o.shipping_address?.city ?? null,
        shippingCountry: o.shipping_address?.country ?? null,
      })),
    };
  } catch (err) {
    return { orders: [], error: err instanceof Error ? err.message : "unknown error" };
  }
}

/**
 * Everything we can find about this customer, gathered in parallel.
 *
 * `brandSlug` gates the Shopify lookup — only Nutty Orange has a storefront, and
 * querying it for an Owner Foundry ticket would be a wasted round trip on every
 * page load.
 */
export async function getCustomerContext(
  email: string | null,
  brandSlug?: string | null
): Promise<CustomerContext> {
  if (!email) return EMPTY;

  const [checkout, shopify] = await Promise.all([
    getCheckoutContext(email),
    brandSlug === "nutty-orange"
      ? getShopifyOrders(email)
      : Promise.resolve({ orders: [] as ShopifyOrder[], error: undefined as string | undefined }),
  ]);

  return {
    checkoutOrders: checkout.checkoutOrders,
    subscriptions: checkout.subscriptions,
    shopifyOrders: shopify.orders,
    errors: {
      ...(checkout.error ? { checkout: checkout.error } : {}),
      ...(shopify.error ? { shopify: shopify.error } : {}),
    },
  };
}
