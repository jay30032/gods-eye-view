import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzePropertyDeal, bestStrategyFor, normalizeStrategy } from './index.js';

const property = {
  opportunityScore: { flip: 90, rental: 70, brrrr: 80, wholesale: 40 },
  deal: { purchase: 200000, rehab: 40000, arv: 320000, rent: 2200 },
};

test('normalizeStrategy accepts rent and brrr aliases', () => {
  assert.equal(normalizeStrategy('RENT'), 'rental');
  assert.equal(normalizeStrategy('brrr'), 'brrrr');
  assert.equal(normalizeStrategy('nope'), null);
});

test('bestStrategyFor picks the highest opportunity score', () => {
  assert.equal(bestStrategyFor(property), 'flip');
});

test('analyzePropertyDeal applies rehabDelta for the demo conversation', () => {
  const base = analyzePropertyDeal(property, 'flip');
  const bumped = analyzePropertyDeal(property, 'flip', { rehabDelta: 20000 });
  assert.equal(bumped.rehab, 60000);
  assert.equal(bumped.profit, base.profit - 20000);
});
