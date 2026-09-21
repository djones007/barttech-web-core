// ---------------------------------------------------------------------------
// Deposit due on acceptance of a quotation.
//
// Pure arithmetic over line items and a rule. Every value that decides an
// outcome — the percentages, the threshold, and which categories are payable in
// full — is supplied by the caller, so this module states no commercial policy
// of its own. It exists because the figure is computed in more than one place
// (the document the customer signs, and the invoice raised from it) and those
// two disagreeing is a customer being asked for one amount and billed another.
//
// The rule it encodes:
//   * Lines billed in monthly instalments never carry a deposit. They are paid
//     as they are consumed, so a deposit would charge the first period twice.
//   * A line the caller has marked exempt is removed from the deposit AND from
//     the threshold test — an excluded line must not be able to push the rest
//     of the quotation over the threshold and trigger one.
//   * A category named in `fullQuoteTriggerCategories` (typically "hardware")
//     switches the ENTIRE quote's non-monthly value — every one-off line, not
//     only the triggering category, and NOT respecting a per-line
//     `depositExempt` either — to `fullPercent`, bypassing `standardPercent`,
//     `thresholdNet` and `fullPaymentCategories` entirely. (Dom, 2026-09-21:
//     splitting the deposit — 100% of hardware, 50% of the rest — left a small
//     odd balance that had to be chased separately after the deposit was paid.
//     "If hardware is on the quote, the entire quote bar any monthly services
//     should be 100% required upfront" — his words, and deliberately wider
//     than the exempt-line carve-out below: verified against a real quote,
//     where the escalated total included a `depositExempt` line (an operator
//     had excluded a shipping charge under the old rule) specifically because
//     Dom's rule names only ONE exception — monthly services.)
//   * Otherwise, categories named in `fullPaymentCategories` are due in full
//     and ignore the threshold entirely.
//   * Everything else takes `standardPercent`, but only once the WHOLE
//     deposit-bearing net value exceeds `thresholdNet` — the threshold is a
//     property of the quotation, not of the part the standard rate applies to.
//   * The rule produces a NET figure; tax is added afterwards, because a deposit
//     is money actually transferred and is taxed like any other payment.
// ---------------------------------------------------------------------------

export interface DepositLine {
  /** Free-text category, matched case-insensitively against the rule. */
  category: string | null;
  /** `"monthly"` marks a recurring line; anything else is treated as one-off. */
  billingType: string | null;
  /**
   * How often a recurring line is billed, in months. null/1 = monthly
   * instalments, 12 = once a year.
   *
   * THE EXEMPTION IS KEYED ON THIS, NOT ON `billingType`. A line billed once a
   * year is a single payment for the period ahead and carries a deposit like
   * any other single payment; only a line billed in monthly instalments is
   * exempt. Keying the exemption on "is it recurring" silently stops charging a
   * deposit on annually-billed lines the moment they gain a period.
   */
  billingPeriodMonths?: number | null;
  /** Caller has taken this line out of the deposit and out of the threshold. */
  depositExempt?: boolean | null;
  /** Net line total, or gross where `taxMode` is `"inclusive"`. */
  amount: number;
}

export interface DepositRule {
  /** Percentage of `fullPaymentCategories` due up front. Supersedes the standard rate. */
  fullPercent: number;
  /** Percentage of everything else, once the threshold is passed. */
  standardPercent: number;
  /** Net value above which the standard rate applies. Full-payment categories ignore it. */
  thresholdNet: number;
  /** Categories payable in full up front. Compared lower-cased. */
  fullPaymentCategories: readonly string[];
  /**
   * Categories whose mere PRESENCE anywhere on the quote — not just their own
   * lines — switches the ENTIRE deposit-bearing value to `fullPercent`,
   * bypassing `standardPercent`, `thresholdNet` and `fullPaymentCategories`
   * entirely for that quote.
   *
   * Optional and defaults to none: a caller that never sets it (every caller
   * before 2026-09-21) gets the old tiered behaviour unchanged. Compared
   * lower-cased, same as `fullPaymentCategories`. A per-brand setting, not a
   * constant — clearing it for a brand switches that brand back to the tiered
   * rule with no code change. See the file header for why this exists.
   */
  fullQuoteTriggerCategories?: readonly string[];
}

export interface DepositTax {
  /** Percentage, e.g. 20. */
  taxRate: number;
  /** `"inclusive"` means `amount` already contains tax. */
  taxMode?: string | null;
}

