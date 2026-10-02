// ---------------------------------------------------------------------------
// When a buyer's email is blocked (a spam complaint or a hard bounce), a human must reach them
// another way. Pure copy and classification for that hand-off; the apps do the I/O (Graph draft,
// Command Centre bell) so this module imports nothing.
//
//   complaint    the mailbox exists and the person marked a message as spam. A short, personal
//                note from a named person goes into an Outlook DRAFT for a human to review and
//                send: never auto-sent. It carries their game pass code and claim link.
//   hard_bounce  the address is dead, so no email can reach them. A Command Centre task and bell
//                carry the order and every other contact detail we hold.
//
// Anything we cannot classify is treated as a hard bounce: the safe side (nothing is emailed to an
// address we cannot vouch for).
// ---------------------------------------------------------------------------

export type UndeliverableClass = "complaint" | "hard_bounce";

export function classifyUndeliverable(reason: string | null | undefined): UndeliverableClass {
  return /(complain|spam|abuse|unsub)/i.test(String(reason ?? "")) ? "complaint" : "hard_bounce";
}

/** One case per order and kind: the key the apps use for the Command Centre bell dedupe and their own once-per-order claim. */
export function buyerContactDedupeKey(kind: UndeliverableClass, orderRef: string): string {
  return `buyer-undeliverable:${kind}:${String(orderRef).slice(0, 80)}`;
}

const esc = (s: string) =>
  String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

export interface ComplaintDraftInput {
  /** Who it is from, e.g. "Jess". The draft is signed with this and sits in that person's mailbox. */
  senderName: string;
  brandName: string;
  productName: string;
  firstName?: string | null;
  opensWhen?: string | null;
  claimCode?: string | null;
  claimUrl?: string | null;
  accessUrl?: string | null;
  orderRef: string;
}

/** A short personal note. Plain English, no marketing, no tracking. The reader is a customer who has paid and cannot receive our mail. */
export function renderComplaintDraft(i: ComplaintDraftInput): { subject: string; html: string; text: string } {
  const hello = i.firstName && i.firstName.trim() ? `Hi ${i.firstName.trim()},` : "Hi,";
  const when = i.opensWhen ? ` It opens ${i.opensWhen}.` : "";
  const subject = `Your ${i.productName} game pass`;
  const lines: string[] = [
    hello,
    `I'm writing myself because our automatic emails to you are being blocked, probably because one was marked as spam at some point (it happens, no harm done). I didn't want you to pay for ${i.productName} and not be able to get in.`,
    `${i.claimCode || i.opensWhen ? "Your game pass is safe." : "Your order is safe."}${when}`,
  ];
  if (i.claimCode) lines.push(`Your game pass code is ${i.claimCode}.${i.claimUrl ? ` Or open this link: ${i.claimUrl}` : ""}`);
  else if (i.accessUrl) lines.push(`You can sign in here with the email you used at checkout: ${i.accessUrl}`);
  if (i.claimCode) lines.push("Sign in with any email address you can read and the game pass moves to it. Please keep the code to yourself.");
  lines.push(`If you would like our emails to reach you again, check your spam folder and mark us "not spam". If anything is stuck, just reply to this email and quote ${i.orderRef}.`, `${i.senderName}`);
  const text = lines.join("\n\n");
  const html = lines.map((l) => `<p>${esc(l).replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1">$1</a>')}</p>`).join("");
  return { subject, html, text };
}

export interface BounceTaskInput {
  brandName: string;
  productName: string;
  orderRef: string;
  email: string;
  reason?: string | null;
  orderedAt?: string | null;
  amountLabel?: string | null;
  /** Everything else we hold about the buyer: phone, name, shipping address, the payment platform's own contact, etc. */
  otherContacts: { label: string; value: string }[];
  /** How to find the order: a Command Centre order link or a shop admin note. */
  whereToLook?: string | null;
}

/** The body of the Command Centre task and bell for a dead address. Facts as lines, nothing pre-rendered. */
export function renderBounceTaskBody(i: BounceTaskInput): string {
  const lines = [
    `Why: ${i.brandName} buyer paid for ${i.productName} but their email cannot receive our mail${i.reason ? ` (${i.reason})` : ""}, so the game pass email never arrived.`,
    ` • Order ref: ${i.orderRef}`,
    ` • Email on the order: ${i.email}`,
  ];
  if (i.orderedAt) lines.push(` • Ordered: ${i.orderedAt}`);
  if (i.amountLabel) lines.push(` • Paid: ${i.amountLabel}`);
  for (const c of i.otherContacts) if (c.value) lines.push(` • ${c.label}: ${c.value}`);
  if (i.whereToLook) lines.push(` • Order: ${i.whereToLook}`);
  lines.push("Do: reach them by phone or post, or fix the address and resend (their game pass code also works from their success page and account).");
  return lines.join("\n");
}
