import test from 'node:test';
import assert from 'node:assert/strict';
import { parseNumber, scaleForField } from './numbers.js';

/** [text, value, kind] — kind is what the words themselves establish. */
const CASES = Object.freeze([
  // digits
  ['110', 110, 'plain'],
  ['195,000', 195000, 'plain'],
  ['1,250,000', 1250000, 'plain'],
  ['6.5', 6.5, 'plain'],
  ['0.75', 0.75, 'plain'],

  // explicit money
  ['$110', 110, 'money'],
  ['$195,000', 195000, 'money'],
  ['$2.5', 2.5, 'money'],

  // thousands suffixes
  ['20k', 20000, 'money'],
  ['20K', 20000, 'money'],
  ['15 k', 15000, 'money'],
  ['20 grand', 20000, 'money'],
  ['250 thousand', 250000, 'money'],
  ['$250k', 250000, 'money'],

  // millions suffixes
  ['2m', 2000000, 'money'],
  ['2.5M', 2500000, 'money'],
  ['2 mil', 2000000, 'money'],
  ['1 million', 1000000, 'money'],

  // word numbers
  ['twenty', 20, 'plain'],
  ['fifteen', 15, 'plain'],
  ['ninety nine', 99, 'plain'],
  ['twenty thousand', 20000, 'money'],
  ['twenty-five thousand', 25000, 'money'],
  ['two hundred fifty thousand', 250000, 'money'],
  ['twenty-five hundred', 2500, 'plain'],
  ['a hundred and ten', 110, 'plain'],
  ['one hundred ten', 110, 'plain'],
  ['half a million', 500000, 'money'],
  ['two million', 2000000, 'money'],
  ['ninety nine thousand', 99000, 'money'],
  ['a thousand', 1000, 'money'],

  // percents
  ['6.5 percent', 6.5, 'percent'],
  ['6.5%', 6.5, 'percent'],
  ['20 percent', 20, 'percent'],
  ['75%', 75, 'percent'],

  // embedded in real sentences
  ['what if i pay 110', 110, 'plain'],
  ['offer 195,000', 195000, 'plain'],
  ['assume rehab is twenty thousand higher', 20000, 'money'],
  ['rehab plus 15k', 15000, 'money'],
  ['hold 9 months', 9, 'plain'],
  ['find foreclosures under 250k in dekalb', 250000, 'money'],
  ['sell it for half a million', 500000, 'money'],
  ['rehab 20 percent higher', 20, 'percent'],
]);

test('every number form parses to the right value and kind', () => {
  const failures = [];
  for (const [text, value, kind] of CASES) {
    const parsed = parseNumber(text);
    if (!parsed) {
      failures.push(`${text} → null (want ${value})`);
      continue;
    }
    if (parsed.value !== value) failures.push(`${text} → ${parsed.value} (want ${value})`);
    if (parsed.kind !== kind) failures.push(`${text} → kind ${parsed.kind} (want ${kind})`);
  }
  assert.deepEqual(failures, []);
  assert.ok(CASES.length >= 25, `only ${CASES.length} cases`);
});

test('text with no number is not a number', () => {
  assert.equal(parseNumber('no numbers here'), null);
  assert.equal(parseNumber('save it'), null);
  assert.equal(parseNumber(''), null);
  assert.equal(parseNumber(null), null);
  assert.equal(parseNumber('   '), null);
});

test('the first number in the sentence is the one that was meant', () => {
  assert.equal(parseNumber('20k over the 15k budget').value, 20000);
  assert.equal(parseNumber('twenty thousand not 40k').value, 20000);
});

test('every parse carries the raw text it read', () => {
  assert.equal(parseNumber('rehab plus 15k').raw, '15k');
  assert.equal(parseNumber('assume rehab is twenty thousand higher').raw, 'twenty thousand');
});

test('money fields read a bare small number as thousands', () => {
  for (const field of ['purchase', 'offer', 'arv', 'value', 'rehab']) {
    assert.equal(scaleForField(field, 60), 60000, field);
    assert.equal(scaleForField(field, 110), 110000, field);
    assert.equal(scaleForField(field, 4999), 4999000, field);
    // Already a real price — leave it alone.
    assert.equal(scaleForField(field, 5000), 5000, field);
    assert.equal(scaleForField(field, 195000), 195000, field);
  }
});

test('rent scales at a much lower threshold than a purchase price', () => {
  assert.equal(scaleForField('rent', 2.8), 2800);
  assert.equal(scaleForField('rent', 99), 99000);
  // A real rent is left alone where a purchase price would have been scaled.
  assert.equal(scaleForField('rent', 2800), 2800);
  assert.equal(scaleForField('rent', 100), 100);
});

test('rate fields convert a percentage into a ratio', () => {
  for (const field of ['rate', 'ltv', 'downPayment']) {
    assert.equal(scaleForField(field, 6.5), 0.065, field);
    assert.equal(scaleForField(field, 75), 0.75, field);
    assert.equal(scaleForField(field, 100), 1, field);
    // Already a ratio — leave it alone.
    assert.equal(scaleForField(field, 0.75), 0.75, field);
    assert.equal(scaleForField(field, 1), 1, field);
  }
});

test('a hold is a whole number of months', () => {
  assert.equal(scaleForField('hold', 9), 9);
  assert.equal(scaleForField('hold', 9.4), 9);
  assert.equal(scaleForField('hold', 12.6), 13);
});

test('an unknown field is passed through untouched', () => {
  assert.equal(scaleForField('mystery', 42), 42);
  assert.ok(Number.isNaN(scaleForField('rehab', NaN)));
});
