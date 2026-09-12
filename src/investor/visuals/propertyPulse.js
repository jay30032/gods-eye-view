/**
 * How each signal type looks and how fast it reads.
 *
 * This used to also compute ellipse radii in metres. Those went with the
 * ellipses — markers are sized in screen space now (see markers.js), and the
 * only thing that belongs here is the per-signal identity.
 */
export const SIGNAL_LOOK = Object.freeze({
  FORECLOSURE: Object.freeze({
    color: [0.55, 0.02, 0.06, 0.92],
    periodMs: 2800,
    kind: 'heartbeat',
  }),
  PREFORECLOSURE: Object.freeze({
    color: [0.86, 0.28, 0.08, 0.88],
    periodMs: 3200,
    kind: 'breathe',
  }),
  TAX_SALE: Object.freeze({
    color: [0.52, 0.22, 0.86, 0.90],
    periodMs: 2600,
    kind: 'vertical',
  }),
  DISTRESS: Object.freeze({
    color: [0.92, 0.62, 0.12, 0.82],
    periodMs: 3600,
    kind: 'shimmer',
  }),
  LISTED_OPPORTUNITY: Object.freeze({
    color: [0.18, 0.48, 0.96, 0.88],
    periodMs: 4000,
    kind: 'ring',
  }),
});

export function lookForSignal(type) {
  return SIGNAL_LOOK[type] || SIGNAL_LOOK.DISTRESS;
}
