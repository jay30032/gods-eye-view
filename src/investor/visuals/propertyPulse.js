import { breathe } from './reducedMotionPolicy.js';

export const SIGNAL_LOOK = Object.freeze({
  FORECLOSURE: Object.freeze({
    color: [0.55, 0.02, 0.06, 0.92],
    periodMs: 2800,
    scaleMin: 0.88,
    scaleMax: 1.12,
    kind: 'heartbeat',
  }),
  PREFORECLOSURE: Object.freeze({
    color: [0.86, 0.28, 0.08, 0.88],
    periodMs: 3200,
    scaleMin: 0.90,
    scaleMax: 1.10,
    kind: 'breathe',
  }),
  TAX_SALE: Object.freeze({
    color: [0.52, 0.22, 0.86, 0.90],
    periodMs: 2600,
    scaleMin: 0.92,
    scaleMax: 1.08,
    kind: 'vertical',
  }),
  DISTRESS: Object.freeze({
    color: [0.92, 0.62, 0.12, 0.82],
    periodMs: 3600,
    scaleMin: 0.94,
    scaleMax: 1.06,
    kind: 'shimmer',
  }),
  LISTED_OPPORTUNITY: Object.freeze({
    color: [0.18, 0.48, 0.96, 0.88],
    periodMs: 4000,
    scaleMin: 0.96,
    scaleMax: 1.08,
    kind: 'ring',
  }),
});

export function lookForSignal(type) {
  return SIGNAL_LOOK[type] || SIGNAL_LOOK.DISTRESS;
}

export function pulseScale(nowMs, look, reduced) {
  if (reduced) return 1;
  const wave = breathe(nowMs, look.periodMs);
  return look.scaleMin + (look.scaleMax - look.scaleMin) * wave;
}

export function pulseAlpha(nowMs, look, reduced) {
  const base = look.color[3];
  if (reduced) return base;
  if (look.kind === 'shimmer') {
    return 0.55 + 0.27 * breathe(nowMs, look.periodMs, 0.25);
  }
  if (look.kind === 'heartbeat') {
    const wave = breathe(nowMs, look.periodMs);
    return base * (0.78 + 0.22 * wave);
  }
  return base;
}

export function pulseHeight(nowMs, look, reduced, baseHeight = 18) {
  if (reduced || look.kind !== 'vertical') return baseHeight;
  return baseHeight * (0.7 + 0.6 * breathe(nowMs, look.periodMs, 0.1));
}

export function ringRotation(nowMs, look, reduced) {
  if (reduced || look.kind !== 'ring') return 0;
  const period = Math.max(4000, look.periodMs);
  return ((Number(nowMs) || 0) / period) * Math.PI * 2;
}
