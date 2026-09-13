/**
 * How a house is drawn, given how far ahead of the drive it is.
 *
 * The product rule being pinned: emphasis follows *what you can see from
 * here*, and it ramps rather than switching. A house that snaps from nothing to
 * a full outline at exactly 120 m reads as a rendering glitch; one that arrives
 * reads as something coming into view.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  APPROACH_M,
  BEHIND_M,
  FAR_M,
  PASSED_ALPHA,
  SAVED_ALPHA,
  SLOW_FACTOR,
  SLOW_RADIUS_M,
  STATES,
  USEFUL_M,
  activationFor,
  activationsFor,
  speedScaleFor,
} from './activation.js';

const weights = (a) => [a.beacon, a.outline, a.highlight, a.motion, a.alpha];

test('the bands are the ones the design states', () => {
  assert.equal(activationFor({ aheadM: FAR_M + 50 }).state, STATES.FAR);
  assert.equal(activationFor({ aheadM: APPROACH_M - 1 }).state, STATES.APPROACHING);
  assert.equal(activationFor({ aheadM: USEFUL_M - 1 }).state, STATES.USEFUL);
  assert.equal(activationFor({ aheadM: -10 }).state, STATES.PASSED);
  assert.equal(activationFor({ aheadM: -BEHIND_M - 10 }).state, STATES.SUSPENDED);
});

test('far ahead is a beacon and nothing else', () => {
  const far = activationFor({ aheadM: 400 });
  assert.equal(far.beacon, 1);
  assert.equal(far.outline, 0, 'no outline should be drawn at 400 m');
  assert.equal(far.highlight, 0);
  assert.equal(far.motion, 0);
});

test('the outline fades in across the approach rather than switching on', () => {
  const at120 = activationFor({ aheadM: APPROACH_M }).outline;
  const at90 = activationFor({ aheadM: 90 }).outline;
  const at60 = activationFor({ aheadM: USEFUL_M }).outline;
  assert.ok(at120 < 0.02, `outline already ${at120} at the far edge`);
  assert.ok(at90 > 0.2 && at90 < 0.8, `mid-approach should be mid-ramp, got ${at90}`);
  assert.ok(at60 > 0.98, `outline only ${at60} by the useful window`);

  // Monotonic all the way in — an outline that dipped would flicker.
  let previous = -1;
  for (let d = APPROACH_M + 20; d >= 0; d -= 1) {
    const value = activationFor({ aheadM: d }).outline;
    assert.ok(value >= previous - 1e-9, `outline dipped at ${d} m`);
    previous = value;
  }
});

test('highlight and motion belong to the useful window only', () => {
  assert.equal(activationFor({ aheadM: USEFUL_M + 1 }).highlight, 0);
  assert.ok(activationFor({ aheadM: USEFUL_M / 2 }).highlight > 0.4);
  assert.ok(activationFor({ aheadM: 5 }).highlight > 0.95);
  assert.ok(activationFor({ aheadM: 5 }).motion > 0.95);
});

test('a passed house fades to a quarter and then out', () => {
  const justPassed = activationFor({ aheadM: -1 });
  assert.ok(Math.abs(justPassed.alpha - PASSED_ALPHA) < 0.02, `got ${justPassed.alpha}`);
  assert.equal(justPassed.highlight, 0, 'nothing behind you is worth highlighting');
  // And it keeps fading over the block behind rather than cutting.
  assert.ok(activationFor({ aheadM: -40 }).alpha < justPassed.alpha);
  assert.equal(activationFor({ aheadM: -BEHIND_M - 1 }).suspended, true);
});

test('a saved house is never suspended and never drops to quiet', () => {
  const saved = activationFor({ aheadM: -500, saved: true });
  assert.equal(saved.suspended, false, 'a saved house must stay findable');
  assert.equal(saved.alpha, SAVED_ALPHA);
  assert.ok(SAVED_ALPHA > PASSED_ALPHA, 'saved must outrank merely passed');
});

test('the selected house wins wherever the camera is', () => {
  // The user asked to look at this one. The drive does not get to dim it
  // because it happens to be behind.
  const selected = activationFor({ aheadM: -9_000, selected: true });
  assert.deepEqual(weights(selected), [1, 1, 1, 1, 1]);
  assert.equal(selected.state, STATES.SELECTED);
  assert.equal(selected.suspended, false);
});

test('every weight stays inside 0..1 at every distance', () => {
  for (let d = -400; d <= 600; d += 1) {
    for (const saved of [false, true]) {
      const a = activationFor({ aheadM: d, saved });
      for (const value of weights(a)) {
        assert.ok(value >= 0 && value <= 1, `weight ${value} at ${d} m (saved=${saved})`);
      }
    }
  }
});

test('a nonsense distance suspends rather than drawing something wrong', () => {
  for (const bad of [NaN, Infinity, null, undefined, 'x']) {
    const a = activationFor({ aheadM: bad });
    assert.equal(a.suspended, true, String(bad));
    assert.equal(a.alpha, 0, String(bad));
  }
});

test('the whole board activates in one pass, in the caller\'s frame', () => {
  const projected = [
    { id: 'A', alongM: 100 },
    { id: 'B', alongM: 400 },
    { id: 'C', alongM: 900 },
  ];
  const map = activationsFor(projected, {
    alongM: 50,
    selectedId: 'C',
    savedIds: ['B'],
    signedAhead: (from, to) => to - from,
  });
  assert.equal(map.size, 3);
  assert.equal(map.get('A').state, STATES.USEFUL, '50 m ahead is the useful window');
  assert.equal(map.get('B').state, STATES.FAR);
  assert.equal(map.get('C').state, STATES.SELECTED, 'selected wins over distance');
  // A saved id is honoured whether it arrives as a Set or an array.
  const asSet = activationsFor(projected, {
    alongM: 5_000,
    savedIds: new Set(['B']),
    signedAhead: (from, to) => to - from,
  });
  assert.equal(asSet.get('B').suspended, false);
});

// --- playback speed -------------------------------------------------------

test('playback slows for the house being explained, and only for it', () => {
  assert.equal(speedScaleFor(10, { discussing: false }), 1, 'no slow-down when not talking');
  assert.equal(speedScaleFor(SLOW_RADIUS_M + 10, { discussing: true }), 1, 'not yet');
  assert.ok(Math.abs(speedScaleFor(0, { discussing: true }) - SLOW_FACTOR) < 1e-9);
});

test('the slow-down eases in rather than braking', () => {
  const far = speedScaleFor(SLOW_RADIUS_M - 1, { discussing: true });
  const mid = speedScaleFor(SLOW_RADIUS_M / 2, { discussing: true });
  const near = speedScaleFor(5, { discussing: true });
  assert.ok(far > mid && mid > near, `${far} > ${mid} > ${near}`);
  assert.ok(far > 0.95, 'the edge of the radius should be nearly full speed');
  // Never below the stated floor, never above normal.
  for (let d = -100; d <= 200; d += 1) {
    const scale = speedScaleFor(d, { discussing: true });
    assert.ok(scale >= SLOW_FACTOR - 1e-9 && scale <= 1 + 1e-9, `scale ${scale} at ${d} m`);
  }
});

test('the slow-down is symmetric — it applies drawing level, not only before', () => {
  // `aheadM` goes negative the moment you draw level. Slowing only on approach
  // would speed back up mid-sentence.
  assert.ok(Math.abs(speedScaleFor(-20, { discussing: true })
    - speedScaleFor(20, { discussing: true })) < 1e-9);
});
