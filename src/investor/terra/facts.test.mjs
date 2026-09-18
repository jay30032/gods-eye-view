import test from 'node:test';
import assert from 'node:assert/strict';
import { createMockPropertyProvider } from '../mock/provider.js';
import { analyzePropertyDeal } from '../deal/index.js';
import { compareFacts, pct, plainStrategy, propertyFacts, rankFacts, spokenFacts } from './facts.js';

const rows = createMockPropertyProvider({ dataset: 'six' }).list();
const house = rows.find((r) => r.id === 'DEMO-SIX-001');
const other = rows.find((r) => r.id === 'DEMO-SIX-003');

test('every line item of every strategy is carried, exactly as the calculators produce it', () => {
  const facts = propertyFacts(house);
  const flip = analyzePropertyDeal(house, 'flip');
  const rental = analyzePropertyDeal(house, 'rental');
  const brrrr = analyzePropertyDeal(house, 'brrrr');
  const wholesale = analyzePropertyDeal(house, 'wholesale');
  assert.equal(facts.strategies.flip.profit, flip.profit);
  assert.equal(facts.strategies.flip.cashNeeded, flip.cashIn);
  assert.equal(facts.strategies.flip.cashOnCashPct, pct(flip.roi));
  assert.equal(facts.strategies.flip.annualizedPct, pct(flip.roiAnnualized));
  assert.equal(facts.strategies.flip.marginPct, 23.26);
  assert.equal(facts.strategies.flip.mao70, flip.mao70);
  assert.equal(facts.strategies.flip.contingency, 3600);
  assert.equal(facts.strategies.flip.carryingCost, flip.carry);
  assert.equal(facts.strategies.flip.points + facts.strategies.flip.interest, flip.points + flip.interest);
  for (const key of ['grossRentAnnual', 'vacancy', 'management', 'maintenance', 'capex', 'propertyTaxes', 'insurance', 'noi',
    'downPayment', 'loan', 'monthlyPayment', 'cashFlowMonthly', 'cashInvested', 'dscr']) {
    assert.ok(typeof facts.strategies.rental[key] === 'number', key);
  }
  assert.equal(facts.strategies.rental.cashFlowMonthly, 532.77);
  assert.equal(facts.strategies.rental.capRatePct, 8.67);
  assert.equal(facts.strategies.rental.cashOnCashPct, 6.16);
  assert.equal(facts.strategies.rental.dscr, 1.45);
  assert.equal(Math.round(rental.dscr * 100) / 100, 1.45);
  assert.equal(facts.strategies.brrrr.refinanceAmount, brrrr.refinanceAmount);
  assert.equal(facts.strategies.brrrr.refiClosing, brrrr.refiClosing);
  assert.equal(facts.strategies.brrrr.cashLeftIn, 0);
  assert.equal(facts.strategies.brrrr.cashOut, 11932.8);
  assert.equal(facts.strategies.brrrr.dscr, Math.round(brrrr.dscr * 100) / 100);
  assert.equal(facts.strategies.wholesale.mao, 262800);
  assert.equal(facts.strategies.wholesale.spread, wholesale.spread);
  assert.equal(facts.strategies.wholesale.assignmentFee, wholesale.assignmentFee);
  assert.equal(facts.strategies.wholesale.buyerDiscountToArvPct, pct(wholesale.buyerDiscountToArv));
  assert.deepEqual(facts.verdicts, { flip: 'strong', rental: 'thin', brrrr: 'pass', wholesale: 'thin' });
});

