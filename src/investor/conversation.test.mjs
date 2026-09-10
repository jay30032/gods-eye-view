import test from 'node:test';
import assert from 'node:assert/strict';
import { createMockPropertyProvider } from './mock/provider.js';
import { saveProperty } from './saved.js';
import {
  ACCEPTANCE_PHRASES,
  FIND_MONEY_LIMIT,
  applyFindMoney,
  applyRehabDelta,
  applySave,
  applyShowDeal,
  applyWhy,
  createConversationState,
  normalizeDemoUtterance,
  parseDemoIntent,
} from './conversation.js';

test('acceptance phrases parse case-insensitively with trailing punctuation', () => {
  const expected = ['find_money', 'why', 'show_deal', 'rehab_plus_20k', 'save'];
  ACCEPTANCE_PHRASES.forEach((phrase, index) => {
    assert.equal(parseDemoIntent(phrase).intent, expected[index]);
    assert.equal(parseDemoIntent(phrase.toUpperCase()).intent, expected[index]);
    assert.equal(parseDemoIntent(`${phrase}.`).intent, expected[index]);
  });
  assert.equal(parseDemoIntent('  Find Me Money!  ').intent, 'find_money');
  assert.equal(parseDemoIntent('WHY?').intent, 'why');
  assert.equal(normalizeDemoUtterance('Save it.'), 'save it');
  assert.notEqual(parseDemoIntent('Where are we hunting today?').intent, 'find_money');
});

test('Find me money turns vision on, shortlists four, and golds the best', () => {
  const properties = createMockPropertyProvider().list();
  const state = createConversationState();
  const found = applyFindMoney(properties, state);
  assert.equal(found.ok, true);
  assert.equal(found.visionOn, true);
  assert.equal(found.candidateCount, FIND_MONEY_LIMIT);
  assert.equal(found.candidateIds.length, 4);
  assert.equal(found.topPickId, found.focusId);
  assert.equal(state.visionOn, true);
  assert.equal(state.candidateIds.length, 4);
  assert.ok(found.results[0].score >= found.results[3].score);
  assert.match(found.spoken, /Opportunity Vision on/i);
  assert.match(found.spoken, /4 strong/i);
});

test('Find me money → Why → Show the deal → rehab +20k → Save it stays on one property', () => {
  const properties = createMockPropertyProvider().list();
  const state = createConversationState();
  const store = {
    data: {},
    getItem(key) { return Object.hasOwn(this.data, key) ? this.data[key] : null; },
    setItem(key, value) { this.data[key] = String(value); },
    removeItem(key) { delete this.data[key]; },
  };

  const found = applyFindMoney(properties, state);
  assert.equal(found.ok, true);
  const property = properties.find((row) => row.id === found.focusId);
  const why = applyWhy(property, state);
  assert.match(why.spoken, /./);
  assert.equal(why.id, property.id);

  const deal = applyShowDeal(property, state);
  assert.equal(deal.ok, true);
  assert.equal(state.dealVisible, true);
  const profitBefore = deal.analysis.profit;

  const bumped = applyRehabDelta(property, state, 20000);
  assert.equal(bumped.rehabDelta, 20000);
  assert.equal(bumped.analysis.rehab, property.deal.rehab + 20000);
  assert.ok(bumped.analysis.profit < profitBefore);
  assert.equal(state.focusedId, property.id);

  const saved = applySave(property, state, (row, meta) => saveProperty(row, meta, store));
  assert.equal(saved.ok, true);
  assert.equal(state.savedId, property.id);
  assert.equal(JSON.parse(store.data['terrasignal:saved-properties:v1'])[0].id, property.id);
});
