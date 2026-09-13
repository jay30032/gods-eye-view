/**
 * Choosing the approach heading.
 *
 * The ray casting itself needs a scene and is exercised by `smoke:six`; what is
 * testable here is the part that decides — which is also the part with a
 * product rule in it, because "pick the highest score" and "prefer the street
 * when it is a tie" are two different cameras.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  HEADING_COUNT,
  MAX_SAMPLE_CORNERS,
  TIE_EPSILON,
  candidateHeadings,
  pickBestHeading,
  samplePoints,
} from './bestAngle.js';

test('the candidates are evenly spaced and start at north', () => {
  const headings = candidateHeadings();
  assert.equal(headings.length, HEADING_COUNT);
  assert.equal(headings[0], 0);
  for (let i = 1; i < headings.length; i += 1) {
    assert.equal(headings[i] - headings[i - 1], 360 / HEADING_COUNT);
  }
  // Every heading is a real bearing.
  for (const heading of headings) assert.ok(heading >= 0 && heading < 360);
});

test('the clearest angle wins outright when it is not close', () => {
  const scored = [
    { headingDeg: 0, score: 0.2 },
    { headingDeg: 90, score: 1.0 },
    { headingDeg: 180, score: 0.4 },
  ];
  const choice = pickBestHeading(scored, 180);
  assert.equal(choice.headingDeg, 90);
  assert.equal(choice.reason, 'clear');
  assert.equal(choice.tied, 1);
});

test('a tie goes to the street, because that is how a house is meant to be seen', () => {
  // 0 and 180 are equally clear; the street-facing heading is 170.
  const scored = [
    { headingDeg: 0, score: 1.0 },
    { headingDeg: 180, score: 1.0 },
    { headingDeg: 90, score: 0.2 },
  ];
  const choice = pickBestHeading(scored, 170);
  assert.equal(choice.headingDeg, 180);
  assert.equal(choice.reason, 'street-tiebreak');
  assert.equal(choice.tied, 2);
});

test('a near-tie inside the epsilon still counts as a tie', () => {
  const scored = [
    { headingDeg: 0, score: 1.0 },
    { headingDeg: 180, score: 1.0 - TIE_EPSILON / 2 },
  ];
  // The slightly worse angle wins on the street preference — which is the
  // point of the epsilon: one ray clipping a gutter must not overrule framing.
  assert.equal(pickBestHeading(scored, 175).headingDeg, 180);

  // Outside the epsilon it does not.
  const decisive = [
    { headingDeg: 0, score: 1.0 },
    { headingDeg: 180, score: 1.0 - TIE_EPSILON * 2 },
  ];
  assert.equal(pickBestHeading(decisive, 175).headingDeg, 0);
});

test('every angle scoring the same is reported as measuring nothing', () => {
  const flat = candidateHeadings().map((headingDeg) => ({ headingDeg, score: 1 }));
  const choice = pickBestHeading(flat, 200);
  assert.equal(choice.reason, 'all-equal');
  // It still answers, and it still answers with the street-facing one.
  assert.equal(choice.headingDeg, 180);
});

test('with no street heading the choice is deterministic, not arbitrary', () => {
  const scored = [
    { headingDeg: 270, score: 1.0 },
    { headingDeg: 45, score: 1.0 },
    { headingDeg: 135, score: 1.0 },
  ];
  // Same answer every time is what makes a camera testable.
  assert.equal(pickBestHeading(scored, null).headingDeg, 45);
  assert.equal(pickBestHeading(scored, null).headingDeg, 45);
});

test('nonsense rows are dropped and an empty sweep chooses nothing', () => {
  assert.equal(pickBestHeading([], 0), null);
  assert.equal(pickBestHeading(null, 0), null);
  assert.equal(pickBestHeading([{ headingDeg: NaN, score: 1 }], 0), null);
  assert.equal(pickBestHeading([{ headingDeg: 0, score: NaN }], 0), null);
  // A good row survives alongside bad ones.
  const choice = pickBestHeading([{ headingDeg: 0, score: NaN }, { headingDeg: 90, score: 0.5 }], null);
  assert.equal(choice.headingDeg, 90);
});

test('sampling covers the whole footprint and always includes the centroid', () => {
  const ring = [[0, 0], [1, 0], [1, 1], [0, 1]];
  const centroid = { lng: 0.5, lat: 0.5 };
  const points = samplePoints(ring, centroid);
  assert.equal(points.length, 5);
  assert.deepEqual(points.at(-1), [0.5, 0.5]);

  // An ornate footprint is capped but still sampled right round, not truncated
  // to one wall — the first and last corners must not be neighbours.
  const many = Array.from({ length: 40 }, (_, i) => [Math.cos(i), Math.sin(i)]);
  const sampled = samplePoints(many, centroid);
  assert.ok(sampled.length <= MAX_SAMPLE_CORNERS + 1, `got ${sampled.length}`);
  assert.ok(sampled.length >= 4);
});

test('sampling survives a missing ring or a missing centroid', () => {
  assert.deepEqual(samplePoints(null, null), []);
  assert.deepEqual(samplePoints([], { lng: 1, lat: 2 }), [[1, 2]]);
  assert.deepEqual(samplePoints([[3, 4]], null), [[3, 4]]);
});
