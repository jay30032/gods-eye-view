import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ATLANTA_DECATUR_PROPERTIES } from './atlantaDecatur.js';
import { createMockPropertyProvider } from './provider.js';
import { validateProperty, SIGNAL_TYPES } from './schema.js';
import { STRATEGY_KEYS } from '../scoring.js';
import { COUNTIES, isAuctionSignal } from '../georgia.js';
import { findMoney, searchMockProperties } from './search.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = join(HERE, '..', '..');
const DATASET = join(HERE, 'atlantaDecatur.js');
const NOW = Date.UTC(2026, 8, 10);

// Built from parts so this file is not its own counter-example.
const RANK_LABEL = ['TOP', 'PICK'].join('_');

function sourceFiles(dir, found = []) {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) sourceFiles(full, found);
    else if (/\.(js|mjs)$/.test(entry)) found.push(full);
  }
  return found;
}

test('Atlanta mock inventory has at least 25 valid DEMO/MOCK properties', () => {
  assert.ok(ATLANTA_DECATUR_PROPERTIES.length >= 25);
  for (const property of ATLANTA_DECATUR_PROPERTIES) {
    assert.deepEqual(validateProperty(property), [], property.id);
    assert.match(property.id, /^(DEMO|MOCK)-/);
    assert.ok(property.signals.every((signal) => SIGNAL_TYPES.includes(signal.type)));
    assert.ok(property.deal.purchase > 0);
  }
});

test('no authored row carries a score, a why, or a ranking label', () => {
  for (const property of ATLANTA_DECATUR_PROPERTIES) {
    assert.equal(Object.hasOwn(property, 'opportunityScore'), false, property.id);
    assert.equal(Object.hasOwn(property, 'composite'), false, property.id);
    assert.equal(Object.hasOwn(property, 'why'), false, property.id);
    assert.ok(property.signals.every((signal) => signal.type !== RANK_LABEL), property.id);
  }
});

test('the validator rejects a row that types its own score, why, or ranking label', () => {
  const base = ATLANTA_DECATUR_PROPERTIES[0];
  assert.ok(validateProperty({ ...base, opportunityScore: { flip: 92 } }).some((e) => /opportunityScore/.test(e)));
  assert.ok(validateProperty({ ...base, why: 'hand-written' }).some((e) => /why/.test(e)));
  assert.ok(validateProperty({ ...base, composite: 99 }).some((e) => /composite/.test(e)));
  const labelled = { ...base, signals: [{ type: RANK_LABEL, confidence: 0.9, effectiveDate: '2026-08-12', source: 'MOCK/ranker' }] };
  assert.ok(validateProperty(labelled).some((e) => /signals\[0\]\.type/.test(e)));
});

test('every row names the county whose courthouse it would sell on', () => {
  for (const property of ATLANTA_DECATUR_PROPERTIES) {
    assert.ok(Object.hasOwn(COUNTIES, property.county), `${property.id} county ${property.county}`);
  }
  const counties = ATLANTA_DECATUR_PROPERTIES.map((row) => row.county);
  assert.ok(counties.includes('dekalb') && counties.includes('fulton'));
});

test('notes are place and condition only — no strategy talk, no numbers', () => {
  // The note is local colour. Anything that sounds like underwriting belongs
  // in the generated Why, where it is derived and cannot go stale.
  const BANNED = /\b(flip|flips|flipping|spread|refi|refinance|wholesale|brrrr|rental|rentals|cash[- ]?flow|clears|works)\b|[$%]|\d+\s*(?:percent|k\b)/i;
  for (const property of ATLANTA_DECATUR_PROPERTIES) {
    assert.ok(property.note, `${property.id} has no note`);
    const hit = property.note.match(BANNED);
    assert.equal(hit, null, `${property.id} note says "${hit?.[0]}": ${property.note}`);
    assert.equal(property.note.trim().split(/(?<=\.)\s+/).length, 1, `${property.id} note is more than one sentence`);
  }
});

