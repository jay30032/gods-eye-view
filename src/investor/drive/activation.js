/**
 * What a property looks like from where the drive currently is.
 *
 * Standing still, a board of houses can all shout at once — that is what
 * Opportunity Vision is for. Moving, they cannot: a house 300 m up the road and
 * a house you are drawing level with are answering different questions, and
 * drawing both at full strength means the one you can actually see gets no
 * emphasis at all.
 *
 * So emphasis is a function of **distance ahead along the route**, and it ramps
 * rather than switching, because a house that pops from nothing to full outline
 * at exactly 120 m reads as a rendering glitch rather than as something coming
 * into view:
 *
 * | ahead | what it is |
 * |---|---|
 * | > 200 m | a small beacon. Something is there; that is all. |
 * | 200 → 120 m | still just the beacon, brightening |
 * | 120 → 60 m | the outline fades in |
 * | 60 m → 0 | the useful window: highlight and status motion at full |
 * | passed | fades to 25%, unless saved or selected |
 * | well behind | suspended — nothing drawn at all |
 *
 * `selected` is the exception to all of it: the existing focus treatment wins
 * wherever the camera happens to be, because the user asked for that house.
 *
 * Pure: distance in, weights out. The effects layer does as it is told.
 */

/** Past this there is nothing to look at yet. */
export const FAR_M = 200;
/** The outline starts to arrive here. */
export const APPROACH_M = 120;
/** Close enough to actually look at the building. */
export const USEFUL_M = 60;
/**
 * How far behind the camera a property keeps being drawn.
 *
 * A house that vanishes the instant you pass it reads as a bug; one that is
 * still lit two blocks back is clutter competing with what is ahead. 80 m is
 * about the length of a residential block.
 */
export const BEHIND_M = 80;

/** What a passed house fades to. */
export const PASSED_ALPHA = 0.25;
/** A saved house never drops below this, passed or not. */
export const SAVED_ALPHA = 0.45;

export const STATES = Object.freeze({
  SELECTED: 'selected',
  USEFUL: 'useful',
  APPROACHING: 'approaching',
  FAR: 'far',
  PASSED: 'passed',
  SUSPENDED: 'suspended',
});

function clamp01(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return n < 0 ? 0 : n > 1 ? 1 : n;
}

/** Smoothstep from a to b — no visible edge where a ramp starts or stops. */
function ramp(value, from, to) {
  if (from === to) return value >= to ? 1 : 0;
  const t = clamp01((value - from) / (to - from));
  return t * t * (3 - 2 * t);
}

/**
 * How a property should be drawn, given where the drive is.
 *
 * @param {{aheadM:number, selected?:boolean, saved?:boolean}} input
 *   `aheadM` is signed: positive ahead, negative already passed.
 * @returns {{state:string, beacon:number, outline:number, highlight:number,
 *   motion:number, alpha:number, suspended:boolean}} every weight in [0,1]
 */
