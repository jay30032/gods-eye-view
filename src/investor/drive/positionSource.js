/**
 * Where the drive currently is — from a spline, or from a phone.
 *
 * Drive Mode v1 plays a recorded route back. Drive Mode in a car reads GPS. The
 * difference must not reach the rest of the feature, so both are behind one
 * contract and **everything downstream reads the source, never the spline**:
 *
 *     { position: {lat, lng}, bearingDeg, speedMps, timestamp, accuracyM }
 *
 * That is not architecture for its own sake. The activation states, the
 * "on your left", and every narration rule are written against a *fix*, so the
 * same call-outs fire in the same order whether the fix came from a spline or
 * from a windscreen — which `positionSource.test.mjs` asserts directly by
 * feeding the route through `GpsSource` as noisy fake fixes and comparing the
 * call-out order against playback.
 *
 * A source emits; it does not decide anything. No activation, no narration, no
 * camera. Those all live downstream and take a fix as input.
 */

import {
  bearingOf,
  buildRoute,
  normalizeDeg,
  pointAt,
  projectOnto,
  smoothHeading,
  toLocal,
  wrapDistance,
} from './route.js';

/** Default playback speed. Not a vehicle's speed — how fast the drive plays. */
export const DEFAULT_SPEED_MPS = 9;
/** "slower" and "faster". */
export const SLOWER_SCALE = 0.6;
export const FASTER_SCALE = 1.5;
/** Playback eases in over this long, so the drive starts rather than lurches. */
export const EASE_IN_S = 2;

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

/** Smoothstep 0..1. */
function ease(t) {
  const x = clamp(t, 0, 1);
  return x * x * (3 - 2 * x);
}

function emitTo(listeners, fix) {
  for (const listener of [...listeners]) {
    try {
      listener(fix);
    } catch (error) {
      console.error('[TerraSignal] position listener:', error);
    }
  }
}

/**
 * Playback along the route spline.
 *
 * Driven by `advance(dt)` rather than owning a timer. The render loop supplies
 * the real elapsed time, and a test supplies whatever it likes — which is what
 * makes a whole drive replayable in a few milliseconds with no clock at all.
 */
