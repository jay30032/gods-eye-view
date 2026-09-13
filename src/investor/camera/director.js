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
import { normalizeDeg, stepPitchDeg, stepRangeM } from './orientation.js';
import { frontNormalDeg, headingForSide } from './orientation.js';
import { candidateHeadings, pickBestHeading, samplePoints } from './bestAngle.js';
import { footprintCentroid } from '../mock/parcel.js';
import { geometryFor } from '../mock/geometry.js';
import {
  DRIVE_CHASE,
  DURATIONS,
  HERO,
  cameraFromRange,
  clusterCruiseShot,
  driveChaseShot,
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
const DRIVE_HOLD = 'investor-camera-drive';
/**
 * Tile gates. Waiting for geometry before the two flights people actually watch
 * trades a short, invisible pause at a stationary camera for tiles popping in
 * while it moves. Both are hard-capped so a slow network delays the demo rather
 * than stalling it.
 */
/** Slack on an occlusion ray: the sample point IS the surface it lands on. */
const RAY_TOLERANCE_M = 2;
/** Lift sample points off the lawn so a ray does not graze the garden. */
const SAMPLE_RISE_M = 1;
const TILE_WAIT_TIMEOUT_MS = 4_000;
const STAGING_GATE_MS = 2_500;
const HERO_GATE_MS = 1_500;

export function createCameraDirector({
  viewer,
  Cesium,
  market,
  reducedMotion = prefersReducedMotion,
  timers = globalThis,
  now = () => Date.now(),
  getGeometry = geometryFor,
}) {
  let flightSeq = 0;
  let activeFlight = 0;
  let currentShot = 'WORLD';
  let orbiting = false;
  let orbitRemove = null;
  let orbitInputRemove = null;
  let destroyed = false;
  let gateSeq = 0;
  let heroGated = false;
  /**
   * Where the camera is standing relative to the focused house.
   *
   * The any-angle commands are relative — "closer" means closer than wherever
   * you are now — so something has to remember the current framing. It lives
   * here rather than in the session because the director is the only thing
   * allowed to move the camera, and a pose the camera owner does not know about
   * would go stale the moment anything else flew.
   */
  let heroPose = null;
  /**
   * Chosen approach heading per property id.
   *
   * Cached because the sweep is forty ray casts against the tileset and the
   * answer does not change: the trees do not move between one focus and the
   * next. Caching also keeps the choice stable, so going back to a house you
   * have already seen puts the camera where it was rather than somewhere new
   * because a few more tiles had loaded.
   */
  const headingChoices = new Map();
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
   * Hero framing options carrying the viewer's true vertical FOV.
   *
   * Cesium's `frustum.fov` is the angle in the WIDER direction; the framing
   * maths needs the vertical one, which on a 16:10 canvas is closer to 40
   * degrees than 60. Getting this wrong moves the house up the frame.
   */
  function heroOptions(extra = {}) {
    const fovy = Number(viewer?.scene?.camera?.frustum?.fovy);
    return Number.isFinite(fovy) && fovy > 0 ? { ...extra, fovRad: fovy } : { ...extra };
  }

  /**
   * Is the straight line from `from` to `to` clear of loaded geometry?
   *
   * `scene.pickFromRay` returns the FIRST thing the ray meets. The target
   * points sit on the building itself, so the ray is expected to hit at
   * (roughly) the target — that counts as clear. Anything appreciably nearer is
   * a tree, a neighbour's roof, or a power line standing between the camera and
   * the house, which is exactly what this is looking for.
   */
  function rayIsClear(from, to) {
    try {
      if (typeof viewer.scene?.pickFromRay !== 'function') return null;
      const direction = Cesium.Cartesian3.normalize(
        Cesium.Cartesian3.subtract(to, from, new Cesium.Cartesian3()),
        new Cesium.Cartesian3(),
      );
      const ray = new Cesium.Ray(from, direction);
      const hit = viewer.scene.pickFromRay(ray, []);
      if (!hit?.position) return true; // nothing in the way at all
      const reach = Cesium.Cartesian3.distance(from, to);
      const blocked = Cesium.Cartesian3.distance(from, hit.position);
      // Two metres of slack: the ray lands on the wall or roof surface that the
      // sample point describes, not on a mathematical point in mid-air.
      return blocked >= reach - RAY_TOLERANCE_M;
    } catch {
      // pickFromRay throws on some drivers and whenever nothing is loaded.
      return null;
    }
  }

  /**
   * Score eight approach headings and keep the one that can see the house.
   *
   * Runs once per property, before the hero flight, at the hero pitch and
   * range — scoring an angle at some other distance would answer a question
   * nobody asked. Returns null when the scene cannot pick at all, in which case
   * the caller keeps the default heading rather than trusting a sweep that
   * measured nothing.
   */
  function chooseHeading(property) {
    if (!property?.id) return null;
    if (headingChoices.has(property.id)) return headingChoices.get(property.id);

    const record = getGeometry(property.id);
    const ring = record?.building?.footprint?.[0] || null;
    if (!ring) return null;

    const centroid = footprintCentroid(ring) || { lat: property.lat, lng: property.lng };
    const ground = groundHeightM(centroid.lat, centroid.lng);
    // Sample a metre above the footprint so a ray does not graze the lawn on
    // its way in and report the house as blocked by its own garden.
    const targets = samplePoints(ring, centroid).map(([lon, lat]) => Cesium.Cartesian3.fromDegrees(
      lon, lat, ground + SAMPLE_RISE_M,
    ));
    if (!targets.length) return null;

    const scored = [];
    let measured = 0;
    for (const headingDeg of candidateHeadings()) {
      const pose = cameraFromRange(centroid, {
        headingDeg,
        pitchDeg: HERO.pitchDeg,
        rangeM: HERO.rangeM,
      });
      // Anchor every candidate camera to the SUBJECT's ground, not its own.
      // That is what `heroShot` does via `groundAnchor`, so the sweep measures
      // the pose the flight will actually take — and it saves eight
      // `sampleHeight` calls, which are render-thread queries.
      const from = Cesium.Cartesian3.fromDegrees(pose.lng, pose.lat, pose.heightM + ground);
      let clear = 0;
      let counted = 0;
      for (const target of targets) {
        const answer = rayIsClear(from, target);
        if (answer === null) continue;
        counted += 1;
        if (answer) clear += 1;
      }
      if (!counted) continue;
      measured += 1;
      scored.push({ headingDeg, score: clear / counted });
    }
    // Nothing could be measured — no tiles, or no picking on this driver.
    if (!measured) return null;

    // The tie-break: a house is meant to be seen from the street.
    const bearing = record?.street?.bearingDeg;
    const front = frontNormalDeg(ring, Number.isFinite(bearing) ? bearing : null);
    const streetHeading = front ? headingForSide('front', front.bearingDeg) : null;

    const choice = pickBestHeading(scored, streetHeading);
    if (!choice) return null;
    const answer = {
      ...choice,
      id: property.id,
      streetHeadingDeg: streetHeading,
      frontSource: front?.source ?? null,
      scores: scored,
    };
    headingChoices.set(property.id, answer);
    return answer;
  }

  /** The pose a fresh HERO lands on, before anyone asks for another angle. */
  function defaultPose(property) {
    return {
      property,
      headingDeg: HERO.headingDeg,
      rangeM: HERO.rangeM,
      pitchDeg: Math.abs(HERO.pitchDeg),
    };
  }

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
    // A shot may anchor its altitude to a point other than the camera position
    // — HERO measures from the house's ground, not the ground it stands on.
    const anchor = shot.groundAnchor || { lat: shot.lat, lng: shot.lng };
    const ground = shot.name === 'WORLD' ? 0 : groundHeightM(anchor.lat, anchor.lng);
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
   * Wait for the scene to stop streaming, bounded.
   *
   * Prefers the tileset's own `allTilesLoaded` event — that is the signal
   * Cesium raises when the current view is fully resolved — and falls back to
   * polling `tilesLoaded` on postRender for the keyless globe, which has no
   * such event. Always resolves: the cap is what keeps a slow network from
   * turning a gate into a stall.
   *
   * @returns {Promise<boolean>} true if tiles settled, false if the cap won
   */
  /** Is the current view fully resolved right now? */
  function tilesSettled() {
    const scene = viewer?.scene;
    if (!scene) return true;
    const tileset = globalThis.__godsEyeView?.tileset || null;
    const globeReady = scene.globe ? scene.globe.tilesLoaded !== false : true;
    const tilesetReady = tileset ? tileset.tilesLoaded !== false : true;
    return globeReady && tilesetReady;
  }

  function awaitTiles(timeoutMs = TILE_WAIT_TIMEOUT_MS) {
    const scene = viewer?.scene;
    if (!scene) return Promise.resolve(false);
    const tileset = globalThis.__godsEyeView?.tileset || null;
    const settled = () => tilesSettled();
    if (settled()) return Promise.resolve(true);

    return new Promise((resolve) => {
      let done = false;
      let removeRender = null;
      let removeTileset = null;
      const finish = (loaded) => {
        if (done) return;
        done = true;
        timers.clearTimeout?.(timer);
        try { removeRender?.(); } catch { /* already gone */ }
        try { removeTileset?.(); } catch { /* already gone */ }
        resolve(loaded);
      };
      const timer = timers.setTimeout(() => finish(false), timeoutMs);

      removeTileset = tileset?.allTilesLoaded?.addEventListener?.(() => {
        if (settled()) finish(true);
      }) || null;
      removeRender = scene.postRender?.addEventListener?.(() => {
        if (settled()) finish(true);
      }) || null;

      if (!removeRender && !removeTileset) finish(false);
    });
  }

  /**
   * Hold for tiles, then fly — unless a newer gated request arrived while we
   * were waiting, in which case this one quietly stands down rather than
   * taking off behind the newer flight.
   */
  function gatedFly(build, options, gateMs) {
    // Nothing to wait for: take off in this tick. Deferring by a microtask
    // when the gate is a no-op would make every caller's timing subtly
    // different depending on the network, which is its own bug.
    if (tilesSettled()) return flyToShot(build(), options);
    const token = ++gateSeq;
    return awaitTiles(gateMs).then(() => {
      if (destroyed || token !== gateSeq) return { cancelled: true, shot: build().name };
      return flyToShot(build(), options);
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
    // Pick up from wherever the camera is standing. Starting every orbit at the
    // default heading would snap the view the instant someone who has just
    // asked for the back of the house says "orbit".
    const base = heroPose?.property === property ? heroPose : defaultPose(property);
    heroPose = { ...base, property };
    let headingDeg = base.headingDeg;
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
      // Same FOV, range and pitch the flight used, or the framing jumps the
      // instant we take over.
      const shot = heroShot(property, heroOptions({
        headingDeg,
        rangeM: base.rangeM,
        pitchDeg: base.pitchDeg,
      }));
      // Keep the remembered pose in step, so "closer" after an orbit measures
      // from where the camera actually is.
      heroPose = { ...base, property, headingDeg };
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

  // ---- drive chase -------------------------------------------------------

  /**
   * The chase camera, held open for the length of a drive.
   *
   * Unlike every other shot this is not a flight: there is no destination and
   * no duration, just a pose written per fix. So it takes its own render hold
   * and writes with `setView`, exactly as the orbit does — a `flyTo` per fix
   * would be a new flight every frame, each cancelling the last, and the camera
   * would never actually arrive anywhere.
   *
   * The heading it is given has already been smoothed by `route.smoothHeading`;
   * the director does not re-filter it. One filter, one place.
   */
  let driving = false;
  let driveLook = { offsetDeg: 0, pitchDeg: DRIVE_CHASE.pitchDeg };

  function engageDrive() {
    if (driving) return false;
    cancel();
    driving = true;
    currentShot = 'DRIVE';
    driveLook = { offsetDeg: 0, pitchDeg: DRIVE_CHASE.pitchDeg };
    holdContinuousRender(DRIVE_HOLD);
    emitFlight({ flying: false, shot: 'DRIVE', driving: true });
    return true;
  }

  function releaseDrive() {
    if (!driving) return false;
    driving = false;
    releaseContinuousRender(DRIVE_HOLD);
    governorRequestRender('investor-drive-released');
    return true;
  }

  /**
   * "Look left", "look right", "overhead" — and back.
   *
   * A temporary offset on the camera only. The drive keeps going and the
   * tracked position keeps advancing; what changes is where the lens points,
   * which is why "Resume drive" can ease it back without touching the route
   * position at all.
   */
  function setDriveLook(look) {
    switch (look) {
      case 'left':
        driveLook = { offsetDeg: DRIVE_CHASE.lookLeftDeg, pitchDeg: DRIVE_CHASE.pitchDeg };
        break;
      case 'right':
        driveLook = { offsetDeg: DRIVE_CHASE.lookRightDeg, pitchDeg: DRIVE_CHASE.pitchDeg };
        break;
      case 'overhead':
        driveLook = { offsetDeg: 0, pitchDeg: DRIVE_CHASE.overheadPitchDeg };
        break;
      default:
        driveLook = { offsetDeg: 0, pitchDeg: DRIVE_CHASE.pitchDeg };
    }
    return { ...driveLook };
  }

  /** Ease a look offset back towards straight ahead. */
  function relaxDriveLook(dtSeconds, { tauS = 0.6 } = {}) {
    const dt = Number(dtSeconds);
    if (!Number.isFinite(dt) || dt <= 0) return { ...driveLook };
    const alpha = 1 - Math.exp(-dt / Math.max(1e-3, tauS));
    driveLook = {
      offsetDeg: driveLook.offsetDeg + (0 - driveLook.offsetDeg) * alpha,
      pitchDeg: driveLook.pitchDeg + (DRIVE_CHASE.pitchDeg - driveLook.pitchDeg) * alpha,
    };
    if (Math.abs(driveLook.offsetDeg) < 0.05) driveLook.offsetDeg = 0;
    if (Math.abs(driveLook.pitchDeg - DRIVE_CHASE.pitchDeg) < 0.05) {
      driveLook.pitchDeg = DRIVE_CHASE.pitchDeg;
    }
    return { ...driveLook };
  }

  /** One frame of the chase. `headingDeg` must already be smoothed. */
  function updateDrive(position, headingDeg) {
    if (!driving || destroyed || !viewer?.camera) return false;
    if (!Number.isFinite(position?.lat) || !Number.isFinite(position?.lng)) return false;
    const shot = driveChaseShot(position, headingDeg, {
      lookOffsetDeg: driveLook.offsetDeg,
      pitchDeg: driveLook.pitchDeg,
    });
    viewer.camera.setView({
      destination: destinationOf(shot),
      orientation: orientationOf(shot),
    });
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
          // A list of houses re-aims the shot at their centroid; no target is
          // the market view. Same shot name either way.
          return Array.isArray(target) && target.length
            ? flyToShot(clusterCruiseShot(target, options), options)
            : flyToShot(cruiseShot(), options);
        case 'REVEAL':
          return flyToShot(revealShot(target || []), options);
        case 'HERO': {
          // Cesium's frustum.fov is the angle in the WIDER direction; the
          // framing maths needs the vertical one, which on a 16:10 canvas is
          // closer to 40 degrees than 60.
          options = heroOptions(options);
          // Arriving at a house resets the framing: whatever angle the last
          // house was being looked at from, this one starts square — except
          // for the approach heading, which is chosen by looking rather than
          // assumed. A house behind a tree from the default 35 degrees is a
          // house the demo just pointed at and cannot show you.
          const chosen = chooseHeading(target);
          heroPose = defaultPose(target);
          if (chosen) {
            heroPose.headingDeg = chosen.headingDeg;
            options = { ...options, headingDeg: chosen.headingDeg };
          }
          // Gate the FIRST descent onto a house — that flight ends on rooftop
          // geometry that has never been in view at this LOD. Later hops are
          // already inside loaded tiles and should not pay the wait.
          if (!heroGated) {
            heroGated = true;
            return gatedFly(() => heroShot(target, options), options, HERO_GATE_MS);
          }
          return flyToShot(heroShot(target, options), options);
        }
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
    async descend({ onStaged, cruiseTarget = null } = {}) {
      await this.fly('STAGING');
      // Nadir at 40 km with the camera still: the cheapest possible moment to
      // wait for the metro to stream in.
      const loaded = await awaitTiles(STAGING_GATE_MS);
      onStaged?.(loaded);
      // A cluster re-aims the arrival shot; no target lands on the market view.
      return this.fly('CRUISE', cruiseTarget);
    },

    /** Up over the midpoint, then down into HERO on the target. */
    async hop(from, to) {
      if (!from || !to) return this.fly('HERO', to);
      const height = currentHeightM();
      const apex = await flyToShot(hopApexShot(from, to, height), { duration: DURATIONS.hop / 2 });
      if (apex.cancelled) return apex;
      const chosen = chooseHeading(to);
      heroPose = defaultPose(to);
      if (chosen) heroPose.headingDeg = chosen.headingDeg;
      return flyToShot(
        heroShot(to, heroOptions({ headingDeg: heroPose.headingDeg })),
        { duration: DURATIONS.hop / 2 },
      );
    },

    /**
     * Every approach heading chosen so far, keyed by property id — what the
     * sweep found, which angle won, and why. The headed probe reads this.
     */
    get angleChoices() {
      const out = {};
      for (const [id, choice] of headingChoices) {
        out[id] = {
          headingDeg: choice.headingDeg,
          score: choice.score,
          tied: choice.tied,
          reason: choice.reason,
          streetHeadingDeg: choice.streetHeadingDeg,
          frontSource: choice.frontSource,
          scores: choice.scores,
        };
      }
      return out;
    },

    /** Score a house's approach headings without flying anywhere. */
    chooseHeading,

    // ---- drive chase -----------------------------------------------------
    get driving() { return driving; },
    engageDrive,
    releaseDrive,
    setDriveLook,
    relaxDriveLook,
    updateDrive,
    get driveLook() { return { ...driveLook }; },

    /** Where the camera currently stands relative to the focused house. */
    get pose() {
      return heroPose
        ? {
          id: heroPose.property?.id ?? null,
          headingDeg: heroPose.headingDeg,
          rangeM: heroPose.rangeM,
          pitchDeg: heroPose.pitchDeg,
        }
        : null;
    },

    /**
     * Move to another angle on the house already in frame.
     *
     * Every one of these is a re-framing of HERO rather than a shot of its own,
     * which is what holds the house at the same place on screen while the camera
     * travels around it: same subject, same framing fractions, only the pose
     * changes. Two seconds, cubic in and out, the same easing every other
     * flight uses.
     *
     * @param {{headingDeg?:number, range?:'closer'|'farther',
     *   height?:'higher'|'lower'}} changes
     */
    reframe(changes = {}) {
      if (!heroPose?.property) {
        return Promise.resolve({ cancelled: true, shot: 'HERO', reason: 'no house in frame' });
      }
      // An angle request is the user taking the wheel; a still-running orbit
      // would drag the camera off the angle they just asked for.
      stopOrbit();

      const next = { ...heroPose };
      if (Number.isFinite(changes.headingDeg)) next.headingDeg = normalizeDeg(changes.headingDeg);
      if (changes.range) next.rangeM = stepRangeM(next.rangeM, changes.range);
      if (changes.height) next.pitchDeg = stepPitchDeg(next.pitchDeg, changes.height);
      heroPose = next;

      return flyToShot(
        heroShot(next.property, heroOptions({
          headingDeg: next.headingDeg,
          rangeM: next.rangeM,
          pitchDeg: next.pitchDeg,
        })),
        { duration: DURATIONS.reframe },
      );
    },

    orbit(property, options) {
      return startOrbit(property, options);
    },

    stopOrbit,
    cancel,
    releaseCamera,
    awaitTiles,
    get gates() { return { stagingMs: STAGING_GATE_MS, heroMs: HERO_GATE_MS, heroUsed: heroGated }; },

    /** Heading along a route leg, for the chase camera. */
    routeHeading(from, to) {
      return from && to ? headingBetween(from, to) : HERO.headingDeg;
    },

    destroy() {
      destroyed = true;
      cancel();
      stopOrbit();
      releaseDrive();
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
