/**
 * Keep the user's camera inside a watchable pitch band.
 *
 * Scroll-zoom and drag stay fully enabled, but Cesium will happily let someone
 * tip past level (looking up at the sky from 100 m) or flatten to a top-down
 * paper map, and neither reads as the product. The clamp only ever applies to
 * camera state the *user* produced: director flights own the camera while they
 * run, and the parked globe and staging shots are deliberately nadir.
 */

/** Shots whose framing is intentionally outside the band. */
export const UNCLAMPED_SHOTS = Object.freeze(['WORLD', 'STAGING', 'HOP']);

export const PITCH_MIN_DEG = -70;
export const PITCH_MAX_DEG = -20;

/** @returns {number} the pitch to use, in degrees */
export function clampPitchDeg(pitchDeg, { min = PITCH_MIN_DEG, max = PITCH_MAX_DEG } = {}) {
  const n = Number(pitchDeg);
  if (!Number.isFinite(n)) return max;
  return Math.min(max, Math.max(min, n));
}

export function pitchNeedsClamp(pitchDeg, options) {
  const n = Number(pitchDeg);
  if (!Number.isFinite(n)) return true;
  return clampPitchDeg(n, options) !== n;
}

/**
 * Whether the clamp applies at all right now.
 * @param {{shot?:string, flying?:boolean}} state
 */
export function clampApplies({ shot, flying } = {}) {
  if (flying) return false;
  return !UNCLAMPED_SHOTS.includes(String(shot || ''));
}
