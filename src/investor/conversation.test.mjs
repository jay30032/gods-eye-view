import test from 'node:test';
import assert from 'node:assert/strict';
import { createMockPropertyProvider } from './mock/provider.js';
import {
  applyFindMoney,
  applyRehabDelta,
  applyShowDeal,
  applyWhy,
  createConversationState,
  parseDemoIntent,
} from './conversation.js';

test('demo conversation intents parse in order', () => {
  assert.equal(parseDemoIntent('Find me money').intent, 'find_money');
  assert.equal(parseDemoIntent('Why?').intent, 'why');
  assert.equal(parseDemoIntent('Show me the deal').intent, 'show_deal');
  assert.equal(parseDemoIntent('Assume rehab is twenty thousand higher').intent, 'rehab_plus_20k');
  assert.equal(parseDemoIntent('Save it').intent, 'save');
});

test('Find me money → Why → Show the deal → rehab +20k stays on one property', () => {
  const properties = createMockPropertyProvider().list();
  const state = createConversationState();
  const found = applyFindMoney(properties, state);
  assert.equal(found.ok, true);
  const property = properties.find((row) => row.id === found.focusId);
  const why = applyWhy(property, state);
  assert.match(why.spoken, /./);
  const deal = applyShowDeal(property, state);
  assert.equal(deal.ok, true);
  const bumped = applyRehabDelta(property, state, 20000);
  assert.equal(bumped.rehabDelta, 20000);
  assert.equal(bumped.analysis.rehab, property.deal.rehab + 20000);
  assert.equal(state.focusedId, property.id);
});
