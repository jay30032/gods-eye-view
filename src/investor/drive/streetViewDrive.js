/**
 * Drive Mode v2 — Street View is the driving view.
 *
 * Drive Mode v1 drove a chase camera 55 m over the road because that was the
 * only camera there was. It reads as a drive, but it is a drive nobody has ever
 * taken: an investor looking at a street looks *along* it from a car, and what
 * they are reading — the roofline, the porch, the fence, whether the grass has
 * been cut — is not legible from above the canopy. So the driving view is now a
 * `StreetViewPanorama`, and the 3D scene stops being the view and becomes the
 * **answer engine**: it is what the product cuts to when a question needs a lot
 * line, a roof, or a block.
 *
 * ## What this module is and is not
 *
 * It is a consumer of the position source, exactly like the chase camera. It
 * takes fixes and moves a panorama; it decides nothing about narration,
 * activation or which house is being discussed. `driveDemo.js` still owns all
 * of that, and still reads the source rather than the spline — which is why a
 * GPS drive and a playback drive resolve the same panoramas in the same order.
 *
 * ## The imagery is Google's and is never touched
 *
 * Nothing here reads a pixel. There is no canvas, no `toDataURL`, no fetch of a
 * tile, no store of a panorama beyond the id currently being displayed, and no
 * derived product of any frame. The panorama element renders itself and carries
 * Google's own attribution and Terms link, and `ensureStreetViewHost` is
 * deliberately written so no drive stylesheet can hide them — see
 * `ATTRIBUTION_GUARD_CSS`. The only thing this module sends to Google is a
 * coordinate and a heading.
 *
 * ## Why it is double-buffered
 *
 * The first cut moved one panorama with `setPano`, which plays Google's own
 * transition: a blur, a zoom, and a re-resolve. Every hop read as a break. A
 * drive is a continuous shot, and a continuous shot cannot be assembled out of
 * something that announces each of its joins.
 *
 * So there are **two** panoramas stacked in the host. The one you are looking
 * at never receives `setPano` — it holds a settled image and Google has no
 * reason to transition it. The hidden one loads the next panorama while you are
 * still looking at the previous, and the hop is a 300 ms opacity cross-fade
 * between the two with a dolly on both. Then the roles swap and the layer you
 * just left preloads the one after. A queue runs two panoramas ahead so the
 * next one is always already there.
 *
 * ## Why the cadence is time and not distance
 *
 * v2 resolved a panorama every 10 m of route. That is the right way to *ask*
 * for panoramas and the wrong way to *show* them: real panorama spacing along a
 * street is irregular — 5 m here, 18 m there — so hopping on arrival gives an
 * irregular rhythm, and irregular motion is exactly what the eye reads as a
 * stutter. The hop now fires on a **constant interval derived from playback
 * speed**, and the spacing between the panoramas asked for stretches or shrinks
 * to keep the picture in step with the road. Regular rhythm, correct pacing.
 *
 * ## Why the dolly is a canvas transform and not `setZoom`
 *
 * `panorama.setZoom()` looked like the honest way to dolly — a real FOV change
 * in the panorama's own optics, leaving Google's chrome alone. It does not
 * work: **fractional zoom is snapped to integers.** Measured, `setZoom(1.0704)`
 * followed by `getZoom()` returns `1.0`, and the picture does not move. The
 * only fractional zoom Street View has is a whole level, which is not a dolly,
 * it is a jump.
 *
 * A CSS transform on the *layer* is the obvious alternative and clips Google's
 * attribution: it sits flush to the bottom edge, and a 1.05 scale about the
 * centre pushes a 14 px strip 22 px below the viewport. So the transform goes
 * on the layer's **canvases**, which are the imagery and nothing else. Measured:
 * at `scale(1.12)` the scene canvas goes from `1440x900` at `(0, 0)` to
 * `1613x1008` at `(-86, -54)` — a true centred dolly — while every attribution
 * node stays at exactly the pixel it was on, because Google's chrome is DOM
 * overlaid on the canvas rather than drawn into it. The transform also survives
 * a live panorama: Google does not rewrite it.
 */

import {
  deltaDeg,
  normalizeDeg,
  pointAt,
  signedAheadM,
  smoothHeading,
  toLocal,
  wrapDistance,
} from './route.js';
import { SIGNAL_LOOK } from '../visuals/propertyPulse.js';
import { GOLD } from '../visuals/goldHalo.js';
import { primarySignal } from '../mock/schema.js';
import { shortAddress } from '../visuals/markers.js';

// ---------------------------------------------------------------------------
// The numbers
// ---------------------------------------------------------------------------

/**
 * Nominal spacing between the panoramas the drive hops along, in metres.
 *
 * Not a measurement of the street — it is the distance the hop interval is
 * derived from, and the actual probe spacing stretches or shrinks around it so
 * the picture keeps pace with the road at any playback speed. Residential
 * Street View sits at roughly this, which is why it is the number the rhythm is
 * built on rather than an arbitrary one.
 */
export const PANO_SPACING_M = 10;
/** How far from the route point a panorama may sit and still be this one. */
export const PANO_RADIUS_M = 25;
/**
 * How much route may pass with no panorama before the drive gives up and falls
 * back to the 3D chase camera. Four consecutive misses at the 10 m cadence.
 */
export const COVERAGE_GAP_M = 40;
/** Signal properties get a pin inside the panorama within this range. */
export const MARKER_RADIUS_M = 120;
/** The POV starts easing towards a discussed house at this range. */
export const POV_EASE_RADIUS_M = 60;
/** And eases back to the direction of travel over this much road past it. */
export const POV_RELEASE_M = 25;
/**
 * The POV never turns further off the direction of travel than this.
 *
 * A panorama looking backwards while the drive moves forwards is disorienting
 * in a way a 3D camera is not: the transition to the next pano then arrives
 * from behind the viewer. 85 degrees is a hard look out of the side window,
 * which is the most a driver actually does.
 */
export const POV_MAX_OFF_TRAVEL_DEG = 85;
/**
 * Time constant of the POV filter.
 *
 * Shorter than the chase camera's 0.9 s because a panorama POV has no
 * inertia to sell — it is a head turning, not a vehicle — and a slow filter
 * reads as the view lagging the road rather than as a smooth pan.
 */
export const POV_TAU_S = 0.55;
/**
 * Playback speed for a Street View drive, in metres per second.
 *
 * Slower than the chase camera's 9 m/s and for a different reason than
 * comfort: each pano transition is Google's own animation, and at 9 m/s a
 * 10 m step arrives before the previous transition has finished, so the drive
 * reads as a stutter of half-played dissolves rather than as travel. It is
 * still a playback rate and still not a claim about a vehicle.
 */
export const STREET_VIEW_SPEED_MPS = 7;

export const COVERAGE = Object.freeze({ STREET_VIEW: 'streetview', CHASE: 'chase' });

// ---------------------------------------------------------------------------
// The hop
// ---------------------------------------------------------------------------

/** The cross-fade between the two panorama layers. */
export const HOP_FADE_MS = 300;
/**
 * The shortest still moment between two fades.
 *
 * Without a floor, a fast playback speed drives the interval below the fade and
 * the transitions overlap — a second fade starting while the first is still
 * running, which is a dissolve with no image in it. 120 ms is short enough to
 * read as continuous motion and long enough that there is always a frame of
 * settled panorama between hops.
 */
export const HOP_MIN_HOLD_MS = 120;
export const HOP_MIN_MS = HOP_FADE_MS + HOP_MIN_HOLD_MS;
/**
 * And a ceiling, for the other end.
 *
 * Playback drops to 40% approaching a house the assistant is explaining, which
 * at the nominal spacing would be a three-and-a-half second hold on one static
 * frame — the exact stillness this whole rewrite exists to remove. Past this the
 * spacing shrinks instead, so a slow drive hops between *closer* panoramas
 * rather than sitting on one.
 */
