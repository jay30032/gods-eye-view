/**
 * Coarser tiles while moving, full detail at rest.
 *
 * The measurement behind it, taken on the six-house route with
 * `targetFrameRate` lifted so the number is the work and not the cap:
 * stationary p95 33.9 ms, driving p95 66.7 ms. 66.7 is exactly two vsync
 * intervals — a *missed* frame, missed while the camera is moving, which is
 * when a dropped frame is most visible.
 *
 * The rules with teeth: restore on silence rather than on an event, never make
 * the tiles finer than they already were, and capture the baseline once.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { MOTION_SSE, RESTORE_DELAY_MS, createMotionTileBudget } from './tileBudget.js';

/** A fake clock, so the 500 ms is tested rather than waited for. */
function fakeTimers() {
  let seq = 0;
  const pending = new Map();
  return {
    setTimeout(fn, ms) {
      seq += 1;
      pending.set(seq, { fn, at: ms });
      return seq;
    },
    clearTimeout(id) { pending.delete(id); },
    /** Fire everything due at or before `ms`. */
    advance(ms) {
      for (const [id, entry] of [...pending]) {
        if (entry.at <= ms) {
          pending.delete(id);
          entry.fn();
        }
      }
    },
    get size() { return pending.size; },
  };
}

const tilesetWith = (sse) => ({ maximumScreenSpaceError: sse });

test('motion raises the budget and rest restores it', () => {
  const timers = fakeTimers();
  const tileset = tilesetWith(16);
  const budget = createMotionTileBudget({ getTileset: () => tileset, timers });

  assert.equal(tileset.maximumScreenSpaceError, 16);
  budget.touch();
  assert.equal(tileset.maximumScreenSpaceError, MOTION_SSE, 'motion should coarsen the tiles');
  assert.equal(budget.raised, true);
  assert.equal(budget.baseline, 16);

  // Not yet — the detail comes back after the delay, not immediately.
  timers.advance(RESTORE_DELAY_MS - 1);
  assert.equal(tileset.maximumScreenSpaceError, MOTION_SSE);

  timers.advance(RESTORE_DELAY_MS);
  assert.equal(tileset.maximumScreenSpaceError, 16, 'detail must come back at rest');
  assert.equal(budget.raised, false);
});

test('continued motion keeps pushing the restore back', () => {
  // The whole mechanism: motion keeps the budget raised simply by continuing.
  const timers = fakeTimers();
  const tileset = tilesetWith(16);
  const budget = createMotionTileBudget({ getTileset: () => tileset, timers });

  for (let i = 0; i < 10; i += 1) {
    budget.touch();
    timers.advance(RESTORE_DELAY_MS - 1);
    assert.equal(tileset.maximumScreenSpaceError, MOTION_SSE, `restored early at step ${i}`);
  }
  // Only one timer is ever outstanding — a touch per frame must not leak one.
  assert.equal(timers.size, 1);

  timers.advance(RESTORE_DELAY_MS);
  assert.equal(tileset.maximumScreenSpaceError, 16);
});

test('the baseline is captured once, not re-captured from the raised value', () => {
  // Re-capturing would latch 24 as "at rest" and the detail would never return.
  const timers = fakeTimers();
  const tileset = tilesetWith(16);
  const budget = createMotionTileBudget({ getTileset: () => tileset, timers });

  budget.touch();
  budget.touch();
  budget.touch();
  assert.equal(budget.baseline, 16);
  timers.advance(RESTORE_DELAY_MS);
  assert.equal(tileset.maximumScreenSpaceError, 16);

  // A second burst of motion restores to the same baseline.
  budget.touch();
  assert.equal(tileset.maximumScreenSpaceError, MOTION_SSE);
  timers.advance(RESTORE_DELAY_MS);
  assert.equal(tileset.maximumScreenSpaceError, 16);
});

test('it never makes the tiles FINER than they already were', () => {
  // If something has already asked for a coarser budget — a slow machine, a
  // future quality setting — motion is not the moment to start demanding more
  // detail than it wanted.
  const timers = fakeTimers();
  const tileset = tilesetWith(48);
  const budget = createMotionTileBudget({ getTileset: () => tileset, timers });

  budget.touch();
  assert.equal(tileset.maximumScreenSpaceError, 48, 'motion must not improve quality');
  timers.advance(RESTORE_DELAY_MS);
  assert.equal(tileset.maximumScreenSpaceError, 48);
});

test('release puts the detail back immediately', () => {
  const timers = fakeTimers();
  const tileset = tilesetWith(16);
  const budget = createMotionTileBudget({ getTileset: () => tileset, timers });

  budget.touch();
  assert.equal(tileset.maximumScreenSpaceError, MOTION_SSE);
  budget.release();
  assert.equal(tileset.maximumScreenSpaceError, 16, 'the drive is over — detail now, not in 500 ms');
  assert.equal(budget.raised, false);
  // And the pending restore is cancelled rather than firing later over the top.
  assert.equal(timers.size, 0);
});

test('releasing when nothing was raised changes nothing', () => {
  const timers = fakeTimers();
  const tileset = tilesetWith(16);
  const budget = createMotionTileBudget({ getTileset: () => tileset, timers });
  assert.equal(budget.release(), false);
  assert.equal(tileset.maximumScreenSpaceError, 16);
});

test('no tileset is a no-op, not a crash', () => {
  // The keyless path has no Google tileset at all.
  const timers = fakeTimers();
  const missing = createMotionTileBudget({ getTileset: () => null, timers });
  assert.doesNotThrow(() => missing.touch());
  assert.equal(missing.raised, false);
  assert.equal(missing.baseline, null);
  assert.doesNotThrow(() => missing.release());

  const throwing = createMotionTileBudget({ getTileset: () => { throw new Error('nope'); }, timers });
  assert.doesNotThrow(() => throwing.touch());

  const malformed = createMotionTileBudget({ getTileset: () => ({}), timers });
  assert.doesNotThrow(() => malformed.touch());
  assert.equal(malformed.raised, false);
});

test('a tileset that appears late is still picked up', () => {
  // The drive can be built before the tileset exists.
  const timers = fakeTimers();
  let tileset = null;
  const budget = createMotionTileBudget({ getTileset: () => tileset, timers });
  budget.touch();
  assert.equal(budget.raised, false);

  tileset = tilesetWith(16);
  budget.touch();
  assert.equal(budget.raised, true);
  assert.equal(tileset.maximumScreenSpaceError, MOTION_SSE);
});

test('destroy restores and forgets', () => {
  const timers = fakeTimers();
  const tileset = tilesetWith(16);
  const budget = createMotionTileBudget({ getTileset: () => tileset, timers });
  budget.touch();
  budget.destroy();
  assert.equal(tileset.maximumScreenSpaceError, 16);
  assert.equal(budget.baseline, null);
  assert.equal(timers.size, 0);
});

test('the constants are the ones the measurement asked for', () => {
  assert.equal(MOTION_SSE, 24);
  assert.equal(RESTORE_DELAY_MS, 500);
  // Coarser than Cesium's 16 default, or it would do nothing.
  assert.ok(MOTION_SSE > 16);
  // Long enough to cover the gap between fixes, short enough that the detail is
  // back before anyone has finished looking at what they stopped for.
  assert.ok(RESTORE_DELAY_MS >= 250 && RESTORE_DELAY_MS <= 1_500);
});
