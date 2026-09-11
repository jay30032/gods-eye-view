import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeBrrrr } from './brrrr.js';
import { analyzeRental } from './rental.js';
import { pmt } from './math.js';

const DEAL = Object.freeze({ purchase: 228000, rehab: 42000, arv: 385000, rent: 2650, units: 1 });

const near = (actual, expected, tol) => assert.ok(
  Math.abs(actual - expected) <= tol,
  `expected ${actual} within ${tol} of ${expected}`,
);
const money = (actual, expected) => near(actual, expected, 5);
const rate = (actual, expected) => near(actual, expected, 0.005);

test('BRRRR acquisition matches the flip block minus the sale', () => {
  const r = analyzeBrrrr(DEAL);
  assert.equal(r.strategy, 'brrrr');
  assert.equal(r.rehabTotal, 46200);
  assert.equal(r.buyClosing, 4560);
  assert.equal(r.loanAmount, 246780);
  assert.equal(r.points, 4935.6);
  assert.equal(r.holdMonths, 6);            // seasoning, not a flip hold
  assert.equal(r.interest, 14806.8);
  assert.equal(r.carry, 2887.5);
  money(r.allIn, 301390);                   // 324490 all-in less the 23100 sell closing
  assert.equal(r.sellClosing, undefined);   // there is no sale in a BRRRR
});

test('refinance sizing and cash left in are deterministic', () => {
  const r = analyzeBrrrr(DEAL);
  assert.equal(r.refinanceAmount, 288750);  // 385000 x 75% LTV
  assert.equal(r.refiClosing, 5775);        // 2% of the new loan
  money(r.cashLeftIn, r.allIn + r.refiClosing - r.refinanceAmount);
  money(r.cashLeftIn, 18415);
  assert.equal(r.cashOut, 0);
  assert.equal(r.infiniteReturn, false);
});

test('BRRRR NOI is computed exactly like the rental', () => {
  const b = analyzeBrrrr(DEAL);
  const r = analyzeRental(DEAL);
  assert.equal(b.grossRent, r.grossRent);
  assert.equal(b.taxes, r.taxes);           // on ARV
  assert.equal(b.insurance, r.insurance);   // per unit
  assert.equal(b.opex, r.opex);
  assert.equal(b.noi, r.noi);
  // Only the debt differs: BRRRR services the refinance, not a purchase loan.
  assert.equal(b.monthlyDebt, pmt(0.07, 30, b.refinanceAmount));
  assert.notEqual(b.monthlyDebt, r.monthlyDebt);
});

test('debt service on the refinance sets cash flow and DSCR', () => {
  const r = analyzeBrrrr(DEAL);
  money(r.cashFlowMonthly, (r.noi / 12) - r.monthlyDebt);
  money(r.cashFlowAnnual, r.cashFlowMonthly * 12);
  rate(r.dscr, r.noi / (r.monthlyDebt * 12));
  rate(r.coc, r.cashFlowAnnual / r.cashLeftIn);
  assert.ok(r.cashFlowMonthly < 0);         // 75% of 385k does not cash flow at 2650
  assert.equal(r.verdict, 'pass');
});

test('a full cash-out with positive cash flow reports an infinite return', () => {
  const r = analyzeBrrrr({ purchase: 120000, rehab: 30000, arv: 320000, rent: 3200, units: 1 });
  assert.equal(r.refinanceAmount, 240000);
  assert.equal(r.cashLeftIn, 0);
  money(r.cashOut, r.refinanceAmount - r.refiClosing - r.allIn);
  assert.ok(r.cashOut > 0);
  assert.ok(r.cashFlowAnnual > 0);
  assert.equal(r.infiniteReturn, true);
  assert.equal(r.coc, 999);
  assert.equal(r.verdict, 'strong');
});

test('zero cash left in with negative cash flow is not an infinite return', () => {
  const r = analyzeBrrrr({ purchase: 120000, rehab: 30000, arv: 320000, rent: 900, units: 1 });
  assert.equal(r.cashLeftIn, 0);
  assert.ok(r.cashFlowAnnual < 0);
  assert.equal(r.infiniteReturn, false);
  assert.equal(r.coc, 0);
  assert.equal(r.verdict, 'pass');
});

test('all-cash BRRRR skips hard money but still refinances', () => {
  const r = analyzeBrrrr(DEAL, { allCash: true });
  assert.equal(r.loanAmount, 0);
  assert.equal(r.points, 0);
  assert.equal(r.interest, 0);
  assert.equal(r.refinanceAmount, 288750);
  money(r.allIn, r.purchase + r.rehabTotal + r.buyClosing + r.carry);
});

test('verdict is strong only when little is left in and it cash flows', () => {
  const r = analyzeBrrrr({ purchase: 150000, rehab: 25000, arv: 260000, rent: 2500, units: 1 });
  assert.ok(r.cashLeftIn <= r.assumptions.brrrrStrongCashLeftIn);
  assert.ok(r.cashFlowMonthly >= r.assumptions.brrrrStrongCashFlow);
  assert.equal(r.verdict, 'strong');
});

test('BRRRR rejects non-finite inputs', () => {
  assert.throws(() => analyzeBrrrr({ ...DEAL, rent: 'maybe' }), /rent/);
});
