import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeBrrrr } from './brrrr.js';

test('BRRRR refinance and cash-left-in are deterministic', () => {
  const result = analyzeBrrrr({
    purchase: 180000,
    rehab: 30000,
    arv: 320000,
    rent: 2400,
  });
  assert.equal(result.buyClosing, 3600);
  assert.equal(result.allIn, 213600);
  assert.equal(result.refinanceAmount, 240000);
  assert.equal(result.cashOut, 26400);
  assert.equal(result.cashLeftIn, 0);
  assert.equal(result.infiniteReturn, result.cashFlowAnnual > 0);
  assert.equal(result.coc, result.cashFlowAnnual > 0 ? 999 : 0);
});

test('BRRRR with thin ARV leaves cash in the deal', () => {
  const result = analyzeBrrrr({
    purchase: 220000,
    rehab: 50000,
    arv: 280000,
    rent: 2200,
  });
  assert.equal(result.refinanceAmount, 210000);
  assert.ok(result.cashLeftIn > 0);
  assert.equal(result.infiniteReturn, false);
});
