import test from 'node:test';
import assert from 'node:assert/strict';
import { createMockPropertyProvider } from './mock/provider.js';
import { saveProperty } from './saved.js';
import { analyzePropertyDeal } from './deal/index.js';
import {
  ACCEPTANCE_PHRASES,
  FIND_MONEY_LIMIT,
  applyCompare,
  applyFindMoney,
  applyFocus,
  applyReset,
  applySave,
  applyShowDeal,
  applyUnsave,
  applyWhatIf,
  applyWhy,
  applyWhyStrategy,
  createConversationState,
  hasCustomNumbers,
  normalizeDemoUtterance,
  parseDemoIntent,
} from './conversation.js';

const NOW = Date.UTC(2026, 8, 10);
const provider = () => createMockPropertyProvider({ now: NOW });
const load = () => provider().list();
const byId = (rows, id) => rows.find((row) => row.id === id);

function memoryStore() {
  return {
    data: {},
    getItem(key) { return Object.hasOwn(this.data, key) ? this.data[key] : null; },
    setItem(key, value) { this.data[key] = String(value); },
    removeItem(key) { delete this.data[key]; },
  };
}

test('acceptance phrases parse case-insensitively with trailing punctuation', () => {
  const expected = ['find_money', 'why', 'show_deal', 'what_if', 'save'];
  ACCEPTANCE_PHRASES.forEach((phrase, index) => {
    assert.equal(parseDemoIntent(phrase).intent, expected[index]);
    assert.equal(parseDemoIntent(phrase.toUpperCase()).intent, expected[index]);
    assert.equal(parseDemoIntent(`${phrase}.`).intent, expected[index]);
  });
  assert.equal(parseDemoIntent('  Find Me Money!  ').intent, 'find_money');
  assert.equal(parseDemoIntent('WHY?').intent, 'why');
  assert.equal(normalizeDemoUtterance('Save it.'), 'save it');
  assert.notEqual(parseDemoIntent('Where are we hunting today?').intent, 'find_money');

  // The demo's rehab beat still carries its exact numbers.
  assert.deepEqual(parseDemoIntent('Assume rehab is twenty thousand higher').slots, {
    field: 'rehab', op: 'plus', value: 20000,
  });
});

test('Find me money turns vision on, shortlists four, and golds the best', () => {
  const properties = load();
  const state = createConversationState();
  const found = applyFindMoney(properties, state);
  assert.equal(found.ok, true);
  assert.equal(found.visionOn, true);
  assert.equal(found.candidateCount, FIND_MONEY_LIMIT);
  assert.equal(found.candidateIds.length, 4);
  assert.equal(found.topPickId, found.focusId);
  assert.equal(state.visionOn, true);
  assert.equal(state.candidateIds.length, 4);
  assert.equal(state.cursor, 0);
  assert.ok(found.results[0].score >= found.results[3].score);
  assert.match(found.spoken, /Opportunity Vision on/i);
  assert.match(found.spoken, /4 strong mock candidates/i);
  assert.match(found.spoken, /Gold pick is .+, composite \d+\./);

  const highest = Math.max(...properties.map((row) => row.composite));
  assert.equal(byId(properties, found.topPickId).composite, highest);
});

test('a hunt filters on county, signal, price cap, score, and limit', () => {
  const properties = load();

  const dekalb = applyFindMoney(properties, createConversationState(), { county: 'dekalb' });
  assert.ok(dekalb.results.every((row) => byId(properties, row.id).county === 'dekalb'));

  const fores = applyFindMoney(properties, createConversationState(), { signalType: 'FORECLOSURE' });
  assert.ok(fores.results.every((row) => byId(properties, row.id).signals
    .some((signal) => signal.type === 'FORECLOSURE')));
  assert.match(fores.spoken, /foreclosures/);

  const capped = applyFindMoney(properties, createConversationState(), { maxPurchase: 200000 });
  assert.ok(capped.results.every((row) => byId(properties, row.id).deal.purchase <= 200000));

  const scored = applyFindMoney(properties, createConversationState(), { minScore: 90 });
  assert.ok(scored.results.every((row) => byId(properties, row.id).composite >= 90));

  const three = applyFindMoney(properties, createConversationState(), { limit: 3 });
  assert.equal(three.results.length, 3);

  const kirkwood = applyFindMoney(properties, createConversationState(), { neighborhood: 'Kirkwood' });
  assert.ok(kirkwood.results.every((row) => byId(properties, row.id).neighborhood === 'Kirkwood'));
  assert.match(kirkwood.spoken, /in Kirkwood/);

  // A strategy filter ranks on that strategy's score, not the composite.
  const flips = applyFindMoney(properties, createConversationState(), { strategy: 'flip' });
  assert.equal(flips.results[0].score, byId(properties, flips.results[0].id).opportunityScore.flip);
  assert.ok(flips.results[0].score >= flips.results[1].score);
});

