import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AUCTION_SIGNAL_TYPES,
  COUNTIES,
  NOTICE_DAYS,
  NOTICE_WEEKS,
  TAX_DEED,
  auctionDateForNotice,
  countdownWords,
  daysUntil,
  firstTuesday,
  formatSaleDate,
  isAuctionSignal,
  nextSaleDate,
  resolveCounty,
  toUtcDay,
} from './georgia.js';

const NOW = '2026-09-10';
const iso = (date) => (date ? date.toISOString().slice(0, 10) : null);

test('the sale is the first Tuesday of the month', () => {
  assert.equal(iso(firstTuesday(2026, 8)), '2026-09-01');
  assert.equal(iso(firstTuesday(2026, 9)), '2026-10-06');
  assert.equal(iso(firstTuesday(2026, 10)), '2026-11-03');
  // Every result is a Tuesday unless a holiday moved it.
  for (let month = 0; month < 12; month += 1) {
    const sale = firstTuesday(2027, month);
    assert.equal(sale.getUTCDay(), 2, `${iso(sale)} should be a Tuesday`);
    assert.ok(sale.getUTCDate() <= 7);
  }
});

test('a sale Tuesday on New Year or the Fourth slides to the next day', () => {
  // Jan 1 2030 is a Tuesday.
  assert.equal(iso(firstTuesday(2030, 0)), '2030-01-02');
  // Jul 4 2028 is a Tuesday.
  assert.equal(iso(firstTuesday(2028, 6)), '2028-07-05');
  // A holiday that is not the first Tuesday changes nothing.
  assert.equal(iso(firstTuesday(2026, 0)), '2026-01-06');
  assert.equal(iso(firstTuesday(2026, 6)), '2026-07-07');
});

test('nextSaleDate is inclusive of a date that is already a sale day', () => {
  assert.equal(iso(nextSaleDate('2026-10-06')), '2026-10-06');
  assert.equal(iso(nextSaleDate('2026-10-07')), '2026-11-03');
  assert.equal(iso(nextSaleDate('2026-09-02')), '2026-10-06');
  assert.equal(iso(nextSaleDate('2026-12-02')), '2027-01-05');
  assert.equal(nextSaleDate('nope'), null);
});

test('four weekly publications must clear before the sale', () => {
  assert.equal(NOTICE_WEEKS, 4);
  assert.equal(NOTICE_DAYS, 28);

  assert.equal(iso(auctionDateForNotice('2026-08-12')), '2026-10-06');
  assert.equal(daysUntil(auctionDateForNotice('2026-08-12'), NOW), 26);
  assert.equal(iso(auctionDateForNotice('2026-09-08')), '2026-10-06');

  // One day later and the ad run no longer fits before Oct 6.
  assert.equal(iso(auctionDateForNotice('2026-09-09')), '2026-11-03');
  assert.equal(daysUntil(auctionDateForNotice('2026-09-09'), NOW), 54);
  assert.equal(auctionDateForNotice('not-a-date'), null);
});

test('daysUntil is whole days and goes negative once the sale has passed', () => {
  assert.equal(daysUntil('2026-10-06', NOW), 26);
  assert.equal(daysUntil('2026-09-10', NOW), 0);
  assert.equal(daysUntil('2026-09-11', NOW), 1);
  assert.equal(daysUntil('2026-09-01', NOW), -9);
  assert.equal(daysUntil('nope', NOW), null);
});

test('dates normalise to UTC midnight from any shape', () => {
  assert.equal(iso(toUtcDay('2026-09-10')), '2026-09-10');
  assert.equal(iso(toUtcDay(new Date('2026-09-10T23:59:59Z'))), '2026-09-10');
  assert.equal(iso(toUtcDay(Date.UTC(2026, 8, 10))), '2026-09-10');
  assert.equal(toUtcDay(null), null);
  assert.equal(toUtcDay('09/10/2026'), null);
});

test('counties carry their legal organ and their courthouse', () => {
  assert.deepEqual(Object.keys(COUNTIES).sort(), ['dekalb', 'fulton']);
  assert.equal(COUNTIES.dekalb.legalOrgan, 'The Champion');
  assert.equal(COUNTIES.fulton.legalOrgan, 'Fulton County Daily Report');
  assert.equal(COUNTIES.dekalb.courthouse, 'DeKalb County Courthouse, Decatur');
  assert.equal(COUNTIES.fulton.courthouse, 'Fulton County Courthouse, Atlanta');
  assert.equal(resolveCounty('DEKALB').name, 'DeKalb');
  assert.equal(resolveCounty('cobb'), null);
});

test('only a foreclosure or a tax sale lands on the courthouse calendar', () => {
  assert.deepEqual([...AUCTION_SIGNAL_TYPES], ['FORECLOSURE', 'TAX_SALE']);
  assert.equal(isAuctionSignal('FORECLOSURE'), true);
  assert.equal(isAuctionSignal('TAX_SALE'), true);
  // Georgia records no Notice of Default, so a delinquency has no sale date.
  assert.equal(isAuctionSignal('PREFORECLOSURE'), false);
  assert.equal(isAuctionSignal('DISTRESS'), false);
  assert.equal(isAuctionSignal('LISTED_OPPORTUNITY'), false);
});

test('a tax deed is redeemable for a year at a 20 percent premium', () => {
  assert.equal(TAX_DEED.redemptionMonths, 12);
  assert.equal(TAX_DEED.premiumRate, 0.20);
});

test('sale dates and countdowns read the way they are spoken', () => {
  assert.equal(formatSaleDate('2026-10-06'), 'Oct 6');
  assert.equal(formatSaleDate('2026-11-03'), 'Nov 3');
  assert.equal(formatSaleDate('bad'), null);
  assert.equal(countdownWords(26), '26 days');
  assert.equal(countdownWords(1), 'tomorrow');
  assert.equal(countdownWords(0), 'today');
  assert.equal(countdownWords(-3), 'passed 3 days ago');
  assert.equal(countdownWords(null), null);
});
