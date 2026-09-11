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

/** The single radius both halo ellipse axes use. */
export function goldHaloRadiusM(nowMs, reduced) {
  return 26 + 6 * (reduced ? 0 : goldHaloAlpha(nowMs, reduced));
}

export function goldColumnHeight(nowMs, reduced) {
  if (reduced) return 90;
  return 70 + 40 * breathe(nowMs, 3000, 0.4);
}

/**
 * Gold is a ranking result, not a property of a house. The session sets the
 * winner with `setTopPick(id)` after "Find me money"; nothing in the data can
 * paint itself gold.
 */
export function isTopPick(propertyId, topPickId) {
  return Boolean(topPickId) && String(propertyId) === String(topPickId);
}