test('a hunt that matches nothing says so and leaves the board alone', () => {
  const properties = load();
  const state = createConversationState();
  applyFindMoney(properties, state);
  const before = state.candidateIds.slice();

  const empty = applyFindMoney(properties, state, { county: 'dekalb', maxPurchase: 1000 });
  assert.equal(empty.ok, false);
  assert.equal(empty.candidateCount, 0);
  assert.match(empty.spoken, /Nothing matches that in Atlanta \/ Decatur/);
  assert.match(empty.spoken, /price cap or the neighborhood/);
  assert.deepEqual(state.candidateIds, before, 'a miss must not clear the shortlist');
});

test('focus steps through the shortlist and wraps at both ends', () => {
  const properties = load();
  const state = createConversationState();
  const found = applyFindMoney(properties, state);
  const shortlist = found.candidateIds;

  assert.equal(applyFocus(properties, state, { step: 'next' }).id, shortlist[1]);
  assert.equal(applyFocus(properties, state, { step: 'next' }).id, shortlist[2]);
  assert.equal(applyFocus(properties, state, { step: 'next' }).id, shortlist[3]);
  // Off the end, back to the start.
  assert.equal(applyFocus(properties, state, { step: 'next' }).id, shortlist[0]);
  // And backwards off the start, round to the end.
  assert.equal(applyFocus(properties, state, { step: 'previous' }).id, shortlist[3]);
  assert.equal(applyFocus(properties, state, { step: 'previous' }).id, shortlist[2]);
});

