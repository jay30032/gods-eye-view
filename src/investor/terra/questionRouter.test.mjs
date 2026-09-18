import test from 'node:test';
import assert from 'node:assert/strict';
import { createMockPropertyProvider } from '../mock/provider.js';
import { compareFacts, propertyFacts, rankFacts } from './facts.js';
import { RENTAL_ORDER, fieldAt, routeQuestion } from './questionRouter.js';

const rows = createMockPropertyProvider({ dataset: 'six' }).list();
const house = rows.find((r) => r.id === 'DEMO-SIX-001');
const facts = propertyFacts(house);
const ranked = rankFacts(rows);
const compared = compareFacts(house, rows[1], 'flip');

/** Forty investor questions → the tool that answers, and the fields it must carry. */
const TABLE = [
  ['what are the rental numbers', 'property_facts', RENTAL_ORDER],
  ['run it as a rental', 'property_facts', RENTAL_ORDER],
  ["what's the cap rate", 'property_facts', ['strategies.rental.capRatePct']],
  ['what is the DSCR', 'property_facts', ['strategies.rental.dscr']],
  ['how much cash flow does it make', 'property_facts', ['strategies.rental.cashFlowMonthly']],
  ["what's the NOI", 'property_facts', ['strategies.rental.noi']],
  ['what is the yield on cost', 'property_facts', ['strategies.rental.yieldOnCostPct']],
  ["what's the ARV", 'property_facts', ['strategies.flip.arv']],
  ['how much is the rehab', 'property_facts', ['strategies.flip.rehab', 'strategies.flip.contingency']],
  ['what does contingency add', 'property_facts', ['strategies.flip.rehabWithContingency']],
  ["what's the all-in", 'property_facts', ['strategies.flip.allIn']],
  ["what's the MAO", 'property_facts', ['strategies.wholesale.mao', 'strategies.flip.mao70']],
  ['what is the maximum allowable offer', 'property_facts', ['strategies.wholesale.mao']],
  ["what's the wholesale fee", 'property_facts', ['strategies.wholesale.assignmentFee']],
  ['how big is the spread', 'property_facts', ['strategies.wholesale.spread']],
  ['how much cash is left in on a BRRRR', 'property_facts', ['strategies.brrrr.cashLeftIn', 'strategies.brrrr.cashOut']],
  ["what's the refinance amount", 'property_facts', ['strategies.brrrr.refinanceAmount']],
  ['how much can I pull out on the refi', 'property_facts', ['strategies.brrrr.cashOut']],
  ["what's the down payment", 'property_facts', ['strategies.rental.downPayment']],
  ['what rate are you using', 'property_facts', ['assumptions.mortgageRatePct', 'assumptions.hardMoneyRatePct']],
  ["what's the mortgage rate", 'property_facts', ['assumptions.mortgageRatePct']],
  ['how much are the points', 'property_facts', ['strategies.flip.points']],
  ["what's the holding cost", 'property_facts', ['strategies.flip.carryingCost', 'strategies.flip.interest']],
  ['what are the closing costs', 'property_facts', ['strategies.flip.buyClosing', 'strategies.flip.sellClosing']],
  ["what's the annualized return", 'property_facts', ['strategies.flip.annualizedPct']],
  ["what's the margin", 'property_facts', ['strategies.flip.marginPct']],
  ['how much cash do I need', 'property_facts', ['strategies.flip.cashNeeded']],
  ["what's the profit on the flip", 'property_facts', ['strategies.flip.profit']],
  ["when's the auction", 'property_facts', ['signals.0.auction.date', 'signals.0.auction.daysUntil']],
  ['when was it filed', 'property_facts', ['signals.0.filed', 'signals.0.ageDays']],
  ['which county is it in', 'property_facts', ['county.name']],
  ['how big is the lot', 'property_facts', ['parcel.acres']],
  ['how much equity does the owner have', 'property_facts', ['ownerEquityPct']],
  ['how far under value is the entry', 'property_facts', ['entry.underValuePct', 'entry.discount']],
  ['why not wholesale', 'explain_strategy', ['verdict']],
  ['why is the rental thin', 'explain_strategy', ['verdict']],
  ['compare flip and rental', 'compare_strategies', ['best']],
  ['what if rent is 3000', 'what_if', ['facts.verdict']],
  ['what if I pay 200', 'what_if', ['facts.verdict']],
  ['compare with the last one', 'compare_properties', ['a.profit', 'b.profit', 'aMinusB.profit']],
  ['which ranks second and why', 'rank_shortlist', ['0.rank', '0.parts.bestPlayScore', '0.drivers']],
];

test('forty investor questions route to the tool that answers them', () => {
  assert.equal(TABLE.length, 41);
  for (const [question, tool, fields] of TABLE) {
    const route = routeQuestion(question);
    assert.equal(route.tool, tool, `${question} → ${route.tool}`);
    for (const field of fields) {
      assert.ok(route.fields.includes(field), `${question}: route lacks ${field} (has ${route.fields.join(', ')})`);
    }
  }
});

test('every field the router names exists on the fixture facts, ranking or comparison', () => {
  for (const [question] of TABLE) {
    const route = routeQuestion(question);
    if (!['property_facts', 'rank_shortlist', 'compare_properties'].includes(route.tool)) continue;
    const source = route.tool === 'property_facts' ? facts : (route.tool === 'rank_shortlist' ? ranked : compared);
    for (const field of route.fields) {
      const value = fieldAt(source, field);
      assert.ok(value !== undefined && value !== null, `${question}: ${field} is ${value}`);
    }
  }
});

test('rental questions carry cash flow, cash-on-cash, cap rate and DSCR in that order', () => {
  assert.deepEqual(routeQuestion('what are the rental numbers').fields, [...RENTAL_ORDER]);
  assert.deepEqual(RENTAL_ORDER.map((f) => fieldAt(facts, f)), [532.77, 6.16, 8.67, 1.45]);
});

test('strategy words and what-if text survive the route', () => {
  assert.equal(routeQuestion('what if rent is 3000').args.text, 'what if rent is 3000');
  assert.equal(routeQuestion('why not wholesale').strategy, 'wholesale');
  assert.equal(routeQuestion('compare the flip with the last one').strategy, 'flip');
  assert.equal(routeQuestion('cash left in on a burr').strategy, 'brrrr');
  assert.equal(routeQuestion('save it').tool, 'investor_command');
});
