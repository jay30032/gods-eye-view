import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PITCH_MAX_DEG,
  PITCH_MIN_DEG,
  UNCLAMPED_SHOTS,
  clampApplies,
  clampPitchDeg,
  pitchNeedsClamp,
} from './pitchClamp.js';

test('the band is -70 to -20 and holds at both ends', () => {
  assert.equal(PITCH_MIN_DEG, -70);
  assert.equal(PITCH_MAX_DEG, -20);
  assert.equal(clampPitchDeg(-45), -45, 'inside the band is untouched');
  assert.equal(clampPitchDeg(-70), -70);
  assert.equal(clampPitchDeg(-20), -20);
  assert.equal(clampPitchDeg(-90), -70, 'top-down flattens to the floor');
  assert.equal(clampPitchDeg(-5), -20, 'nearly level tips back down');
  assert.equal(clampPitchDeg(10), -20, 'looking at the sky is never allowed');
  assert.equal(clampPitchDeg(0), -20, 'dead level is not a shot');
});

test('a garbage pitch resolves to the shallow end rather than NaN', () => {
  for (const bad of [NaN, undefined, null, 'x', Infinity]) {
    const value = clampPitchDeg(bad);
    assert.ok(Number.isFinite(value), `${bad} produced ${value}`);
    assert.equal(value, PITCH_MAX_DEG);
  }
});

test('every shipped shot pitch lands inside the band after clamping', () => {
  for (let pitch = -90; pitch <= 20; pitch += 1) {
    const clamped = clampPitchDeg(pitch);
    assert.ok(clamped >= PITCH_MIN_DEG && clamped <= PITCH_MAX_DEG, `${pitch} -> ${clamped}`);
  }
});

test('needsClamp only fires outside the band', () => {
  assert.equal(pitchNeedsClamp(-45), false);
  assert.equal(pitchNeedsClamp(-20), false);
  assert.equal(pitchNeedsClamp(-70), false);
  assert.equal(pitchNeedsClamp(-71), true);
  assert.equal(pitchNeedsClamp(-19), true);
});

test('the clamp never fights a flight or a deliberately nadir shot', () => {
  // A director flight owns the camera outright.
  assert.equal(clampApplies({ shot: 'HERO', flying: true }), false);
  assert.equal(clampApplies({ shot: 'CRUISE', flying: true }), false);
  // WORLD and STAGING are -90 on purpose; HOP passes through -60 mid-arc.
  for (const shot of UNCLAMPED_SHOTS) {
    assert.equal(clampApplies({ shot, flying: false }), false, shot);
  }
  // Everywhere else, a settled camera is the user's and gets clamped.
  for (const shot of ['CRUISE', 'REVEAL', 'HERO', 'DRIVE']) {
    assert.equal(clampApplies({ shot, flying: false }), true, shot);
  }
  assert.equal(clampApplies({}), true, 'unknown settled state still clamps');
});
