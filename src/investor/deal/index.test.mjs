import test from 'node:test';
import assert from 'node:assert/strict';
import {
  analyzePropertyDeal,
  bestStrategyFor,
  normalizeStrategy,
  unitsFor,
} from './index.js';

const property = Object.freeze({
  propertyType: 'sfr',
  opportunityScore: { flip: 92, rental: 71, brrrr: 88, wholesale: 64 },
  deal: { purchase: 228000, rehab: 42000, arv: 385000, rent: 2650 },
});

test('normalizeStrategy accepts rent and brrr aliases', () => {
  assert.equal(normalizeStrategy('RENT'), 'rental');
  assert.equal(normalizeStrategy('brrr'), 'brrrr');
  assert.equal(normalizeStrategy('nope'), null);
});

test('bestStrategyFor picks the highest opportunity score', () => {
  assert.equal(bestStrategyFor(property), 'flip');
});

test('unitsFor maps property types and honours an explicit count', () => {
  assert.equal(unitsFor('sfr'), 1);
  assert.equal(unitsFor('condo'), 1);
  assert.equal(unitsFor('townhouse'), 1);
  assert.equal(unitsFor('duplex'), 2);
  assert.equal(unitsFor('triplex'), 3);
  assert.equal(unitsFor('quad'), 4);
  assert.equal(unitsFor('small_multifamily'), 3);
  assert.equal(unitsFor('unknown-type'), 1);
  assert.equal(unitsFor(undefined), 1);
  assert.equal(unitsFor('duplex', 7), 7);        // explicit wins
  assert.equal(unitsFor('duplex', 'nonsense'), 2);
});

test('analyzePropertyDeal threads units from the property into the deal', () => {
  const duplex = { ...property, propertyType: 'duplex' };
  assert.equal(analyzePropertyDeal(property, 'rental').units, 1);
  assert.equal(analyzePropertyDeal(duplex, 'rental').units, 2);
  assert.equal(analyzePropertyDeal(duplex, 'rental').insurance, 2800);
  assert.equal(analyzePropertyDeal({ ...duplex, units: 5 }, 'rental').units, 5);
  assert.equal(analyzePropertyDeal({ ...duplex, units: 5 }, 'brrrr').insurance, 7000);
});

test('rehabDelta lands on base rehab before the contingency', () => {
  const base = analyzePropertyDeal(property, 'flip');
  const bumped = analyzePropertyDeal(property, 'flip', { rehabDelta: 20000 });
  assert.equal(base.rehabTotal, 46200);
  assert.equal(bumped.rehab, 62000);
  assert.equal(bumped.rehabTotal, 68200);        // 62000 x 1.10, not 46200 + 20000
  assert.ok(bumped.profit < base.profit);
  assert.ok(bumped.cashIn > base.cashIn);
});

test('rehabDelta reaches every strategy', () => {
  for (const strategy of ['flip', 'rental', 'brrrr', 'wholesale']) {
    const bumped = analyzePropertyDeal(property, strategy, { rehabDelta: 20000 });
    assert.equal(bumped.rehabTotal, 68200, strategy);
  }
  const wholesale = analyzePropertyDeal(property, 'wholesale', { rehabDelta: 20000 });
  assert.equal(wholesale.mao, 385000 * 0.7 - 68200);
});

test('overrides pass through while rehabDelta is consumed', () => {
  const r = analyzePropertyDeal(property, 'flip', { rehabDelta: 20000, flipHoldMonths: 12 });
  assert.equal(r.holdMonths, 12);
  assert.equal(r.rehabTotal, 68200);
  assert.equal(Object.hasOwn(r.assumptions, 'rehabDelta'), false);
});

test('every strategy returns a verdict and its frozen assumptions', () => {
  for (const strategy of ['flip', 'rental', 'brrrr', 'wholesale']) {
    const r = analyzePropertyDeal(property, strategy);
    assert.equal(r.strategy, strategy);
    assert.ok(['strong', 'thin', 'pass'].includes(r.verdict), `${strategy}: ${r.verdict}`);
    assert.equal(Object.isFrozen(r), true);
    assert.equal(Object.isFrozen(r.assumptions), true);
  }
});

test('analyzePropertyDeal rejects an unknown strategy', () => {
  assert.throws(() => analyzePropertyDeal(property, 'airbnb'), /Unknown deal strategy/);
  assert.throws(() => analyzePropertyDeal(property, ''), /missing/);
});
