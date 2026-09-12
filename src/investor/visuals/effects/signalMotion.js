/**
 * The near-field motion model: tempos, brightness envelopes, dim rules, and
 * the altitude at which this layer takes over from the sprites.
 *
 * Pure functions only — no Cesium, no clock, no state. Everything here is a
 * function of (signal type, seconds, selection state), which is what makes the
 * whole motion design unit-testable. `nearFieldEffects.js` is the Cesium half
 * and imports this; nothing here imports that.
 *
 * ## Where each animation actually runs
 *
 * One clock drives all of it (see `createEffectClock`), and it reaches the GPU
 * as material uniforms. The work is split by whether an effect varies across
 * the *geometry* or only over *time*:
 *
 *   - **Over time only** — brightness, glow width, alpha. Computed here on the
 *     CPU, once per property per frame, and written as scalar uniforms. Cheap,
 *     deterministic, and testable, which is why the envelopes live in JS.
 *   - **Across the geometry** — the segment travelling around the LISTED
 *     parcel and the wave climbing a TAX_SALE column. These need a value per
 *     *fragment*, which the CPU cannot supply, so the shaders read the shared
 *     `time` uniform and the constant speed/width uniforms set here.
 *
 * Either way it is a uniform write. No geometry is rebuilt after `build()`, and
 * there is no `CallbackProperty` anywhere in this layer — that machinery makes
 * Cesium re-evaluate a property every frame on the main thread, which is the
 * cost this design exists to avoid.
 */

import { SIGNAL_LOOK } from '../propertyPulse.js';
import { GOLD } from '../goldHalo.js';

/**
 * The sprites read at altitude and the effects read on the ground, and both
 * at once is noise. 1,500 m is a little above CRUISE (1,800 m) and well above
 * the six-house scene (900 m), so the handover happens during a descent rather
 * than while the camera sits still.
 */
export const NEAR_FIELD_MAX_HEIGHT_M = 1_500;
/** Hysteresis, so a camera hovering at the boundary cannot flicker the layer. */
export const NEAR_FIELD_HYSTERESIS_M = 120;

/** Outline alpha for a property the current shortlist did not include. */
export const QUIET_ALPHA = 0.25;
/** Outline alpha for everything that is not the focused property. */
export const DIM_ALPHA = 0.35;

/** The gold breath never reaches zero: the top pick is never off. */
export const GOLD_BREATH_MIN = 0.55;
export const GOLD_BREATH_MAX = 1.0;
export const GOLD_BREATH_PERIOD_S = 3.0;

/**
 * Glow half-width in pixels, at rest and at the top of a beat.
 *
 * These started at 6–15 px and drew a lot line like a rope. Draped on
 * photogrammetry a wide ribbon also picks up every bush and neighbouring roof
 * it crosses, so the thing that should read as a surveyed edge reads as a
 * jagged smear. A parcel edge is a *line*: a bright couple of pixels with a
 * soft halo around it.
 */
export const GLOW_WIDTH_MIN_PX = 1.6;
export const GLOW_WIDTH_MAX_PX = 4.2;
/** The gold outline carries a wider, softer halo than a signal outline. */
export const GOLD_GLOW_WIDTH_PX = 6;

/** How tall the column stands and how far up it fades to nothing. */
export const COLUMN_HEIGHT_M = 120;
/** Below this camera range the column is in the way of the house it marks. */
export const COLUMN_FADE_NEAR_M = 150;
/** By this range it is the only thing that says which roof is which. */
export const COLUMN_FADE_FAR_M = 900;
/**
 * A column is a closed wall, so a line of sight through it crosses the near
 * face and the far face — and an L-shaped roof crosses four or six. Those
 * translucent surfaces stack, so the alpha a single face carries has to be well
 * under what the column should look like in total. At 0.42 the HERO shot was a
 * solid gold slab standing in front of the house it was pointing at.
 */
export const COLUMN_ALPHA_NEAR = 0.015;
export const COLUMN_ALPHA_FAR = 0.16;

