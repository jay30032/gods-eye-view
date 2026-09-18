/**
 * The fictional-address rule, pinned.
 *
 *   **A mock signal is never attached to a real site address.**
 *
 * Every row here is invented and every signal on it is fiction. The footprint
 * and lot line under it are real — that is what makes the demo read as a demo
 * of something — so the one thing that must never line up is the *name*. A row
 * that stands on a real building and also calls itself by that building's
 * address has stopped illustrating a foreclosure and started alleging one.
 *
 * `fetch-parcels.mjs` enforces this when it writes, but a fetcher only runs by
 * hand. This is the standing check: it re-derives the comparison from the data
 * on disk every `npm test`, so editing an authored address to a real one is
 * caught whether or not anybody re-runs a script.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { ATLANTA_DECATUR_PROPERTIES } from './atlantaDecatur.js';
import { SIX_HOUSE_PROPERTIES } from './sixHouse.js';
import { ATLANTA_DECATUR_GEOMETRY } from './atlantaDecaturGeometry.js';
import { SIX_HOUSE_GEOMETRY } from './sixHouseGeometry.js';
import { addressKey, sameStreetAddress } from './siteAddress.js';

const DATASETS = [
  ['atlanta', ATLANTA_DECATUR_PROPERTIES, ATLANTA_DECATUR_GEOMETRY],
  ['six', SIX_HOUSE_PROPERTIES, SIX_HOUSE_GEOMETRY],
];

test('no mock row is named after the real parcel it stands on', () => {
  let compared = 0;
  for (const [dataset, rows, geometry] of DATASETS) {
    for (const row of rows) {
      const siteAddress = geometry[row.id]?.parcel?.siteAddress;
      if (!siteAddress) continue; // no surveyed parcel, nothing to compare
      compared += 1;
      assert.equal(
        sameStreetAddress(row.address, siteAddress),
        false,
        `${dataset} ${row.id}: authored "${row.address}" is the county's own address `
        + `for the parcel this row stands on ("${siteAddress}"). A mock signal is never `
        + 'attached to a real site address — re-author it.',
      );
    }
  }
  // A rule that silently compared nothing would pass forever.
  assert.ok(compared >= 30, `only ${compared} rows had a site address to check against`);
});

test('every authored address parses, or the rule cannot see it', () => {
  // A row whose address cannot be parsed would be skipped by
  // `sameStreetAddress`, which returns false for an unparseable side. That is a
  // silent exemption from the rule, so it is failed here instead.
  for (const [dataset, rows] of DATASETS) {
    for (const row of rows) {
      assert.ok(
        addressKey(row.address),
        `${dataset} ${row.id}: "${row.address}" does not parse to a number and street`,
      );
    }
  }
});

test('every stored site address parses too', () => {
  for (const [dataset, , geometry] of DATASETS) {
    for (const [id, record] of Object.entries(geometry)) {
      const siteAddress = record?.parcel?.siteAddress;
      if (!siteAddress) continue;
      assert.ok(addressKey(siteAddress), `${dataset} ${id}: county address "${siteAddress}" does not parse`);
    }
  }
});

test('the comparison survives the two formats actually in play', () => {
  // Authored rows abbreviate; the counties spell out and punctuate differently.
  assert.equal(sameStreetAddress('915 Mead Rd, Decatur, GA 30030', '915 Mead Road Decatur, GA 30030'), true);
  assert.equal(sameStreetAddress('87 Waddell St NE, Atlanta, GA 30307', '87 WADDELL STREET NORTHEAST'), true);
  assert.equal(sameStreetAddress('621 Third Ave, Decatur, GA 30030', '621  THIRD AVE.  DECATUR, GA'), true);
  // "East Point" is a city, not a quadrant on Main Street.
  assert.equal(
    sameStreetAddress('2799 Main St, East Point, GA 30344', '2799 MAIN STREET EAST POINT, GA 30344'),
    true,
  );
});

test('different houses stay different, including on the same street', () => {
  assert.equal(sameStreetAddress('915 Mead Rd, Decatur, GA 30030', '1305 Oakview Road Decatur, GA 30030'), false);
  // The dangerous near-miss: same street, two door numbers apart.
  assert.equal(sameStreetAddress('1187 Oakview Rd, Decatur, GA 30030', '1344 Oakview Rd, Decatur, GA 30030'), false);
  assert.equal(sameStreetAddress('1187 Oakview Rd, Decatur, GA 30030', '1189 Oakview Rd, Decatur, GA 30030'), false);
});

test('an unparseable side is never reported as a match', () => {
  for (const bad of ['', null, undefined, 'Decatur, GA', 'Oakview Road']) {
    assert.equal(sameStreetAddress(bad, '915 Mead Rd'), false, JSON.stringify(bad));
    assert.equal(sameStreetAddress('915 Mead Rd', bad), false, JSON.stringify(bad));
  }
});

test('no owner identity is stored anywhere, site address or not', () => {
  // The site address is the ONE county field kept beyond geometry, and it is
  // kept so this rule can be checked. Owner name and mailing address are not.
  const banned = /owner|mailing|pstladdress|ownernme|assess|taxpayer/i;
  for (const [dataset, , geometry] of DATASETS) {
    for (const [id, record] of Object.entries(geometry)) {
      for (const key of Object.keys(record?.parcel || {})) {
        assert.equal(banned.test(key), false, `${dataset} ${id} stores parcel.${key}`);
      }
    }
  }
});
