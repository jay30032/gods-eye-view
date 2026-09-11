import test from 'node:test';
import assert from 'node:assert/strict';
import { ATLANTA_DECATUR_PROPERTIES } from './mock/atlantaDecatur.js';
import { analyzePropertyDeal } from './deal/index.js';
import {
  STRATEGY_KEYS,
  auctionFor,
  enrichProperty,
  equityScore,
  recencyFactor,
  scoreProperty,
  scoreStrategy,
  signalAgeDays,
  signalStrength,
  taxDeedFor,
} from './scoring.js';

const NOW = Date.UTC(2026, 8, 10);
const ROW = ATLANTA_DECATUR_PROPERTIES.find((row) => row.id === 'DEMO-ATL-001');

function signal(type, confidence, effectiveDate) {
  return { type, confidence, effectiveDate, source: 'MOCK/fixture' };
}

function row(overrides = {}) {
  return {
    id: 'MOCK-FIXTURE',
    address: '1 Fixture Ln, Decatur, GA 30030',
    county: 'dekalb',
    lat: 33.77,
    lng: -84.29,
    propertyType: 'sfr',
    estimatedValue: 300000,
    estimatedEquityPct: 0.30,
    signals: [signal('FORECLOSURE', 0.9, '2026-09-01')],
    deal: { purchase: 180000, rehab: 30000, arv: 300000, rent: 2200 },
    ...overrides,
  };
}

test('scoring is deterministic — the same row and clock give the same numbers', () => {
  const first = scoreProperty(ROW, { now: NOW });
  const second = scoreProperty(ROW, { now: NOW });
  assert.deepEqual(first.scores, second.scores);
  assert.equal(first.composite, second.composite);
  assert.equal(first.bestStrategy, second.bestStrategy);
  assert.deepEqual(first.drivers, second.drivers);
});

test('DEMO-ATL-001 scores the way the demo promises', () => {
  const scored = scoreProperty(ROW, { now: NOW });
  assert.equal(scored.bestStrategy, 'flip');
  assert.ok(scored.scores.flip >= 70, `flip ${scored.scores.flip} should be strong`);
  assert.equal(scored.scores.wholesale, 0);
  assert.equal(scored.signalAgeDays, 29);
});

test('a score can never contradict the verdict printed beside it', () => {
  let seen = { strong: 0, thin: 0, pass: 0 };
  for (const property of ATLANTA_DECATUR_PROPERTIES) {
    const scored = scoreProperty(property, { now: NOW });
    for (const key of STRATEGY_KEYS) {
      const analysis = scored.analyses[key];
      const score = scored.scores[key];
      seen[analysis.verdict] += 1;
      if (analysis.verdict === 'strong') {
        assert.ok(score >= 70, `${property.id} ${key} strong but scored ${score}`);
      } else if (analysis.verdict === 'thin') {
        assert.ok(score >= 40 && score <= 69, `${property.id} ${key} thin but scored ${score}`);
      } else {
        assert.ok(score <= 39, `${property.id} ${key} pass but scored ${score}`);
      }
    }
  }
  // The dataset has to actually exercise all three bands for this to mean anything.
  assert.ok(seen.strong > 0 && seen.thin > 0 && seen.pass > 0, JSON.stringify(seen));
});

test('the verdict band overrides a raw score that disagrees with it', () => {
  // A raw flip score of 0 that the calculator called strong still lands at 70.
  assert.equal(scoreStrategy({ strategy: 'flip', margin: 0, profit: 0, verdict: 'strong' }), 70);
  // A raw flip score of 100 that the calculator called a pass is capped at 39.
  assert.equal(scoreStrategy({ strategy: 'flip', margin: 1, profit: 1e6, verdict: 'pass' }), 39);
  assert.equal(scoreStrategy({ strategy: 'rental', coc: 1, dscr: 9, verdict: 'thin' }), 69);
  assert.equal(scoreStrategy({ strategy: 'wholesale', viable: false, verdict: 'pass' }), 0);
  assert.equal(
    scoreStrategy({ strategy: 'brrrr', infiniteReturn: true, cashFlowAnnual: 1200, verdict: 'strong' }),
    100,
  );
});

