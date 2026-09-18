/**
 * The two position sources, and the claim that binds them.
 *
 * Drive Mode reads a *fix*, never the spline — so the same drive narrated from
 * a phone must produce the same call-outs, in the same order, as the same drive
 * played back. The last test in this file asserts exactly that, by feeding the
 * committed route through `GpsSource` as fake fixes with +/-6 m of noise at
 * 9 m/s and comparing the result against playback.
 *
 * That is the test the whole abstraction exists for. Without it "pluggable"
 * means the GPS path compiles, not that it works.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_SPEED_MPS,
  EASE_IN_S,
  FASTER_SCALE,
  GPS_SNAP_M,
  SLOWER_SCALE,
  createGpsSource,
  createPlaybackSource,
} from './positionSource.js';
import { buildRoute, pointAt, projectOnto, signedAheadM } from './route.js';
import { CALLOUT_AHEAD_M, groupByProximity, shouldAnnounce } from './narration.js';
import { SIX_ROUTE } from '../mock/sixRoute.js';
import { SIX_HOUSE_PROPERTIES } from '../mock/sixHouse.js';

const route = buildRoute(SIX_ROUTE);

/** Deterministic +/-1 noise. A seeded LCG, so a failure is reproducible. */
function noise(seed = 7) {
  let state = seed;
  return () => {
    state = (state * 48271) % 2147483647;
    return (state / 2147483647 - 0.5) * 2;
  };
}

// --- playback -------------------------------------------------------------

test('playback eases in over two seconds rather than lurching', () => {
  const source = createPlaybackSource({ route, now: () => 0 });
  source.start();
  const speeds = [];
  for (let i = 0; i < 10; i += 1) {
    source.advance(0.5);
    speeds.push(source.last.speedMps);
  }
  assert.ok(speeds[0] < DEFAULT_SPEED_MPS * 0.3, `started at ${speeds[0]}`);
  // Up to speed by the end of the ease-in, and monotonic getting there.
  const atEase = Math.round(EASE_IN_S / 0.5) - 1;
  assert.ok(Math.abs(speeds[atEase] - DEFAULT_SPEED_MPS) < 0.6, `${speeds[atEase]} at ease-in`);
  for (let i = 1; i <= atEase; i += 1) {
    assert.ok(speeds[i] >= speeds[i - 1] - 1e-9, `speed dipped at step ${i}`);
  }
});

test('playback covers the route at the speed it claims', () => {
  const source = createPlaybackSource({ route, now: () => 0 });
  source.start();
  // Past the ease-in, ten seconds is ninety metres.
  for (let i = 0; i < 8; i += 1) source.advance(0.5); // clear the ease-in
  const before = source.alongM;
  for (let i = 0; i < 20; i += 1) source.advance(0.5);
  const covered = source.alongM - before;
  assert.ok(Math.abs(covered - DEFAULT_SPEED_MPS * 10) < 2, `covered ${covered.toFixed(1)} m`);
});

test('slower and faster scale playback, and clamp', () => {
  const source = createPlaybackSource({ route, now: () => 0 });
  assert.ok(Math.abs(source.slower() - SLOWER_SCALE) < 1e-9);
  source.setSpeedScale(1);
  assert.ok(Math.abs(source.faster() - FASTER_SCALE) < 1e-9);
  // Repeated presses stop at a rail rather than running away.
  for (let i = 0; i < 20; i += 1) source.faster();
  assert.ok(source.setSpeedScale(999) <= 4);
  for (let i = 0; i < 20; i += 1) source.slower();
  assert.ok(source.speedMps > 0, 'playback must never stop dead');
});

test('the loop wraps and counts laps', () => {
  const source = createPlaybackSource({ route, startAlongM: route.lengthM - 20, now: () => 0 });
  source.start();
  for (let i = 0; i < 40; i += 1) source.advance(0.5);
  assert.ok(source.alongM < 200, `did not wrap: ${source.alongM}`);
  assert.equal(source.laps, 1);
});

test('pause stops the drive without losing where it is', () => {
  const source = createPlaybackSource({ route, now: () => 0 });
  source.start();
  for (let i = 0; i < 10; i += 1) source.advance(0.5);
  const at = source.alongM;
  source.pause();
  for (let i = 0; i < 10; i += 1) source.advance(0.5);
  assert.equal(source.alongM, at, 'a paused drive moved');
  source.resume();
  source.advance(0.5);
  assert.ok(source.alongM > at);
});

