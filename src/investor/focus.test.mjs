import test from 'node:test';
import assert from 'node:assert/strict';
import { ATLANTA_DECATUR_PROPERTIES } from './mock/atlantaDecatur.js';
import { dealVisionCaption, focusCardModel } from './focus.js';

const topPick = ATLANTA_DECATUR_PROPERTIES.find((row) => row.id === 'DEMO-ATL-001');

test('focus card leads with why and withholds deal math until reveal', () => {
  const glance = focusCardModel(topPick);
  assert.match(glance.why, /Auction-set foreclosure/);
  assert.doesNotMatch(glance.why, /modeled profit/i);
  assert.equal(glance.score >= 70, true);

  const open = focusCardModel(topPick, { revealDeal: true, strategy: 'flip' });
  assert.equal(open.why, glance.why);
  assert.equal(open.analysis.strategy, 'flip');
  assert.equal(Number.isFinite(open.analysis.profit), true);
  assert.match(dealVisionCaption('flip', open.analysis), /FLIP/);
  assert.match(dealVisionCaption('flip', open.analysis), /Profit/);
});
