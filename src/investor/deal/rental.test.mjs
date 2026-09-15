import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeRental } from './rental.js';
import { pmt } from './math.js';

const DEAL = Object.freeze({ purchase: 228000, rehab: 42000, arv: 385000, rent: 2650, units: 1 });

const near = (actual, expected, tol) => assert.ok(
  Math.abs(actual - expected) <= tol,
  `expected ${actual} within ${tol} of ${expected}`,
);
const money = (actual, expected) => near(actual, expected, 5);
const rate = (actual, expected) => near(actual, expected, 0.005);

test('rental operating model matches the underwriting fixture', () => {
  const r = analyzeRental(DEAL);
  assert.equal(r.strategy, 'rental');
  assert.equal(r.grossRent, 31800);     // 2650 x 12
  assert.equal(r.vacancy, 1590);        // 5%
  assert.equal(r.management, 2544);     // 8%
  assert.equal(r.maintenance, 1590);    // 5%
  assert.equal(r.capex, 1590);          // 5%
  assert.equal(r.taxes, 4235);          // 1.1% of ARV
  assert.equal(r.insurance, 1400);      // one door
  assert.equal(r.opex, 12949);
  money(r.noi, 18851);
  money(r.cashFlowMonthly, 433);
  rate(r.dscr, 1.38);
  assert.equal(r.verdict, 'thin');
});

test('NOI is gross rent less the six operating lines', () => {
  const r = analyzeRental(DEAL);
  const opex = r.vacancy + r.management + r.maintenance + r.capex + r.taxes + r.insurance;
  money(r.opex, opex);
  money(r.noi, r.grossRent - r.opex);
});

test('cap rate is on purchase, yield on cost carries the rehab', () => {
  const r = analyzeRental(DEAL);
  rate(r.capRate, r.noi / 228000);
  rate(r.yieldOnCost, r.noi / (228000 + 46200));
  assert.ok(r.yieldOnCost < r.capRate);
});

test('conventional financing drives debt service and cash needed', () => {
  const r = analyzeRental(DEAL);
  assert.equal(r.downPayment, 57000);            // 25%
  assert.equal(r.loan, 171000);
  assert.equal(r.buyClosing, 4560);              // 2%
  assert.equal(r.monthlyDebt, pmt(0.07, 30, 171000));
  assert.equal(r.cashInvested, 57000 + 46200 + 4560);
  money(r.cashFlowAnnual, r.cashFlowMonthly * 12);
  rate(r.coc, r.cashFlowAnnual / r.cashInvested);
  rate(r.dscr, r.noi / (r.monthlyDebt * 12));
});

test('a duplex doubles insurance and drops NOI by exactly one premium', () => {
  const single = analyzeRental(DEAL);
  const duplex = analyzeRental({ ...DEAL, units: 2 });
  assert.equal(single.units, 1);
  assert.equal(duplex.units, 2);
  assert.equal(single.insurance, 1400);
  assert.equal(duplex.insurance, 2800);
  money(duplex.noi, single.noi - 1400);
  assert.equal(duplex.taxes, single.taxes);      // taxes track ARV, not doors
});

test('units are inferred from property type when not given', () => {
  const { units: _drop, ...typed } = DEAL;
  assert.equal(analyzeRental({ ...typed, propertyType: 'duplex' }).units, 2);
  assert.equal(analyzeRental({ ...typed, propertyType: 'quad' }).units, 4);
  assert.equal(analyzeRental({ ...typed }).units, 1);
});

test('verdict is strong only when both CoC and DSCR clear the bar', () => {
  const r = analyzeRental(DEAL);
  assert.ok(r.dscr >= r.assumptions.rentalStrongDscr);
  assert.ok(r.coc < r.assumptions.rentalStrongCoc);
  assert.equal(r.verdict, 'thin');               // DSCR alone is not enough

  const strong = analyzeRental({ purchase: 150000, rehab: 20000, arv: 240000, rent: 2400, units: 1 });
  assert.ok(strong.coc >= strong.assumptions.rentalStrongCoc);
  assert.ok(strong.dscr >= strong.assumptions.rentalStrongDscr);
  assert.equal(strong.verdict, 'strong');

  const bleeding = analyzeRental({ purchase: 420000, rehab: 20000, arv: 460000, rent: 1900, units: 1 });
  assert.ok(bleeding.cashFlowMonthly < 0);
  assert.equal(bleeding.verdict, 'pass');
});

test('rental rejects non-finite inputs', () => {
  assert.throws(() => analyzeRental({ ...DEAL, rent: 'lots' }), /rent/);
  assert.throws(() => analyzeRental({ ...DEAL, arv: 'tbd' }), /arv/);
});
