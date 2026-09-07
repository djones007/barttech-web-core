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
