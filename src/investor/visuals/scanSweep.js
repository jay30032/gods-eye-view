import { breathe } from './reducedMotionPolicy.js';

/**
 * One-shot market scan: expanding ring over the hunt area.
 * Lifetime is bounded; the visual manager releases the governor hold after.
 */
export const SCAN_DURATION_MS = 4200;

export function scanProgress(startedAt, nowMs, reduced) {
  if (reduced) return 1;
  const elapsed = Math.max(0, (Number(nowMs) || 0) - (Number(startedAt) || 0));
  return Math.min(1, elapsed / SCAN_DURATION_MS);
}

export function scanRadiusM(progress, maxRadiusM = 4200) {
  const p = Math.max(0, Math.min(1, Number(progress) || 0));
  return maxRadiusM * (0.12 + 0.88 * p);
}

export function scanAlpha(progress, nowMs, reduced) {
  if (reduced) return 0;
  const p = Math.max(0, Math.min(1, Number(progress) || 0));
  const fade = 1 - p;
  return Math.max(0, fade * (0.18 + 0.08 * breathe(nowMs, 2400)));
}

export function scanIsActive(startedAt, nowMs, reduced) {
  if (reduced) return false;
  return scanProgress(startedAt, nowMs, reduced) < 1;
}
