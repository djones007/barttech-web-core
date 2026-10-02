// ---------------------------------------------------------------------------
// The "safety net" for a sale: everything a buyer needs to get what they paid for
// WITHOUT the delivery email. Pure and product-neutral: the CONTENT of the block
// shown on a success / thank-you page, the downloadable ticket (see ticketPdf.ts)
// and the "copy details" text, all built from one model so they can never disagree.
//
// Why: a delivery email can be blocked (a hard bounce, a spam complaint) or sent to
// a typo. Emailit answers 200 and silently drops the mail, so the buyer has paid
// and has nothing. The success page already knows who they are (their own order),
// so it shows what the email would have said, plus a code or link where the product
// has one, and a way to reach a human.
//
// No brand, product or domain is named here. The caller passes names, URLs and the
// support address from its own config; the page component stays per-app (no React
// in web-core), and scripts/check-success-safety-net.mjs gates that a success page
// renders it.
// ---------------------------------------------------------------------------

export type SafetyNetKind = "game_licence" | "lms_enrol" | "r2_download" | "physical" | "none" | "bundle" | "other";

export const SAFETY_NET_KINDS: readonly SafetyNetKind[] = ["game_licence", "lms_enrol", "r2_download", "physical", "none", "bundle", "other"];

/** Any fulfilment string, including one added later, maps to a kind: an unknown type is `other`, never an error. */
export function normaliseSafetyNetKind(fulfilment: string | null | undefined): SafetyNetKind {
  return (SAFETY_NET_KINDS as readonly string[]).includes(String(fulfilment)) ? (fulfilment as SafetyNetKind) : "other";
}

export interface SafetyNetInput {
  brandName: string;
  productName: string;
  /** products.fulfilment (or any string: unknown becomes `other`). */
  kind: string | null | undefined;
  /** The short reference the buyer quotes to support. */
  orderRef: string;
  /** Where the delivery email was sent (the buyer's own address). */
  email: string;
  /** Pre-sale: when the product opens, as a sentence ("Saturday 10 October at 6pm UK time"). */
  opensWhen?: string | null;
  /** Where to sign in or learn: a non-secret URL. */
  accessUrl?: string | null;
  /** A bearer code that claims the purchase onto any address the buyer signs in with. Optional per product type. */
  claimCode?: string | null;
  /** A link that carries the code. */
  claimUrl?: string | null;
  supportEmail?: string | null;
  /** Per-offer extra line (offers.safety_net_note): shown under the steps. */
  note?: string | null;
  /** When it was bought, already formatted ("2 October 2026"). */
  purchasedOn?: string | null;
}

export interface SafetyNetRow {
  label: string;
  value: string;
  /** `code` is shown big and monospaced; `link` wraps anywhere; `text` is the default. */
  style?: "code" | "link" | "text";
}

export interface SafetyNetModel {
  kind: SafetyNetKind;
  title: string;
  headline: string;
  intro: string;
  rows: SafetyNetRow[];
  steps: string[];
  keepNote: string;
  /** Only when there is a claim code or link: it is a bearer secret. */
  privateNote: string | null;
  supportLine: string;
  note: string | null;
  hasClaim: boolean;
}

export const KEEP_NOTE = "If for any reason the email doesn't arrive, keep these details: they get you in.";
export const PRIVATE_NOTE = "Keep this private: anyone with this code or link can claim your ticket.";

const clean = (s: string | null | undefined, max = 300): string => {
  let out = "";
  for (const ch of String(s ?? "")) {
    const c = ch.codePointAt(0) ?? 0;
    out += c < 32 || c === 127 ? " " : ch;
  }
  return out.replace(/\s+/g, " ").trim().slice(0, max);
};

/** "j***@gmail.com": enough to recognise your own address, not enough to read someone else's. */
export function maskEmail(email: string | null | undefined): string {
  const e = String(email ?? "").trim();
  const at = e.lastIndexOf("@");
  if (at < 1) return "";
  const local = e.slice(0, at);
  return `${local[0]}${"*".repeat(Math.max(2, Math.min(6, local.length - 1)))}${e.slice(at)}`;
}

function title(kind: SafetyNetKind, opensWhen: boolean): string {
  switch (kind) {
    case "game_licence":
      return opensWhen ? "Your ticket" : "Your game pass";
    case "lms_enrol":
      return "Your course access";
    case "r2_download":
      return "Your download";
    case "physical":
      return "Your order";
    default:
      return "Your order details";
  }
}

