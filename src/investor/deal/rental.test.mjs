import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeRental } from './rental.js';
import { pmt } from './math.js';

test('rental NOI, cap rate, and cash-on-cash are deterministic', () => {
  const result = analyzeRental({ purchase: 200000, rehab: 20000, rent: 2000 });
  assert.equal(result.grossRent, 24000);
  assert.equal(result.vacancy, 1200);
  assert.equal(result.opex, 8400);
  assert.equal(result.noi, 14400);
  assert.equal(result.capRate, 0.072);
  assert.equal(result.downPayment, 50000);
  assert.equal(result.loan, 150000);
  assert.equal(result.monthlyDebt, pmt(0.07, 30, 150000));
  assert.equal(result.cashInvested, 70000);
  assert.equal(result.cashFlowMonthly, Number((14400 / 12 - result.monthlyDebt).toFixed(2)));
  assert.equal(result.coc, Number(((result.cashFlowAnnual) / 70000).toFixed(6)));
});