test('every strategy formula responds to its own inputs', () => {
  const weakFlip = scoreStrategy({ strategy: 'flip', margin: 0.05, profit: 15000, verdict: 'thin' });
  const strongFlip = scoreStrategy({ strategy: 'flip', margin: 0.18, profit: 55000, verdict: 'thin' });
  assert.ok(strongFlip > weakFlip);

  const weakRental = scoreStrategy({ strategy: 'rental', coc: 0.03, dscr: 1.05, verdict: 'thin' });
  const strongRental = scoreStrategy({ strategy: 'rental', coc: 0.11, dscr: 1.4, verdict: 'thin' });
  assert.ok(strongRental > weakRental);

  const heavyBrrrr = scoreStrategy({ strategy: 'brrrr', cashLeftIn: 45000, cashFlowMonthly: 60, verdict: 'thin' });
  const lightBrrrr = scoreStrategy({ strategy: 'brrrr', cashLeftIn: 5000, cashFlowMonthly: 350, verdict: 'thin' });
  assert.ok(lightBrrrr > heavyBrrrr);

  const thinWholesale = scoreStrategy({
    strategy: 'wholesale', viable: true, assignmentFee: 6000, buyerDiscountToArv: 0.1, verdict: 'thin',
  });
  const fatWholesale = scoreStrategy({
    strategy: 'wholesale', viable: true, assignmentFee: 24000, buyerDiscountToArv: 0.3, verdict: 'thin',
  });
  assert.ok(fatWholesale > thinWholesale);
});

test('signal strength decays with age and floors at 0.6', () => {
  assert.equal(recencyFactor(0), 1);
  assert.equal(recencyFactor(90), 1);
  assert.equal(recencyFactor(365), 0.6);
  assert.equal(recencyFactor(4000), 0.6);
  assert.ok(recencyFactor(200) < 1 && recencyFactor(200) > 0.6);
  assert.ok(recencyFactor(200) < recencyFactor(120));

  const fresh = signalStrength(row({ signals: [signal('FORECLOSURE', 1, '2026-09-01')] }), { now: NOW });
  const stale = signalStrength(row({ signals: [signal('FORECLOSURE', 1, '2025-01-01')] }), { now: NOW });
  assert.equal(fresh.strength, 100);
  assert.equal(Math.round(stale.strength), 60);
});

test('signal age is whole UTC days and never negative', () => {
  assert.equal(signalAgeDays('2026-08-12', NOW), 29);
  assert.equal(signalAgeDays('2026-09-10', NOW), 0);
  assert.equal(signalAgeDays('2026-12-01', NOW), 0);
  assert.equal(signalAgeDays('not-a-date', NOW), null);
});

test('stacked signals add 8 each and stop at +16', () => {
  // Same primary signal in every case (first DISTRESS wins the rank tie), so
  // the only thing moving between them is the stacking bonus.
  const extra = (n) => Array.from({ length: n }, (_, i) => signal('DISTRESS', 0.4 - i * 0.05, '2026-09-01'));
  const strengthWith = (n) => signalStrength(
    row({ signals: [signal('DISTRESS', 0.5, '2026-09-01'), ...extra(n)] }),
    { now: NOW },
  ).strength;

  const one = strengthWith(0);
  assert.equal(one, 0.65 * 0.5 * 100);
  assert.equal(strengthWith(1) - one, 8);
  assert.equal(strengthWith(2) - one, 16);
  assert.equal(strengthWith(3) - one, 16);
  assert.equal(strengthWith(6) - one, 16);
});

test('equity score saturates at 45% and clamps at both ends', () => {
  assert.equal(equityScore({ estimatedEquityPct: 0 }), 0);
  assert.equal(equityScore({ estimatedEquityPct: 0.45 }), 100);
  assert.equal(equityScore({ estimatedEquityPct: 0.9 }), 100);
  assert.equal(equityScore({ estimatedEquityPct: -1 }), 0);
  assert.equal(equityScore({}), 0);
});

test('composite stays an integer inside 0..100 for every mock row', () => {
  for (const property of ATLANTA_DECATUR_PROPERTIES) {
    const { composite } = scoreProperty(property, { now: NOW });
    assert.ok(Number.isInteger(composite), `${property.id} composite ${composite}`);
    assert.ok(composite >= 0 && composite <= 100, `${property.id} composite ${composite}`);
  }
});

test('composite rewards a house that works more than one way', () => {
  const base = row();
  const scored = scoreProperty(base, { now: NOW });
  const supporting = STRATEGY_KEYS
    .filter((key) => key !== scored.bestStrategy)
    .filter((key) => scored.analyses[key].verdict !== 'pass').length;
  const blended = 0.55 * scored.bestScore + 0.25 * scored.signalStrength + 0.20 * scored.equityScore;
  assert.equal(scored.composite, Math.round(blended + Math.min(6, supporting * 2)));
});

test('discount to value comes from the contract price, not a typed field', () => {
  const scored = scoreProperty(ROW, { now: NOW });
  assert.equal(
    Math.round(scored.discountToValue * 100),
    Math.round((1 - ROW.deal.purchase / ROW.estimatedValue) * 100),
  );
});

test('drivers read as plain sentences a human can check', () => {
  const { drivers } = scoreProperty(ROW, { now: NOW });
  assert.ok(drivers.length >= 4);
  assert.ok(drivers.every((line) => typeof line === 'string' && line.length > 0));
  assert.match(drivers[0], /FORECLOSURE 91%, filed 29 days ago/);
  assert.match(drivers[1], /^Auction Oct 6 — 26 days$/);
  assert.match(drivers[2], /41% owner equity, entry 41% under value/);
  assert.match(drivers[3], /^FLIP strong — \$\d+k profit$/);
});

