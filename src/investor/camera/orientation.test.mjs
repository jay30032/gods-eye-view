/**
 * Which way round a house is, and what heading looks at a given side.
 *
 * The fixtures are deliberately hand-built rectangles rather than real
 * footprints: a 20 x 10 m box whose long wall runs east-west has an
 * unarguable front, back, left and right, so a failure here is a bug in the
 * derivation and never an argument about what some OSM mapper drew.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  COMPASS,
  MAX_RANGE_M,
  MIN_PITCH_DEG,
  MIN_RANGE_M,
  MAX_PITCH_DEG,
  SIDES,
  angleBetweenDeg,
  frontNormalDeg,
  headingForCompass,
  headingForSide,
  longAxisBearingDeg,
  normalizeDeg,
  sideNormalDeg,
  stepPitchDeg,
  stepRangeM,
} from './orientation.js';

/** A rectangle `wide` m east-west by `deep` m north-south, centred on origin. */
function box(wide, deep, { lat = 33.7584, lng = -84.3074 } = {}) {
  const mPerLat = 111_320;
  const mPerLng = mPerLat * Math.cos(lat * (Math.PI / 180));
  const dx = wide / 2 / mPerLng;
  const dy = deep / 2 / mPerLat;
  return [
    [lng - dx, lat - dy],
    [lng + dx, lat - dy],
    [lng + dx, lat + dy],
    [lng - dx, lat + dy],
  ];
}

test('the long axis of a wide house runs east-west', () => {
  // 20 m across, 10 m deep: the long wall faces north and south.
  const axis = longAxisBearingDeg(box(20, 10));
  assert.ok(
    angleBetweenDeg(axis, 90) < 1,
    `expected an east-west axis, got ${axis}`,
  );
});

test('the front is the wall facing the street, not the longest wall', () => {
  const ring = box(20, 10);
  // Street to the south. The south wall is long AND nearest, so both readings
  // agree — this is the easy case and it must not be the only one that works.
  const south = frontNormalDeg(ring, 180);
  assert.equal(south.source, 'street');
  assert.ok(angleBetweenDeg(south.bearingDeg, 180) < 1, `got ${south.bearingDeg}`);

  // Street to the EAST. The east wall is the short one, and it is still the
  // front — which is the whole reason the street bearing is fetched at all.
  const east = frontNormalDeg(ring, 90);
  assert.equal(east.source, 'street');
  assert.ok(angleBetweenDeg(east.bearingDeg, 90) < 1, `got ${east.bearingDeg}`);
});

test('with no street the long-wall convention takes over and says so', () => {
  const answer = frontNormalDeg(box(20, 10), null);
  assert.equal(answer.source, 'long-axis');
  // Perpendicular to the long (east-west) axis: the front faces north or south.
  const offAxis = Math.min(
    angleBetweenDeg(answer.bearingDeg, 0),
    angleBetweenDeg(answer.bearingDeg, 180),
  );
  assert.ok(offAxis < 1, `expected a north/south frontage, got ${answer.bearingDeg}`);
});

test('a nonsense street bearing falls back rather than throwing', () => {
  for (const bad of [NaN, Infinity, null, undefined, 'north']) {
    const answer = frontNormalDeg(box(20, 10), bad);
    assert.equal(answer.source, 'long-axis', `bearing ${String(bad)}`);
  }
});

test('a degenerate ring has no front at all', () => {
  assert.equal(frontNormalDeg([], 90), null);
  assert.equal(frontNormalDeg([[0, 0], [1, 1]], 90), null);
  assert.equal(frontNormalDeg(null, 90), null);
});

test('back is opposite the front and the sides are square to it', () => {
  const front = 90; // the house faces east
  assert.equal(sideNormalDeg('front', front), 90);
  assert.equal(sideNormalDeg('back', front), 270);
  // Standing in the street looking west at the front, your left hand points
  // north — so the left wall faces north.
  assert.equal(sideNormalDeg('left', front), 180);
  assert.equal(sideNormalDeg('right', front), 0);
});

test('the camera heading for a side looks BACK at that wall', () => {
  // To see the wall facing east you stand to the east and look west.
  assert.equal(headingForSide('front', 90), 270);
  assert.equal(headingForSide('back', 90), 90);
  // Every side resolves to a heading, and no two adjacent sides share one.
  const headings = SIDES.map((side) => headingForSide(side, 33));
  assert.equal(new Set(headings).size, SIDES.length);
});

test('"from the north" stands in the north and looks south', () => {
  assert.equal(headingForCompass('north'), 180);
  assert.equal(headingForCompass('south'), 0);
  assert.equal(headingForCompass('east'), 270);
  assert.equal(headingForCompass('west'), 90);
  assert.equal(headingForCompass('southeast'), normalizeDeg(COMPASS.southeast + 180));
  assert.equal(headingForCompass('nonsense'), null);
});

test('range steps move decisively and clamp at both ends', () => {
  assert.ok(stepRangeM(150, 'closer') < 150);
  assert.ok(stepRangeM(150, 'farther') > 150);
  // Repeated presses stop at the rails rather than running to zero or orbit.
  let near = 150;
  for (let i = 0; i < 20; i += 1) near = stepRangeM(near, 'closer');
  assert.equal(near, MIN_RANGE_M);
  let far = 150;
  for (let i = 0; i < 20; i += 1) far = stepRangeM(far, 'farther');
  assert.equal(far, MAX_RANGE_M);
  // An unknown direction is a no-op, not a reset.
  assert.equal(stepRangeM(150, 'sideways'), 150);
});

test('height steps clamp so the camera never looks at the sky or straight down', () => {
  assert.ok(stepPitchDeg(45, 'higher') > 45);
  assert.ok(stepPitchDeg(45, 'lower') < 45);
  let up = 45;
  for (let i = 0; i < 20; i += 1) up = stepPitchDeg(up, 'higher');
  assert.equal(up, MAX_PITCH_DEG);
  let down = 45;
  for (let i = 0; i < 20; i += 1) down = stepPitchDeg(down, 'lower');
  assert.equal(down, MIN_PITCH_DEG);
  assert.equal(stepPitchDeg(45, 'sideways'), 45);
});

test('angles normalise and compare the short way round', () => {
  assert.equal(normalizeDeg(-90), 270);
  assert.equal(normalizeDeg(450), 90);
  assert.equal(angleBetweenDeg(350, 10), 20);
  assert.equal(angleBetweenDeg(10, 350), 20);
  assert.equal(angleBetweenDeg(0, 180), 180);
});
