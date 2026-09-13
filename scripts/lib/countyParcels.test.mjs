/**
 * Which county land classes count as residential.
 *
 * This is the rule that decides whether the globe outlines somebody's house or
 * a school, so it is pinned here rather than left to a comment. Only the pure
 * classification is tested — the HTTP half needs two county servers and belongs
 * to the hand-run fetchers, not to `npm test`.
 *
 * The fixtures are the codes actually observed. Sampling roughly a thousand
 * parcels around each market returned:
 *
 *   DeKalb (CLASSDSCRP)  R3 x941, E1 x48, C3 x32, E3, E2, R9, E6, E5, R4, C9
 *   Fulton (ClassCode)   R3 x1324, C3 x56, E1 x30, U3, I3, H3, C4, E2, R4
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { COUNTIES, isResidentialClass } from './countyParcels.mjs';

test('R is a house lot; C, E, I, U and H are not', () => {
  for (const code of ['R3', 'R4', 'R9', 'R1']) {
    assert.equal(isResidentialClass(code), true, code);
  }
  for (const code of ['C3', 'C4', 'C9', 'E1', 'E2', 'E3', 'E5', 'E6', 'I3', 'U2', 'U3', 'H3']) {
    assert.equal(isResidentialClass(code), false, code);
  }
});

test('E1 is refused — that is the code that was outlining Oakhurst Elementary', () => {
  // DEMO-SIX-004 matched a `building=yes` with no amenity tag and an ordinary
  // 240 m² footprint that turned out to be on the school's grounds. Nothing in
  // OSM distinguished it from a house; the county's E1 did.
  assert.equal(isResidentialClass('E1'), false);
  // And the house it was replaced with sits on R3.
  assert.equal(isResidentialClass('R3'), true);
});

test('an absent class is indeterminate, never a quiet yes or a quiet no', () => {
  // Three-valued on purpose. "The county says house", "the county says school"
  // and "the county did not answer" are three different facts: folding the
  // third into true re-admits the school the moment a server blinks, and
  // folding it into false drops every footprint in the market.
  for (const empty of [null, undefined, '', '   ']) {
    assert.equal(isResidentialClass(empty), null, JSON.stringify(empty));
  }
});

test('the class test ignores case and surrounding whitespace', () => {
  assert.equal(isResidentialClass('r3'), true);
  assert.equal(isResidentialClass('  R3  '), true);
  assert.equal(isResidentialClass(' e1 '), false);
});

test('both counties are configured with an id field and a class field', () => {
  assert.deepEqual(Object.keys(COUNTIES).sort(), ['dekalb', 'fulton']);
  for (const [name, config] of Object.entries(COUNTIES)) {
    assert.ok(config.url.startsWith('https://'), `${name} url`);
    assert.ok(config.url.endsWith('/query'), `${name} must point at a query endpoint`);
    assert.ok(config.idField, `${name} idField`);
    assert.ok(config.classField, `${name} classField`);
    assert.ok(config.attribution, `${name} attribution`);
    // The source string is what nearFieldEffects.js allow-lists before it will
    // draw a lot line at all; a rename here silently stops parcels rendering.
    assert.match(config.source, /^(dekalb|fulton)-gis$/, `${name} source`);
  }
});