test('assumptions, signals, county, lot, equity and entry are all there in plain labels', () => {
  const facts = propertyFacts(house);
  assert.equal(facts.assumptions.mortgageRatePct, 7);
  assert.equal(facts.assumptions.hardMoneyRatePct, 12);
  assert.equal(facts.assumptions.refiLtvPct, 75);
  assert.equal(facts.assumptions.flipHoldMonths, 6);
  assert.equal(facts.assumptions.vacancyPct, 5);
  assert.equal(facts.assumptions.verdictBars.rentalStrongDscr, 1.25);
  assert.equal(facts.signals[0].type, 'Notice of Sale Under Power');
  assert.equal(facts.signals[0].filed, '2026-08-05');
  assert.equal(facts.signals[0].ageDays, 36);
  assert.equal(facts.signals[0].confidencePct, 94);
  assert.equal(facts.signals[0].auction.daysUntil, 26);
  assert.equal(facts.signals[0].auction.date, 'Oct 6');
  assert.equal(facts.county.name, 'DeKalb');
  assert.equal(facts.county.legalOrgan, 'The Champion');
  assert.equal(facts.parcel.acres, 0.3535);
  assert.equal(facts.ownerEquityPct, 52);
  assert.equal(facts.entry.underValuePct, 44.91);
  assert.equal(facts.entry.discount, 194000);
  assert.equal(facts.estimatedValue, 432000);
  assert.equal(facts.bestPlay, 'flip');
  assert.equal(propertyFacts(null), null);
});

test('what-ifs flow through as overrides and are reported in use', () => {
  const facts = propertyFacts(house, { overrides: { dealOverrides: { rehab: 60000 } } });
  assert.equal(facts.strategies.flip.rehab, 60000);
  assert.equal(facts.strategies.flip.profit, 72192);
  assert.deepEqual(facts.overridesInUse.dealOverrides, { rehab: 60000 });
  const rent = propertyFacts(house, { overrides: { dealOverrides: { rent: 3000 } } });
  assert.equal(rent.strategies.rental.rentMonthly, 3000);
  assert.ok(rent.strategies.rental.cashFlowMonthly > 532.77);
  assert.equal(plainStrategy(null), null);
});

test('the ranking explains itself: composite, its parts, the drivers', () => {
  const ranked = rankFacts(rows);
  assert.equal(ranked[0].id, 'DEMO-SIX-001');
  assert.equal(ranked[0].rank, 1);
  assert.equal(ranked[1].id, 'DEMO-SIX-003');
  assert.ok(ranked.every((row, i, all) => i === 0 || row.composite <= all[i - 1].composite));
  assert.equal(ranked[0].parts.bestPlayWeightPct + ranked[0].parts.signalWeightPct + ranked[0].parts.equityWeightPct, 100);
  assert.ok(ranked[0].drivers.length >= 3);
  const shortlist = rankFacts(rows, ['DEMO-SIX-003', 'DEMO-SIX-001']);
  assert.deepEqual(shortlist.map((r) => r.id), ['DEMO-SIX-003', 'DEMO-SIX-001']);
});

test('two houses side by side on a strategy, with the differences', () => {
  const cmp = compareFacts(house, other, 'flip');
  assert.equal(cmp.strategy, 'flip');
  assert.equal(cmp.a.address, '621 Third Ave');
  assert.equal(cmp.b.address, '208 Winter Ave');
  assert.equal(cmp.aMinusB.profit, Math.round((cmp.a.profit - cmp.b.profit) * 100) / 100);
  assert.equal(compareFacts(house, other).strategy, 'flip');
  assert.equal(compareFacts(house, other, 'rental').a.cashFlowMonthly, 532.77);
  assert.equal(compareFacts(null, other), null);
});

test('the spoken form rounds money to the dollar and percentages to one decimal; the exact facts keep their cents', () => {
  const facts = propertyFacts(house);
  const said = spokenFacts(facts);
  assert.equal(said.strategies.rental.cashFlowMonthly, 533);
  assert.equal(facts.strategies.rental.cashFlowMonthly, 532.77);
  assert.equal(said.strategies.brrrr.cashOut, 11933);
  assert.equal(said.strategies.rental.capRatePct, 8.7);
  assert.equal(said.strategies.rental.cashOnCashPct, 6.2);
  assert.equal(said.strategies.rental.dscr, 1.45);
  assert.equal(said.entry.underValuePct, 44.9);
  assert.equal(said.parcel.acres, 0.3535);
  assert.equal(said.signals[0].auction.daysUntil, 26);
  assert.equal(said.strategies.wholesale.mao, 262800);
  assert.equal(said.assumptions.mortgageRatePct, 7);
  assert.equal(spokenFacts(null), null);
});