/**
 * Near-field colour per signal.
 *
 * Four of the five are the far-field sprite colours unchanged, so a house does
 * not change identity as the camera drops. LISTED_OPPORTUNITY is the exception:
 * its sprite blue disappears against Google's aerial imagery of a shaded street
 * once it is a thin line on the ground, so the near field uses cyan. The sprite
 * palette is deliberately left alone — `propertyPulse.js` is the far field.
 */
export const EFFECT_COLORS = Object.freeze({
  FORECLOSURE: Object.freeze(SIGNAL_LOOK.FORECLOSURE.color.slice(0, 3)),
  PREFORECLOSURE: Object.freeze(SIGNAL_LOOK.PREFORECLOSURE.color.slice(0, 3)),
  TAX_SALE: Object.freeze(SIGNAL_LOOK.TAX_SALE.color.slice(0, 3)),
  DISTRESS: Object.freeze(SIGNAL_LOOK.DISTRESS.color.slice(0, 3)),
  LISTED_OPPORTUNITY: Object.freeze([0.16, 0.86, 0.92]),
});

export const EFFECT_GOLD = Object.freeze([GOLD.r, GOLD.g, GOLD.b]);

/**
 * One motion per signal. `periodS` is a full cycle; every one is ≥ 2.2 s,
 * which is the no-strobe floor the product has held since Phase 1.
 *
 * `floor` and `ceil` bound the brightness this type can reach, so a restrained
 * signal stays restrained no matter what its envelope does. `travelPerSec` and
 * `wavePerSec` are handed to the shaders for the two effects that move across
 * the geometry rather than merely over time.
 */
export const MOTION = Object.freeze({
  FORECLOSURE: Object.freeze({
    kind: 'heartbeat', periodS: 3.4, floor: 0.30, ceil: 1.00,
    travelPerSec: 0, wavePerSec: 0,
  }),
  PREFORECLOSURE: Object.freeze({
    kind: 'twoPulse', periodS: 4.0, floor: 0.34, ceil: 0.82,
    travelPerSec: 0, wavePerSec: 0,
  }),
  TAX_SALE: Object.freeze({
    kind: 'rise', periodS: 2.8, floor: 0.38, ceil: 0.95,
    travelPerSec: 0, wavePerSec: 0.36,
  }),
  DISTRESS: Object.freeze({
    kind: 'shimmer', periodS: 3.6, floor: 0.40, ceil: 0.70,
    travelPerSec: 0, wavePerSec: 0,
  }),
  LISTED_OPPORTUNITY: Object.freeze({
    kind: 'steady', periodS: 4.4, floor: 0.46, ceil: 0.62,
    travelPerSec: 0.22, wavePerSec: 0,
  }),
});

export function motionFor(type) {
  return MOTION[type] || MOTION.DISTRESS;
}

export function colorFor(type) {
  return EFFECT_COLORS[type] || EFFECT_COLORS.DISTRESS;
}

function clamp01(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return n < 0 ? 0 : n > 1 ? 1 : n;
}

/** Phase 0..1 within a period, safe for negative and non-finite clocks. */
export function phaseOf(seconds, periodS) {
  const period = Math.max(0.1, Number(periodS) || 1);
  const elapsed = Number(seconds);
  if (!Number.isFinite(elapsed)) return 0;
  return (((elapsed % period) + period) % period) / period;
}

/** A soft half-sine bump of width `w` centred at `centre`, 0 outside it. */
function bump(t, centre, w) {
  const d = Math.abs(t - centre);
  if (d >= w) return 0;
  return Math.cos((d / w) * (Math.PI / 2)) ** 2;
}

/**
 * Envelope value in [0,1] for a motion kind at a phase in [0,1].
 *
 * Every branch is bounded by construction — sums of bumps that do not overlap,
 * or cosines already in range — and `nearField.test.mjs` sweeps all of them at
 * 1 ms resolution over several cycles to prove it rather than trusting it.
 */