export function createPlaybackSource({
  route,
  speedMps = DEFAULT_SPEED_MPS,
  startAlongM = 0,
  now = () => Date.now(),
} = {}) {
  const listeners = new Set();
  let alongM = wrapDistance(startAlongM, route?.lengthM || 0);
  let running = false;
  let paused = false;
  let elapsedS = 0;
  let speedScale = 1;
  /** Set by the drive when it wants to slow for a house being explained. */
  let externalScale = 1;
  let last = null;
  let laps = 0;

  function fixAt(distanceM, speed) {
    const point = pointAt(route, distanceM);
    if (!point) return null;
    return {
      position: { lat: point.lat, lng: point.lng },
      bearingDeg: point.bearingDeg,
      speedMps: speed,
      timestamp: now(),
      accuracyM: 0,
      source: 'playback',
    };
  }

  const source = {
    kind: 'playback',
    get running() { return running; },
    get paused() { return paused; },
    get last() { return last; },
    get alongM() { return alongM; },
    get laps() { return laps; },
    /** The base playback speed before any slow-down. */
    get speedMps() { return speedMps * speedScale; },

    subscribe(listener) {
      if (typeof listener !== 'function') return () => {};
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    start() {
      running = true;
      paused = false;
      elapsedS = 0;
      laps = 0;
      last = fixAt(alongM, 0);
      if (last) emitTo(listeners, last);
      return true;
    },

    stop() {
      running = false;
      paused = false;
    },

    pause() { paused = true; },
    resume() { paused = false; },

    /** "slower" / "faster" / back to normal. */
    setSpeedScale(scale) {
      speedScale = clamp(Number(scale) || 1, 0.1, 4);
      return speedScale;
    },
    slower() { return this.setSpeedScale(speedScale * SLOWER_SCALE); },
    faster() { return this.setSpeedScale(speedScale * FASTER_SCALE); },

    /** The drive slowing playback for a house it is talking about. */
    setExternalScale(scale) {
      externalScale = clamp(Number(scale) || 1, 0.05, 1);
      return externalScale;
    },

    /** Jump to a distance along the route — "keep going" after a detour. */
    seek(distanceM) {
      alongM = wrapDistance(distanceM, route?.lengthM || 0);
      last = fixAt(alongM, 0);
      if (last) emitTo(listeners, last);
      return alongM;
    },

    /**
     * Move the drive on by `dtSeconds` of wall clock.
     *
     * The ease-in is on elapsed time rather than on distance, so the drive
     * always takes two seconds to reach speed regardless of how fast playback
     * is set — which is what makes "faster" feel like a faster drive rather
     * than a harder launch.
     */
    advance(dtSeconds) {
      if (!running || paused) return last;
      const dt = Number(dtSeconds);
      if (!Number.isFinite(dt) || dt <= 0) return last;

      elapsedS += dt;
      const easeScale = ease(elapsedS / EASE_IN_S);
      const speed = speedMps * speedScale * externalScale * easeScale;
      const before = alongM;
      const next = alongM + speed * dt;
      const length = route?.lengthM || 0;
      if (length > 0 && next >= length && before < length) laps += 1;
      alongM = wrapDistance(next, length);

      last = fixAt(alongM, speed);
      if (last) emitTo(listeners, last);
      return last;
    },

    destroy() {
      running = false;
      listeners.clear();
    },
  };
  return source;
}

// ---------------------------------------------------------------------------
// GPS
// ---------------------------------------------------------------------------

/** Below this a GPS course is noise, not a direction of travel. */
export const GPS_MOVING_MPS = 0.8;
/** How far back to look for a bearing when the course is unusable. */
export const GPS_BEARING_WINDOW_M = 15;
/** Snap to the road only when the fix is already this close to one. */
export const GPS_SNAP_M = 12;
/** Time constant of the position filter. Enough to stop jitter, not to lag. */
export const GPS_POSITION_TAU_S = 0.7;
/** A fix worse than this is reported but not trusted to move the camera. */
export const GPS_MAX_ACCURACY_M = 40;

/**
 * A real position source: `navigator.geolocation.watchPosition`.
 *
 * Four things a naive implementation gets wrong, all of which show up as a
 * camera that cannot be watched:
 *
 *   1. **Bearing.** `coords.heading` is only meaningful while actually moving;
 *      standing still it is `null` or last-known garbage, and feeding it to the
 *      camera spins it on the spot. So the course is used while moving and
 *      otherwise the bearing is derived from the last 15 m of travel.
 *   2. **Jitter.** A consumer fix wanders several metres a second even
 *      stationary. Unfiltered, that is a camera with a tremor. A light
 *      exponential filter on position — time-based, so it behaves the same at
 *      any fix rate — takes it out without adding visible lag.
 *   3. **Snapping.** Pulling every fix onto the road hides real divergence and
 *      teleports the camera when the driver leaves the route. Snapping only
 *      within 12 m keeps the camera on the road where the road is plainly where
 *      you are, and lets it be wrong honestly when it is not.
 *   4. **Bad fixes.** A 200 m-accuracy fix under a bridge is not a position.
 *      It is passed through as data, with `trusted: false`, and the drive keeps
 *      the last good one rather than jumping across the neighbourhood.
 */
export function createGpsSource({
  route = null,
  geolocation = globalThis.navigator?.geolocation,
  now = () => Date.now(),
  snapM = GPS_SNAP_M,
  tauS = GPS_POSITION_TAU_S,
} = {}) {
  const listeners = new Set();
  let watchId = null;
  let running = false;
  let last = null;
  let smoothed = null; // { lat, lng }
  let smoothedBearing = null;
  let lastAt = null;
  const trail = []; // recent fixes, for the fallback bearing

  function bearingFromTrail() {
    if (trail.length < 2) return null;
    const head = trail[trail.length - 1];
    const origin = { lat: head.lat, lng: head.lng };
    // Walk back until far enough away to be a direction rather than noise.
    for (let i = trail.length - 2; i >= 0; i -= 1) {
      const p = toLocal([trail[i].lng, trail[i].lat], origin);
      const distance = Math.hypot(p[0], p[1]);
      if (distance >= GPS_BEARING_WINDOW_M) {
        // From the older point TO the head: the direction of travel.
        return bearingOf([-p[0], -p[1]]);
      }
    }
    return null;
  }

  /** Pull a fix onto the route, but only when it is plainly already on it. */
  function snap(position) {
    if (!route?.points?.length) return { position, snapped: false, alongM: null };
    const projected = projectOnto(route, position);
    if (!projected || projected.offsetM > snapM) {
      return { position, snapped: false, alongM: projected?.alongM ?? null };
    }
    const onRoad = pointAt(route, projected.alongM);
    if (!onRoad) return { position, snapped: false, alongM: projected.alongM };
    return {
      position: { lat: onRoad.lat, lng: onRoad.lng },
      snapped: true,
      alongM: projected.alongM,
    };
  }

  /**
   * Turn a browser GeolocationPosition into a fix.
   * Exported through `handle` so the test can drive it without a browser.
   */
  function handle(raw) {
    const coords = raw?.coords;
    if (!Number.isFinite(coords?.latitude) || !Number.isFinite(coords?.longitude)) return null;
    const timestamp = Number(raw.timestamp) || now();
    const accuracyM = Number.isFinite(coords.accuracy) ? coords.accuracy : null;
    const speedMps = Number.isFinite(coords.speed) && coords.speed >= 0 ? coords.speed : 0;
    const trusted = accuracyM === null || accuracyM <= GPS_MAX_ACCURACY_M;

    const dtS = lastAt === null ? 0 : Math.max(0, (timestamp - lastAt) / 1000);
    lastAt = timestamp;

    const measured = { lat: coords.latitude, lng: coords.longitude };

    // (2) Filter. First fix sets the state; after that it eases towards each
    // new measurement over `tauS`, which is a fix rate the filter never has to
    // know about.
    if (!smoothed || !trusted) {
      smoothed = smoothed && !trusted ? smoothed : { ...measured };
    } else {
      const alpha = dtS > 0 ? 1 - Math.exp(-dtS / tauS) : 1;
      smoothed = {
        lat: smoothed.lat + (measured.lat - smoothed.lat) * alpha,
        lng: smoothed.lng + (measured.lng - smoothed.lng) * alpha,
      };
    }

    trail.push({ ...smoothed, timestamp });
    while (trail.length > 64) trail.shift();

    // (3) Snap, only when already close.
    const snappedResult = snap(smoothed);

    // (1) Bearing: course while moving, trail otherwise.
    const course = Number.isFinite(coords.heading) ? normalizeDeg(coords.heading) : null;
    const moving = speedMps >= GPS_MOVING_MPS;
    const target = (moving && course !== null) ? course : bearingFromTrail();
    if (target !== null) {
      smoothedBearing = smoothHeading(smoothedBearing, target, dtS > 0 ? dtS : 1);
    }

    const fix = {
      position: snappedResult.position,
      bearingDeg: smoothedBearing === null ? 0 : smoothedBearing,
      speedMps,
      timestamp,
      accuracyM,
      source: 'gps',
      trusted,
      snapped: snappedResult.snapped,
      alongM: snappedResult.alongM,
      raw: measured,
    };
    // An untrusted fix is reported but must not move the drive; the caller
    // keeps the last good one. Reporting it is what lets the HUD say "weak
    // signal" instead of silently freezing.
    if (trusted) last = fix;
    emitTo(listeners, fix);
    return fix;
  }

  return {
    kind: 'gps',
    get running() { return running; },
    get last() { return last; },
    get supported() { return Boolean(geolocation?.watchPosition); },

    subscribe(listener) {
      if (typeof listener !== 'function') return () => {};
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    start(onError) {
      if (!geolocation?.watchPosition) {
        onError?.(new Error('geolocation is not available'));
        return false;
      }
      running = true;
      watchId = geolocation.watchPosition(
        (raw) => handle(raw),
        (error) => onError?.(error),
        { enableHighAccuracy: true, maximumAge: 1_000, timeout: 15_000 },
      );
      return true;
    },

    stop() {
      running = false;
      if (watchId !== null && geolocation?.clearWatch) {
        try { geolocation.clearWatch(watchId); } catch { /* already gone */ }
      }
      watchId = null;
    },

    /** Feed one fix directly. The test harness and nothing else. */
    handle,

    // A GPS drive has no playback speed to change; these exist so the drive
    // can talk to either source without asking which one it has.
    setSpeedScale() { return 1; },
    slower() { return 1; },
    faster() { return 1; },
    setExternalScale() { return 1; },
    pause() {},
    resume() {},
    advance() { return last; },
    seek() { return null; },

    destroy() {
      this.stop();
      listeners.clear();
    },
  };
}

/** Build a route object from raw coordinates once, for either source. */
export function routeFrom(coordinates) {
  return buildRoute(coordinates);
}