test('focus resolves an ordinal, a query, and the gold pick', () => {
  const properties = load();
  const state = createConversationState();
  const found = applyFindMoney(properties, state);

  const second = applyFocus(properties, state, { ordinal: 2 });
  assert.equal(second.id, found.candidateIds[1]);
  assert.equal(state.cursor, 1);

  const named = applyFocus(properties, state, { query: '214 sycamore' });
  assert.equal(named.id, 'DEMO-ATL-001');
  assert.match(named.spoken, /214 Sycamore St\./);
  assert.match(named.spoken, /composite \d+, best path [A-Z]+\./);

  const gold = applyFocus(properties, state, { step: 'top' });
  assert.equal(gold.id, found.topPickId);

  const missing = applyFocus(properties, state, { query: 'nowhere at all' });
  assert.equal(missing.ok, false);
  assert.match(missing.spoken, /don't have nowhere at all/);

  const past = applyFocus(properties, state, { ordinal: 99 });
  assert.equal(past.ok, false);
  assert.match(past.spoken, /only \d+ on the board/);
});

test('focusing a new house drops its what-ifs but keeps the financing terms', () => {
  const properties = load();
  const state = createConversationState();
  applyFindMoney(properties, state);
  const first = byId(properties, state.focusedId);

  applyWhatIf(first, state, { field: 'rehab', op: 'plus', value: 20000 });
  applyWhatIf(first, state, { field: 'rate', op: 'set', value: 0.06 });
  assert.equal(state.rehabDelta, 20000);
  assert.equal(hasCustomNumbers(state), true);

  applyFocus(properties, state, { step: 'next' });
  assert.equal(state.rehabDelta, 0, 'the last house\'s scope does not describe this one');
  assert.deepEqual(state.dealOverrides, {});
  assert.equal(state.assumptionOverrides.mortgageAnnualRate, 0.06, 'my rate is still my rate');
});

test('a what-if leads with the new figure and says when the verdict moves', () => {
  const properties = load();
  const state = createConversationState();
  const property = byId(properties, 'DEMO-ATL-020');
  state.focusedId = property.id;
  state.lastStrategy = 'flip';

  // Same verdict — say so rather than implying something changed.
  const nudge = applyWhatIf(property, state, { field: 'rehab', op: 'plus', value: 2000 });
  assert.equal(nudge.ok, true);
  assert.equal(nudge.verdictChanged, false);
  assert.match(nudge.spoken, /^Rehab is now \$30k\. Still a strong flip — \$\d+k profit on \$\d+k cash in\.$/);

  // Enough scope to break it.
  const heavy = applyWhatIf(property, state, { field: 'rehab', op: 'set', value: 60000 });
  assert.equal(heavy.verdictChanged, true);
  assert.equal(heavy.previousVerdict, 'strong');
  assert.match(heavy.spoken, /^Rehab is now \$60k\. That moves flip from strong to pass — /);

  // And a cheaper entry to fix it again.
  const cheaper = applyWhatIf(property, state, { field: 'purchase', op: 'set', value: 110000 });
  assert.match(cheaper.spoken, /^Purchase at \$110k\. That moves flip from pass to thin — /);
  assert.equal(cheaper.analysis.purchase, 110000);
});

test('a what-if composes with the demo rehab bump instead of replacing it', () => {
  const properties = load();
  const state = createConversationState();
  const property = byId(properties, 'DEMO-ATL-020');
  state.lastStrategy = 'flip';

  applyWhatIf(property, state, { field: 'rehab', op: 'plus', value: 20000 });
  const both = applyWhatIf(property, state, { field: 'rehab', op: 'set', value: 60000 });
  // Setting the scope to 60k means 60k funded, not 60k plus the old delta.
  assert.equal(both.analysis.rehab, 60000);
  assert.equal(both.value, 60000);
});

test('a what-if refuses terms outside what the model can defend', () => {
  const properties = load();
  const state = createConversationState();
  const property = byId(properties, 'DEMO-ATL-020');
  state.lastStrategy = 'rental';

  const usury = applyWhatIf(property, state, { field: 'rate', op: 'set', value: 0.25 });
  assert.equal(usury.ok, false);
  assert.match(usury.spoken, /Rate of 25% is outside what I model — keep it between 0% and 20%\./);
  assert.equal(state.assumptionOverrides.mortgageAnnualRate, undefined, 'a refusal writes nothing');

  const overLevered = applyWhatIf(property, state, { field: 'ltv', op: 'set', value: 1.1 });
  assert.equal(overLevered.ok, false);
  assert.match(overLevered.spoken, /LTV of 110% is outside what I model/);

  const forever = applyWhatIf(property, state, { field: 'hold', op: 'set', value: 48 });
  assert.equal(forever.ok, false);
  assert.match(forever.spoken, /Hold of 48 months is outside what I model — keep it between 1 month and 36 months\./);

  // The edges themselves are allowed.
  assert.equal(applyWhatIf(property, state, { field: 'rate', op: 'set', value: 0.20 }).ok, true);
  assert.equal(applyWhatIf(property, state, { field: 'hold', op: 'set', value: 36 }).ok, true);
});

test('why-not-a-strategy names the numbers and the threshold that decided it', () => {
  const properties = load();
  const state = createConversationState();
  const property = byId(properties, 'DEMO-ATL-020');

  const wholesale = applyWhyStrategy(property, state, 'wholesale');
  assert.equal(wholesale.verdict, 'pass');
  assert.equal(
    wholesale.spoken,
    'Wholesale is a pass: MAO $133,700 against a $124,000 contract leaves a $9,700 spread, '
    + 'and the $5,000 fee is under the $7,500 floor.',
  );

  const thinRental = applyWhyStrategy(byId(properties, 'DEMO-ATL-001'), state, 'rental');
  assert.equal(thinRental.verdict, 'thin');
  assert.match(thinRental.spoken, /^Rental is thin: \$\d+ a month, \d+\.\d% cash-on-cash, DSCR \d\.\d\d — /);
  assert.match(thinRental.spoken, /the cash-on-cash is under 8%\.$|DSCR is under 1\.25\.$/);

  const strongFlip = applyWhyStrategy(property, state, 'flip');
  assert.equal(strongFlip.verdict, 'strong');
  assert.match(strongFlip.spoken, /^Flip is strong: .+ clears the \$30,000 and 10% bars\.$/);

  // An unknown strategy falls back to the property-level why rather than failing.
  assert.equal(applyWhyStrategy(property, state, 'nonsense').action, 'explain_property');
});

test('compare reports all four verdicts and names the winner', () => {
  const properties = load();
  const state = createConversationState();
  const property = byId(properties, 'DEMO-ATL-020');

  const compared = applyCompare(property, state);
  assert.equal(compared.ok, true);
  assert.deepEqual(compared.rows.map((row) => row.strategy), ['flip', 'rental', 'brrrr', 'wholesale']);
  assert.equal(compared.best, 'flip');
  assert.match(compared.spoken, /^Flip strong \$\d+k profit · Rental strong .+ · BRRRR pass · Wholesale pass\. Flip wins\.$/);

  // A passing strategy shows no headline — there is no number worth repeating.
  const passing = compared.rows.find((row) => row.strategy === 'wholesale');
  assert.equal(passing.text, 'Wholesale pass');

  for (const key of ['flip', 'rental', 'brrrr', 'wholesale']) {
    assert.equal(compared.analyses[key].strategy, key);
  }
  assert.equal(applyCompare(null, state).ok, false);
});

test('compare runs against the what-ifs in play, not the listed numbers', () => {
  const properties = load();
  const state = createConversationState();
  const property = byId(properties, 'DEMO-ATL-020');
  state.lastStrategy = 'flip';

  applyWhatIf(property, state, { field: 'rehab', op: 'set', value: 60000 });
  const compared = applyCompare(property, state);
  assert.equal(compared.analyses.flip.rehab, 60000);
});

test('reset puts every number back on the listed deal', () => {
  const properties = load();
  const state = createConversationState();
  const property = byId(properties, 'DEMO-ATL-020');
  state.lastStrategy = 'flip';

  applyWhatIf(property, state, { field: 'rehab', op: 'plus', value: 20000 });
  applyWhatIf(property, state, { field: 'purchase', op: 'set', value: 110000 });
  applyWhatIf(property, state, { field: 'rate', op: 'set', value: 0.06 });
  assert.equal(hasCustomNumbers(state), true);

  const reset = applyReset(state);
  assert.equal(reset.ok, true);
  assert.equal(reset.spoken, 'Numbers reset to defaults.');
  assert.equal(hasCustomNumbers(state), false);
  assert.deepEqual(state.dealOverrides, {});
  assert.deepEqual(state.assumptionOverrides, {});
  assert.equal(state.rehabDelta, 0);

  const after = applyShowDeal(property, state);
  const listed = analyzePropertyDeal(property, 'flip');
  assert.equal(after.analysis.profit, listed.profit);
});

test('save carries a spoken note, and unsave takes it back off', () => {
  const properties = load();
  const state = createConversationState();
  const store = memoryStore();
  const property = byId(properties, 'DEMO-ATL-020');

  const saved = applySave(property, state, (row, meta) => saveProperty(row, meta, store), 'call the agent tuesday');
  assert.equal(saved.ok, true);
  assert.equal(saved.note, 'call the agent tuesday');
  assert.equal(saved.spoken, 'Saved 3372 Belvedere Ln — "call the agent tuesday".');
  assert.equal(JSON.parse(store.data['terrasignal:saved-properties:v1'])[0].note, 'call the agent tuesday');

  const plain = applySave(property, state, (row, meta) => saveProperty(row, meta, store));
  assert.equal(plain.spoken, 'Saved 3372 Belvedere Ln.');

  const removed = [];
  const gone = applyUnsave(property, state, (id) => removed.push(id));
  assert.equal(gone.ok, true);
  assert.deepEqual(removed, [property.id]);
  assert.equal(state.savedId, null);
  assert.equal(gone.spoken, 'Removed 3372 Belvedere Ln from saved.');
});

test('Find me money → Why → Show the deal → rehab +20k → Save it stays on one property', () => {
  const properties = load();
  const state = createConversationState();
  const store = memoryStore();

  const found = applyFindMoney(properties, state);
  assert.equal(found.ok, true);
  const property = byId(properties, found.focusId);

  const why = applyWhy(property, state);
  assert.match(why.spoken, /./);
  assert.equal(why.id, property.id);

  const deal = applyShowDeal(property, state);
  assert.equal(deal.ok, true);
  assert.equal(state.dealVisible, true);
  const profitBefore = deal.analysis.profit;

  const bumped = applyWhatIf(property, state, { field: 'rehab', op: 'plus', value: 20000 });
  assert.equal(state.rehabDelta, 20000);
  assert.equal(bumped.analysis.rehab, property.deal.rehab + 20000);
  assert.ok(bumped.analysis.profit < profitBefore);
  assert.equal(state.focusedId, property.id);

  const saved = applySave(property, state, (row, meta) => saveProperty(row, meta, store));
  assert.equal(saved.ok, true);
  assert.equal(state.savedId, property.id);
  assert.equal(JSON.parse(store.data['terrasignal:saved-properties:v1'])[0].id, property.id);
});

test('Why speaks the generated explanation and the drivers behind the score', () => {
  const properties = load();
  const state = createConversationState();
  const property = byId(properties, 'DEMO-ATL-001');

  const why = applyWhy(property, state);
  assert.equal(why.ok, true);
  assert.equal(why.strategy, property.bestStrategy);
  assert.equal(why.spoken, why.why);
  assert.match(why.why, /Notice of Sale Under Power/);
  assert.match(why.why, /Auction Tuesday Oct 6/);
  assert.match(why.why, /Best path: FLIP — \$\d+k profit/);
  assert.deepEqual(why.drivers, [...property.drivers]);
  assert.deepEqual(why.scores, property.opportunityScore);
});