export function envelopeFor(kind, phase) {
  const t = clamp01(phase);
  switch (kind) {
    // A slow lub-dub: a strong beat, a weaker one behind it, then a long rest.
    case 'heartbeat':
      return clamp01(bump(t, 0.06, 0.06) + 0.62 * bump(t, 0.20, 0.06));
    // Two gentle pulses, then a pause that is longer than both of them.
    case 'twoPulse':
      return clamp01(0.85 * bump(t, 0.10, 0.10) + 0.85 * bump(t, 0.32, 0.10));
    // A ramp up and a quick release — the outline cue that matches the wave
    // climbing the column.
    case 'rise':
      return t < 0.82 ? clamp01((t / 0.82) ** 1.6) : clamp01(1 - (t - 0.82) / 0.18);
    // Uneven on purpose: two incommensurate rates, so it never lands in the
    // same place twice inside a cycle and never reads as a pulse.
    case 'shimmer':
      return clamp01(
        0.5
        + 0.30 * Math.sin(2 * Math.PI * t)
        + 0.20 * Math.sin(2 * Math.PI * t * 2.618 + 1.1),
      );
    case 'steady':
    default:
      return 0.5;
  }
}

/**
 * Brightness for a signal outline at a moment on the shared clock.
 * @returns {number} inside the type's own [floor, ceil]
 */
export function brightnessFor(type, seconds, { reduced = false } = {}) {
  const motion = motionFor(type);
  const mid = (motion.floor + motion.ceil) / 2;
  if (reduced) return mid;
  const value = envelopeFor(motion.kind, phaseOf(seconds, motion.periodS));
  return motion.floor + (motion.ceil - motion.floor) * clamp01(value);
}

/**
 * The gold breath: the top pick and the focused house. Never fully dark, which
 * is the whole point — a gold outline that blinks off reads as a bug.
 * @returns {number} inside [GOLD_BREATH_MIN, GOLD_BREATH_MAX]
 */
export function goldBreathFor(seconds, { reduced = false } = {}) {
  if (reduced) return GOLD_BREATH_MAX;
  const phase = phaseOf(seconds, GOLD_BREATH_PERIOD_S);
  const wave = (1 - Math.cos(2 * Math.PI * phase)) / 2;
  return GOLD_BREATH_MIN + (GOLD_BREATH_MAX - GOLD_BREATH_MIN) * clamp01(wave);
}

/**
 * Glow half-width in pixels. Width follows the same envelope as brightness, so
 * a beat reads as the line swelling rather than only as it getting paler.
 */
export function glowWidthFor(type, seconds, { reduced = false, gold = false } = {}) {
  if (gold) return GOLD_GLOW_WIDTH_PX;
  const motion = motionFor(type);
  const value = reduced
    ? 0.5
    : clamp01(envelopeFor(motion.kind, phaseOf(seconds, motion.periodS)));
  return GLOW_WIDTH_MIN_PX + (GLOW_WIDTH_MAX_PX - GLOW_WIDTH_MIN_PX) * value;
}

/**
 * Selection state for one outline.
 *
 * Order matters and is the product decision, not an implementation detail:
 * a house the shortlist left out is *quiet* even while another house is
 * focused, because "not an answer to the question you asked" outranks "not the
 * one you are looking at". The focused house and the top pick are never quiet —
 * the same exemption `markerAlphaFor` makes in the far field.
 *
 * A *saved* house is the one exception in between. It does not get gold and it
 * does not get full brightness — it was not the answer to this question — but
 * it never drops to quiet either, because the user already said they wanted to
 * be able to find it again.
 *
 * @returns {{alpha:number, moving:boolean, gold:boolean, focused:boolean}}
 */
