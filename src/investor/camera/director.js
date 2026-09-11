/**
 * One object owns the investor camera.
 *
 * Before this, five places called `viewer.camera.flyTo` directly — session
 * bootstrap, focus, the market flight, the drive, and the pick handler — each
 * with its own durations and angles, each calling `cancelFlight()` and hoping.
 * Two of them could be in the air at once, which is what made moves feel abrupt:
 * a half-finished flight getting stomped mid-arc reads as a pop.
 *
 * The director serialises all of it:
 *   - `fly(shot, target)` resolves when the move settles. A new `fly` cancels
 *     the one in progress *cleanly* — Cesium's `cancelFlight()` leaves the
 *     camera where it is, so there is no jump — and the superseded promise
 *     resolves with `{ cancelled: true }` rather than hanging or rejecting.
 *   - `orbit()` runs the hero orbit off the render loop, and stops on the first
 *     user input or the next flight.
 *   - `hop(from, to)` rises over the midpoint and comes down into HERO.
 *
 * Two house rules, both about not fighting the rest of the app:
 *   - every flight takes a render-governor hold for its duration and releases
 *     it on settle, so frames actually render mid-flight;
 *   - `prefers-reduced-motion` collapses every flight to an instant `setView`.
 */
import { governorRequestRender, holdContinuousRender, releaseContinuousRender } from '../../renderGovernor.js';
import { prefersReducedMotion } from '../visuals/reducedMotionPolicy.js';
import {
  DURATIONS,
  HERO,
  cruiseShot,
  durationFor,
  headingBetween,
  heroShot,
  hopApexShot,
  revealShot,
  stagingShot,
  worldShot,
  driveShot,
} from './shots.js';

const FLIGHT_HOLD = 'investor-camera-flight';
const ORBIT_HOLD = 'investor-camera-orbit';
/** Give up waiting on tiles rather than stalling the demo behind a slow network. */
const TILE_WAIT_TIMEOUT_MS = 4_000;