test('seek puts the drive back exactly where it left off', () => {
  // What "keep going" after a closer look depends on.
  const source = createPlaybackSource({ route, now: () => 0 });
  source.start();
  source.seek(400);
  assert.ok(Math.abs(source.alongM - 400) < 0.001);
  assert.ok(source.last, 'seeking must emit a fix so the camera can follow');
});

test('subscribers get every fix and can unsubscribe', () => {
  const source = createPlaybackSource({ route, now: () => 0 });
  const seen = [];
  const off = source.subscribe((fix) => seen.push(fix));
  source.start();
  source.advance(0.5);
  assert.equal(seen.length, 2, 'start emits, then each advance');
  off();
  source.advance(0.5);
  assert.equal(seen.length, 2);
  // Every fix carries the whole contract.
  for (const fix of seen) {
    assert.ok(Number.isFinite(fix.position.lat) && Number.isFinite(fix.position.lng));
    assert.ok(fix.bearingDeg >= 0 && fix.bearingDeg < 360);
    assert.ok(Number.isFinite(fix.speedMps));
    assert.ok(Number.isFinite(fix.timestamp));
  }
});

// --- GPS ------------------------------------------------------------------

/** One browser-shaped fix. */
const gpsFix = (lat, lng, { accuracy = 6, speed = 9, heading = null, timestamp = 0 } = {}) => ({
  coords: { latitude: lat, longitude: lng, accuracy, speed, heading },
  timestamp,
});

test('a fix close to the road snaps to it; one far away does not', () => {
  const source = createGpsSource({ route, geolocation: null, now: () => 0 });
  const on = pointAt(route, 200);
  const near = source.handle(gpsFix(on.lat, on.lng, { heading: on.bearingDeg }));
  assert.equal(near.snapped, true);

  // A hundred metres off the road is a driver who has left the route, and
  // pulling them back would teleport the camera and hide the divergence.
  const far = createGpsSource({ route, geolocation: null, now: () => 0 });
  const off = far.handle(gpsFix(on.lat + 0.002, on.lng + 0.002, { heading: 0 }));
  assert.equal(off.snapped, false);
  assert.ok(GPS_SNAP_M > 0 && GPS_SNAP_M < 30);
});

test('bearing comes from the course while moving', () => {
  const source = createGpsSource({ route, geolocation: null, now: () => 0 });
  const on = pointAt(route, 100);
  source.handle(gpsFix(on.lat, on.lng, { heading: 90, speed: 9, timestamp: 0 }));
  const second = source.handle(gpsFix(on.lat, on.lng, { heading: 90, speed: 9, timestamp: 1000 }));
  assert.ok(Math.abs(second.bearingDeg - 90) < 5, `got ${second.bearingDeg}`);
});

test('standing still, the course is ignored in favour of the trail', () => {
  // A stationary phone reports garbage or null for heading; feeding it to the
  // camera spins it on the spot.
  const source = createGpsSource({ route, geolocation: null, now: () => 0 });
  let along = 0;
  for (let i = 0; i < 8; i += 1) {
    const p = pointAt(route, along);
    source.handle(gpsFix(p.lat, p.lng, { heading: 315, speed: 0, timestamp: i * 1000 }));
    along += 9;
  }
  const truth = pointAt(route, along).bearingDeg;
  const got = source.last.bearingDeg;
  // The trail says we are heading along the road, not north-west.
  assert.ok(Math.abs(((got - truth + 540) % 360) - 180) < 40, `bearing ${got} vs road ${truth}`);
});

test('a wildly inaccurate fix is reported but not trusted', () => {
  const source = createGpsSource({ route, geolocation: null, now: () => 0 });
  const on = pointAt(route, 100);
  source.handle(gpsFix(on.lat, on.lng, { timestamp: 0 }));
  const good = source.last;
  const bad = source.handle(gpsFix(on.lat + 0.01, on.lng, { accuracy: 500, timestamp: 1000 }));
  assert.equal(bad.trusted, false);
  assert.equal(source.last, good, 'an untrusted fix must not become the position');
});