export interface DepositResult {
  /** Gross deposit payable. */
  amount: number;
  net: number;
  tax: number;
  /** Net contributed by the full-payment categories. */
  full: number;
  /** Net contributed by everything else. */
  standard: number;
  isOverridden: boolean;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Billed in monthly instalments, and therefore never deposited. */
export function isMonthlyInstalment(line: DepositLine): boolean {
  return line.billingType === "monthly" && (line.billingPeriodMonths ?? 1) === 1;
}

/** The lines a deposit is calculated over: not monthly, not exempted. */
export function depositBearingLines(lines: DepositLine[]): DepositLine[] {
  return lines.filter((l) => !isMonthlyInstalment(l) && !l.depositExempt);
}

export function computeDeposit(
  lines: DepositLine[],
  rule: DepositRule,
  tax: DepositTax,
  overrideAmount?: number | null
): DepositResult {
  const taxRate = Number(tax.taxRate ?? 0);

  /* Every figure below is NET, whatever basis the caller prices on. Under
     `inclusive` the amounts already contain tax, so they are divided down
     first — applying the rule to a gross figure and adding tax again taxes the
     deposit twice. */
  const netOf = (amount: number) =>
    tax.taxMode === "inclusive" ? Number(amount || 0) / (1 + taxRate / 100) : Number(amount || 0);

  const full = new Set(rule.fullPaymentCategories.map((c) => c.toLowerCase()));
  const isFullPayment = (l: DepositLine) => full.has((l.category ?? "").toLowerCase());

  const bearing = depositBearingLines(lines);

  /* A trigger category anywhere on the NON-MONTHLY quote (not `bearing` —
     `depositExempt` does not disarm the trigger, see below) switches the whole
     non-monthly value to `fullPercent`. */
  const nonMonthly = lines.filter((l) => !isMonthlyInstalment(l));
  const trigger = new Set((rule.fullQuoteTriggerCategories ?? []).map((c) => c.toLowerCase()));
  const quoteTriggered =
    trigger.size > 0 && nonMonthly.some((l) => trigger.has((l.category ?? "").toLowerCase()));

  let fullNet: number;
  let otherNet: number;
  let totalNet: number;
  let fullDue: number;
  let standardDue: number;

  if (quoteTriggered) {
    /* Deliberately `nonMonthly`, not `bearing` — a per-line `depositExempt`
       stops applying once the trigger fires. Dom's rule names exactly one
       exception ("bar any monthly services"); a line an operator excluded
       under the OLD tiered rule for its own reasons is not automatically also
       an exception to this one — a deposit-exempt shipping line on the real
       quote this rule was written for was still part of "the entire quote". */
    totalNet = round2(nonMonthly.reduce((t, l) => t + netOf(l.amount), 0));
    fullNet = totalNet;
    otherNet = 0;
    fullDue = round2(fullNet * (rule.fullPercent / 100));
    standardDue = 0;
  } else {
    fullNet = round2(bearing.filter(isFullPayment).reduce((t, l) => t + netOf(l.amount), 0));
    otherNet = round2(
      bearing.filter((l) => !isFullPayment(l)).reduce((t, l) => t + netOf(l.amount), 0)
    );
    totalNet = round2(fullNet + otherNet);
    fullDue = round2(fullNet * (rule.fullPercent / 100));
    standardDue = totalNet > rule.thresholdNet ? round2(otherNet * (rule.standardPercent / 100)) : 0;
  }

  const net = round2(fullDue + standardDue);
  const taxDue = round2(net * (taxRate / 100));

  if (overrideAmount != null) {
    /* An override is the GROSS figure someone agreed, so the split is derived
       back from it rather than left showing the calculation it replaced. */
    const overrideGross = round2(overrideAmount);
    const overrideNet = round2(overrideGross / (1 + taxRate / 100));
    return {
      amount: overrideGross,
      net: overrideNet,
      tax: round2(overrideGross - overrideNet),
      full: fullDue,
      standard: standardDue,
      isOverridden: true,
    };
  }

  return {
    amount: round2(net + taxDue),
    net,
    tax: taxDue,
    full: fullDue,
    standard: standardDue,
    isOverridden: false,
  };
}

/**
 * Does the rule take the entire deposit-bearing value up front?
 *
 * Separated from `computeDeposit` because the answer changes a document rather
 * than a figure — payment terms, and whether it says the order is charged in
 * advance. Compared to the penny: a deposit that merely rounds close to the
 * total is not a full-value deposit, and saying so would be wrong.
 */
export function depositIsFullValue(lines: DepositLine[], rule: DepositRule): boolean {
  const bearing = depositBearingLines(lines);
  if (bearing.length === 0) return false;
  const net = round2(bearing.reduce((t, l) => t + Number(l.amount || 0), 0));
  if (net <= 0) return false;
  const deposit = computeDeposit(lines, rule, { taxRate: 0 });
  return deposit.net >= net;
}