export function createCameraDirector({
  viewer,
  Cesium,
  market,
  reducedMotion = prefersReducedMotion,
  timers = globalThis,
  now = () => Date.now(),
}) {
  let flightSeq = 0;
  let activeFlight = 0;
  let currentShot = 'WORLD';
  let orbiting = false;
  let orbitRemove = null;
  let orbitInputRemove = null;
  let destroyed = false;
  const flightListeners = new Set();

  /**
   * Everything that reacts to the camera — pulses, halos, the focus card —
   * listens here rather than guessing from timers. `flying` is the only state
   * that matters; `shot` and `cancelled` are context.
   */
  function emitFlight(state) {
    for (const listener of [...flightListeners]) {
      try { listener(state); } catch (error) { console.error('[TerraSignal] camera listener:', error); }
    }
  }

  const easing = () => Cesium?.EasingFunction?.CUBIC_IN_OUT;

  /**
   * Ground elevation under a point, in metres above the ellipsoid.
   *
   * Every altitude in shots.js is above GROUND, which is the only reading that
   * means anything for a camera. `Cartesian3.fromDegrees` takes ellipsoid
   * height, and Decatur sits ~310 m up — so without this correction the 111 m
   * hero camera is two hundred metres *below* the street and renders an empty
   * void. Sampled from the loaded scene where possible so other markets need no
   * new constant; the market value is the fallback before tiles arrive.
   */
  function groundHeightM(lat, lng) {
    try {
      const carto = Cesium.Cartographic.fromDegrees(lng, lat);
      if (viewer.scene?.sampleHeightSupported) {
        const sampled = viewer.scene.sampleHeight(carto);
        if (Number.isFinite(sampled)) return sampled;
      }
      const terrain = viewer.scene?.globe?.getHeight?.(carto);
      if (Number.isFinite(terrain)) return terrain;
    } catch {
      // Scene not ready, or no geometry loaded under that point yet.
    }
    return Number(market?.groundElevationM) || 0;
  }

  function destinationOf(shot) {
    // WORLD is a space view; adding a few hundred metres to 18,000 km is noise,
    // but keeping one code path is worth more than the micro-optimisation.
    const ground = shot.name === 'WORLD' ? 0 : groundHeightM(shot.lat, shot.lng);
    return Cesium.Cartesian3.fromDegrees(shot.lng, shot.lat, shot.heightM + ground);
  }

  function orientationOf(shot) {
    return {
      heading: Cesium.Math.toRadians(shot.headingDeg),
      pitch: Cesium.Math.toRadians(shot.pitchDeg),
      roll: 0,
    };
  }

  function settle(token) {
    if (token !== activeFlight) return; // a newer flight owns the hold now
    releaseContinuousRender(FLIGHT_HOLD);
    governorRequestRender('investor-camera-settled');
  }

  /** Cancel whatever is in the air. Leaves the camera exactly where it is. */
  function cancel() {
    stopOrbit();
    if (!activeFlight) return;
    activeFlight = 0;
    try { viewer?.camera?.cancelFlight?.(); } catch { /* nothing in flight */ }
    releaseContinuousRender(FLIGHT_HOLD);
  }

  /**
   * @param {object} shot a resolved shot from shots.js
   * @returns {Promise<{cancelled:boolean, shot:string}>}
   */
  function flyToShot(shot, { duration } = {}) {
    if (destroyed || !viewer?.camera) return Promise.resolve({ cancelled: true, shot: shot?.name });
    cancel();
    const token = ++flightSeq;
    activeFlight = token;
    const previous = currentShot;
    currentShot = shot.name;

    const seconds = Number.isFinite(duration) ? duration : durationFor(previous, shot.name);

    if (reducedMotion()) {
      // No motion budget: take the framing, skip the travel.
      viewer.camera.setView({ destination: destinationOf(shot), orientation: orientationOf(shot) });
      activeFlight = 0;
      governorRequestRender('investor-camera-reduced');
      emitFlight({ flying: false, shot: shot.name, cancelled: false, reduced: true });
      return Promise.resolve({ cancelled: false, shot: shot.name, reduced: true });
    }

    holdContinuousRender(FLIGHT_HOLD);
    emitFlight({ flying: true, shot: shot.name });
    return new Promise((resolve) => {
      viewer.camera.flyTo({
        destination: destinationOf(shot),
        orientation: orientationOf(shot),
        duration: seconds,
        easingFunction: easing(),
        complete: () => {
          settle(token);
          if (token === activeFlight) activeFlight = 0;
          emitFlight({ flying: false, shot: shot.name, cancelled: false });
          resolve({ cancelled: false, shot: shot.name });
        },
        cancel: () => {
          settle(token);
          // Superseded, not failed — the caller's `await` must not hang.
          // No `flying:false` here: a cancel is always immediately followed by
          // the flight that superseded it, and flapping the flag would let
          // visuals rebuild for one frame in the middle of a move.
          resolve({ cancelled: true, shot: shot.name });
        },
      });
    });
  }

  /**
   * Wait for the scene to stop streaming tiles, bounded. This is what STAGING
   * is for: hold at 40 km until the metro is loaded, so the descent does not
   * fly through popping tiles.
   */
  function awaitTiles(timeoutMs = TILE_WAIT_TIMEOUT_MS) {
    const scene = viewer?.scene;
    if (!scene) return Promise.resolve(false);
    return new Promise((resolve) => {
      let done = false;
      const finish = (loaded) => {
        if (done) return;
        done = true;
        timers.clearTimeout?.(timer);
        try { remove?.(); } catch { /* already gone */ }
        resolve(loaded);
      };
      const timer = timers.setTimeout(() => finish(false), timeoutMs);
      const remove = scene.postRender?.addEventListener?.(() => {
        const globeReady = scene.globe ? scene.globe.tilesLoaded !== false : true;
        const tileset = globalThis.__godsEyeView?.tileset;
        const tilesetReady = tileset ? tileset.tilesLoaded !== false : true;
        if (globeReady && tilesetReady) finish(true);
      });
      if (!remove) finish(false);
    });
  }

  // ---- orbit -------------------------------------------------------------

  function stopOrbit() {
    if (!orbiting) return;
    orbiting = false;
    try { orbitRemove?.(); } catch { /* already removed */ }
    orbitRemove = null;
    try { orbitInputRemove?.(); } catch { /* already removed */ }
    orbitInputRemove = null;
    releaseContinuousRender(ORBIT_HOLD);
  }

  /**
   * Slow orbit around the focused house. Stops on the first user input — a
   * camera that keeps moving while someone is dragging it is the definition of
   * fighting the user.
   *
   * This re-derives the HERO shot each frame with an advancing heading rather
   * than using `camera.lookAt`. lookAt always CENTRES its target, so it would
   * throw away the lower-third framing the hero flight just landed on — the
   * camera would visibly snap from the framed pitch to the geometric one the
   * instant the orbit started. Flying the shot keeps position, pitch and
   * framing continuous, so the orbit begins from exactly the pose that landed.
   */
  function startOrbit(property, {
    degPerSec = HERO.orbitDegPerSec,
    maxDeg = HERO.orbitMaxDeg,
  } = {}) {
    stopOrbit();
    if (destroyed || !viewer?.camera || !property || reducedMotion()) return false;
    let headingDeg = HERO.headingDeg;
    let travelled = 0;
    let last = now();

    orbiting = true;
    holdContinuousRender(ORBIT_HOLD);

    orbitRemove = viewer.scene.postRender.addEventListener(() => {
      if (!orbiting) return;
      const stamp = now();
      const delta = Math.min(0.25, (stamp - last) / 1000); // cap after a stall
      last = stamp;
      const step = degPerSec * delta;
      travelled += step;
      headingDeg = (headingDeg + step) % 360;
      const shot = heroShot(property, { headingDeg });
      viewer.camera.setView({
        destination: destinationOf(shot),
        orientation: orientationOf(shot),
      });
      // One revolution is a look around the house. Past that it is just a
      // continuous-render hold burning a laptop battery on an idle demo.
      if (travelled >= maxDeg) stopOrbit();
    });

    // Any drag, wheel or pinch hands control back to the user.
    const handler = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas);
    for (const type of ['LEFT_DOWN', 'RIGHT_DOWN', 'MIDDLE_DOWN', 'WHEEL', 'PINCH_START']) {
      const eventType = Cesium.ScreenSpaceEventType[type];
      if (eventType !== undefined) handler.setInputAction(() => releaseCamera(), eventType);
    }
    orbitInputRemove = () => handler.destroy();
    return true;
  }

  function releaseCamera() {
    stopOrbit();
    governorRequestRender('investor-camera-user-input');
  }

  // ---- public shots ------------------------------------------------------

  const director = {
    get shot() { return currentShot; },
    get orbiting() { return orbiting; },
    get flying() { return activeFlight !== 0; },

    /** Subscribe to flight start/settle. Returns an unsubscribe function. */
    onFlight(listener) {
      if (typeof listener !== 'function') return () => {};
      flightListeners.add(listener);
      return () => flightListeners.delete(listener);
    },

    /** Hold on a settled shot so the audience can read it. */
    dwell(seconds) {
      return new Promise((resolve) => timers.setTimeout(resolve, Math.max(0, seconds * 1000)));
    },

    /**
     * @param {'WORLD'|'STAGING'|'CRUISE'|'REVEAL'|'HERO'|'DRIVE'} name
     * @param {object} [target] property, list of properties, or {headingDeg}
     */
    fly(name, target = null, options = {}) {
      switch (name) {
        case 'WORLD':
          return flyToShot(worldShot(market), options);
        case 'STAGING':
          return flyToShot(stagingShot(market), options);
        case 'CRUISE':
          return flyToShot(cruiseShot(), options);
        case 'REVEAL':
          return flyToShot(revealShot(target || []), options);
        case 'HERO':
          return flyToShot(heroShot(target, options), options);
        case 'DRIVE':
          return flyToShot(driveShot(target, options.headingDeg), options);
        default:
          return Promise.resolve({ cancelled: true, shot: name });
      }
    },

    /**
     * The opening move: park, stage high while tiles stream, then descend.
     * Returns when the market view has settled.
     */
    async descend({ onStaged } = {}) {
      await this.fly('STAGING');
      await awaitTiles();
      onStaged?.();
      return this.fly('CRUISE');
    },

    /** Up over the midpoint, then down into HERO on the target. */
    async hop(from, to) {
      if (!from || !to) return this.fly('HERO', to);
      const height = currentHeightM();
      const apex = await flyToShot(hopApexShot(from, to, height), { duration: DURATIONS.hop / 2 });
      if (apex.cancelled) return apex;
      return flyToShot(heroShot(to), { duration: DURATIONS.hop / 2 });
    },

    orbit(property, options) {
      return startOrbit(property, options);
    },

    stopOrbit,
    cancel,
    releaseCamera,
    awaitTiles,

    /** Heading along a route leg, for the chase camera. */
    routeHeading(from, to) {
      return from && to ? headingBetween(from, to) : HERO.headingDeg;
    },

    destroy() {
      destroyed = true;
      cancel();
      stopOrbit();
      flightListeners.clear();
    },
  };

  function currentHeightM() {
    try {
      const carto = Cesium.Cartographic.fromCartesian(viewer.camera.positionWC);
      return Number(carto?.height) || 0;
    } catch {
      return 0;
    }
  }

  return director;
}
