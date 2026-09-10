import { breathe } from './reducedMotionPolicy.js';

export const GOLD = Object.freeze({
  r: 0.93,
  g: 0.74,
  b: 0.22,
});

export function goldHaloAlpha(nowMs, reduced) {
  if (reduced) return 0.55;
  return 0.38 + 0.28 * breathe(nowMs, 3000, 0.15);
}

export function goldColumnHeight(nowMs, reduced) {
  if (reduced) return 90;
  return 70 + 40 * breathe(nowMs, 3000, 0.4);
}

export function isTopPick(property) {
  return (property?.signals || []).some((signal) => signal.type === 'TOP_PICK');
}