test('sources read like the feed they would actually come from', () => {
  const ORGAN = { dekalb: 'The Champion', fulton: 'Fulton County Daily Report' };
  const TAX = { dekalb: 'DeKalb', fulton: 'Fulton' };
  for (const property of ATLANTA_DECATUR_PROPERTIES) {
    for (const signal of property.signals) {
      const where = `${property.id} ${signal.type}`;
      assert.match(signal.source, /^MOCK\//, where);
      if (signal.type === 'FORECLOSURE') {
        assert.equal(signal.source, `MOCK/notice-of-sale — ${ORGAN[property.county]}`, where);
      } else if (signal.type === 'TAX_SALE') {
        assert.equal(signal.source, `MOCK/${TAX[property.county]} Tax Commissioner tax sale list`, where);
      } else if (signal.type === 'PREFORECLOSURE') {
        // Georgia records no Notice of Default, so this is a servicer feed.
        assert.equal(signal.source, 'MOCK/90-day delinquency — servicer feed', where);
      } else if (signal.type === 'LISTED_OPPORTUNITY') {
        assert.equal(signal.source, 'MOCK/FMLS listing under comps', where);
      } else {
        assert.match(
          signal.source,
          /^MOCK\/(code enforcement — (City of Atlanta|DeKalb County)|water shutoff — (Atlanta|DeKalb) Watershed)$/,
          where,
        );
      }
      assert.equal(signal.source.includes('lis-pendens'), false, where);
      assert.equal(signal.source.includes('mls-shadow'), false, where);
    }
  }
});

test('the board shows two different sale dates at the demo clock', () => {
  const rows = createMockPropertyProvider({ now: NOW }).list();
  const auctions = rows.filter((row) => row.auction);
  assert.ok(auctions.length >= 10);

  const dates = auctions.map((row) => row.auction.date.toISOString().slice(0, 10));
  assert.ok(dates.includes('2026-10-06'), 'no October sale on the board');
  assert.ok(dates.includes('2026-11-03'), 'no November sale on the board');

  for (const row of auctions) {
    const primary = row.signals.find((signal) => isAuctionSignal(signal.type));
    assert.ok(primary, `${row.id} has an auction with no auction signal`);
    assert.ok(row.auction.daysUntil > 0, `${row.id} sale already passed at the demo clock`);
    // Every sale is a Tuesday four weeks clear of its notice.
    assert.equal(row.auction.date.getUTCDay(), 2, row.id);
  }

  // Only foreclosures and tax sales get a date; nothing else invents one.
  for (const row of rows.filter((r) => !r.auction)) {
    assert.equal(row.signals.some((signal) => isAuctionSignal(signal.type)), false, row.id);
  }
});

test('a tax sale row carries the redeemable-deed caveat', () => {
  const rows = createMockPropertyProvider({ now: NOW }).list();
  for (const row of rows) {
    const primary = row.signals.find((signal) => isAuctionSignal(signal.type))
      || row.signals[0];
    if (primary?.type === 'TAX_SALE') {
      assert.deepEqual(row.taxDeed, { redemptionMonths: 12, premiumRate: 0.20 }, row.id);
    } else {
      assert.equal(row.taxDeed, null, row.id);
    }
  }
});

test('the validator refuses a row with no county', () => {
  const { county, ...orphan } = ATLANTA_DECATUR_PROPERTIES[0];
  assert.ok(validateProperty(orphan).includes('county'));
  assert.ok(validateProperty({ ...orphan, county: 'cobb' }).includes('county'));
});

test('the dataset source is free of derived fields', () => {
  const source = readFileSync(DATASET, 'utf8');
  assert.equal(source.includes('opportunityScore'), false);
  assert.equal(source.includes(RANK_LABEL), false);
  assert.equal(source.includes('why:'), false);
  assert.equal(source.includes('scores('), false);
  assert.ok(source.includes('note:'));
});

test('nothing in src/ still treats the gold pick as data', () => {
  const offenders = sourceFiles(SRC)
    .filter((file) => file !== fileURLToPath(import.meta.url))
    .filter((file) => readFileSync(file, 'utf8').includes(RANK_LABEL))
    .map((file) => file.slice(SRC.length + 1));
  assert.deepEqual(offenders, []);
});

test('every row enriches with derived scores and an enriched row fails validation', () => {
  const provider = createMockPropertyProvider({ now: NOW });
  const rows = provider.list();
  assert.equal(rows.length, ATLANTA_DECATUR_PROPERTIES.length);
  assert.equal(rows.length, 30);
  for (const row of rows) {
    assert.equal(Object.isFrozen(row), true, row.id);
    assert.ok(Number.isInteger(row.composite), row.id);
    assert.ok(STRATEGY_KEYS.includes(row.bestStrategy), row.id);
    assert.ok(Array.isArray(row.drivers) && row.drivers.length >= 3, row.id);
    for (const key of STRATEGY_KEYS) {
      assert.ok(Number.isInteger(row.opportunityScore[key]), `${row.id}.${key}`);
    }
    // Enrichment is deliberately not round-trippable into the dataset.
    assert.notDeepEqual(validateProperty(row), []);
  }
});

test('list() and getById hand back the same memoized rows', () => {
  const provider = createMockPropertyProvider({ now: NOW });
  const first = provider.list();
  const second = provider.list();
  assert.notEqual(first, second, 'the array is a copy');
  assert.equal(first[0], second[0], 'the rows are not re-scored per call');
  assert.equal(provider.getById('DEMO-ATL-001'), first.find((row) => row.id === 'DEMO-ATL-001'));
  assert.equal(provider.getById('nope'), null);
});

test('mock provider refuses a live property provider', () => {
  assert.throws(
    () => createMockPropertyProvider({ provider: 'attom' }),
    /mock only/,
  );
});

test('find money returns exactly four, best composite first', () => {
  const provider = createMockPropertyProvider({ now: NOW });
  const rows = provider.list();
  const hits = findMoney(rows);

  assert.equal(hits.length, 4);
  const highest = Math.max(...rows.map((row) => row.composite));
  assert.equal(hits[0].score, highest);
  assert.equal(hits[0].property.composite, highest);
  for (let i = 1; i < hits.length; i += 1) {
    assert.ok(hits[i - 1].score >= hits[i].score, 'shortlist is ranked by composite');
  }
  assert.equal(new Set(hits.map((row) => row.property.id)).size, 4);
  for (const hit of hits) {
    assert.ok(
      hit.score >= 70 || ['FORECLOSURE', 'TAX_SALE'].includes(hit.primary?.type),
      `${hit.property.id} qualified on neither score nor signal`,
    );
  }
});

test('search filters by neighborhood and signal', () => {
  const provider = createMockPropertyProvider({ now: NOW });
  const decatur = searchMockProperties(provider.list(), { query: 'oakhurst' });
  assert.ok(decatur.length >= 1);
  const fores = searchMockProperties(provider.list(), { signalType: 'FORECLOSURE' });
  assert.ok(fores.every((row) => row.property.signals.some((s) => s.type === 'FORECLOSURE')));
});

test('search ranks on the derived scores, not a typed field', () => {
  const provider = createMockPropertyProvider({ now: NOW });
  const rows = provider.list();
  const byFlip = searchMockProperties(rows, { strategy: 'flip', limit: 5 });
  assert.equal(byFlip[0].score, byFlip[0].property.opportunityScore.flip);
  assert.ok(byFlip[0].score >= byFlip[1].score);
  const byComposite = searchMockProperties(rows, { strategy: 'composite', limit: 5 });
  assert.equal(byComposite[0].score, byComposite[0].property.composite);
});
