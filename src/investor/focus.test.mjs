import test from 'node:test';
import assert from 'node:assert/strict';
import { createMockPropertyProvider } from './mock/provider.js';
import { dealVisionCaption, focusCardModel, whyThisMatters } from './focus.js';
import { escapeHtml } from './ui/escapeHtml.js';

const NOW = Date.UTC(2026, 8, 10);
const provider = createMockPropertyProvider({ now: NOW });
const flipRow = provider.getById('DEMO-ATL-001');
const rentalRow = provider.list().find((row) => row.bestStrategy === 'rental');
const taxRow = provider.getById('DEMO-ATL-009');
const quietRow = provider.list().find((row) => !row.auction);

test('focus card leads with why and withholds deal math until reveal', () => {
  const glance = focusCardModel(flipRow);
  assert.match(glance.why, /Two blocks off the Square/);
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

  assert.match(why, /Notice of Sale Under Power/, 'names the filing the way Georgia does');
  assert.doesNotMatch(why, /\bFORECLOSURE\b/, 'the enum key is never spoken');
  assert.match(why, /The Champion/, 'names the legal organ it was published in');
  assert.doesNotMatch(why, /MOCK\//, 'the MOCK/ prefix is a card kicker, not spoken');
  assert.match(why, /filed Aug 12 \(29 days ago\)/);
  assert.match(why, /91% confidence/);
  assert.match(why, /Owner equity 41%/);
  assert.match(why, /entry at \$228,000 is 41% under the \$385,000 estimate/);
  assert.match(why, /Best path: FLIP/);
});

test('an auction row says when and where the sale is', () => {
  const why = whyThisMatters(flipRow, null, { now: NOW });
  assert.equal(
    why.includes('Auction Tuesday Oct 6 at the DeKalb County Courthouse — 26 days.'),
    true,
    why,
  );
  // The sale sentence follows the filing it comes from, before the money.
  assert.ok(why.indexOf('Auction Tuesday') > why.indexOf('Notice of Sale Under Power'));
  assert.ok(why.indexOf('Auction Tuesday') < why.indexOf('Owner equity'));
});

test('a signal with no courthouse date says nothing about an auction', () => {
  assert.ok(quietRow, 'the dataset needs a row with no auction');
  const why = whyThisMatters(quietRow, null, { now: NOW });
  assert.doesNotMatch(why, /Auction/);
  assert.doesNotMatch(why, /Tax deed/);
});

test('a tax sale warns that the deed is redeemable; a foreclosure does not', () => {
  const why = whyThisMatters(taxRow, null, { now: NOW });
  assert.match(why, /Tax sale \(fi\. fa\.\)/);
  assert.match(why, /Auction Tuesday Oct 6 at the Fulton County Courthouse — 26 days\./);
  assert.equal(
    why.includes('Tax deed — 12-month redemption at a 20% premium applies, '
      + 'so the flip clock starts after redemption.'),
    true,
    why,
  );
  // The caveat qualifies the path, so it lands after it and before the colour.
  assert.ok(why.indexOf('Tax deed —') > why.indexOf('Best path:'));

  assert.doesNotMatch(whyThisMatters(flipRow, null, { now: NOW }), /Tax deed/);
});

test('the countdown says tomorrow and today rather than 1 and 0 days', () => {
  const dayBefore = whyThisMatters(flipRow, null, { now: Date.UTC(2026, 9, 5) });
  assert.match(dayBefore, /Auction Tuesday Oct 6 at the DeKalb County Courthouse — tomorrow\./);
  const saleDay = whyThisMatters(flipRow, null, { now: Date.UTC(2026, 9, 6) });
  assert.match(saleDay, /— today\./);
  const after = whyThisMatters(flipRow, null, { now: Date.UTC(2026, 9, 9) });
  assert.match(after, /— passed 3 days ago\./);
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
  assert.equal(model.signalLabel, 'Notice of Sale Under Power');
  assert.equal(model.signalSource, 'The Champion');
  assert.equal(model.signalDate, 'Aug 12');
  assert.equal(model.auction.county, 'DeKalb');
  assert.equal(model.auction.daysUntil, 26);
  assert.equal(model.taxDeed, null);
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
