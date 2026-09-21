import { test } from "node:test";
import assert from "node:assert/strict";
import { computeDeposit, depositIsFullValue, type DepositRule } from "./deposit";

// The rule shape a consumer supplies. Percentages and categories are the
// caller's policy, not this module's — these are only fixtures.
const RULE: DepositRule = {
  fullPercent: 100,
  standardPercent: 50,
  thresholdNet: 350,
  fullPaymentCategories: ["hardware", "software"],
};
// Same rule, plus the hardware-escalation trigger a consumer added 2026-09-21.
const TRIGGERED_RULE: DepositRule = { ...RULE, fullQuoteTriggerCategories: ["hardware"] };
const EX = { taxRate: 20 };
const INC = { taxRate: 20, taxMode: "inclusive" };

test("a full-payment category is due in full and ignores the threshold", () => {
  const d = computeDeposit([{ category: "hardware", billingType: "one_off", amount: 90 }], RULE, EX);
  assert.equal(d.full, 90);
  assert.equal(d.standard, 0);
  assert.equal(d.amount, 108);
});

test("another full-payment category behaves identically — the list is data", () => {
  const d = computeDeposit([{ category: "software", billingType: "one_off", amount: 2964 }], RULE, EX);
  assert.equal(d.net, 2964);
  assert.equal(d.amount, 3556.8);
});

test("a category NOT in the list takes the standard rate above the threshold", () => {
  const d = computeDeposit([{ category: "labour", billingType: "one_off", amount: 1000 }], RULE, EX);
  assert.equal(d.standard, 500);
  assert.equal(d.amount, 600);
});

test("below the threshold, a standard-rate line takes nothing", () => {
  const d = computeDeposit([{ category: "labour", billingType: "one_off", amount: 300 }], RULE, EX);
  assert.equal(d.amount, 0);
});

test("the threshold is tested on the WHOLE bearing value, full-payment lines included", () => {
  // 300 + 100 = 400 net, so the labour crosses a threshold it could not reach alone.
  const d = computeDeposit(
    [
      { category: "hardware", billingType: "one_off", amount: 300 },
      { category: "labour", billingType: "one_off", amount: 100 },
    ],
    RULE,
    EX
  );
  assert.equal(d.full, 300);
  assert.equal(d.standard, 50);
});

test("monthly instalments never carry a deposit", () => {
  const d = computeDeposit(
    [{ category: "software", billingType: "monthly", billingPeriodMonths: 1, amount: 5000 }],
    RULE,
    EX
  );
  assert.equal(d.amount, 0);
});

test("an absent period on a recurring line means monthly, and stays exempt", () => {
  const d = computeDeposit(
    [{ category: "labour", billingType: "monthly", billingPeriodMonths: null, amount: 5000 }],
    RULE,
    EX
  );
  assert.equal(d.amount, 0);
});

test("billed once a year is a single payment, so it IS deposited", () => {
  const d = computeDeposit(
    [{ category: "software", billingType: "monthly", billingPeriodMonths: 12, amount: 2964 }],
    RULE,
    EX
  );
  assert.equal(d.net, 2964);
});

test("an exempt line contributes to neither the deposit nor the threshold", () => {
  const d = computeDeposit(
    [
      { category: "labour", billingType: "one_off", amount: 300 },
      { category: "labour", billingType: "one_off", amount: 1000, depositExempt: true },
    ],
    RULE,
    EX
  );
  assert.equal(d.amount, 0);
});

test("inclusive pricing does not tax the deposit twice", () => {
  // 1200 inclusive at 20% is 1000 net; a 100% deposit is 1000 net + 200 tax.
  const d = computeDeposit([{ category: "hardware", billingType: "one_off", amount: 1200 }], RULE, INC);
  assert.equal(d.net, 1000);
  assert.equal(d.amount, 1200);
});

test("an override replaces the figure and derives its own split", () => {
  const d = computeDeposit(
    [{ category: "hardware", billingType: "one_off", amount: 1000 }],
    RULE,
    EX,
    600
  );
  assert.equal(d.amount, 600);
  assert.equal(d.net, 500);
  assert.equal(d.isOverridden, true);
});

test("depositIsFullValue is true only when the whole bearing value is taken", () => {
  assert.equal(
    depositIsFullValue([{ category: "software", billingType: "one_off", amount: 2964 }], RULE),
    true
  );
  assert.equal(
    depositIsFullValue([{ category: "labour", billingType: "one_off", amount: 2964 }], RULE),
    false
  );
});