test('the filter takes the jitter out without losing the road', () => {
  const random = noise(11);
  const source = createGpsSource({ route, geolocation: null, now: () => 0 });
  let along = 0;
  let worst = 0;
  for (let i = 0; i < 40; i += 1) {
    const p = pointAt(route, along);
    const dLat = (random() * 6) / 111_320;
    const dLng = (random() * 6) / (111_320 * Math.cos(p.lat * Math.PI / 180));
    const fix = source.handle(gpsFix(p.lat + dLat, p.lng + dLng, {
      heading: p.bearingDeg, speed: 9, timestamp: i * 1000,
    }));
    const drift = projectOnto(route, fix.position).offsetM;
    worst = Math.max(worst, drift);
    along += 9;
  }
  assert.ok(worst < 6, `worst drift from the road was ${worst.toFixed(1)} m`);
});

test('a source with no geolocation reports that rather than throwing', () => {
  const source = createGpsSource({ route, geolocation: null });
  assert.equal(source.supported, false);
  let error = null;
  assert.equal(source.start((e) => { error = e; }), false);
  assert.ok(error);
});

// --- the claim ------------------------------------------------------------

/**
 * Drive the route with a source and collect which houses get announced.
 *
 * Deliberately re-implements the narration loop in miniature rather than
 * importing the drive: the point is to prove the *rules* behave identically on
 * either fix stream, and pulling in the orchestration would test the
 * orchestration instead.
 */
function calloutOrder(nextFix) {
  const projected = SIX_HOUSE_PROPERTIES.map((property) => ({
    id: property.id,
    property,
    alongM: projectOnto(route, property).alongM,
  }));
  const groups = groupByProximity(projected);
  const announced = new Set();
  const order = [];

  for (;;) {
    const fix = nextFix();
    if (!fix) break;
    const at = projectOnto(route, fix.position);
    if (!at) continue;
    for (const group of groups) {
      const ahead = signedAheadM(route, at.alongM, group.alongM);
      if (!shouldAnnounce({ group, aheadM: ahead, announced })) continue;
      for (const id of group.ids) announced.add(id);
      order.push(group.ids.join('+'));
      break;
    }
  }
  return order;
}

test('a noisy GPS drive fires the same call-outs, in the same order, as playback', () => {
  // Playback.
  const playback = createPlaybackSource({ route, now: () => 0 });
  playback.start();
  let steps = 0;
  const fromPlayback = calloutOrder(() => {
    if (steps++ > 4_000 || playback.alongM > route.lengthM - 6) return null;
    return playback.advance(0.25);
  });

  // The same route through GPS, at the same 9 m/s, with +/-6 m of noise.
  const random = noise(23);
  const gps = createGpsSource({ route, geolocation: null, now: () => 0 });
  let along = 0;
  let tick = 0;
  const fromGps = calloutOrder(() => {
    if (along > route.lengthM - 6) return null;
    const p = pointAt(route, along);
    const dLat = (random() * 6) / 111_320;
    const dLng = (random() * 6) / (111_320 * Math.cos(p.lat * Math.PI / 180));
    const fix = gps.handle(gpsFix(p.lat + dLat, p.lng + dLng, {
      heading: p.bearingDeg, speed: 9, timestamp: tick * 250,
    }));
    tick += 1;
    along += 9 * 0.25;
    return fix;
  });

  assert.ok(fromPlayback.length >= 5, `playback only fired ${fromPlayback.length} call-outs`);
  assert.deepEqual(
    fromGps,
    fromPlayback,
    'a GPS drive must narrate the same houses in the same order as playback',
  );
});

test('every six-house property gets announced on a full lap of playback', () => {
  const playback = createPlaybackSource({ route, now: () => 0 });
  playback.start();
  let steps = 0;
  const order = calloutOrder(() => {
    if (steps++ > 4_000 || playback.alongM > route.lengthM - 6) return null;
    return playback.advance(0.25);
  });
  const announced = new Set(order.flatMap((entry) => entry.split('+')));
  for (const property of SIX_HOUSE_PROPERTIES) {
    assert.ok(announced.has(property.id), `${property.id} was never announced`);
  }
  // And no house is announced twice.
  assert.equal(announced.size, order.flatMap((e) => e.split('+')).length);
});

test('the call-out window is wide enough to catch a house at full speed', () => {
  // A fix every 250 ms at 9 m/s is 2.25 m of travel; the window is ~85 m wide.
  // If it were ever narrowed below one step, houses would be skipped silently.
  assert.ok(CALLOUT_AHEAD_M > DEFAULT_SPEED_MPS * 0.25 * 4);
});