export const HOP_MAX_MS = 2_500;
/** How long a stalled preload may extend the drift before it reads as frozen. */
export const HOP_STALL_EXTEND_MS = 2_000;
/** Panoramas kept loaded ahead of the one on screen. */
export const QUEUE_DEPTH = 2;
/** Consecutive preload failures before the drive gives up on the panorama. */
export const PRELOAD_FAIL_LIMIT = 2;
/**
 * How long to let tiles arrive after `pano_changed` before calling a preload
 * ready.
 *
 * `pano_changed` fires when the panorama *id* has been accepted, not when its
 * imagery has been decoded and drawn. Cross-fading on that event alone brings
 * in a grey layer and fades the good one out behind it, which is a worse break
 * than the one being fixed.
 */
export const PRELOAD_SETTLE_MS = 250;
/** A preload that has not fired by now is a failure, not a slow success. */
export const PRELOAD_TIMEOUT_MS = 4_000;
/**
 * No position fix for this long and the drive is stopped, not slow.
 *
 * Fixes arrive with the render loop at 30-60 Hz, so this is two orders of
 * magnitude clear of a slow frame and immediately true of a pause. It is what
 * stops the hop loop without the drive having to tell it: a paused drive that
 * kept hopping would drain its queue into a street the viewer is not on.
 */
export const HOP_IDLE_MS = 400;
/**
 * How far ahead of the drive the picture may run before the queue stops
 * filling, in metres — or in spacings, whichever is more.
 *
 * ## Why the picture runs ahead at all
 *
 * A regular rhythm and a picture that matches the road are in genuine conflict
 * whenever the drive's speed drops below what Street View's own spacing
 * supports. The interval is derived from the **base** playback speed, so at the
 * 40% slow-down near a house being explained the drive covers 6 m in a hop —
 * and the nearest panorama 6 m ahead is the one already on screen. The queue
 * rejects the duplicate and nudges the probe forward, so the picture advances
 * by the panorama graph's ~10 m regardless, and every one of those hops gains
 * about 4 m on the road. Measured over 33 hops at the default speed: the
 * picture **74 m ahead** of the drive, three or four houses, with the pins and
 * the call-outs describing a stretch of street already out of frame.
 *
 * ## What is given up
 *
 * The rhythm, and only when it would otherwise be wrong. Past this bound the
 * queue stops asking, the hop stalls, and the drift extends — the same path a
 * slow preload takes, and visible in the same statistic. A drive whose rhythm
 * hesitates while it waits for the road is better than one that keeps perfect
 * time over the wrong houses.
 */
export const MAX_PICTURE_LEAD_M = 25;
export const MAX_PICTURE_LEAD_SPACINGS = 2.5;

/**
 * May the queue reach further ahead, given how far the picture already leads?
 *
 * In spacings as well as metres, because at a fast playback speed one hop is
 * legitimately 12 m and a flat 25 m bound would stop the queue after two.
 */
export function queueMayReach(leadM, spacingM) {
  const lead = Number(leadM);
  if (!Number.isFinite(lead)) return true;
  return lead <= Math.max(MAX_PICTURE_LEAD_M, (Number(spacingM) || 0) * MAX_PICTURE_LEAD_SPACINGS);
}

/**
 * The dolly.
 *
 * One continuous forward push per panorama, in two parts. Between hops the
 * front layer drifts 1.00 -> 1.05, so the image is never static even while the
 * drive is standing on one panorama. Through the fade it carries on from there
 * to 1.12 while the incoming layer eases 1.10 -> 1.00 — the outgoing picture
 * accelerating away as the incoming one settles, which is what a forward dolly
 * looks like and what makes a cross-fade read as travel rather than as a
 * dissolve between two photographs.
 *
 * The two halves share the value at the join: the outgoing layer's whole life
 * is 1.00 -> 1.12 without a step in it.
 */
export const DOLLY_FROM = 1.0;
export const DOLLY_DRIFT_TO = 1.05;
export const DOLLY_OUT_TO = 1.12;
export const DOLLY_IN_FROM = 1.10;
export const DOLLY_IN_TO = 1.0;
/** A stalled preload keeps drifting, but not forever and not far. */
export const DOLLY_STALL_MAX = 1.08;

export const HOP_PHASE = Object.freeze({ HOLDING: 'holding', FADING: 'fading' });
export const HOP_ACTION = Object.freeze({
  NONE: null,
  START_FADE: 'start-fade',
  END_FADE: 'end-fade',
  STALL: 'stall',
});

function lerp(from, to, t) {
  return from + (to - from) * t;
}

/**
 * How long one hop takes, and how far apart the panoramas it hops between are.
 *
 * The interval comes from the **base** playback speed — what "slower" and
 * "faster" set — rather than from the instantaneous one, because the rhythm has
 * to be regular: the drive eases in over two seconds and drops to 40% near a
 * house being explained, and an interval that tracked either of those would
 * make the hops speed up and slow down under the viewer.
 *
 * The spacing comes from the **instantaneous** speed, so the picture keeps pace
 * with the road through exactly those variations. Between them, the clamps
 * never introduce drift: whatever the interval ends up being, the spacing is
 * the distance actually covered in it.
 *
 * @param {number} baseSpeedMps the playback speed before easing and slow-downs
 * @returns {{intervalMs:number, clamped:boolean}}
 */
export function hopPlanFor(baseSpeedMps, {
  nominalSpacingM = PANO_SPACING_M,
  minMs = HOP_MIN_MS,
  maxMs = HOP_MAX_MS,
} = {}) {
  const speed = Number(baseSpeedMps);
  if (!Number.isFinite(speed) || speed <= 0) return { intervalMs: maxMs, clamped: true };
  const raw = (nominalSpacingM / speed) * 1000;
  const intervalMs = Math.min(maxMs, Math.max(minMs, raw));
  return { intervalMs, clamped: intervalMs !== raw };
}

/**
 * How far ahead to ask for the next panorama.
 *
 * The distance the drive actually covers in one hop. At normal speed that is
 * the nominal spacing; at 4x, where the interval has floored, it stretches, and
 * that stretch is the whole reason the picture does not fall behind the road.
 */
export function hopSpacingFor(speedMps, intervalMs, { minM = 4, maxM = 60 } = {}) {
  const speed = Number(speedMps);
  if (!Number.isFinite(speed) || speed <= 0) return minM;
  return Math.min(maxM, Math.max(minM, (speed * intervalMs) / 1000));
}

/**
 * `since` is the start of the **cycle**, not of the current phase.
 *
 * The first cut restarted it at the fade too, which made the real period
 * `interval + fade` rather than `interval`. It measured fine — 80 clean hops,
 * every fade inside 300 ms — and it was wrong where it mattered: the spacing is
 * derived from the interval, so the picture advanced 11.8 m every 720 ms while
 * the drive covered 28 m/s, and the panorama fell about 11 m/s behind the road.
 * Over one lap of the loop that is half a kilometre: the markers, the call-outs
 * and the view would all be for somewhere the picture had not reached.
 *
 * `fadeSince` is separate because a stall delays the fade without delaying the
 * cycle it belongs to.
 */
export function initialHopState(nowMs = 0) {
  return { phase: HOP_PHASE.HOLDING, since: nowMs, fadeSince: null, stalls: 0, hops: 0 };
}

/**
 * One step of the swap state machine.
 *
 * Two phases and one rule each. Holding: when the interval is up, fade if the
 * next panorama is loaded and **hold if it is not** — the stall does not
 * advance `since`, so the hop stays overdue and fires on the very frame the
 * preload lands rather than waiting out another whole interval. Fading: end
 * after the fade, and swap.
 *
 * Pure, and takes the clock as a number, so a whole drive's worth of hops is a
 * loop in a test.
 *
 * @returns {{state:object, action:string|null}}
 */
export function nextHopState(state, {
  nowMs = 0, intervalMs = HOP_MIN_MS, nextReady = false, fadeMs = HOP_FADE_MS,
} = {}) {
  const current = state || initialHopState(nowMs);
  if (current.phase === HOP_PHASE.FADING) {
    if (nowMs - (current.fadeSince ?? current.since) >= fadeMs) {
      return {
        state: {
          phase: HOP_PHASE.HOLDING, since: nowMs, fadeSince: null, stalls: 0, hops: current.hops + 1,
        },
        action: HOP_ACTION.END_FADE,
      };
    }
    return { state: current, action: HOP_ACTION.NONE };
  }
  // The hold is the part of the cycle that is not the fade, so that one whole
  // hop — hold plus fade — takes exactly `intervalMs`.
  const holdMs = Math.max(0, intervalMs - fadeMs);
  if (nowMs - current.since < holdMs) return { state: current, action: HOP_ACTION.NONE };
  if (!nextReady) {
    return { state: { ...current, stalls: current.stalls + 1 }, action: HOP_ACTION.STALL };
  }
  return {
    state: { ...current, phase: HOP_PHASE.FADING, fadeSince: nowMs },
    action: HOP_ACTION.START_FADE,
  };
}

