// ---------------------------------------------------------------------------
// mailProviderNotice — browser-safe: no node imports, ever — client
// components import this file directly.
//
// The MailProvider type, the `?p=` param helpers, and the post-submit
// deliverability notice copy ("check your spam folder" style messaging shown
// after a form, optin, or download) all live here because none of them touch
// the network or Node. `mailProvider.ts` re-exports this whole file so the
// public surface is unchanged, but a CLIENT component must import THIS file
// directly rather than `mailProvider.ts` — see that file's header for why.
//
// WHY THIS COPY IS SHARED, NOT JUST A NICETY
// This copy had drifted into five different phrasings across sites before
// this existed. Worse than inconsistent tone: a "mark as not spam" / "move to
// Primary" / "add to contacts" action taken by the recipient is one of the
// strongest positive reputation signals a mailbox provider accepts about a
// sending domain. Steering someone to the RIGHT action for THEIR provider
// (a Promotions-tab drag for Gmail, Safe senders for Outlook, Not Junk for
// iCloud/Yahoo) is a deliverability lever as much as it is UX copy, so it
// deserves one canonical, kept-current source rather than five independent
// guesses that drift apart.
//
// Rendering stays per-consumer — this repo ships no React (see CLAUDE.md
// golden rule 6) — so each site's own component calls mailProviderNotice()
// and lays the result out with its own styling.
// ---------------------------------------------------------------------------

export type MailProvider = "gmail" | "outlook" | "apple" | "yahoo" | "unknown";

export const MAIL_PROVIDERS: readonly MailProvider[] = ["gmail", "outlook", "apple", "yahoo", "unknown"];

/** For safely parsing a `?p=` query param into a MailProvider. */
export function isMailProvider(x: unknown): x is MailProvider {
  return typeof x === "string" && (MAIL_PROVIDERS as readonly string[]).includes(x);
}

// ---------------------------------------------------------------------------
// Post-submit deliverability notice copy. THE ONLY PLACE THIS COPY LIVES —
// see the file header for why that matters beyond consistency.
// ---------------------------------------------------------------------------

export type NoticeMode = "asset" | "link" | "confirm";

interface ProviderCopy {
  label: string | null;
  body: string;
  /** May contain a literal "{sender}" placeholder, filled in verbatim. */
  steps: string[];
}

const PROVIDER_COPY: Readonly<Record<MailProvider, ProviderCopy>> = {
  gmail: {
    label: "Gmail",
    body: "Gmail sometimes files new senders under Promotions or Spam.",
    steps: [
      "Check the Promotions tab, then Spam.",
      "If it is there, drag it to Primary.",
      "Add {sender} to your contacts so the next one lands in your inbox.",
    ],
  },
  outlook: {
    label: "Outlook",
    body: "Outlook sometimes files new senders under Junk Email or the Other tab.",
    steps: [
      "Check Junk Email, then the Other tab.",
      "If it is there, right-click it, choose Junk, then Never block sender.",
      "Add {sender} to your Safe senders list.",
    ],
  },
  apple: {
    label: "iCloud Mail",
    body: "iCloud Mail sometimes files new senders under Junk.",
    steps: ["Check the Junk folder.", "If it is there, tap Not Junk.", "Add {sender} to your contacts."],
  },
  yahoo: {
    label: "Yahoo Mail",
    body: "Yahoo sometimes files new senders under Spam.",
    steps: ["Check the Spam folder.", "If it is there, mark it Not Spam.", "Add {sender} to your contacts."],
  },
  unknown: {
    label: null,
    body: "New senders sometimes land in spam or junk.",
    steps: [
      "Check your spam or junk folder.",
      "If it is there, mark it as not spam.",
      "Add {sender} to your contacts so the next one lands in your inbox.",
    ],
  },
};

/** "a minute" / "a couple of minutes" / "5 minutes" — natural at 1, 2, and 5+. */
function minutesPhrase(minutes: number): string {
  if (minutes <= 1) return "a minute";
  if (minutes === 2) return "a couple of minutes";
  return `${minutes} minutes`;
}

function noticeHeading(mode: NoticeMode, minutes: number): string {
  if (mode === "confirm") return "Can't see the confirmation email? Here is where to look.";
  if (mode === "link") return "Can't see the email with your link? Here is where to look.";
  return `Not there in ${minutesPhrase(minutes)}? Here is where to look.`;
}

export interface MailProviderNoticeInput {
  provider: MailProvider;
  /** The brand's from-address. Merged into the steps verbatim. */
  sender: string;
  mode: NoticeMode;
  /** Default 2. Only affects the heading in "asset" mode. */
  minutes?: number;
}

export interface MailProviderNoticeResult {
  providerLabel: string | null;
  heading: string;
  body: string;
  steps: string[];
}

export function mailProviderNotice(input: MailProviderNoticeInput): MailProviderNoticeResult {
  const { provider, sender, mode } = input;
  const minutes = input.minutes ?? 2;
  const copy = PROVIDER_COPY[provider];
  return {
    providerLabel: copy.label,
    heading: noticeHeading(mode, minutes),
    body: copy.body,
    steps: copy.steps.map((s) => s.split("{sender}").join(sender)),
  };
}

/** Keeps the redirect param name in one place. */
export const MAIL_PROVIDER_PARAM = "p";

export function mailProviderQueryParam(provider: MailProvider): string {
  return `${MAIL_PROVIDER_PARAM}=${provider}`;
}
