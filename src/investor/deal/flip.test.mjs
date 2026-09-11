import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeFlip } from './flip.js';

/** The mock top pick, DEMO-ATL-001. Every fixture below is hand-checked. */
const DEAL = Object.freeze({ purchase: 228000, rehab: 42000, arv: 385000, rent: 2650, units: 1 });

const near = (actual, expected, tol) => assert.ok(
  Math.abs(actual - expected) <= tol,
  `expected ${actual} within ${tol} of ${expected}`,
);
const money = (actual, expected) => near(actual, expected, 5);
const rate = (actual, expected) => near(actual, expected, 0.005);

test('financed flip matches the underwriting fixture', () => {
  const r = analyzeFlip(DEAL);
  assert.equal(r.strategy, 'flip');
  assert.equal(r.rehabTotal, 46200);       // 42000 x 1.10 contingency
  assert.equal(r.buyClosing, 4560);        // 228000 x 2%
  assert.equal(r.loanAmount, 246780);      // (228000 + 46200) x 90% LTC
  assert.equal(r.points, 4935.6);          // 2 points
  assert.equal(r.interest, 14806.8);       // 12% for 6 months
  assert.equal(r.carry, 2887.5);           // 1.5% of ARV for 6 months
  assert.equal(r.sellClosing, 23100);      // 6% of ARV
  money(r.allIn, 324490);
  money(r.profit, 60510);
  money(r.cashIn, 54610);
  rate(r.roi, 1.108);
  rate(r.margin, 0.157);
  assert.equal(r.mao70, 223300);           // 385000 x 0.70 - 46200
  assert.equal(r.holdMonths, 6);
  assert.equal(r.verdict, 'strong');
});

test('annualized ROI scales the six-month hold to a year', () => {
  const r = analyzeFlip(DEAL);
  rate(r.roiAnnualized, r.roi * 2);
  assert.equal(r.assumptions.flipHoldMonths, 6);
});

test('profit reconciles to ARV minus every line of all-in', () => {
  const r = analyzeFlip(DEAL);
  const sum = r.purchase + r.rehabTotal + r.buyClosing + r.points
    + r.interest + r.carry + r.sellClosing;
  money(r.allIn, sum);
  money(r.profit, r.arv - r.allIn);
  rate(r.margin, r.profit / r.arv);
});

test('all-cash flip carries no loan, points, or interest', () => {
  const financed = analyzeFlip(DEAL);
  const cash = analyzeFlip(DEAL, { allCash: true });
  assert.equal(cash.allCash, true);
  assert.equal(cash.loanAmount, 0);
  assert.equal(cash.points, 0);
  assert.equal(cash.interest, 0);
  assert.equal(cash.carry, financed.carry);          // carry is not a lender cost
  money(cash.cashIn, cash.purchase + cash.rehabTotal + cash.buyClosing + cash.carry);
  assert.ok(cash.profit > financed.profit);          // no financing cost to pay
  assert.ok(cash.cashIn > financed.cashIn);          // but far more capital tied up
  assert.ok(cash.roi < financed.roi);                // leverage is what lifts ROI
});

test('contingency lands on rehab before anything else is sized', () => {
  const bigger = analyzeFlip({ ...DEAL, rehab: 62000 });
  assert.equal(bigger.rehabTotal, 68200);
  assert.equal(bigger.loanAmount, (228000 + 68200) * 0.9);
  assert.equal(bigger.mao70, 385000 * 0.7 - 68200);
});

test('verdict steps down from strong to thin to pass', () => {
  assert.equal(analyzeFlip(DEAL).verdict, 'strong');
  // Margin holds but profit falls under the strong bar: thin.
  const thin = analyzeFlip({ purchase: 228000, rehab: 42000, arv: 345000 });
  assert.ok(thin.profit >= thin.assumptions.flipThinProfit);
  assert.ok(thin.profit < thin.assumptions.flipStrongProfit);
  assert.equal(thin.verdict, 'thin');
  const bad = analyzeFlip({ purchase: 300000, rehab: 42000, arv: 345000 });
  assert.ok(bad.profit < bad.assumptions.flipThinProfit);
  assert.equal(bad.verdict, 'pass');
});

test('overrides flow through mergeAssumptions', () => {
  const r = analyzeFlip(DEAL, { flipHoldMonths: 12 });
  assert.equal(r.holdMonths, 12);
  assert.equal(r.interest, 246780 * 0.12);
  assert.equal(r.carry, 385000 * 0.015);
});

test('flip rejects non-finite inputs', () => {
  assert.throws(() => analyzeFlip({ purchase: 'x', rehab: 1, arv: 1 }), /purchase/);
  assert.throws(() => analyzeFlip({ purchase: 1, rehab: 'soon', arv: 1 }), /rehab/);
  assert.throws(() => analyzeFlip({ purchase: 1, rehab: 1, arv: undefined }), /arv/);
});

test('result is frozen so callers cannot mutate an underwrite', () => {
  const r = analyzeFlip(DEAL);
  assert.equal(Object.isFrozen(r), true);
  assert.equal(Object.isFrozen(r.assumptions), true);
});
