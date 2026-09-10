import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeWholesale } from './wholesale.js';

test('wholesale MAO, spread, and assignment fee are deterministic', () => {
  const result = analyzeWholesale({ purchase: 120000, arv: 220000 });
  assert.equal(result.mao, 154000);
  assert.equal(result.spread, 34000);
  assert.equal(result.assignmentFee, 13600);
  assert.equal(result.profit, 13600);
  assert.equal(result.buyerPays, 133600);
  assert.equal(result.viable, true);
});

test('wholesale is not viable when spread is too thin', () => {
  const result = analyzeWholesale({ purchase: 200000, arv: 220000 });
  assert.equal(result.spread, -46000);
  assert.equal(result.assignmentFee, 0);
  assert.equal(result.viable, false);
});
