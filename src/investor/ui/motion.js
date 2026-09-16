/**
 * Motion primitives for the investor chrome.
 *
 * Every UI element enters and leaves on a spring. Not "ease-out": a damped
 * spring, sampled into a CSS `linear()` easing so the browser plays it on the
 * compositor and nothing in JS ticks per frame. The sampler is pure, so the
 * curve's shape — starts at 0, ends at 1, overshoots a little and settles —
 * is asserted in a test rather than eyeballed.
 *
 * `countUp` is the one thing that does tick: a dollar figure climbing to its
 * value over 400 ms, with the text written straight onto the node.
 */

/** The one spring the chrome uses. Tuned for a card, not a ball. */
export const SPRING = Object.freeze({
  stiffness: 170,
  damping: 18,
  mass: 1,
  /** How long the sampled curve runs, which is also the transition duration. */
  durationMs: 520,
});

/** Leave springs are firmer and quicker: the thing is going, not arriving. */
export const SPRING_OUT = Object.freeze({
  stiffness: 260, damping: 26, mass: 1, durationMs: 260,
});

/** The dollar count-up. */
export const COUNT_UP_MS = 400;
/** How long the leader line from the house to its card stays. */
export const LEADER_MS = 600;
/** Score rings sweep in over this long. */
export const RING_SWEEP_MS = 700;

/** A cubic-bezier that stands in for the spring where `linear()` is unsupported. */
export const SPRING_FALLBACK = 'cubic-bezier(0.22, 1.28, 0.36, 1)';
export const SPRING_OUT_FALLBACK = 'cubic-bezier(0.4, 0, 0.6, 1)';

/**
 * Position of a critically- or under-damped spring at time `t` (seconds),
 * released from 0 towards 1 with no initial velocity. Closed form, so the
 * sampler is cheap and exact.
 */
export function springAt(t, { stiffness = SPRING.stiffness, damping = SPRING.damping, mass = SPRING.mass } = {}) {
  if (!(t > 0)) return 0;
  const w0 = Math.sqrt(stiffness / mass);
  const zeta = damping / (2 * Math.sqrt(stiffness * mass));
  if (zeta < 1) {
    const wd = w0 * Math.sqrt(1 - zeta * zeta);
    const decay = Math.exp(-zeta * w0 * t);
    return 1 - decay * (Math.cos(wd * t) + (zeta * w0 / wd) * Math.sin(wd * t));
  }
  if (zeta === 1) return 1 - Math.exp(-w0 * t) * (1 + w0 * t);
  const s1 = -w0 * (zeta - Math.sqrt(zeta * zeta - 1));
  const s2 = -w0 * (zeta + Math.sqrt(zeta * zeta - 1));
  return 1 - (s2 * Math.exp(s1 * t) - s1 * Math.exp(s2 * t)) / (s2 - s1);
}

/**
 * Sample the spring into `linear(...)` stops over its duration.
 *
 * The last stop is pinned to exactly 1 so a transition lands on its final
 * value rather than a hair off it. Stops are rounded to four places: the
 * string is written into a stylesheet once and never parsed by us again.
 */
export function springLinearEasing(spring = SPRING, { samples = 40 } = {}) {
  const seconds = spring.durationMs / 1000;
  const stops = [];
  for (let i = 0; i <= samples; i += 1) {
    const t = (i / samples) * seconds;
    const value = i === samples ? 1 : springAt(t, spring);
    stops.push(Number(value.toFixed(4)).toString());
  }
  return `linear(${stops.join(', ')})`;
}

/** Does this browser accept `linear()` easing? */
export function supportsLinearEasing(css = globalThis.CSS) {
  try {
    return Boolean(css?.supports?.('transition-timing-function', 'linear(0, 1)'));
  } catch {
    return false;
  }
}

/**
 * Install the springs as custom properties on the root element, once.
 *
 * `--ts-spring` and `--ts-spring-out` carry either the sampled curve or the
 * cubic-bezier stand-in; the stylesheet only ever refers to the variables.
 */