/** Where in its hold or its fade the machine currently is. */
export function hopProgress(state, { nowMs = 0, intervalMs = HOP_MIN_MS, fadeMs = HOP_FADE_MS } = {}) {
  const current = state || initialHopState(nowMs);
  if (current.phase === HOP_PHASE.FADING) {
    const fading = Math.max(0, nowMs - (current.fadeSince ?? current.since));
    return {
      holdProgress: 1,
      fadeProgress: clamp(fading / Math.max(1, fadeMs), 0, 1),
      stalled: false,
      stallProgress: 0,
    };
  }
  const holdMs = Math.max(1, intervalMs - fadeMs);
  const elapsed = Math.max(0, nowMs - current.since);
  const over = elapsed - holdMs;
  return {
    holdProgress: clamp(elapsed / holdMs, 0, 1),
    fadeProgress: 0,
    stalled: over > 0,
    stallProgress: over > 0 ? clamp(over / HOP_STALL_EXTEND_MS, 0, 1) : 0,
  };
}

/**
 * Opacity and dolly scale for both layers, given where the hop is.
 *
 * Smoothstep on the fade for the same reason the view director's cross-fade
 * uses it: a linear alpha ramp between two photographs reads as a wipe with a
 * hard start and stop.
 *
 * **The two opacities always sum to 1.** That is not a tidiness property, it is
 * the guarantee that there is never a frame with no panorama on screen — which
 * is the failure mode a double buffer introduces and the one `smoke:drive`
 * samples for.
 *
 * @returns {{front:{opacity:number, scale:number}, back:{opacity:number, scale:number}}}
 */
export function dollyFor({
  phase = HOP_PHASE.HOLDING,
  holdProgress = 0,
  fadeProgress = 0,
  stalled = false,
  stallProgress = 0,
} = {}) {
  if (phase === HOP_PHASE.FADING) {
    const t = smoothstep(fadeProgress);
    return {
      front: { opacity: 1 - t, scale: lerp(DOLLY_DRIFT_TO, DOLLY_OUT_TO, t) },
      back: { opacity: t, scale: lerp(DOLLY_IN_FROM, DOLLY_IN_TO, t) },
    };
  }
  const drift = stalled
    ? lerp(DOLLY_DRIFT_TO, DOLLY_STALL_MAX, smoothstep(stallProgress))
    : lerp(DOLLY_FROM, DOLLY_DRIFT_TO, smoothstep(holdProgress));
  return {
    front: { opacity: 1, scale: drift },
    back: { opacity: 0, scale: DOLLY_IN_FROM },
  };
}

// ---------------------------------------------------------------------------
// The queue
// ---------------------------------------------------------------------------

/**
 * The panoramas the drive is about to hop to, nearest first.
 *
 * Shallow on purpose. Two deep is enough that the next hop is always already
 * loaded and the one after is already being asked for; deeper would hold
 * panorama ids the route may never reach, because "keep going" after a detour
 * seeks and a live drive can leave the route entirely.
 *
 * **Duplicates are rejected**, which is the queue's one real rule. The probe
 * distance is a guess at where the next panorama is, and guessing short returns
 * the panorama already on screen — queued, it would hop to itself: a 300 ms
 * cross-fade between two identical images, which looks like a stutter and is
 * indistinguishable in the logs from a working hop.
 */
export function createPanoQueue({ depth = QUEUE_DEPTH } = {}) {
  const items = [];
  return {
    get depth() { return depth; },
    get length() { return items.length; },
    get items() { return items.map((item) => ({ ...item })); },
    get head() { return items[0] ? { ...items[0] } : null; },
    get tail() { return items[items.length - 1] ? { ...items[items.length - 1] } : null; },
    get full() { return items.length >= depth; },
    /** @returns {boolean} whether it was taken */
    push(entry, currentPanoId = null) {
      if (!entry?.panoId) return false;
      if (entry.panoId === currentPanoId) return false;
      if (items.some((item) => item.panoId === entry.panoId)) return false;
      if (items.length >= depth) return false;
      items.push({ ...entry });
      return true;
    },
    shift() { return items.shift() || null; },
    clear() { items.length = 0; },
  };
}

// ---------------------------------------------------------------------------
// Preload health
// ---------------------------------------------------------------------------

export function initialPreloadHealth() {
  return { failures: 0, exhausted: false };
}

/**
 * Two consecutive preload failures and the drive stops trying.
 *
 * Consecutive, not cumulative: one panorama that will not load over a 1.4 km
 * loop is a gap in Google's coverage and the drive should hold and carry on.
 * Two in a row is the imagery not coming, and at that point holding one frame
 * while the road moves underneath is a worse view than the 3D chase camera.
 */