export function outlineStateFor(id, {
  shortlistIds = null,
  focusedId = null,
  topPickId = null,
  savedId = null,
} = {}) {
  const privileged = Boolean(id) && (id === focusedId || id === topPickId);
  const hasShortlist = Boolean(shortlistIds && shortlistIds.size);
  if (hasShortlist && !shortlistIds.has(id) && !privileged) {
    const saved = Boolean(id) && id === savedId;
    return {
      alpha: saved ? DIM_ALPHA : QUIET_ALPHA,
      moving: false,
      gold: false,
      focused: false,
    };
  }
  if (focusedId && id !== focusedId) {
    return { alpha: DIM_ALPHA, moving: true, gold: privileged, focused: false };
  }
  return { alpha: 1, moving: true, gold: privileged, focused: id === focusedId };
}

/**
 * Column alpha by camera range.
 *
 * Deliberately the opposite way round from an ordinary distance fade. The
 * column exists to answer "which roof?" from across the neighbourhood, and at
 * HERO the answer is already filling the frame — a light shaft standing in
 * front of the house at 150 m is just something in the way. So it is nearly
 * gone up close and strongest out near the layer's own ceiling.
 *
 * @returns {number} inside [COLUMN_ALPHA_NEAR, COLUMN_ALPHA_FAR]
 */
export function columnAlphaFor(rangeM) {
  const range = Number(rangeM);
  if (!Number.isFinite(range)) return COLUMN_ALPHA_NEAR;
  const t = clamp01((range - COLUMN_FADE_NEAR_M) / (COLUMN_FADE_FAR_M - COLUMN_FADE_NEAR_M));
  // Smoothstep: no visible edge where the ramp starts or stops.
  const eased = t * t * (3 - 2 * t);
  return COLUMN_ALPHA_NEAR + (COLUMN_ALPHA_FAR - COLUMN_ALPHA_NEAR) * eased;
}

/**
 * Should the near-field layer be drawn at this camera height?
 *
 * `wasActive` supplies the hysteresis: once on, the layer stays on until the
 * camera climbs a further NEAR_FIELD_HYSTERESIS_M. Without it a camera parked
 * at exactly 1,500 m — which is where a hand-flown descent tends to pause —
 * builds and tears down thirty primitives on alternate frames.
 */
export function nearFieldActive(heightM, wasActive = false) {
  // `Number(null)` is 0, which is a perfectly good ground-level altitude — so
  // a camera whose `positionCartographic` has not resolved yet would switch the
  // whole layer on while the viewer is still in space. Reject the absence
  // before coercing it.
  if (heightM === null || heightM === undefined || heightM === '') return false;
  const height = Number(heightM);
  if (!Number.isFinite(height)) return false;
  const ceiling = wasActive
    ? NEAR_FIELD_MAX_HEIGHT_M + NEAR_FIELD_HYSTERESIS_M
    : NEAR_FIELD_MAX_HEIGHT_M;
  return height >= 0 && height < ceiling;
}

/**
 * The one clock the whole layer animates on.
 *
 * Not `Date.now()` and not a per-primitive epoch: one object, read once per
 * frame, written to every material as the `time` uniform. A single source is
 * what keeps thirty outlines in phase with each other and lets a flight freeze
 * all of them at once by freezing this.
 */
export function createEffectClock() {
  let epochMs = null;
  let frozenAt = null;
  return {
    /** @param {number} nowMs monotonic milliseconds */
    read(nowMs) {
      const now = Number(nowMs);
      if (!Number.isFinite(now)) return frozenAt ?? 0;
      if (epochMs === null) epochMs = now;
      if (frozenAt !== null) return frozenAt;
      return (now - epochMs) / 1000;
    },
    freeze(nowMs) {
      if (frozenAt !== null) return frozenAt;
      frozenAt = this.read(nowMs);
      return frozenAt;
    },
    thaw(nowMs) {
      const now = Number(nowMs);
      if (frozenAt === null || !Number.isFinite(now)) { frozenAt = null; return; }
      // Resume where it stopped rather than jumping forward by the pause.
      epochMs = now - frozenAt * 1000;
      frozenAt = null;
    },
    get frozen() { return frozenAt !== null; },
    reset() { epochMs = null; frozenAt = null; },
  };
}