export function buildSafetyNet(input: SafetyNetInput): SafetyNetModel {
  const kind = normaliseSafetyNetKind(input.kind);
  const product = clean(input.productName, 160) || "Your purchase";
  const brand = clean(input.brandName, 80);
  const ref = clean(input.orderRef, 80);
  const email = clean(input.email, 254);
  const opens = clean(input.opensWhen, 120) || null;
  const access = clean(input.accessUrl, 300) || null;
  const code = clean(input.claimCode, 80) || null;
  const claimUrl = clean(input.claimUrl, 400) || null;
  const support = clean(input.supportEmail, 254) || null;
  const hasClaim = !!(code || claimUrl);

  const rows: SafetyNetRow[] = [{ label: kind === "lms_enrol" ? "Course" : kind === "game_licence" ? "Game" : "Product", value: product }];
  if (opens) rows.push({ label: "Opens", value: opens });
  rows.push({ label: "Order ref", value: ref });
  if (input.purchasedOn) rows.push({ label: "Bought", value: clean(input.purchasedOn, 60) });
  if (email) rows.push({ label: kind === "lms_enrol" ? "Login email" : "Sent to", value: email });
  if (code) rows.push({ label: "Ticket code", value: code, style: "code" });
  if (claimUrl) rows.push({ label: "Claim link", value: claimUrl, style: "link" });
  else if (access && kind !== "r2_download") rows.push({ label: kind === "lms_enrol" ? "Where to learn" : "Sign in at", value: access, style: "link" });

  const steps: string[] = [];
  switch (kind) {
    case "game_licence":
      steps.push(claimUrl ? "Open your claim link, or go to the sign-in page and enter your ticket code." : access ? `Go to ${access} and sign in.` : "Sign in to your account.");
      steps.push(code ? "Sign in with any email address you can read. The ticket moves to that address." : `Sign in with ${email || "the email you used at checkout"}.`);
      steps.push(opens ? `When it opens (${opens}), sign in and start a game from your account.` : "Start a game from your account and invite your players.");
      break;
    case "lms_enrol":
      steps.push(access ? `Go to ${access}.` : "Go to your course login page.");
      steps.push(`Sign in with ${email || "the email you used at checkout"}.`);
      steps.push("If you cannot get in, contact support with your order ref and we will sort it by hand.");
      break;
    case "r2_download":
      steps.push("Use the Download button on this page while it is open.");
      steps.push("If the page has closed, contact support with your order ref and we will send it another way.");
      steps.push("Keep this ticket as your proof of purchase.");
      break;
    case "physical":
      steps.push(`Shipping updates go to ${email || "your email"}. Check your junk folder if they do not appear.`);
      steps.push("Keep this ticket as your proof of purchase.");
      steps.push("If nothing has arrived when you expect it, contact support with your order ref.");
      break;
    default:
      steps.push(`Your receipt goes to ${email || "your email"}. Check your junk folder if it does not appear.`);
      steps.push("Keep this ticket as your proof of purchase.");
      steps.push("Contact support with your order ref if anything is missing.");
  }

  return {
    kind,
    title: title(kind, !!opens),
    headline: product,
    intro: brand ? `Thank you for your order with ${brand}.` : "Thank you for your order.",
    rows,
    steps,
    keepNote: KEEP_NOTE,
    privateNote: hasClaim ? PRIVATE_NOTE : null,
    supportLine: support ? `Need a hand? Email ${support} and quote ${ref}.` : `Need a hand? Reply to any email from ${brand || "us"} and quote ${ref}.`,
    note: clean(input.note, 400) || null,
    hasClaim,
  };
}

/** The "Copy details" text: the same facts as the model, plain. */
export function safetyNetCopyText(m: SafetyNetModel, brandName = ""): string {
  const lines: string[] = [];
  lines.push(brandName ? `${brandName}: ${m.title}` : m.title, m.headline, "");
  for (const r of m.rows) lines.push(`${r.label}: ${r.value}`);
  lines.push("", "How to get in:");
  m.steps.forEach((s, i) => lines.push(`${i + 1}. ${s}`));
  if (m.note) lines.push("", m.note);
  if (m.privateNote) lines.push("", m.privateNote);
  lines.push("", m.supportLine);
  return lines.join("\n");
}