test("depositIsFullValue is false when there is nothing to deposit", () => {
  assert.equal(depositIsFullValue([], RULE), false);
  assert.equal(
    depositIsFullValue(
      [{ category: "software", billingType: "monthly", billingPeriodMonths: 1, amount: 500 }],
      RULE
    ),
    false
  );
});

// ---------------------------------------------------------------------------
// Hardware-triggered full-quote deposit (Dom, 2026-09-21). Replaces the old
// "100% of hardware, 50% of the rest" split, which left a small odd balance
// to chase after the deposit was paid. `fullQuoteTriggerCategories` is unset
// on every test above, so all of them prove the OLD tiered rule is completely
// unchanged for a caller that hasn't opted in.
// ---------------------------------------------------------------------------

test("hardware present: the WHOLE bearing value is due, not just hardware's share", () => {
  // Old split would have been 100% of 300 + 50% of 100 = 350. The new rule is
  // 100% of the full 400.
  const d = computeDeposit(
    [
      { category: "hardware", billingType: "one_off", amount: 300 },
      { category: "labour", billingType: "one_off", amount: 100 },
    ],
    TRIGGERED_RULE,
    EX
  );
  assert.equal(d.full, 400);
  assert.equal(d.standard, 0);
  assert.equal(d.net, 400);
  assert.equal(d.amount, 480);
});

test("hardware escalation ignores the threshold — small hardware + small labour is still 100%", () => {
  const d = computeDeposit(
    [
      { category: "hardware", billingType: "one_off", amount: 20 },
      { category: "labour", billingType: "one_off", amount: 30 },
    ],
    TRIGGERED_RULE,
    EX
  );
  assert.equal(d.net, 50);
  assert.equal(d.amount, 60);
});

test("hardware escalation still excludes monthly lines", () => {
  const d = computeDeposit(
    [
      { category: "hardware", billingType: "one_off", amount: 300 },
      { category: "labour", billingType: "one_off", amount: 100 },
      { category: "software", billingType: "monthly", billingPeriodMonths: 1, amount: 5000 },
    ],
    TRIGGERED_RULE,
    EX
  );
  assert.equal(d.net, 400);
  assert.equal(d.amount, 480);
});

test("hardware escalation does NOT respect a per-line depositExempt — only monthly is excepted", () => {
  // The rule this implements names one exception ("bar any monthly
  // services"), not two — a depositExempt line is swept into the escalated
  // total, unlike under the old tiered rule.
  const d = computeDeposit(
    [
      { category: "hardware", billingType: "one_off", amount: 300 },
      { category: "labour", billingType: "one_off", amount: 1000, depositExempt: true },
    ],
    TRIGGERED_RULE,
    EX
  );
  assert.equal(d.net, 1300);
  assert.equal(d.amount, 1560);
});

test("real-world shape: hardware + labour + a deposit-exempt shipping line, all swept into 100%", () => {
  // The case this was written for: a shipping line an operator had excluded
  // from the deposit under the OLD rule was still part of "the entire quote"
  // once hardware triggered the new one.
  const d = computeDeposit(
    [
      { category: "hardware", billingType: "one_off", amount: 1621.5 },
      { category: "hardware", billingType: "one_off", amount: 423.2 },
      { category: "labour", billingType: "one_off", amount: 171.42 },
      { category: "shipping", billingType: "one_off", amount: 29.9, depositExempt: true },
    ],
    TRIGGERED_RULE,
    EX
  );
  assert.equal(d.net, 2246.02);
  assert.equal(d.amount, 2695.22);
});

test("no hardware line: the trigger is armed but silent, and the old tiered rule applies", () => {
  const d = computeDeposit(
    [{ category: "labour", billingType: "one_off", amount: 1000 }],
    TRIGGERED_RULE,
    EX
  );
  assert.equal(d.full, 0);
  assert.equal(d.standard, 500);
  assert.equal(d.amount, 600);
});

test("a single hardware line behaves the same whether triggered or not", () => {
  const untriggered = computeDeposit([{ category: "hardware", billingType: "one_off", amount: 90 }], RULE, EX);
  const triggered = computeDeposit(
    [{ category: "hardware", billingType: "one_off", amount: 90 }],
    TRIGGERED_RULE,
    EX
  );
  assert.deepEqual(untriggered, triggered);
});
