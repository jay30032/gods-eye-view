import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeWholesale } from './wholesale.js';
import { DEAL_ASSUMPTIONS } from './assumptions.js';

const DEAL = Object.freeze({ purchase: 228000, rehab: 42000, arv: 385000, rent: 2650, units: 1 });

const near = (actual, expected, tol) => assert.ok(
  Math.abs(actual - expected) <= tol,
  `expected ${actual} within ${tol} of ${expected}`,
);
const rate = (actual, expected) => near(actual, expected, 0.005);

test('MAO nets rehab out of the 70% rule', () => {
  const r = analyzeWholesale(DEAL);
  assert.equal(r.rehabTotal, 46200);
  assert.equal(r.mao, 223300);            // 385000 x 0.70 - 46200, not 269500
  assert.equal(r.spread, -4700);          // the contract is above the max offer
  assert.equal(r.assignmentFee, 0);
  assert.equal(r.viable, false);
  assert.equal(r.verdict, 'pass');
});

test('the old bare-70%-of-ARV MAO would have overstated this deal', () => {
  const r = analyzeWholesale(DEAL);
  assert.equal(385000 * 0.70, 269500);
  assert.ok(r.mao < 269500);
  assert.ok(r.spread < 0);                // the rehab is what kills it
});

test('a real spread pays a clamped 40% assignment fee', () => {
  const r = analyzeWholesale({ purchase: 190000, rehab: 40000, arv: 400000 });
  assert.equal(r.rehabTotal, 44000);
  assert.equal(r.mao, 236000);            // 280000 - 44000
  assert.equal(r.spread, 46000);
  assert.equal(r.assignmentFee, 18400);   // 40% of spread
  assert.equal(r.profit, 18400);
  assert.equal(r.buyerPays, 208400);
  rate(r.buyerDiscountToArv, 1 - (208400 / 400000));
  assert.equal(r.viable, true);
  assert.equal(r.verdict, 'strong');
});

test('the fee is clamped to the 5k floor and 25k ceiling', () => {
  const capped = analyzeWholesale({ purchase: 160000, rehab: 40000, arv: 400000 });
  assert.equal(capped.spread, 76000);
  assert.equal(capped.assignmentFee, DEAL_ASSUMPTIONS.wholesaleFeeMax);

  const floored = analyzeWholesale({ purchase: 149000, rehab: 50000, arv: 300000 });
  assert.equal(floored.mao, 155000);
  assert.equal(floored.spread, 6000);
  assert.equal(floored.assignmentFee, DEAL_ASSUMPTIONS.wholesaleFeeMin);
});

test('the fee never exceeds the spread across the whole range', () => {
  for (let purchase = 100000; purchase <= 240000; purchase += 500) {
    const r = analyzeWholesale({ purchase, rehab: 40000, arv: 400000 });
    assert.ok(r.assignmentFee <= Math.max(0, r.spread),
      `fee ${r.assignmentFee} exceeded spread ${r.spread} at purchase ${purchase}`);
    assert.ok(r.assignmentFee >= 0);
    assert.equal(r.viable, r.assignmentFee > 0);
  }
});

test('a spread at or under the floor is not assignable', () => {
  const atFloor = analyzeWholesale({ purchase: 231000, rehab: 40000, arv: 400000 });
  assert.equal(atFloor.spread, 5000);
  assert.equal(atFloor.assignmentFee, 0);
  assert.equal(atFloor.viable, false);
  assert.equal(atFloor.verdict, 'pass');
});

test('verdict steps on the fee, not the spread', () => {
  const thin = analyzeWholesale({ purchase: 216000, rehab: 40000, arv: 400000 });
  assert.equal(thin.spread, 20000);
  assert.equal(thin.assignmentFee, 8000);
  assert.ok(thin.assignmentFee >= DEAL_ASSUMPTIONS.wholesaleThinFee);
  assert.ok(thin.assignmentFee < DEAL_ASSUMPTIONS.wholesaleStrongFee);
  assert.equal(thin.verdict, 'thin');
});

test('wholesale now requires rehab', () => {
  assert.throws(() => analyzeWholesale({ purchase: 120000, arv: 220000 }), /rehab/);
});