test('a signal with no sale date contributes no auction driver', () => {
  const { drivers, auction } = scoreProperty(
    row({ signals: [signal('DISTRESS', 0.8, '2026-09-01')] }),
    { now: NOW },
  );
  assert.equal(auction, null);
  assert.equal(drivers.some((line) => line.startsWith('Auction ')), false);
});

test('a foreclosure notice derives its own first-Tuesday sale', () => {
  const scored = scoreProperty(ROW, { now: NOW });
  assert.equal(scored.auction.date.toISOString().slice(0, 10), '2026-10-06');
  assert.equal(scored.auction.daysUntil, 26);
  assert.equal(scored.auction.county, 'DeKalb');
  assert.equal(scored.auction.legalOrgan, 'The Champion');
  assert.equal(scored.auction.courthouse, 'DeKalb County Courthouse, Decatur');
  assert.equal(scored.taxDeed, null);
});

test('a tax sale carries the redeemable-deed caveat, nothing else does', () => {
  const taxRow = row({
    county: 'fulton',
    signals: [signal('TAX_SALE', 0.85, '2026-08-20')],
  });
  const scored = scoreProperty(taxRow, { now: NOW });
  assert.deepEqual(scored.taxDeed, { redemptionMonths: 12, premiumRate: 0.20 });
  assert.equal(scored.auction.county, 'Fulton');
  assert.equal(scored.auction.date.toISOString().slice(0, 10), '2026-10-06');

  assert.equal(taxDeedFor({ type: 'TAX_SALE' }).redemptionMonths, 12);
  assert.equal(taxDeedFor({ type: 'FORECLOSURE' }), null);
  assert.equal(taxDeedFor(null), null);
});

test('a sale inside 45 days adds five points of urgency, and only then', () => {
  const near = signalStrength(row({ signals: [signal('FORECLOSURE', 0.5, '2026-08-12')] }), { now: NOW });
  const far = signalStrength(row({ signals: [signal('FORECLOSURE', 0.5, '2026-09-09')] }), { now: NOW });
  assert.equal(near.auction.daysUntil, 26);
  assert.equal(far.auction.daysUntil, 54);
  // Same type, same confidence, same freshness band — only the sale date moves.
  assert.equal(near.strength - far.strength, 5);

  // A delinquency has no sale date, so it can never collect the bonus.
  const delinquent = signalStrength(row({ signals: [signal('PREFORECLOSURE', 0.5, '2026-08-12')] }), { now: NOW });
  assert.equal(delinquent.auction, null);
  assert.equal(delinquent.strength, 0.80 * 0.5 * 100);

  // A sale already held is a closed door, not an urgent one: age decay only.
  const past = signalStrength(row({ signals: [signal('FORECLOSURE', 0.5, '2026-01-05')] }), { now: NOW });
  assert.ok(past.auction.daysUntil < 0);
  assert.equal(past.strength, 1.0 * 0.5 * 100 * recencyFactor(past.ageDays));
});

test('auctionFor refuses to guess without a county or a parsable date', () => {
  const fixture = row();
  const primary = fixture.signals[0];
  assert.ok(auctionFor(fixture, primary, { now: NOW }));
  assert.equal(auctionFor({ ...fixture, county: 'cobb' }, primary, { now: NOW }), null);
  assert.equal(auctionFor(fixture, { ...primary, effectiveDate: 'soon' }, { now: NOW }), null);
  assert.equal(auctionFor(fixture, null, { now: NOW }), null);
});

test('enrichProperty returns a new frozen row and never touches the input', () => {
  const input = row();
  const before = JSON.parse(JSON.stringify(input));
  const enriched = enrichProperty(input, { now: NOW });

  assert.notEqual(enriched, input);
  assert.equal(Object.isFrozen(enriched), true);
  assert.deepEqual(JSON.parse(JSON.stringify(input)), before);
  assert.equal(Object.hasOwn(input, 'opportunityScore'), false);
  assert.equal(Object.hasOwn(input, 'composite'), false);

  assert.deepEqual(Object.keys(enriched.opportunityScore).sort(), [...STRATEGY_KEYS].sort());
  assert.equal(enriched.address, input.address);
  assert.equal(typeof enriched.composite, 'number');
  assert.ok(STRATEGY_KEYS.includes(enriched.bestStrategy));
  assert.ok(Array.isArray(enriched.drivers));
});

test('derived scores match a hand-run of the calculators', () => {
  const enriched = enrichProperty(ROW, { now: NOW });
  for (const key of STRATEGY_KEYS) {
    const analysis = analyzePropertyDeal(ROW, key);
    assert.equal(enriched.opportunityScore[key], scoreStrategy(analysis), key);
    assert.equal(enriched.analyses[key].verdict, analysis.verdict, key);
  }
});
