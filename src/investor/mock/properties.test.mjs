import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ATLANTA_DECATUR_PROPERTIES } from './atlantaDecatur.js';
import { createMockPropertyProvider } from './provider.js';
import { validateProperty, SIGNAL_TYPES } from './schema.js';
import { STRATEGY_KEYS } from '../scoring.js';
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
