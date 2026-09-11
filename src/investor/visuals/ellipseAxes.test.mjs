import test from 'node:test';
import assert from 'node:assert/strict';
import { MIN_AXIS_M, ellipseAxes, staticAxes } from './ellipseAxes.js';
import { PULSE_BASE_RADIUS_M, lookForSignal, pulseRadiusM } from './propertyPulse.js';
import { goldHaloRadiusM } from './goldHalo.js';
import { SCAN_DURATION_MS, scanProgress, scanRadiusM } from './scanSweep.js';

/**
 * The bug: semiMajorAxis and semiMinorAxis were two CallbackProperties, each
 * recomputing from Date.now(). Cesium reads them sequentially within a frame,
 * so a millisecond tick between the reads returned a larger minor than major on
 * the rising half of a cycle — DeveloperError, render loop stops, dead globe.
 */

/** Minimal Cesium stand-in: CallbackProperty is just a getValue wrapper. */
const FakeCesium = {
  CallbackProperty: class {
    constructor(callback) { this._callback = callback; }

    getValue(time) { return this._callback(time); }
  },
};

const stamp = (ms) => ({ dayNumber: Math.floor(ms / 86_400_000), secondsOfDay: (ms % 86_400_000) / 1000 });

/** Every radius function the product animates, swept the same way. */
const RADIUS_FUNCTIONS = [
  {
    name: 'pulse FORECLOSURE',
    cycleMs: lookForSignal('FORECLOSURE').periodMs,
    fn: (t) => pulseRadiusM(t, lookForSignal('FORECLOSURE'), false),
  },
  {
    name: 'pulse LISTED_OPPORTUNITY',
    cycleMs: lookForSignal('LISTED_OPPORTUNITY').periodMs,
    fn: (t) => pulseRadiusM(t, lookForSignal('LISTED_OPPORTUNITY'), false),
  },
  {
    name: 'pulse focused + deal boost',
    cycleMs: lookForSignal('TAX_SALE').periodMs,
    fn: (t) => pulseRadiusM(t, lookForSignal('TAX_SALE'), false, {
      base: PULSE_BASE_RADIUS_M, focused: true, dealBoost: 1,
    }),
  },
  { name: 'gold halo', cycleMs: 3000, fn: (t) => goldHaloRadiusM(t, false) },
  {
    name: 'scan sweep',
    cycleMs: SCAN_DURATION_MS,
    fn: (t) => scanRadiusM(scanProgress(0, t, false)),
  },
];

test('every radius function is positive and deterministic across full cycles', () => {
  for (const { name, cycleMs, fn } of RADIUS_FUNCTIONS) {
    const span = cycleMs * 3;
    for (let t = 0; t <= span; t += 1) {
      const value = fn(t);
      assert.ok(Number.isFinite(value), `${name} @${t} is not finite`);
      assert.ok(value > MIN_AXIS_M, `${name} @${t} is ${value}, under the ${MIN_AXIS_M}m floor`);
      // Same input, same output — no hidden clock read inside.
      assert.equal(fn(t), value, `${name} @${t} is not deterministic`);
    }
  }
});

test('reduced motion freezes every radius', () => {
  const look = lookForSignal('FORECLOSURE');
  const frozen = pulseRadiusM(0, look, true);
  for (let t = 0; t <= 9000; t += 250) {
    assert.equal(pulseRadiusM(t, look, true), frozen);
    assert.equal(goldHaloRadiusM(t, true), goldHaloRadiusM(0, true));
  }
});

test('major >= minor >= floor even when the clock ticks between the two reads', () => {
  // Cesium reads semiMajorAxis, then semiMinorAxis. This is the exact race:
  // the wall clock advances 1ms in between, on every single read pair.
  for (const { name, cycleMs, fn } of RADIUS_FUNCTIONS) {
    let now = 0;
    const axes = ellipseAxes(FakeCesium, () => fn(now));
    const span = cycleMs * 3;
    for (let t = 0; t <= span; t += 1) {
      const time = stamp(t);
      now = t;
      const major = axes.semiMajorAxis.getValue(time);
      now = t + 1; // the millisecond ticks between Cesium's two reads
      const minor = axes.semiMinorAxis.getValue(time);
      assert.ok(major >= minor, `${name} @${t}: major ${major} < minor ${minor}`);
      assert.ok(minor >= MIN_AXIS_M, `${name} @${t}: minor ${minor} under floor`);
    }
  }
});

test('a frame stamp pins both axes to one value', () => {
  let now = 0;
  const look = lookForSignal('FORECLOSURE');
  const axes = ellipseAxes(FakeCesium, () => pulseRadiusM(now, look, false));
  const time = stamp(1234);
  const major = axes.semiMajorAxis.getValue(time);
  now = 999_999; // the source moves a long way...
  assert.equal(axes.semiMinorAxis.getValue(time), major, '...but the frame is the same frame');
  // A new frame is allowed to move.
  now = 1234 + look.periodMs / 2;
  const next = axes.semiMajorAxis.getValue(stamp(now));
  assert.ok(Number.isFinite(next));
});

test('the clamp holds even with no usable frame stamp', () => {
  // Some call paths hand the property no JulianDate at all. Without the memo
  // the compute runs twice — the clamp is what keeps the pair legal.
  let now = 0;
  const look = lookForSignal('FORECLOSURE');
  const axes = ellipseAxes(FakeCesium, () => pulseRadiusM(now, look, false));
  for (let t = 0; t <= 6000; t += 1) {
    now = t;
    const major = axes.semiMajorAxis.getValue(undefined);
    now = t + 1;
    const minor = axes.semiMinorAxis.getValue(undefined);
    assert.ok(major >= minor, `@${t}: major ${major} < minor ${minor}`);
    assert.ok(minor >= MIN_AXIS_M);
  }
});

test('the old two-property shape really did invert — the test can catch it', () => {
  // Guard on the test itself: reproduce the shipped bug and prove this sweep
  // detects it. A sweep that cannot fail proves nothing about the fix.
  const look = lookForSignal('FORECLOSURE');
  let now = 0;
  const major = new FakeCesium.CallbackProperty(() => pulseRadiusM(now, look, false));
  const minor = new FakeCesium.CallbackProperty(() => pulseRadiusM(now, look, false));
  let inversions = 0;
  for (let t = 0; t <= look.periodMs * 3; t += 1) {
    now = t;
    const a = major.getValue(stamp(t));
    now = t + 1;
    const b = minor.getValue(stamp(t));
    if (b > a) inversions += 1;
  }
  assert.ok(inversions > 0, 'the pre-fix shape should invert on the rising half');
});

test('static axes share one value and honour the floor', () => {
  const axes = staticAxes(180 + 3 * 40);
  assert.equal(axes.semiMajorAxis, axes.semiMinorAxis);
  assert.equal(axes.semiMajorAxis, 300);
  // Degenerate inputs cannot produce a zero or negative axis.
  for (const bad of [0, -5, NaN, undefined, null, 'x']) {
    const guarded = staticAxes(bad);
    assert.equal(guarded.semiMajorAxis, MIN_AXIS_M);
    assert.equal(guarded.semiMinorAxis, MIN_AXIS_M);
  }
});

test('a compute that returns garbage still yields a legal ellipse', () => {
  const axes = ellipseAxes(FakeCesium, () => NaN);
  const time = stamp(10);
  const major = axes.semiMajorAxis.getValue(time);
  const minor = axes.semiMinorAxis.getValue(time);
  assert.equal(major, MIN_AXIS_M);
  assert.equal(minor, MIN_AXIS_M);
  assert.ok(major >= minor);
});
