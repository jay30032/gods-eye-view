/**
 * Surgical edits to a generated geometry file.
 *
 * Three scripts write `mock/*Geometry.js` and two of them edit fields in a file
 * they did not generate. That string surgery has now produced two silent bugs
 * in a row, and "silent" is the operative word — neither threw, neither failed
 * a test, and the headed check passed through both:
 *
 *   1. `fetch-parcels.mjs` kept everything *before* `parcel:` and appended the
 *      entry's closing brace, which was right until `fetch-streets.mjs` started
 *      writing `street` after it. The next parcel run deleted 29 street bearings
 *      from one file and all 6 from the other. The globe simply fell back to the
 *      long-wall convention and looked fine.
 *   2. The field span included the trailing comma, so lifting a block out and
 *      writing it back produced `}),,` — a syntax error in a generated file that
 *      nothing notices until the next import.
 *
 * Hence this. The fixtures are the generator's exact formatting, and the tests
 * that matter are the round trips: edit one field, and every other field of
 * every entry must come back byte for byte.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  entryTextOf,
  fieldBlockOf,
  fieldSpan,
  replaceFieldBlock,
} from './geometryFile.mjs';

/** Exactly the shape `renderGeometryFile` emits, including indentation. */
const FILE = `/** header */

export const FIXTURE_GEOMETRY = Object.freeze({
  'ROW-001': Object.freeze({
    id: 'ROW-001',
    centroid: Object.freeze({ lat: 33.75, lng: -84.3 }),
    shiftM: 1.5,
    building: Object.freeze({
      source: 'osm',
      osmId: 'way/1',
      footprint: Object.freeze([
        Object.freeze([
          [-84.3, 33.75],
          [-84.31, 33.76],
        ]),
      ]),
    }),
    parcel: Object.freeze({
      source: 'synthetic',
      areaM2: 1416.4,
      ring: Object.freeze([
        [-84.3, 33.75],
      ]),
    }),
    street: Object.freeze({
      source: 'osm',
      name: "Maxwell Street",
      bearingDeg: 180,
    }),
  }),
  'ROW-002': Object.freeze({
    id: 'ROW-002',
    centroid: null,
    shiftM: null,
    building: Object.freeze({
      source: 'osm',
      osmId: null,
      footprint: null,
    }),
    parcel: null,
  }),
});
`;

test('an entry is found by id and bounded at its own closing brace', () => {
  const first = entryTextOf(FILE, 'ROW-001');
  assert.ok(first);
  assert.ok(first.text.startsWith("  'ROW-001': Object.freeze({\n"));
  assert.ok(first.text.endsWith('\n  }),\n'));
  // It stops at its own entry, not at the next one or at the file's end.
  assert.equal(first.text.includes('ROW-002'), false);

  assert.equal(entryTextOf(FILE, 'ROW-404'), null);
});

test('a field span stops before the trailing comma, never after it', () => {
  const entry = entryTextOf(FILE, 'ROW-001').text;
  const span = fieldSpan(entry, 'parcel');
  assert.ok(span);
  // The character AT `to` is the comma — that is the contract callers rely on.
  assert.equal(entry[span.to], ',');
  const block = entry.slice(span.from + '\n    parcel: '.length, span.to);
  assert.ok(block.startsWith('Object.freeze({'));
  assert.ok(block.endsWith('})'), `block ended with ${JSON.stringify(block.slice(-4))}`);
  assert.equal(block.endsWith('}),'), false, 'the comma must not be inside the block');
});

test('a null field is spanned too', () => {
  const entry = entryTextOf(FILE, 'ROW-002').text;
  const span = fieldSpan(entry, 'parcel');
  assert.ok(span);
  assert.equal(entry[span.to], ',');
  assert.equal(fieldBlockOf(FILE, 'ROW-002', 'parcel'), 'null');
});

test('nested closing braces never end the span early', () => {
  // `building` contains `      }),` and `      ]),` at six spaces. Only the
  // four-space `    }),` closes the field.
  const block = fieldBlockOf(FILE, 'ROW-001', 'building');
  assert.ok(block.includes('footprint: Object.freeze(['));
  assert.ok(block.endsWith('})'));
  // The span must not have run on into `parcel`.
  assert.equal(block.includes('areaM2'), false);
});

test('replacing a field leaves every other field untouched — the street bug', () => {
  // This is the one that actually happened: `parcel` is edited and `street`,
  // which follows it, has to survive.
  const next = replaceFieldBlock(FILE, 'ROW-001', 'parcel', "Object.freeze({\n      source: 'dekalb-gis',\n    })");
  assert.equal(next.ok, true);
  assert.ok(next.source.includes("source: 'dekalb-gis'"));
  assert.ok(next.source.includes('street: Object.freeze('), 'the street block was deleted');
  assert.ok(next.source.includes('"Maxwell Street"'));
  assert.ok(next.source.includes('bearingDeg: 180'));
  // And the row before/after it is intact.
  assert.ok(next.source.includes("'ROW-002': Object.freeze({"));
  assert.ok(next.source.includes("osmId: 'way/1'"));
});

test('a replaced field never doubles or drops its comma — the `}),,` bug', () => {
  const next = replaceFieldBlock(FILE, 'ROW-001', 'parcel', 'null');
  assert.equal(next.ok, true);
  assert.equal(next.source.includes('),,'), false, 'produced a double comma');
  assert.equal(next.source.includes(',,'), false);
  assert.ok(next.source.includes('\n    parcel: null,\n    street: Object.freeze('));
});

test('a lifted block can be written straight back, unchanged', () => {
  // The round trip the restore path depends on.
  const block = fieldBlockOf(FILE, 'ROW-001', 'street');
  const next = replaceFieldBlock(FILE, 'ROW-001', 'street', block);
  assert.equal(next.ok, true);
  assert.equal(next.source, FILE, 'a no-op edit changed the file');
});

test('a missing field is refused unless insertion was asked for', () => {
  const refused = replaceFieldBlock(FILE, 'ROW-002', 'street', 'null');
  assert.equal(refused.ok, false);
  assert.match(refused.reason, /no street field/);

  const inserted = replaceFieldBlock(FILE, 'ROW-002', 'street', 'null', { insertIfMissing: true });
  assert.equal(inserted.ok, true);
  assert.ok(inserted.source.includes("'ROW-002': Object.freeze({"));
  assert.ok(inserted.source.includes('\n    street: null,\n  }),'));
  // ROW-001 is untouched by an edit to ROW-002.
  assert.ok(inserted.source.includes('"Maxwell Street"'));
});

test('an unknown id changes nothing', () => {
  const outcome = replaceFieldBlock(FILE, 'ROW-404', 'parcel', 'null');
  assert.equal(outcome.ok, false);
  assert.equal(outcome.source, FILE);
});

test('the result still parses as the module it is meant to be', async () => {
  // The cheapest possible guard against emitting something Node cannot import.
  const next = replaceFieldBlock(
    FILE, 'ROW-001', 'parcel',
    "Object.freeze({\n      source: 'dekalb-gis',\n      siteAddress: \"1305 Oakview Road\",\n    })",
  );
  const encoded = `data:text/javascript;base64,${Buffer.from(next.source).toString('base64')}`;
  const module = await import(encoded);
  const row = module.FIXTURE_GEOMETRY['ROW-001'];
  assert.equal(row.parcel.source, 'dekalb-gis');
  assert.equal(row.parcel.siteAddress, '1305 Oakview Road');
  assert.equal(row.street.bearingDeg, 180, 'the street survived a parcel edit');
  assert.equal(module.FIXTURE_GEOMETRY['ROW-002'].parcel, null);
});