export function activationFor({ aheadM, selected = false, saved = false } = {}) {
  // The focused house is the focused house. The drive does not get to dim the
  // thing the user just asked to look at because it happens to be behind.
  if (selected) {
    return {
      state: STATES.SELECTED,
      beacon: 1,
      outline: 1,
      highlight: 1,
      motion: 1,
      alpha: 1,
      suspended: false,
    };
  }

  // Reject the absence BEFORE coercing it. `Number(null)` is 0, which is a
  // perfectly good "you are drawing level with it" — so a missing distance
  // would light a house at full strength rather than report that there is no
  // distance. This is the third place in this codebase that trap has appeared,
  // after `nearFieldActive` and `scanEnvelopeFor`; it is always the same shape.
  if (aheadM === null || aheadM === undefined || aheadM === '') {
    return {
      state: STATES.SUSPENDED,
      beacon: 0,
      outline: 0,
      highlight: 0,
      motion: 0,
      alpha: 0,
      suspended: true,
    };
  }
  const ahead = Number(aheadM);
  if (!Number.isFinite(ahead)) {
    return {
      state: STATES.SUSPENDED,
      beacon: 0,
      outline: 0,
      highlight: 0,
      motion: 0,
      alpha: 0,
      suspended: true,
    };
  }

  if (ahead < -BEHIND_M) {
    // Behind the camera and out of the rear-view. Suspended rather than merely
    // transparent: this is the cheap half of the frame budget on a board where
    // most of the route is behind you most of the time.
    return {
      state: STATES.SUSPENDED,
      beacon: 0,
      outline: 0,
      highlight: 0,
      motion: 0,
      alpha: saved ? SAVED_ALPHA : 0,
      suspended: !saved,
    };
  }

  if (ahead < 0) {
    const alpha = saved ? SAVED_ALPHA : PASSED_ALPHA;
    // Fading out over the block behind, not cutting at the instant of passing.
    const fade = 1 - ramp(-ahead, 0, BEHIND_M);
    return {
      state: STATES.PASSED,
      beacon: alpha * fade,
      outline: alpha * fade,
      highlight: 0,
      motion: 0,
      alpha: alpha * fade,
      suspended: false,
    };
  }

  // The beacon is the one thing visible at every distance — it is how a house
  // announces itself before there is anything to look at.
  const beacon = ahead > FAR_M ? 1 : 1;
  // Outline arrives across the approach band, full by the useful window.
  const outline = 1 - ramp(ahead, USEFUL_M, APPROACH_M);
  // Highlight and motion only inside the useful window, and they come up over
  // its outer half rather than switching on at 60 m exactly.
  const inUseful = 1 - ramp(ahead, USEFUL_M * 0.5, USEFUL_M);

  let state = STATES.FAR;
  if (ahead <= USEFUL_M) state = STATES.USEFUL;
  else if (ahead <= APPROACH_M) state = STATES.APPROACHING;

  return {
    state,
    beacon,
    outline,
    highlight: inUseful,
    motion: inUseful,
    alpha: Math.max(saved ? SAVED_ALPHA : 0, Math.max(outline, inUseful, 0.35)),
    suspended: false,
  };
}

/**
 * The whole board's activation in one pass.
 *
 * @param {Array<{id:string, alongM:number}>} projected properties already
 *   projected onto the route
 * @param {{alongM:number, selectedId?:string, savedIds?:Set|Array,
 *   signedAhead:Function}} state
 * @returns {Map<string, object>} id → activation
 */
export function activationsFor(projected, {
  alongM,
  selectedId = null,
  savedIds = null,
  signedAhead,
} = {}) {
  const saved = savedIds instanceof Set
    ? savedIds
    : new Set(Array.isArray(savedIds) ? savedIds : []);
  const out = new Map();
  for (const row of projected || []) {
    if (!row?.id) continue;
    const ahead = typeof signedAhead === 'function'
      ? signedAhead(alongM, row.alongM)
      : row.alongM - alongM;
    out.set(row.id, activationFor({
      aheadM: ahead,
      selected: row.id === selectedId,
      saved: saved.has(row.id),
    }));
  }
  return out;
}

/**
 * How much to slow down for a property being explained.
 *
 * The drive is not a vehicle and the speed is not a speed limit — it is
 * playback. When the assistant is talking about a house, the playback slows so
 * the house is still on screen when the sentence ends. 40% within 70 m, easing
 * in over the approach rather than braking.
 *
 * @returns {number} a multiplier in [SLOW_FACTOR, 1]
 */
export const SLOW_RADIUS_M = 70;
export const SLOW_FACTOR = 0.4;

export function speedScaleFor(aheadM, { discussing = false } = {}) {
  if (!discussing) return 1;
  const ahead = Math.abs(Number(aheadM));
  if (!Number.isFinite(ahead) || ahead > SLOW_RADIUS_M) return 1;
  // Full slow at the house, easing back to normal by the edge of the radius.
  const nearness = 1 - ramp(ahead, 0, SLOW_RADIUS_M);
  return 1 - (1 - SLOW_FACTOR) * nearness;
}
