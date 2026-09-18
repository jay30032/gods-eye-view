/**
 * Opportunity Vision never strobes. prefers-reduced-motion freezes every
 * pulse, shimmer, and sweep to a static color/pose.
 */

export function prefersReducedMotion(media = globalThis.matchMedia) {
  try {
    if (typeof media !== 'function') return false;
    return Boolean(media('(prefers-reduced-motion: reduce)')?.matches);
  } catch {
    return false;
  }
}

export function createReducedMotionPolicy({ media = globalThis.matchMedia, onChange } = {}) {
  let reduced = prefersReducedMotion(media);
  let mq = null;
  const listeners = new Set();
  if (typeof onChange === 'function') listeners.add(onChange);

  const emit = () => {
    for (const listener of listeners) {
      try { listener(reduced); } catch { /* ignore */ }
    }
  };

  try {
    mq = typeof media === 'function' ? media('(prefers-reduced-motion: reduce)') : null;
    mq?.addEventListener?.('change', (event) => {
      reduced = Boolean(event.matches);
      emit();
    });
  } catch {
    mq = null;
  }

  return {
    get reduced() { return reduced; },
    subscribe(listener) {
      if (typeof listener === 'function') listeners.add(listener);
      return () => listeners.delete(listener);
    },
    destroy() {
      listeners.clear();
    },
  };
}

/** Slow sine in 0..1. Periods stay ≥ 2.2s so nothing strobes. */
export function breathe(nowMs, periodMs, phase = 0) {
  const period = Math.max(2200, Number(periodMs) || 2800);
  const t = ((Number(nowMs) || 0) / period) + phase;
  return 0.5 + 0.5 * Math.sin(t * Math.PI * 2);
}