export function nextPreloadHealth(state, { ok, limit = PRELOAD_FAIL_LIMIT } = {}) {
  const current = state || initialPreloadHealth();
  if (ok) return { failures: 0, exhausted: false };
  const failures = current.failures + 1;
  return { failures, exhausted: failures >= limit };
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

/** Smoothstep on 0..1. */
function smoothstep(t) {
  const x = clamp(Number(t) || 0, 0, 1);
  return x * x * (3 - 2 * x);
}

// ---------------------------------------------------------------------------
// Cadence
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Coverage and the fallback rule
// ---------------------------------------------------------------------------

/** Starting coverage state: assume Street View until told otherwise. */
export function initialCoverage() {
  return { mode: COVERAGE.STREET_VIEW, missedM: 0, lastAtM: null };
}

/**
 * One resolve attempt, folded into the coverage state.
 *
 * The rule the product states is "no panorama within 25 m for 40 m of route",
 * so what accumulates is **route distance across consecutive misses**, not a
 * count of failed requests. Counting requests would make the fallback depend on
 * the cadence, and a drive that fell back after four misses at 10 m and after
 * four misses at 2 m would be two different products.
 *
 * A single hit clears the debt and restores Street View, which is the other
 * half of "until coverage returns".
 *
 * @param {{mode:string, missedM:number, lastAtM:number|null}} state
 * @param {{alongM:number, found:boolean, lengthM?:number, gapM?:number}} attempt
 */
export function nextCoverage(state, { alongM, found, lengthM = 0, gapM = COVERAGE_GAP_M } = {}) {
  const previous = state || initialCoverage();
  if (!Number.isFinite(alongM)) return previous;
  if (found) return { mode: COVERAGE.STREET_VIEW, missedM: 0, lastAtM: alongM };
  const travelled = previous.lastAtM === null
    ? 0
    : Math.abs(lengthM > 0
      ? signedAheadM({ lengthM }, previous.lastAtM, alongM)
      : alongM - previous.lastAtM);
  const missedM = previous.missedM + travelled;
  return {
    mode: missedM >= gapM ? COVERAGE.CHASE : previous.mode,
    missedM,
    lastAtM: alongM,
  };
}

// ---------------------------------------------------------------------------
// POV
// ---------------------------------------------------------------------------

/**
 * How much of the look belongs to the house rather than to the road, 0..1.
 *
 * Rises from nothing at 60 m to full as the drive draws level, then releases
 * over the next 25 m of road. The release is a ramp rather than a switch
 * because the *target* has to be continuous: the POV filter below would smooth
 * a step, but it would smooth it into a swing back through the windscreen that
 * takes a second and a half, and the house is gone by then.
 *
 * @param {number} aheadM positive ahead, negative once passed
 */
export function povBlendFor(aheadM) {
  const d = Number(aheadM);
  if (!Number.isFinite(d)) return 0;
  if (d >= POV_EASE_RADIUS_M) return 0;
  if (d >= 0) return smoothstep(1 - d / POV_EASE_RADIUS_M);
  const past = -d;
  if (past >= POV_RELEASE_M) return 0;
  return smoothstep(1 - past / POV_RELEASE_M);
}

/**
 * The panorama heading for one fix.
 *
 * Travel bearing by default; blended towards the house being discussed as it
 * comes into range; filtered, so the pan is a head turning rather than a cut.
 *
 * The blend is applied to the **signed shortest turn** off the travel bearing,
 * not to the two absolute headings — averaging 359 and 1 the naive way points
 * the camera south.
 *
 * @returns {{headingDeg:number, targetDeg:number, blend:number}}
 */
export function povHeadingFor({
  previousHeadingDeg = null,
  travelBearingDeg = 0,
  houseBearingDeg = null,
  aheadM = Infinity,
  dtSeconds = 0.25,
  tauS = POV_TAU_S,
} = {}) {
  const travel = normalizeDeg(travelBearingDeg);
  const blend = Number.isFinite(houseBearingDeg) ? povBlendFor(aheadM) : 0;
  let targetDeg = travel;
  if (blend > 0) {
    const off = clamp(
      deltaDeg(travel, houseBearingDeg),
      -POV_MAX_OFF_TRAVEL_DEG,
      POV_MAX_OFF_TRAVEL_DEG,
    );
    targetDeg = normalizeDeg(travel + off * blend);
  }
  return {
    headingDeg: smoothHeading(previousHeadingDeg, targetDeg, dtSeconds, { tauS }),
    targetDeg,
    blend,
  };
}

// ---------------------------------------------------------------------------
// Markers inside the panorama
// ---------------------------------------------------------------------------

function hexOf([r, g, b]) {
  const byte = (v) => Math.round(clamp(Number(v) || 0, 0, 1) * 255).toString(16).padStart(2, '0');
  return `#${byte(r)}${byte(g)}${byte(b)}`;
}

/** The gold accent, as the hex a Google marker icon wants. */
export const GOLD_HEX = hexOf([GOLD.r, GOLD.g, GOLD.b]);

/**
 * Which signal properties get a pin in the panorama right now.
 *
 * 120 m rather than the whole route because a `StreetViewPanorama` will happily
 * place a marker a kilometre away and render it as a speck on the horizon over
 * a house that is not the house. The label is the top pick's alone: a street of
 * five labelled pins is a map legend, and the one thing worth reading at speed
 * is which of them is the answer.
 *
 * @param {Array} rows drive rows (`{id, property}`) or plain properties
 * @param {{position:{lat:number,lng:number}, radiusM?:number, topPickId?:string}} options
 */
export function panoMarkersFor(rows, { position, radiusM = MARKER_RADIUS_M, topPickId = null } = {}) {
  if (!Number.isFinite(position?.lat) || !Number.isFinite(position?.lng)) return [];
  const origin = { lat: position.lat, lng: position.lng };
  const out = [];
  for (const row of rows || []) {
    const property = row?.property || row;
    if (!Number.isFinite(property?.lat) || !Number.isFinite(property?.lng)) continue;
    const [east, north] = toLocal([property.lng, property.lat], origin);
    const distanceM = Math.hypot(east, north);
    if (distanceM > radiusM) continue;
    const gold = Boolean(topPickId) && property.id === topPickId;
    const signalType = primarySignal(property)?.type || 'DISTRESS';
    out.push({
      id: property.id,
      lat: property.lat,
      lng: property.lng,
      distanceM,
      gold,
      signalType,
      color: gold ? GOLD_HEX : hexOf((SIGNAL_LOOK[signalType] || SIGNAL_LOOK.DISTRESS).color),
      // An empty string is not a label: a row with no address must not produce
      // a gold pin with a blank white box floating next to it.
      label: gold ? (shortAddress(property) || null) : null,
    });
  }
  // Nearest last, so the closest pin is appended over the ones behind it.
  return out.sort((a, b) => b.distanceM - a.distanceM);
}

// ---------------------------------------------------------------------------
// The Maps JavaScript API
// ---------------------------------------------------------------------------

const MAPS_SCRIPT_ID = 'ts-google-maps-js';
const MAPS_CALLBACK = '__terraSignalMapsReady';

/**
 * Load the Maps JavaScript API once, and be honest about a key that refuses.
 *
 * Google does not reject the bootstrap request for a bad key — the script loads
 * and then fails at the point of use, which is how a broken key presents as a
 * blank grey box rather than as an error. Two things catch it: `gm_authFailure`,
 * which Google calls for `InvalidKeyMapError` and `RefererNotAllowedMapError`,
 * and a timeout, for the case where the script host is blocked outright.
 *
 * @returns {Promise<{ok:boolean, maps?:object, reason?:string}>}
 */
export function loadGoogleMaps({
  apiKey,
  win = globalThis,
  doc = globalThis.document,
  timeoutMs = 12_000,
} = {}) {
  if (!apiKey) {
    return Promise.resolve({ ok: false, reason: 'no GOOGLE_MAPS_API_KEY in this build' });
  }
  if (win.google?.maps?.StreetViewPanorama) {
    return Promise.resolve({ ok: true, maps: win.google.maps });
  }
  if (win[MAPS_CALLBACK]?.promise) return win[MAPS_CALLBACK].promise;
  if (!doc?.createElement) return Promise.resolve({ ok: false, reason: 'no document' });

  const promise = new Promise((resolve) => {
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    // Google calls this by name on an auth failure, and only then.
    win.gm_authFailure = () => finish({
      ok: false,
      reason: 'the Google Maps key refused this origin (check the key\'s API '
        + 'restrictions include Maps JavaScript API, and its HTTP referrer list)',
    });
    const timer = win.setTimeout(
      () => finish({ ok: false, reason: `maps.googleapis.com did not load in ${timeoutMs} ms` }),
      timeoutMs,
    );
    win[MAPS_CALLBACK] = Object.assign(() => {
      win.clearTimeout(timer);
      finish(win.google?.maps?.StreetViewPanorama
        ? { ok: true, maps: win.google.maps }
        : { ok: false, reason: 'Maps JS loaded without StreetViewPanorama' });
    }, { promise: null });

    const script = doc.createElement('script');
    script.id = MAPS_SCRIPT_ID;
    script.async = true;
    script.src = 'https://maps.googleapis.com/maps/api/js'
      + `?key=${encodeURIComponent(apiKey)}&v=weekly&loading=async&callback=${MAPS_CALLBACK}`;
    script.addEventListener('error', () => {
      win.clearTimeout(timer);
      finish({ ok: false, reason: 'the Maps JavaScript API script failed to load' });
    });
    doc.head.appendChild(script);
  });
  win[MAPS_CALLBACK] = win[MAPS_CALLBACK] || (() => {});
  win[MAPS_CALLBACK].promise = promise;
  return promise;
}

/** Read the key the way the rest of the app does, without importing main.js. */
export function readMapsApiKey(win = globalThis) {
  try {
    return win.__GOOGLE_MAPS_API_KEY__ || import.meta.env?.GOOGLE_MAPS_API_KEY || '';
  } catch {
    return win.__GOOGLE_MAPS_API_KEY__ || '';
  }
}

// ---------------------------------------------------------------------------
// The host element
// ---------------------------------------------------------------------------

export const STREET_VIEW_HOST_ID = 'ts-streetview';
/**
 * The panorama gets its own element inside the host, and this is not tidiness.
 *
 * The Maps JavaScript API **writes `position: relative` inline onto whatever
 * container it is given**, and an inline style beats a stylesheet: the host's
 * `position: fixed` became `relative`, `top: 0; bottom: 0` stopped stretching
 * anything, and the box collapsed to its content — which is zero, because
 * everything Google puts inside it is absolutely positioned. The result was a
 * full-width, **zero-height** element that was present, opaque, correct in
 * every property the probe could read, and drew nothing at all: 125 panoramas
 * resolved, five images loaded, and the screen showed the 3D scene straight
 * through it.
 *
 * So the host owns the layout and this inner element is what Google is handed
 * to rewrite.
 */
export const STREET_VIEW_PANO_ID = 'ts-streetview-pano';
/** The second buffer. Same element shape, same rules, opposite role. */
export const STREET_VIEW_PANO_B_ID = 'ts-streetview-pano-b';
export const STREET_VIEW_LAYER_IDS = Object.freeze([STREET_VIEW_PANO_ID, STREET_VIEW_PANO_B_ID]);
const HOST_STYLE_ID = 'ts-streetview-style';

/**
 * Google's attribution is not ours to restyle.
 *
 * Drive Mode hides the standing HUD with one class on `<body>`, and the easiest
 * possible mistake is a selector broad enough to catch the logo and Terms link
 * the panorama renders for itself. These rules are `!important` and they exist
 * to make that mistake impossible rather than unlikely.
 */
const ATTRIBUTION_GUARD_CSS = `
#${STREET_VIEW_HOST_ID} .gm-style-cc,
#${STREET_VIEW_HOST_ID} .gmnoprint,
#${STREET_VIEW_HOST_ID} a[href*="maps.google.com"],
#${STREET_VIEW_HOST_ID} a[href*="google.com/maps"],
#${STREET_VIEW_HOST_ID} img[src*="google"] {
  display: revert !important;
  visibility: visible !important;
  opacity: 1 !important;
}
`;

const HOST_CSS = `
#${STREET_VIEW_HOST_ID} {
  /* !important because the Maps API writes position inline; see above. */
  position: fixed !important;
  top: 0;
  left: 0;
  /* Explicit extent as well as insets: a container whose position has been
     rewritten under us must still be the size of the screen. */
  width: 100vw;
  height: 100vh;
  /* Above the Cesium canvas (z-index 0) and below every piece of HUD (40+). */
  z-index: 1;
  opacity: 0;
  background: #05070a;
  pointer-events: none;
  transition: none;
  overflow: hidden;
}
#${STREET_VIEW_HOST_ID}[data-ts-sv-active="true"] { pointer-events: auto; }
#${STREET_VIEW_HOST_ID}[hidden] { display: none !important; }

/**
 * The two buffers, stacked. Both always in the tree and both always laid out:
 * a panorama inside a display:none ancestor measures zero and comes back empty,
 * and the hidden buffer's entire job is to be loaded before it is seen.
 */
#${STREET_VIEW_HOST_ID} [data-ts-sv-layer] {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  opacity: 0;
  will-change: opacity;
}

/**
 * The dolly, on the imagery and on nothing else.
 *
 * Scaling the layer clips Google's attribution — it sits flush to the bottom
 * edge, and 1.05 about the centre pushes it 22 px off screen. The canvases are
 * the imagery; the attribution is DOM overlaid on them. Measured at 1.12 the
 * scene canvas grows from 1440x900 at (0,0) to 1613x1008 at (-86,-54) and every
 * attribution node stays on the pixel it was on.
 *
 * One custom property per layer, written once a frame; the compositor does the
 * rest. Anything that writes a transform per frame in JS is writing to the main
 * thread instead.
 */
#${STREET_VIEW_HOST_ID} [data-ts-sv-layer] canvas {
  transform: scale(var(--ts-sv-scale, 1));
  transform-origin: 50% 50%;
  will-change: transform;
}
@media (prefers-reduced-motion: reduce) {
  /* The cross-fade stays; the dolly is the part that is motion for its own
     sake, and a viewer who has asked for less of it gets a plain dissolve. */
  #${STREET_VIEW_HOST_ID} [data-ts-sv-layer] canvas { transform: none; }
}
${ATTRIBUTION_GUARD_CSS}
`;

/** Create (once) the element the panorama renders into. */
export function ensureStreetViewHost(doc = globalThis.document) {
  if (!doc?.createElement) return null;
  if (!doc.getElementById(HOST_STYLE_ID)) {
    const style = doc.createElement('style');
    style.id = HOST_STYLE_ID;
    style.textContent = HOST_CSS;
    doc.head.appendChild(style);
  }
  let host = doc.getElementById(STREET_VIEW_HOST_ID);
  if (host) return host;
  host = doc.createElement('div');
  host.id = STREET_VIEW_HOST_ID;
  host.hidden = true;
  host.setAttribute('aria-label', 'Street View — imagery © Google');
  for (const id of STREET_VIEW_LAYER_IDS) {
    const layer = doc.createElement('div');
    layer.id = id;
    layer.dataset.tsSvLayer = id === STREET_VIEW_PANO_ID ? 'a' : 'b';
    host.appendChild(layer);
  }
  doc.body.appendChild(host);
  return host;
}

/** The element the first panorama is built into. */
export function panoElementOf(host) {
  return host?.querySelector?.(`#${STREET_VIEW_PANO_ID}`) || host || null;
}

/** Both buffers, in `[a, b]` order. */
export function panoLayersOf(host) {
  if (!host?.querySelector) return [];
  return STREET_VIEW_LAYER_IDS
    .map((id) => host.querySelector(`#${id}`))
    .filter(Boolean);
}

// ---------------------------------------------------------------------------
// The driver
// ---------------------------------------------------------------------------

/**
 * Follow a position source with two cross-faded Street View panoramas.
 *
 * `getRoute` rather than a route, because the drive builds the spline and the
 * panorama must measure its cadence against **that** object rather than
 * against a second copy — two `buildRoute` calls on the same coordinates give
 * equal lengths today and would not have to, and a pano step measured in
 * different metres from a call-out is a bug with no symptom until it is one.
 *
 * @param {{getRoute:Function, getRows:Function, getTopPickId:Function,
 *   apiKey?:string, host?:Element, loader?:Function, onCoverage?:Function,
 *   onPano?:Function, onError?:Function, now?:Function}} deps
 */
export function createStreetViewDrive({
  getRoute = () => null,
  getRows = () => [],
  getTopPickId = () => null,
  apiKey = readMapsApiKey(),
  host = null,
  loader = loadGoogleMaps,
  doc = globalThis.document,
  win = globalThis,
  onCoverage = null,
  onPano = null,
  onError = null,
  now = () => (globalThis.performance?.now?.() ?? Date.now()),
} = {}) {
  let maps = null;
  let service = null;
  let element = host;
  let ready = false;
  let failure = null;
  let destroyed = false;

  /**
   * The two buffers.
   *
   * `front` is what the viewer is looking at and **never receives `setPano`** —
   * that is the whole mechanism. Google only plays its own blurred transition
   * on a panorama it is asked to move, so the panorama on screen is never
   * asked to move. `back` is loaded, off screen, and swapped in.
   */
  const layers = [
    { key: 'a', element: null, panorama: null, panoId: null, markers: [], markerKey: '', opacity: 1, scale: DOLLY_FROM },
    { key: 'b', element: null, panorama: null, panoId: null, markers: [], markerKey: '', opacity: 0, scale: DOLLY_IN_FROM },
  ];
  let frontIndex = 0;
  const front = () => layers[frontIndex];
  const back = () => layers[1 - frontIndex];

  let coverage = initialCoverage();
  let health = initialPreloadHealth();
  let hop = initialHopState(now());
  const queue = createPanoQueue({ depth: QUEUE_DEPTH });

  /** Where along the route the picture currently stands. */
  let cursorM = null;
  /** Where the DRIVE is — which is not always where the picture is. */
  let driveAtM = null;
  /** How many times the probe distance has been nudged past a duplicate. */
  let probeAttempt = 0;
  /** A hop the stop view has asked for, which does not wait out an interval. */
  let forceHop = false;
  let fillInFlight = false;
  /** When the fade in progress began — for the longest-fade measurement. */
  let fadeStartedAt = 0;
  /** The entry `back` is loading or has loaded, and whether it is ready. */
  let loading = null;
  let backReady = false;
  let preloadTimer = null;
  let preloadToken = 0;

  let headingDeg = null;
  let lastFixAt = 0;
  let rafHandle = null;
  let intervalMs = HOP_MAX_MS;
  let spacingM = PANO_SPACING_M;
  let requests = 0;
  let hits = 0;
  let panoCount = 0;
  let stalls = 0;
  let fades = 0;
  let longestFadeMs = 0;
  const seenPanos = new Set();

  function fail(reason) {
    if (failure) return;
    failure = reason;
    // A refused key is a product fact, not a crash: the drive keeps going on
    // the 3D chase camera and the HUD says why.
    coverage = { ...coverage, mode: COVERAGE.CHASE };
    onError?.(reason);
    onCoverage?.(COVERAGE.CHASE, { reason });
  }

  function buildPanorama(layerElement) {
    return new maps.StreetViewPanorama(layerElement, {
      // Nothing of Google's own beyond what carries the attribution. The drive
      // supplies the controls, and every one of these is a way for a viewer to
      // move a panorama the drive is in the middle of cross-fading.
      disableDefaultUI: true,
      addressControl: false,
      linksControl: false,
      panControl: false,
      zoomControl: false,
      fullscreenControl: false,
      motionTracking: false,
      motionTrackingControl: false,
      showRoadLabels: false,
      clickToGo: false,
      scrollwheel: false,
      disableDoubleClickZoom: true,
      visible: true,
    });
  }

  /** Load the API and build both buffers. Idempotent. */
  async function mount() {
    if (ready || failure || destroyed) return { ok: ready, reason: failure };
    element = element || ensureStreetViewHost(doc);
    const layerElements = panoLayersOf(element);
    if (!element || layerElements.length < 2) {
      fail('no DOM to host a panorama');
      return { ok: false, reason: failure };
    }
    const loaded = await loader({ apiKey, win, doc });
    if (destroyed) return { ok: false, reason: 'destroyed' };
    if (!loaded?.ok) {
      fail(loaded?.reason || 'the Maps JavaScript API did not load');
      return { ok: false, reason: failure };
    }
    maps = loaded.maps;
    // A panorama measures its container at construction, and a container inside
    // a `hidden` ancestor measures zero. Give both the layout first; the host is
    // still fully transparent, so nothing appears early.
    element.hidden = false;
    try {
      layers.forEach((layer, index) => {
        layer.element = layerElements[index];
        layer.panorama = buildPanorama(layer.element);
      });
      service = new maps.StreetViewService();
      ready = true;
    } catch (error) {
      fail(`StreetViewPanorama refused to build: ${error?.message || error}`);
      return { ok: false, reason: failure };
    }
    hop = initialHopState(now());
    paint();
    startLoop();
    return { ok: true };
  }

  /**
   * The hop runs on its own animation frame, not on the drive's fixes.
   *
   * It used to run on fixes, which arrive from `scene.preRender` — and that
   * makes the panorama's cross-fade hostage to the 3D renderer's frame time.
   * Measured: a 600 ms Cesium frame while Google's photogrammetry streamed in
   * behind the opaque panorama turned a 300 ms dissolve into an **850 ms** one,
   * twice in a lap, at page times nowhere near a capture. The dissolve is DOM
   * and compositor work and has no business waiting on a tile decode.
   *
   * Position and heading still come from fixes, because those are facts about
   * the drive. Only the clock moved.
   *
   * Idleness is inferred from the fixes rather than announced: a paused drive
   * emits none, so the loop stops on its own and there is no `setPaused` for a
   * call site to forget.
   */
  function startLoop() {
    if (rafHandle !== null || !win.requestAnimationFrame) return;
    const frame = () => {
      rafHandle = win.requestAnimationFrame(frame);
      if (!ready || destroyed) return;
      const fading = hop.phase === HOP_PHASE.FADING;
      const forcing = forceHop && backReady;
      // A fade always runs to the end: freezing half way through a dissolve is
      // a double exposure, not a picture.
      if (!fading && !forcing && now() - lastFixAt > HOP_IDLE_MS) return;
      if (forcing) forceHop = false;
      stepHop({ force: forcing });
      paint();
    };
    rafHandle = win.requestAnimationFrame(frame);
  }

  function stopLoop() {
    if (rafHandle === null) return;
    win.cancelAnimationFrame?.(rafHandle);
    rafHandle = null;
  }

  // ---- the queue ---------------------------------------------------------

  /**
   * Ask for one more panorama ahead of the last one queued.
   *
   * One request in flight at a time. The queue is shallow and the network is
   * not ordered, so two outstanding probes can answer out of order and queue
   * the route backwards.
   *
   * A probe that returns a panorama already queued or already on screen is not
   * a failure — it is the probe distance guessing short, because Street View
   * spacing is irregular. The distance is nudged forward and asked again, up to
   * a few times, rather than counted against coverage.
   */
  function fillQueue() {
    if (!ready || fillInFlight || !service || queue.full || cursorM === null) return;
    const route = getRoute();
    const lengthM = route?.lengthM || 0;
    /**
     * Ask ahead of whichever is further along: the last panorama queued, or the
     * drive itself.
     *
     * Without the second term the picture can only ever fall behind. A preload
     * takes a network round trip plus the settle, and when that exceeds the
     * hold — which it does at the probe's 4x, where the hold is 120 ms — every
     * hop stalls and the queue advances at the speed of the network rather than
     * the speed of the road. Measured: 103 hops where 145 were due, the picture
     * moving at 20 m/s under a drive doing 28.
     *
     * Anchoring on the drive turns that into a **skipped panorama** instead of
     * a growing lag, which is the right trade by a distance: a drive that shows
     * every panorama of the wrong street is worse than one that shows most of
     * the right one.
     */
    const queued = queue.tail?.alongM ?? cursorM;
    const from = (driveAtM !== null && lengthM > 0 && signedAheadM(route, queued, driveAtM) > 0)
      ? driveAtM
      : queued;
    // And the other end of the same leash: stop asking once the picture has run
    // far enough ahead that it is no longer the street the drive is on.
    if (driveAtM !== null && lengthM > 0
      && !queueMayReach(signedAheadM(route, driveAtM, queued), spacingM)) {
      return;
    }
    const askAtM = wrapDistance(from + spacingM * (1 + probeAttempt * 0.5), lengthM);
    const point = pointAt(route, askAtM);
    if (!point) return;

    fillInFlight = true;
    requests += 1;
    service.getPanorama(
      {
        location: { lat: point.lat, lng: point.lng },
        radius: PANO_RADIUS_M,
        source: 'outdoor',
        preference: 'nearest',
      },
      (data, status) => {
        fillInFlight = false;
        if (destroyed) return;
        const found = status === 'OK' && Boolean(data?.location?.pano);
        const before = coverage.mode;
        coverage = nextCoverage(coverage, { alongM: askAtM, found, lengthM });
        if (found) {
          hits += 1;
          const taken = queue.push(
            { panoId: data.location.pano, alongM: askAtM, position: { lat: point.lat, lng: point.lng } },
            front().panoId,
          );
          // Taken: the next probe starts from this one. Rejected as a duplicate:
          // nudge and ask again from the same place.
          probeAttempt = taken ? 0 : Math.min(4, probeAttempt + 1);
        } else {
          probeAttempt = Math.min(4, probeAttempt + 1);
        }
        if (coverage.mode !== before) onCoverage?.(coverage.mode, { missedM: coverage.missedM });
        startPreload();
      },
    );
  }

  // ---- preloading the hidden buffer --------------------------------------

  function clearPreloadTimer() {
    if (preloadTimer !== null) {
      win.clearTimeout?.(preloadTimer);
      preloadTimer = null;
    }
  }

  function preloadSettled(token, ok) {
    if (token !== preloadToken || destroyed) return;
    clearPreloadTimer();
    const before = health.exhausted;
    health = nextPreloadHealth(health, { ok });
    if (ok) {
      backReady = true;
      back().panoId = loading?.panoId ?? back().panoId;
      if (before) {
        // The imagery came back. So does the panorama.
        coverage = { ...coverage, mode: COVERAGE.STREET_VIEW, missedM: 0 };
        onCoverage?.(COVERAGE.STREET_VIEW, { recovered: true });
      }
      return;
    }
    // A failed preload leaves the queue entry behind rather than retrying it:
    // a panorama that would not load once will not load the second time either,
    // and the road has moved on.
    loading = null;
    backReady = false;
    if (health.exhausted && coverage.mode !== COVERAGE.CHASE) {
      coverage = { ...coverage, mode: COVERAGE.CHASE };
      onCoverage?.(COVERAGE.CHASE, { preloadFailures: health.failures });
    }
  }

  /**
   * Put the head of the queue into the hidden buffer.
   *
   * `pano_changed` fires when the id has been accepted, not when the imagery
   * has been decoded — cross-fading on that event alone brings in a grey layer.
   * So the buffer is not called ready until the settle has also elapsed.
   */
  function startPreload() {
    if (!ready || destroyed || loading || !queue.length) return;
    const entry = queue.shift();
    if (!entry) return;
    loading = entry;
    backReady = false;
    const token = ++preloadToken;
    const target = back();
    /**
     * The timeout is armed BEFORE `setPano`, and that ordering is the bug this
     * comment exists to prevent recurring.
     *
     * `pano_changed` fires **synchronously** from inside `setPano`. Arming the
     * failure timeout after the call therefore overwrote the 250 ms settle
     * timer the handler had already set, and every preload resolved as a
     * timeout four seconds later: measured, 0 hops and 228 stalled frames over
     * a whole lap, two consecutive failures, and the drive on the chase camera
     * having never once shown a second panorama. Every log said the panoramas
     * were being found — 6 requests, 6 hits — because they were.
     */
    clearPreloadTimer();
    preloadTimer = win.setTimeout?.(() => preloadSettled(token, false), PRELOAD_TIMEOUT_MS);
    try {
      maps.event.addListenerOnce(target.panorama, 'pano_changed', () => {
        if (token !== preloadToken) return;
        clearPreloadTimer();
        preloadTimer = win.setTimeout?.(() => preloadSettled(token, true), PRELOAD_SETTLE_MS);
      });
      // The ONLY setPano in the module, and it is always on the hidden buffer.
      target.panorama.setPano(entry.panoId);
      // Whatever heading the drive is on now, so the fade does not also turn.
      if (headingDeg !== null) target.panorama.setPov({ heading: headingDeg, pitch: 0 });
    } catch {
      preloadSettled(token, false);
    }
  }

  // ---- the hop -----------------------------------------------------------

  /** Write the two layers' opacity and dolly. One style write each per frame. */
  function paint() {
    const progress = hopProgress(hop, { nowMs: now(), intervalMs });
    const dolly = dollyFor({ phase: hop.phase, ...progress });
    apply(front(), dolly.front);
    apply(back(), dolly.back);
  }

  function apply(layer, { opacity, scale }) {
    layer.opacity = opacity;
    layer.scale = scale;
    if (!layer.element) return;
    layer.element.style.opacity = String(opacity);
    layer.element.style.setProperty('--ts-sv-scale', scale.toFixed(4));
  }

  /** The swap. The layer that was hidden is now the one that must not move. */
  function completeHop() {
    frontIndex = 1 - frontIndex;
    const arrived = front();
    if (loading?.panoId) {
      arrived.panoId = loading.panoId;
      cursorM = loading.alongM;
      if (!seenPanos.has(loading.panoId)) seenPanos.add(loading.panoId);
      panoCount += 1;
      onPano?.({ panoId: loading.panoId, alongM: loading.alongM, position: loading.position });
    }
    loading = null;
    backReady = false;
    fades += 1;
    // The layer just vacated becomes the buffer, and starts loading at once.
    startPreload();
    fillQueue();
  }

  function stepHop({ force = false } = {}) {
    const nowMs = now();
    // A forced hop is due now rather than at the end of the interval: the stop
    // view is answering a question, and a question does not wait for a rhythm.
    const { state, action } = nextHopState(hop, {
      nowMs,
      intervalMs: force ? HOP_FADE_MS : intervalMs,
      nextReady: backReady,
    });
    hop = state;
    if (action === HOP_ACTION.STALL) {
      // Once per overdue hop, not once per frame it stays overdue — otherwise
      // one slow preload reads as two hundred stalls.
      if (hop.stalls === 1) stalls += 1;
      // Hold the current panorama and extend the drift. Never a blank.
      fillQueue();
      startPreload();
      return;
    }
    if (action === HOP_ACTION.START_FADE) {
      fadeStartedAt = nowMs;
      return;
    }
    if (action === HOP_ACTION.END_FADE) {
      longestFadeMs = Math.max(longestFadeMs, nowMs - fadeStartedAt);
      completeHop();
    }
  }

  // ---- markers -----------------------------------------------------------

  /**
   * Pins for the signal properties within 120 m, on **both** buffers.
   *
   * Both, because a pin that lives only on the front layer would vanish the
   * moment a cross-fade started and reappear when it finished — a blink on
   * every hop, on the one element of the frame the user is being asked to
   * track. Two sets of at most six DOM markers is the cheaper problem.
   */
  function syncMarkers(position) {
    if (!ready || !maps) return;
    const wanted = panoMarkersFor(getRows(), { position, topPickId: getTopPickId() });
    const key = wanted.map((m) => `${m.id}:${m.gold ? 'g' : 's'}`).join('|');
    for (const layer of layers) {
      if (layer.markerKey === key) continue;
      layer.markerKey = key;
      for (const marker of layer.markers) {
        try { marker.setMap(null); } catch { /* already gone */ }
      }
      layer.markerRows = wanted;
      layer.markers = wanted.map((row) => new maps.Marker({
        position: { lat: row.lat, lng: row.lng },
        map: layer.panorama,
        title: row.label || undefined,
        icon: {
          path: maps.SymbolPath.CIRCLE,
          scale: row.gold ? 11 : 7,
          fillColor: row.color,
          fillOpacity: row.gold ? 1 : 0.9,
          strokeColor: '#0b0d10',
          strokeWeight: row.gold ? 3 : 2,
        },
        label: row.label
          ? {
            text: row.label,
            color: GOLD_HEX,
            fontFamily: 'Inter, system-ui, sans-serif',
            fontSize: '13px',
            fontWeight: '600',
          }
          : undefined,
        optimized: false,
        clickable: false,
      }));
    }
  }

  function clearMarkers() {
    for (const layer of layers) {
      for (const marker of layer.markers) {
        try { marker.setMap(null); } catch { /* already gone */ }
      }
      layer.markers = [];
      layer.markerRows = [];
      layer.markerKey = '';
    }
  }

  return {
    get ready() { return ready; },
    get failure() { return failure; },
    get mode() { return coverage.mode; },
    get coverage() { return { ...coverage }; },
    get panoId() { return front().panoId; },
    get panoCount() { return panoCount; },
    get headingDeg() { return headingDeg; },
    get element() { return element; },
    get panorama() { return front().panorama; },
    get phase() { return hop.phase; },
    get intervalMs() { return intervalMs; },
    /**
     * What both buffers are doing right now — the headed probe reads this, and
     * the two opacities are what it asserts never both fall to zero.
     */
    get layers() {
      return layers.map((layer, index) => ({
        key: layer.key,
        role: index === frontIndex ? 'front' : 'back',
        panoId: layer.panoId,
        opacity: layer.opacity,
        scale: layer.scale,
      }));
    },
    get stats() {
      return {
        requests,
        hits,
        panoCount,
        uniquePanos: seenPanos.size,
        missedM: coverage.missedM,
        mode: coverage.mode,
        hops: hop.hops,
        fades,
        stalls,
        longestFadeMs: Math.round(longestFadeMs),
        intervalMs: Math.round(intervalMs),
        spacingM: Math.round(spacingM * 10) / 10,
        queued: queue.length,
        preloadFailures: health.failures,
        /**
         * Where the picture is, and how far that is from where the drive is.
         *
         * The number that says whether the panorama is still on the road. A
         * hop rate the network cannot sustain shows up here and nowhere else:
         * every other statistic looks healthy while the view drifts.
         */
        pictureAtM: cursorM === null ? null : Math.round(cursorM),
        driveAtM: driveAtM === null ? null : Math.round(driveAtM),
        /** Positive: the picture is ahead of the drive. Negative: behind. */
        leadM: (cursorM === null || driveAtM === null || !(getRoute()?.lengthM > 0))
          ? null
          : Math.round(signedAheadM(getRoute(), driveAtM, cursorM)),
      };
    },
    /** What is pinned in the panorama right now — the headed probe reads this. */
    get markers() {
      const layer = front();
      return (layer.markers || []).map((marker, index) => ({
        id: layer.markerRows?.[index]?.id ?? null,
        gold: Boolean(layer.markerRows?.[index]?.gold),
        label: layer.markerRows?.[index]?.label ?? null,
      }));
    },

    mount,

    /**
     * Show or hide both buffers.
     *
     * `setVisible(false)` is what stops Google streaming imagery for a view
     * nobody is looking at — an element at opacity 0 is still a panorama
     * fetching tiles, and there are two of them. The **resize trigger** on the
     * way back is what makes a panorama that was measured inside a
     * `display: none` ancestor size itself to the screen again; without it the
     * element comes back present, opaque and empty.
     */
    setVisible(on) {
      if (!ready || !element) return false;
      if (!on) {
        // Stop hopping as well as stop fetching. A panorama nobody is looking
        // at should not be walking down the street on its own.
        stopLoop();
        for (const layer of layers) {
          try { layer.panorama?.setVisible?.(false); } catch { /* already gone */ }
        }
        return true;
      }
      element.hidden = false;
      startLoop();
      const remeasure = () => {
        for (const layer of layers) {
          try { maps?.event?.trigger?.(layer.panorama, 'resize'); } catch { /* gone */ }
        }
      };
      for (const layer of layers) {
        try { layer.panorama?.setVisible?.(true); } catch { /* not built */ }
      }
      remeasure();
      // Once more after layout: the element was display:none one tick ago and
      // its box is not final until the next style recalculation.
      win.setTimeout?.(remeasure, 0);
      paint();
      return true;
    },

    /**
     * One fix.
     *
     * @param {{position:object, bearingDeg:number, speedMps:number}} fix
     * @param {{alongM:number, house?:object, houseAheadM?:number,
     *   dtSeconds?:number, baseSpeedMps?:number}} context
     */
    update(fix, {
      alongM, house = null, houseAheadM = Infinity, dtSeconds = 0.25, baseSpeedMps = null,
    } = {}) {
      if (!ready || destroyed || !fix?.position) return null;
      const position = fix.position;
      if (cursorM === null) cursorM = alongM;
      driveAtM = alongM;

      // The rhythm comes from the base speed and the reach from the real one.
      const plan = hopPlanFor(baseSpeedMps ?? fix.speedMps ?? STREET_VIEW_SPEED_MPS);
      intervalMs = plan.intervalMs;
      spacingM = hopSpacingFor(fix.speedMps, intervalMs);

      let houseBearingDeg = null;
      if (Number.isFinite(house?.lat) && Number.isFinite(house?.lng)) {
        const [east, north] = toLocal([house.lng, house.lat], position);
        houseBearingDeg = normalizeDeg(Math.atan2(east, north) * 180 / Math.PI);
      }
      const pov = povHeadingFor({
        previousHeadingDeg: headingDeg,
        travelBearingDeg: fix.bearingDeg,
        houseBearingDeg,
        aheadM: houseAheadM,
        dtSeconds,
      });
      headingDeg = pov.headingDeg;
      // Both buffers, always. The heading has to be continuous **across** the
      // cross-fade or the hop is a pan as well as a dolly, and two pictures
      // pointing different ways dissolving into each other is a smear.
      for (const layer of layers) {
        try { layer.panorama.setPov({ heading: headingDeg, pitch: 0 }); } catch { /* between panos */ }
      }

      lastFixAt = now();
      fillQueue();
      startPreload();
      // The hop itself is stepped by `startLoop`, on its own animation frame.
      syncMarkers(position);
      return {
        headingDeg,
        blend: pov.blend,
        mode: coverage.mode,
        panoId: front().panoId,
        phase: hop.phase,
      };
    },

    /**
     * Park a panorama at one point and hold it. The stop view.
     *
     * Not a hop along a route: there is no queue, no cadence and no next one.
     * The first panorama goes straight into the **front** buffer, because the
     * host is still transparent at that moment and there is nothing to
     * cross-fade *from* — a dissolve out of a black rectangle is worse than an
     * arrival. Every panorama after that preloads into the back buffer and
     * cross-fades in like any other change, which is the double buffer earning
     * its keep at a standstill.
     *
     * @returns {Promise<{ok:boolean, panoId?:string, faded?:boolean, reason?:string}>}
     */
    async showAt(position, headingDeg = null) {
      if (!ready || destroyed) return { ok: false, reason: failure || 'not mounted' };
      if (!Number.isFinite(position?.lat) || !Number.isFinite(position?.lng)) {
        return { ok: false, reason: 'no position' };
      }
      if (Number.isFinite(headingDeg)) headingDeg = normalizeDeg(headingDeg);
      const found = await new Promise((resolve) => {
        try {
          service.getPanorama(
            {
              location: { lat: position.lat, lng: position.lng },
              radius: PANO_RADIUS_M,
              source: 'outdoor',
              preference: 'nearest',
            },
            (data, status) => resolve(
              status === 'OK' && data?.location?.pano ? data.location.pano : null,
            ),
          );
        } catch { resolve(null); }
      });
      requests += 1;
      if (!found) return { ok: false, reason: `no panorama within ${PANO_RADIUS_M} m` };
      hits += 1;
      if (found === front().panoId) return { ok: true, panoId: found, faded: false };

      const arrive = (layer) => {
        layer.panoId = found;
        seenPanos.add(found);
        panoCount += 1;
        try { layer.panorama.setPano(found); } catch { /* pano vanished */ }
        if (headingDeg !== null) {
          try { layer.panorama.setPov({ heading: headingDeg, pitch: 0 }); } catch { /* ok */ }
        }
      };

      // Nothing on screen yet: straight into the front buffer, invisibly.
      if (!front().panoId) {
        arrive(front());
        hop = initialHopState(now());
        paint();
        onPano?.({ panoId: found, alongM: null, position });
        return { ok: true, panoId: found, faded: false };
      }

      // Something is already showing: preload and cross-fade to it.
      queue.clear();
      loading = { panoId: found, alongM: null, position };
      backReady = false;
      const token = ++preloadToken;
      clearPreloadTimer();
      preloadTimer = win.setTimeout?.(() => preloadSettled(token, false), PRELOAD_TIMEOUT_MS);
      try {
        maps.event.addListenerOnce(back().panorama, 'pano_changed', () => {
          if (token !== preloadToken) return;
          clearPreloadTimer();
          preloadTimer = win.setTimeout?.(() => preloadSettled(token, true), PRELOAD_SETTLE_MS);
        });
        back().panorama.setPano(found);
        if (headingDeg !== null) back().panorama.setPov({ heading: headingDeg, pitch: 0 });
      } catch {
        preloadSettled(token, false);
        return { ok: false, reason: 'the panorama refused to load' };
      }
      forceHop = true;
      startLoop();
      onPano?.({ panoId: found, alongM: null, position });
      return { ok: true, panoId: found, faded: true };
    },

    /**
     * Finish whatever is in flight, now.
     *
     * The hop advances on fixes, and a paused drive emits none — so a pause
     * landing mid-fade would freeze both layers at half opacity, which is a
     * double exposure rather than a picture. Pausing settles it first.
     */
    settle() {
      if (hop.phase !== HOP_PHASE.FADING) return false;
      completeHop();
      hop = { ...initialHopState(now()), hops: hop.hops + 1 };
      paint();
      return true;
    },

    /** After a seek: the queue is about a stretch of road we are no longer on. */
    reseat() {
      this.settle();
      queue.clear();
      loading = null;
      backReady = false;
      preloadToken += 1;
      clearPreloadTimer();
      cursorM = null;
      driveAtM = null;
      probeAttempt = 0;
      headingDeg = null;
      hop = initialHopState(now());
      paint();
    },

    /** Start a fresh drive: no coverage debt carried over from the last one. */
    reset() {
      this.reseat();
      coverage = initialCoverage();
      health = initialPreloadHealth();
      requests = 0;
      hits = 0;
      panoCount = 0;
      stalls = 0;
      fades = 0;
      longestFadeMs = 0;
      seenPanos.clear();
      for (const layer of layers) {
        layer.panoId = null;
        layer.markerKey = '';
      }
      frontIndex = 0;
    },

    clearMarkers,

    destroy() {
      destroyed = true;
      stopLoop();
      clearPreloadTimer();
      clearMarkers();
      for (const layer of layers) {
        try { layer.panorama?.setVisible?.(false); } catch { /* already gone */ }
        layer.panorama = null;
      }
      if (element) element.hidden = true;
      service = null;
      ready = false;
    },
  };
}
