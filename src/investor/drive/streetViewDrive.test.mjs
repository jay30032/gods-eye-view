/**
 * The pure rules of the Street View drive.
 *
 * Everything here is a product rule that has a number in it, and the point of
 * the test is the *reason* for the number rather than the number: a cadence
 * that survives a loop wrap and a seek, a fallback measured in metres of road
 * rather than in failed requests, and a POV that turns like a head rather than
 * like a compass needle.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  COVERAGE,
  COVERAGE_GAP_M,
  MARKER_RADIUS_M,
  PANO_RADIUS_M,
  PANO_STEP_M,
  POV_EASE_RADIUS_M,
  POV_MAX_OFF_TRAVEL_DEG,
  POV_RELEASE_M,
  STREET_VIEW_SPEED_MPS,
  initialCoverage,
  nextCoverage,
  panoDue,
  panoMarkersFor,
  povBlendFor,
  povHeadingFor,
} from './streetViewDrive.js';
import { deltaDeg } from './route.js';

const LOOP_M = 1360.2;

// ---------------------------------------------------------------------------
// Cadence
// ---------------------------------------------------------------------------

test('a panorama is due every 10 m of route progress and not before', () => {
  assert.equal(PANO_STEP_M, 10);
  assert.equal(panoDue(null, 0, { lengthM: LOOP_M }), true, 'the first fix is always due');
  assert.equal(panoDue(100, 105, { lengthM: LOOP_M }), false);
  assert.equal(panoDue(100, 109.99, { lengthM: LOOP_M }), false);
  assert.equal(panoDue(100, 110, { lengthM: LOOP_M }), true);
  assert.equal(panoDue(100, 400, { lengthM: LOOP_M }), true);
});

test('the cadence survives the loop wrap', () => {
  // Crossing the join, 1,355 m -> 5 m is 10.2 m of progress and not 1,350 m
  // backwards. A raw subtraction reads it as a lap in reverse, and at that
  // point the drive either stops asking for panoramas or asks on every fix.
  assert.equal(panoDue(1355, 0, { lengthM: LOOP_M }), false, '5.2 m is short of a step');
  assert.equal(panoDue(1355, 5, { lengthM: LOOP_M }), true, '10.2 m across the join is a step');
});

test('a seek backwards is due, not almost a lap ahead', () => {
  // "Keep going" after a detour seeks the source back to where the question was
  // asked. Read as a forward-only wrap that is 1,340 m of progress; read signed
  // it is 20 m backwards, which is still a step and still due — and, crucially,
  // a 2 m nudge backwards from GPS noise is NOT.
  assert.equal(panoDue(300, 280, { lengthM: LOOP_M }), true);
  assert.equal(panoDue(300, 298, { lengthM: LOOP_M }), false);
});

test('the search radius and the playback speed are the stated ones', () => {
  assert.equal(PANO_RADIUS_M, 25);
  assert.equal(STREET_VIEW_SPEED_MPS, 7);
});

// ---------------------------------------------------------------------------
// Coverage fallback
// ---------------------------------------------------------------------------

test('40 m of route with no panorama falls back to the chase camera', () => {
  assert.equal(COVERAGE_GAP_M, 40);
  let state = initialCoverage();
  assert.equal(state.mode, COVERAGE.STREET_VIEW);
  // Misses every 10 m. The first miss establishes the origin and contributes
  // no distance; 40 m of road has passed by the fifth.
  for (const [alongM, expected] of [
    [100, COVERAGE.STREET_VIEW],
    [110, COVERAGE.STREET_VIEW],
    [120, COVERAGE.STREET_VIEW],
    [130, COVERAGE.STREET_VIEW],
    [140, COVERAGE.CHASE],
  ]) {
    state = nextCoverage(state, { alongM, found: false, lengthM: LOOP_M });
    assert.equal(state.mode, expected, `at ${alongM} m`);
  }
  assert.equal(state.missedM, 40);
});

test('the gap is metres of road, not a count of failed requests', () => {
  // The same five misses 2 m apart are 8 m of road and must not fall back:
  // otherwise the rule would mean something different at every playback speed.
  let state = initialCoverage();
  for (const alongM of [100, 102, 104, 106, 108]) {
    state = nextCoverage(state, { alongM, found: false, lengthM: LOOP_M });
  }
  assert.equal(state.mode, COVERAGE.STREET_VIEW);
  assert.equal(state.missedM, 8);
});

test('one panorama clears the debt and brings Street View back', () => {
  let state = initialCoverage();
  for (const alongM of [0, 10, 20, 30, 40, 50]) {
    state = nextCoverage(state, { alongM, found: false, lengthM: LOOP_M });
  }
  assert.equal(state.mode, COVERAGE.CHASE);
  state = nextCoverage(state, { alongM: 60, found: true, lengthM: LOOP_M });
  assert.equal(state.mode, COVERAGE.STREET_VIEW);
  assert.equal(state.missedM, 0, 'a hit must not leave the next miss one step from falling back');
});

test('the gap accumulates across the loop join', () => {
  let state = nextCoverage(initialCoverage(), { alongM: 1340, found: false, lengthM: LOOP_M });
  state = nextCoverage(state, { alongM: 1350, found: false, lengthM: LOOP_M });
  state = nextCoverage(state, { alongM: 1360, found: false, lengthM: LOOP_M });
  // 1,360 -> 10 is 10 m forward over the join, not 1,350 m backwards.
  state = nextCoverage(state, { alongM: 10, found: false, lengthM: LOOP_M });
  assert.ok(Math.abs(state.missedM - 30) < 1, `missed ${state.missedM} m across the join`);
  assert.equal(state.mode, COVERAGE.STREET_VIEW);
});

// ---------------------------------------------------------------------------
// POV
// ---------------------------------------------------------------------------

test('the POV is the road until a house is 60 m away', () => {
  assert.equal(POV_EASE_RADIUS_M, 60);
  assert.equal(povBlendFor(200), 0);
  assert.equal(povBlendFor(61), 0);
  assert.ok(povBlendFor(59) > 0);
  assert.ok(povBlendFor(0) > 0.999, 'level with the house is a full look');
});

test('the look ramps in monotonically rather than switching on', () => {
  let previous = -1;
  for (let d = POV_EASE_RADIUS_M; d >= 0; d -= 0.5) {
    const value = povBlendFor(d);
    assert.ok(value >= previous - 1e-9, `blend dipped at ${d} m`);
    previous = value;
  }
});

test('and eases back to the road over 25 m past the house', () => {
  assert.equal(POV_RELEASE_M, 25);
  // Continuous through zero: a step in the TARGET would be smoothed into a
  // second-and-a-half swing back through the windscreen, by which time the
  // house is gone.
  assert.ok(Math.abs(povBlendFor(0) - povBlendFor(-0.001)) < 1e-3);
  assert.ok(povBlendFor(-12) > 0 && povBlendFor(-12) < 1);
  assert.equal(povBlendFor(-POV_RELEASE_M), 0);
  assert.equal(povBlendFor(-200), 0, 'well past is forward, not a glance backwards');
});

test('with nothing discussed the POV is exactly the travel bearing', () => {
  const { headingDeg, blend } = povHeadingFor({
    previousHeadingDeg: null,
    travelBearingDeg: 271,
    houseBearingDeg: null,
    aheadM: 10,
  });
  assert.equal(blend, 0);
  assert.equal(headingDeg, 271);
});

test('the POV never turns more than 85 degrees off the direction of travel', () => {
  // A house directly behind: the blend would point the panorama at the road
  // already driven, and the next transition would then arrive from behind the
  // viewer. It is clamped to a hard look out of the side window instead.
  assert.equal(POV_MAX_OFF_TRAVEL_DEG, 85);
  const { targetDeg } = povHeadingFor({
    previousHeadingDeg: null,
    travelBearingDeg: 0,
    houseBearingDeg: 179,
    aheadM: 0,
  });
  assert.ok(Math.abs(deltaDeg(0, targetDeg)) <= POV_MAX_OFF_TRAVEL_DEG + 1e-6,
    `turned ${deltaDeg(0, targetDeg)} degrees off travel`);
});

test('the pan filters on the shortest turn, not through south', () => {
  // Filtering 359 towards 1 the naive way spins the view the long way round.
  const { headingDeg } = povHeadingFor({
    previousHeadingDeg: 359,
    travelBearingDeg: 1,
    dtSeconds: 0.25,
  });
  assert.ok(headingDeg > 359 - 1e-9 || headingDeg < 10,
    `filtered to ${headingDeg}, which is the long way round`);
});

test('a whole approach and pass turns towards the house and comes back', () => {
  // 300 m of road north past a house on the right hand side, 20 m off it.
  let heading = null;
  const samples = [];
  for (let ahead = 150; ahead >= -60; ahead -= 2) {
    // Bearing to a house 20 m east of the road, `ahead` metres up it.
    const houseBearingDeg = (Math.atan2(20, ahead) * 180) / Math.PI;
    const step = povHeadingFor({
      previousHeadingDeg: heading,
      travelBearingDeg: 0,
      houseBearingDeg: ahead > -POV_RELEASE_M ? ((houseBearingDeg % 360) + 360) % 360 : null,
      aheadM: ahead,
      dtSeconds: 2 / 7, // 2 m at the Street View playback speed
    });
    heading = step.headingDeg;
    samples.push({ ahead, off: deltaDeg(0, heading), blend: step.blend });
  }
  const far = samples.find((s) => s.ahead === 150);
  const close = samples.reduce((a, b) => (Math.abs(b.off) > Math.abs(a.off) ? b : a));
  const after = samples[samples.length - 1];
  assert.ok(Math.abs(far.off) < 1, `already looking ${far.off} degrees off at 150 m`);
  assert.ok(Math.abs(close.off) > 30, `never really looked at the house: peak ${close.off}`);
  assert.ok(Math.abs(close.off) <= POV_MAX_OFF_TRAVEL_DEG + 1);
  assert.ok(Math.abs(after.off) < 12, `still looking ${after.off} degrees off 60 m past it`);
});

// ---------------------------------------------------------------------------
// Markers
// ---------------------------------------------------------------------------

const HOUSES = [
  { id: 'A', address: '1 Pano Row, Decatur, GA 30030', lat: 33.7582, lng: -84.3074, signals: [{ type: 'FORECLOSURE' }] },
  { id: 'B', address: '2 Pano Row, Decatur, GA 30030', lat: 33.7592, lng: -84.3074, signals: [{ type: 'TAX_SALE' }] },
  // ~700 m south: well outside the 120 m window.
  { id: 'C', address: '3 Pano Row, Decatur, GA 30030', lat: 33.7519, lng: -84.3074, signals: [{ type: 'DISTRESS' }] },
];

test('only signal properties within 120 m get a pin', () => {
  assert.equal(MARKER_RADIUS_M, 120);
  const markers = panoMarkersFor(HOUSES, { position: { lat: 33.7582, lng: -84.3074 } });
  assert.deepEqual(markers.map((m) => m.id).sort(), ['A', 'B']);
  assert.ok(markers.every((m) => m.distanceM <= MARKER_RADIUS_M));
});

test('the top pick is the only gold pin and the only labelled one', () => {
  const markers = panoMarkersFor(HOUSES, {
    position: { lat: 33.7582, lng: -84.3074 },
    topPickId: 'B',
  });
  const gold = markers.filter((m) => m.gold);
  assert.equal(gold.length, 1);
  assert.equal(gold[0].id, 'B');
  assert.equal(markers.filter((m) => m.label).length, 1,
    'a street of labelled pins is a map legend');
  assert.equal(gold[0].label, '2 Pano Row');
  const other = markers.find((m) => m.id === 'A');
  assert.equal(other.gold, false);
  assert.notEqual(other.color, gold[0].color, 'the rest carry their signal colour');
});

test('the nearest pin is drawn last, so it is not behind the ones further off', () => {
  const markers = panoMarkersFor(HOUSES, { position: { lat: 33.7582, lng: -84.3074 } });
  for (let i = 1; i < markers.length; i += 1) {
    assert.ok(markers[i].distanceM <= markers[i - 1].distanceM);
  }
});

test('a fix with no position produces no pins rather than throwing', () => {
  assert.deepEqual(panoMarkersFor(HOUSES, { position: null }), []);
  assert.deepEqual(panoMarkersFor(null, { position: { lat: 33.75, lng: -84.3 } }), []);
});