export function installSpringEasing(root = globalThis.document?.documentElement, css = globalThis.CSS) {
  if (!root?.style) return null;
  const linear = supportsLinearEasing(css);
  const spring = linear ? springLinearEasing(SPRING) : SPRING_FALLBACK;
  const out = linear ? springLinearEasing(SPRING_OUT) : SPRING_OUT_FALLBACK;
  root.style.setProperty('--ts-spring', spring);
  root.style.setProperty('--ts-spring-out', out);
  root.style.setProperty('--ts-spring-ms', `${SPRING.durationMs}ms`);
  root.style.setProperty('--ts-spring-out-ms', `${SPRING_OUT.durationMs}ms`);
  root.style.setProperty('--ts-ring-ms', `${RING_SWEEP_MS}ms`);
  return { linear, spring, out };
}

/** Ease-out cubic, for the count-up: fast at first, settling on the number. */
export function easeOutCubic(t) {
  const x = Math.min(1, Math.max(0, t));
  return 1 - (1 - x) ** 3;
}

/**
 * The value a count-up shows at `elapsedMs`, from `from` to `to`.
 * Pure, so the 400 ms and the ease are tested without a frame loop.
 */
export function countUpValueAt(elapsedMs, from, to, durationMs = COUNT_UP_MS) {
  const start = Number(from) || 0;
  const end = Number(to) || 0;
  if (!(durationMs > 0) || elapsedMs >= durationMs) return end;
  if (!(elapsedMs > 0)) return start;
  return start + (end - start) * easeOutCubic(elapsedMs / durationMs);
}

/**
 * Animate a node's text from one number to another.
 *
 * @param {Element} node
 * @param {{from:number, to:number, format:Function, durationMs?:number,
 *   raf?:Function, now?:Function, reduced?:boolean}} options
 * @returns {{cancel:Function}}
 */
export function countUp(node, {
  from, to, format, durationMs = COUNT_UP_MS,
  raf = globalThis.requestAnimationFrame, now = () => performance.now(), reduced = false,
}) {
  const fmt = typeof format === 'function' ? format : String;
  if (!node) return { cancel() {} };
  if (reduced || typeof raf !== 'function' || !(durationMs > 0) || from === to) {
    node.textContent = fmt(to);
    return { cancel() {} };
  }
  let cancelled = false;
  const startedAt = now();
  const step = () => {
    if (cancelled) return;
    const elapsed = now() - startedAt;
    const value = countUpValueAt(elapsed, from, to, durationMs);
    node.textContent = fmt(value);
    if (elapsed < durationMs) raf(step);
    else node.textContent = fmt(to);
  };
  node.textContent = fmt(from);
  raf(step);
  return { cancel() { cancelled = true; node.textContent = fmt(to); } };
}

/**
 * Play a spring entrance on an element with the Web Animations API.
 *
 * The element's resting position is whatever its styles say; the animation
 * is a *delta* from `from` (an offset in px and an optional scale) to rest,
 * so repositioning the element while it enters does not fight the spring.
 */
export function springIn(el, { dx = 0, dy = 0, scale = 0.96, reduced = false, easing = null, durationMs = SPRING.durationMs } = {}) {
  if (!el?.animate || reduced) {
    if (el?.style) el.style.opacity = '';
    return null;
  }
  const curve = easing || readVar(el, '--ts-spring') || SPRING_FALLBACK;
  try {
    return el.animate([
      { transform: `translate(${dx}px, ${dy}px) scale(${scale})`, opacity: 0 },
      { transform: 'translate(0px, 0px) scale(1)', opacity: 1 },
    ], { duration: durationMs, easing: curve, fill: 'none' });
  } catch {
    return null;
  }
}

/** The matching exit. Resolves when it is done (or at once under reduced motion). */
export function springOut(el, { dx = 0, dy = 0, scale = 0.96, reduced = false, easing = null, durationMs = SPRING_OUT.durationMs } = {}) {
  if (!el?.animate || reduced) return Promise.resolve(null);
  const curve = easing || readVar(el, '--ts-spring-out') || SPRING_OUT_FALLBACK;
  try {
    const animation = el.animate([
      { transform: 'translate(0px, 0px) scale(1)', opacity: 1 },
      { transform: `translate(${dx}px, ${dy}px) scale(${scale})`, opacity: 0 },
    ], { duration: durationMs, easing: curve, fill: 'forwards' });
    return (animation.finished || Promise.resolve()).then(() => animation, () => animation);
  } catch {
    return Promise.resolve(null);
  }
}

function readVar(el, name) {
  try {
    const value = globalThis.getComputedStyle?.(el)?.getPropertyValue?.(name)?.trim();
    return value || null;
  } catch {
    return null;
  }
}
