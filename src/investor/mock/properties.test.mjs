import test from 'node:test';
import assert from 'node:assert/strict';
import { createMockPropertyProvider } from './provider.js';
import { validateProperty, SIGNAL_TYPES } from './schema.js';
import { findMoney, searchMockProperties } from './search.js';

test('Atlanta mock inventory has at least 25 valid DEMO/MOCK properties', () => {
  const provider = createMockPropertyProvider({ marketId: 'atlanta', provider: 'mock' });
  assert.ok(provider.count >= 25);
  for (const property of provider.list()) {
    assert.deepEqual(validateProperty(property), []);
    assert.match(property.id, /^(DEMO|MOCK)-/);
    assert.ok(property.signals.every((signal) => SIGNAL_TYPES.includes(signal.type)));
    assert.ok(property.deal.purchase > 0);
  }
});

test('mock provider refuses a live property provider', () => {
  assert.throws(
    () => createMockPropertyProvider({ provider: 'attom' }),
    /mock only/,
  );
});

test('find money ranks high-signal mock properties first', () => {
  const provider = createMockPropertyProvider();
  const hits = findMoney(provider.list(), 5);
  assert.ok(hits.length >= 3);
  assert.ok(hits[0].score >= hits[1].score);
  assert.match(hits[0].property.id, /DEMO-ATL-001|DEMO-ATL-026|DEMO-ATL-010/);
});

test('search filters by neighborhood and signal', () => {
  const provider = createMockPropertyProvider();
  const decatur = searchMockProperties(provider.list(), { query: 'oakhurst' });
  assert.ok(decatur.length >= 1);
  const fores = searchMockProperties(provider.list(), { signalType: 'FORECLOSURE' });
  assert.ok(fores.every((row) => row.primary.type === 'FORECLOSURE' || row.property.signals.some((s) => s.type === 'FORECLOSURE')));
});
