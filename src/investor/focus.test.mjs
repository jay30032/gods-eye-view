import test from 'node:test';
import assert from 'node:assert/strict';
import { createMockPropertyProvider } from './mock/provider.js';
import { dealVisionCaption, focusCardModel, whyThisMatters } from './focus.js';
import { escapeHtml } from './ui/escapeHtml.js';

const NOW = Date.UTC(2026, 8, 10);
const provider = createMockPropertyProvider({ now: NOW });
const flipRow = provider.getById('DEMO-ATL-001');
const rentalRow = provider.list().find((row) => row.bestStrategy === 'rental');

test('focus card leads with why and withholds deal math until reveal', () => {
  const glance = focusCardModel(flipRow);
  assert.match(glance.why, /Auction-set foreclosure/);
  assert.doesNotMatch(glance.why, /modeled profit/i);
  assert.equal(glance.score >= 70, true);

  const open = focusCardModel(flipRow, { revealDeal: true, strategy: 'flip' });
  assert.equal(open.why, glance.why, 'opening the deal must not rewrite the reason');
  assert.equal(open.analysis.strategy, 'flip');
  assert.equal(Number.isFinite(open.analysis.profit), true);
  assert.match(dealVisionCaption('flip', open.analysis), /FLIP/);
  assert.match(dealVisionCaption('flip', open.analysis), /Profit/);
});

test('why is generated from the signal, the equity, and the underwriting', () => {
  const why = whyThisMatters(flipRow, null, { now: NOW });

  assert.match(why, /Foreclosure/, 'names the signal type in words');
  assert.match(why, /county-notice/, 'names the source');
  assert.doesNotMatch(why, /MOCK\//, 'the MOCK/ prefix is a card kicker, not spoken');
  assert.match(why, /filed Aug 12 \(29 days ago\)/);
  assert.match(why, /91% confidence/);
  assert.match(why, /Owner equity 41%/);
  assert.match(why, /entry at \$228,000 is 41% under the \$385,000 estimate/);
  assert.match(why, /Best path: FLIP/);
});

test('why carries one headline figure and none of the breakdown', () => {
  const why = whyThisMatters(flipRow, null, { now: NOW });

  assert.equal((why.match(/Best path:/g) || []).length, 1, 'exactly one headline clause');
  assert.match(why, /Best path: FLIP — \$\d+k profit on \$\d+k cash in\./);

  // The full breakdown stays behind "Show me the deal".
  for (const leaked of [/DSCR/i, /cap rate/i, /\bMAO\b/i, /all[- ]in/i, /annualized/i, /\bmargin\b/i]) {
    assert.doesNotMatch(why, leaked, `${leaked} belongs to the deal card, not why`);
  }
});

test('the headline follows the best strategy, not whatever ran last', () => {
  assert.ok(rentalRow, 'the dataset needs at least one rental-best row');
  const why = whyThisMatters(rentalRow, null, { now: NOW });
  assert.match(why, /Best path: RENTAL — \$[\d,]+\/mo, \d+\.\d% cash-on-cash\./);

  // A flip analysis handed in for a rental-best house is ignored, not printed.
  const withFlip = whyThisMatters(rentalRow, { strategy: 'flip', profit: 1, cashIn: 1 }, { now: NOW });
  assert.equal(withFlip, why);
});

test('why is deterministic for a fixed clock', () => {
  assert.equal(whyThisMatters(flipRow, null, { now: NOW }), whyThisMatters(flipRow, null, { now: NOW }));
});

test('the focus card model exposes the composite, drivers, and all four scores', () => {
  const model = focusCardModel(flipRow);
  assert.equal(model.score, flipRow.composite);
  assert.equal(model.bestStrategy, 'flip');
  assert.deepEqual(model.drivers, [...flipRow.drivers]);
  assert.deepEqual(model.scores, flipRow.opportunityScore);
  assert.equal(model.note, flipRow.note);
});

test('escapeHtml neutralises every character that can break out of a template', () => {
  assert.equal(escapeHtml('<script>'), '&lt;script&gt;');
  assert.equal(escapeHtml('a & b'), 'a &amp; b');
  assert.equal(escapeHtml('say "hi"'), 'say &quot;hi&quot;');
  assert.equal(escapeHtml("it's"), 'it&#39;s');
  assert.equal(
    escapeHtml(`<img src=x onerror="alert('&')">`),
    '&lt;img src=x onerror=&quot;alert(&#39;&amp;&#39;)&quot;&gt;',
  );
  assert.equal(escapeHtml(null), '');
  assert.equal(escapeHtml(undefined), '');
  assert.equal(escapeHtml(0), '0');
});
