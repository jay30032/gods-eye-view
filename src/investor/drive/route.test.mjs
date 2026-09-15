/**
 * The route as geometry: spline sampling, projection, sides, heading smoothing.
 *
 * Most of these run against the real committed route rather than a fixture,
 * because the properties that matter — that the spline passes through the road
 * vertices, that a house projects onto the road in front of it — are claims
 * about *that* route and a synthetic square would not test them.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  HEADING_TAU_S,
  bearingOf,
  buildRoute,
  catmullRom,
  deltaDeg,
  normalizeDeg,
  pointAt,
  projectOnto,
  resampleClosed,
  sideFromBearing,
  signedAheadM,
  smoothHeading,
  wrapDistance,
} from './route.js';
import { SIX_ROUTE, SIX_ROUTE_LENGTH_M } from '../mock/sixRoute.js';
import { SIX_HOUSE_PROPERTIES } from '../mock/sixHouse.js';

const route = buildRoute(SIX_ROUTE);

// --- spline ---------------------------------------------------------------

test('Catmull-Rom passes exactly through its control points', () => {
  // The whole reason for choosing it: a B-spline would cut the corner, which
  // on a road means the camera drives through the garden on the inside of it.
  const p0 = [0, 0];
  const p1 = [10, 0];
  const p2 = [20, 10];
  const p3 = [30, 10];
  assert.deepEqual(catmullRom(p0, p1, p2, p3, 0).map(Math.round), p1);
  assert.deepEqual(catmullRom(p0, p1, p2, p3, 1).map(Math.round), p2);
});

test('resampling a closed ring wraps rather than stopping at the seam', () => {
  const square = [[0, 0], [100, 0], [100, 100], [0, 100]];
  const dense = resampleClosed(square, 10);
  // First point repeated at the end: the loop is closed.
  assert.deepEqual(dense[0].map(Math.round), dense[dense.length - 1].map(Math.round));
  assert.ok(dense.length > square.length * 4, `only ${dense.length} samples`);
});

test('a ring whose last vertex duplicates its first does not stall', () => {
  // A duplicated closing vertex is a zero-length span, which is how a resampler
  // ends up emitting the same point forever.
  const closed = [[0, 0], [100, 0], [100, 100], [0, 100], [0, 0]];
  const dense = resampleClosed(closed, 10);
  assert.ok(dense.length > 8);
  assert.ok(dense.every((p) => Number.isFinite(p[0]) && Number.isFinite(p[1])));
});

test('the spline follows the committed route to within a few metres', () => {
  assert.ok(route.points.length > SIX_ROUTE.length * 5, 'the route was not densified');
  // Smoothing rounds the corners slightly outward, so the spline is a touch
  // longer than the polyline — but only a touch, or it is not the same road.
  const drift = Math.abs(route.lengthM - SIX_ROUTE_LENGTH_M);
  assert.ok(drift < SIX_ROUTE_LENGTH_M * 0.05, `spline is ${drift.toFixed(0)} m off the polyline`);
});

test('every route vertex is still on the spline after resampling', () => {
  // The spline must not wander off the road it was built from.
  for (const vertex of SIX_ROUTE) {
    const projected = projectOnto(route, { lat: vertex[1], lng: vertex[0] });
    assert.ok(projected.offsetM < 4, `a vertex sits ${projected.offsetM.toFixed(1)} m off the spline`);
  }
});

// --- distances ------------------------------------------------------------

test('distance wraps around the loop', () => {
  assert.equal(wrapDistance(0, 100), 0);
  assert.equal(wrapDistance(150, 100), 50);
  assert.equal(wrapDistance(-10, 100), 90);
  assert.equal(wrapDistance(NaN, 100), 0);
  assert.equal(wrapDistance(10, 0), 0);
});

test('"ahead" takes the short way round, so most of a loop is behind you', () => {
  const length = route.lengthM;
  assert.ok(Math.abs(signedAheadM(route, 0, 100) - 100) < 1);
  assert.ok(signedAheadM(route, 100, 0) < 0, 'a point just behind must read as behind');
  // Three quarters of the way round is a quarter of the way back, not a long
  // drive forward — which is what the activation rules need.
  const threeQuarters = signedAheadM(route, 0, length * 0.75);
  assert.ok(threeQuarters < 0, `got ${threeQuarters.toFixed(0)}`);
  assert.ok(Math.abs(threeQuarters + length * 0.25) < 2);
});

test('every six-house property projects onto the road in front of it', () => {
  for (const property of SIX_HOUSE_PROPERTIES) {
    const projected = projectOnto(route, property);
    assert.ok(projected, property.id);
    // The offset is the house's setback from the kerb — tens of metres, not
    // hundreds. A property that projected 200 m away is on another street.
    assert.ok(
      projected.offsetM > 5 && projected.offsetM < 60,
      `${property.id} projects ${projected.offsetM.toFixed(0)} m from the route`,
    );
    assert.ok(projected.alongM >= 0 && projected.alongM <= route.lengthM + 1);
  }
});

test('pointAt returns a real position and a tangent everywhere on the loop', () => {
  for (let d = 0; d < route.lengthM; d += 37) {
    const point = pointAt(route, d);
    assert.ok(Number.isFinite(point.lat) && Number.isFinite(point.lng), `at ${d} m`);
    assert.ok(point.bearingDeg >= 0 && point.bearingDeg < 360, `at ${d} m`);
  }
  // Past the end it wraps rather than falling off.
  const wrapped = pointAt(route, route.lengthM + 50);
  const start = pointAt(route, 50);
  assert.ok(Math.abs(wrapped.lat - start.lat) < 1e-6);
});

// --- sides ----------------------------------------------------------------

test('left and right come from the travel bearing, not from the map', () => {
  const here = { lat: 33.7582, lng: -84.3074 };
  // A point due north of us.
  const north = { lat: here.lat + 0.001, lng: here.lng };
  assert.equal(sideFromBearing(here, 90, north), 'left', 'heading east, north is left');
  assert.equal(sideFromBearing(here, 270, north), 'right', 'heading west, north is right');
  // The same house, driven the other way, is on the other side. That is the
  // whole reason this is computed per fix instead of stored.
  assert.notEqual(
    sideFromBearing(here, 90, north),
    sideFromBearing(here, 270, north),
  );
});

test('straight ahead is not a side', () => {
  const here = { lat: 33.7582, lng: -84.3074 };
  const ahead = { lat: here.lat + 0.002, lng: here.lng };
  assert.equal(sideFromBearing(here, 0, ahead), 'ahead');
  // And a house far up the road with a little lateral offset is still ahead,
  // because the test is an angle rather than a distance.
  const slightlyOff = { lat: here.lat + 0.004, lng: here.lng + 0.00005 };
  assert.equal(sideFromBearing(here, 0, slightlyOff), 'ahead');
});

test('a missing position never claims a side', () => {
  assert.equal(sideFromBearing(null, 90, { lat: 1, lng: 1 }), 'ahead');
  assert.equal(sideFromBearing({ lat: 1, lng: 1 }, 90, null), 'ahead');
});

// --- heading smoothing ----------------------------------------------------

test('heading smoothing takes the short way across north', () => {
  // 350 -> 10 is a 20 degree turn, not a 340 degree spin. Filtering the raw
  // numbers would send the camera the long way round through south.
  const next = smoothHeading(350, 10, 0.25);
  assert.ok(next > 350 || next < 20, `went the long way: ${next}`);
  assert.ok(next >= 0 && next < 360);
  const delta = deltaDeg(350, next);
  assert.ok(delta > 0 && delta < 20, `turned ${delta} of the available 20`);
});

test('smoothing approaches the target and never overshoots it', () => {
  let heading = 0;
  for (let i = 0; i < 200; i += 1) heading = smoothHeading(heading, 90, 0.05);
  assert.ok(Math.abs(deltaDeg(heading, 90)) < 0.5, `settled at ${heading}`);
  // Monotonic: a low-pass filter that oscillates is a camera that wobbles.
  let previous = 0;
  let current = 0;
  for (let i = 0; i < 40; i += 1) {
    current = smoothHeading(current, 90, 0.05);
    assert.ok(current >= previous - 1e-9, `went backwards at step ${i}`);
    assert.ok(current <= 90 + 1e-9, `overshot to ${current}`);
    previous = current;
  }
});

test('the turn takes the same wall-clock time at any frame rate', () => {
  // Ten steps of 0.1 s and one of 1 s must land in about the same place, or a
  // dropped frame leaves the camera behind and 30 fps turns slower than 60.
  let stepped = 0;
  for (let i = 0; i < 10; i += 1) stepped = smoothHeading(stepped, 90, 0.1);
  const once = smoothHeading(0, 90, 1);
  assert.ok(Math.abs(stepped - once) < 2, `${stepped.toFixed(1)} vs ${once.toFixed(1)}`);
});

test('the first heading snaps and a broken clock changes nothing', () => {
  assert.equal(smoothHeading(null, 123, 0.1), 123);
  assert.equal(smoothHeading(undefined, 123, 0.1), 123);
  assert.equal(smoothHeading(10, 90, 0), 10);
  assert.equal(smoothHeading(10, 90, NaN), 10);
  assert.equal(smoothHeading(10, 90, -1), 10);
});

test('a longer time constant turns more slowly', () => {
  const quick = smoothHeading(0, 90, 0.5, { tauS: 0.2 });
  const slow = smoothHeading(0, 90, 0.5, { tauS: 3 });
  assert.ok(quick > slow, `${quick} should outrun ${slow}`);
  assert.ok(HEADING_TAU_S > 0.3 && HEADING_TAU_S < 2, 'the default should be about a second');
});

test('angle helpers normalise and compare the short way', () => {
  assert.equal(normalizeDeg(-90), 270);
  assert.equal(normalizeDeg(450), 90);
  assert.equal(deltaDeg(350, 10), 20);
  assert.equal(deltaDeg(10, 350), -20);
  assert.equal(Math.round(bearingOf([1, 0])), 90);
  assert.equal(Math.round(bearingOf([0, 1])), 0);
});
