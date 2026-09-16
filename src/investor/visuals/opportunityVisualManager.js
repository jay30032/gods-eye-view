import {
  governorRequestRender,
  holdContinuousRender,
  releaseContinuousRender,
} from '../../renderGovernor.js';
import { cameraHeightM, isNearMarket, lodFromHeight } from '../lod.js';
import { createMarkerLayer } from './markers.js';
import { createNearFieldEffects } from './effects/nearFieldEffects.js';
import { createGroundSource } from './ground.js';
import { createGroundPulses } from './effects/groundPulses.js';
import { createReducedMotionPolicy } from './reducedMotionPolicy.js';

const HOLD_ID = 'investor-opportunity';

/**
 * Opportunity Vision.
 *
 * This used to build Cesium *entities* — ground-clamped ellipses sized in
 * metres — and rebuild the whole set on every state change. That is gone. The
 * markers are screen-space primitives in `markers.js`, and this file is the
 * policy layer around them: when they show, when the render governor is held,
 * and how hovers and picks reach the session.
 *
 * The public API is unchanged, so `session.js` did not have to move.
 *
 * There are two layers under here now and the manager owns both. The markers
 * are the **far field** — screen-space sprites that hold their size from orbit
 * down to the street. `effects/` is the **near field**: parcel outlines draped
 * on Google's tiles and columns standing over real footprints, which only exist
 * below 1,500 m and cost nothing above it. Every selection call fans out to
 * both, so a shortlist or a gold pick means the same thing at either altitude.
 */
export function createOpportunityVisualManager({
  viewer,
  Cesium,
  market,
  getProperties,
  enabled: startEnabled = false,
}) {
  const reducedPolicy = createReducedMotionPolicy({ onChange: () => syncHold() });
  let enabled = Boolean(startEnabled);
  let dealStrategy = null;
  let driveMode = false;
  let savedId = null;
  let dealCaption = null;
  let destroyed = false;
  let built = false;

  function reduced() {
    return reducedPolicy.reduced;
  }

  /**
   * The one ground every layer stands on. Sampled from the tiles at each
   * property's anchor, re-sampled once the camera is in the near field, and
   * the layers are re-placed when it moves — see `ground.js` for the bug this
   * closes. The marker and effect collections are excluded from the sample so
   * a sprite standing on the anchor cannot be mistaken for the ground.
   */
  let layer = null;
  let effects = null;
  const ground = createGroundSource({
    Cesium,
    scene: viewer.scene,
    market,
    getProperties,
    getCameraAglM: () => {
      const height = cameraHeightM(viewer);
      return Number.isFinite(height) ? height - (Number(market?.groundElevationM) || 0) : null;
    },
    excluded: () => [...(layer?.collections || []), ...(effects?.collections || [])],
  });
  layer = createMarkerLayer({ viewer, Cesium, ground, getProperties, reduced });
  effects = createNearFieldEffects({ viewer, Cesium, market, ground, getProperties, reduced });
  /**
   * The two draped pulses — the top pick's ring and the scan wave.
   *
   * Ticked off `effects.seconds` rather than a clock of their own, so a flight
   * that freezes the near field freezes these with it. Registered after the
   * effects layer so the value it reads each frame is this frame's, not last
   * frame's.
   */
  const pulses = createGroundPulses({ viewer, Cesium, market, reduced });
  const removePulseTick = viewer.scene.preRender.addEventListener(
    () => pulses.tick(effects.seconds),
  );

  /** In space the markers are meaningless and must not hold the render loop. */
  function isSpace() {
    const lod = lodFromHeight(cameraHeightM(viewer));
    return lod.id === 'globe' || lod.id === 'regional';
  }

  /**
   * Markers pulse every frame, so they need continuous render — but only while
   * they are actually on screen. A parked globe, or a market the camera has
   * left, must not hold 60 fps.
   */
  function needsContinuous() {
    if (destroyed || !enabled || reduced()) return false;
    if (isSpace()) return false;
    return isNearMarket(viewer, market, 220);
  }

  function syncHold() {
    if (needsContinuous()) holdContinuousRender(HOLD_ID);
    else releaseContinuousRender(HOLD_ID);
    governorRequestRender('investor-vision');
  }

  function refresh() {
    if (destroyed) return;
    // Whatever ground can still improve, improves here; whoever stood on the
    // old number moves. The first refresh places everything.
    const moved = ground.refresh();
    if (!built) {
      built = true;
      layer.build();
    } else if (moved.length) {
      layer.build();
      // The near field only builds in the near field, where samples are already
      // fine, so this is a safety net rather than the usual path.
      if (effects.count > 0) effects.rebuild();
    }
    layer.setEnabled(enabled && !isSpace());
    // The effects layer decides for itself whether the camera is low enough;
    // this only says whether Opportunity Vision is on at all.
    effects.setEnabled(enabled && !isSpace());
    syncHold();
  }

  const handler = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas);

  handler.setInputAction((movement) => {
    if (destroyed) return;
    const hovered = viewer.scene.pick(movement.endPosition);
    const id = layer.idFrom(hovered) || effects.idFrom(hovered);
    const canvas = viewer.scene.canvas;
    if (canvas?.style) canvas.style.cursor = id ? 'pointer' : '';
    layer.setHovered(id);
    governorRequestRender('investor-hover');
  }, Cesium.ScreenSpaceEventType.MOUSE_MOVE);

  handler.setInputAction((movement) => {
    if (destroyed) return;
    const picked = viewer.scene.pick(movement.position);
    const id = layer.idFrom(picked) || effects.idFrom(picked);
    if (!id) return;
    viewer.entities._terrasignalLastPick = id;
    globalThis.dispatchEvent(new CustomEvent('terrasignal:pick-property', { detail: { id } }));
  }, Cesium.ScreenSpaceEventType.LEFT_CLICK);

  const removeMove = viewer.camera.changed.addEventListener(() => {
    if (destroyed) return;
    refresh();
  });

  refresh();

  return {
    get enabled() { return enabled; },
    get markerCount() { return layer.count; },
    /** The near-field layer, for the headed probes and the six-house check. */
    get effects() {
      return {
        supported: effects.supported,
        active: effects.active,
        count: effects.count,
        surveyed: effects.surveyedIds,
        approximate: effects.approximateIds,
        parcels: effects.parcelIds,
        parcelSources: effects.parcelSources,
        classification: effects.classificationSupported,
        tinted: effects.tintedIds,
        tintEdges: effects.tintEdgeIds,
        rims: effects.rimIds,
        outlines: effects.outlineIds,
        world: effects.world,
      };
    },
    /** Screen positions of shown markers — used by the headed smoke check. */
    screenPositions() { return layer.screenPositions(); },
    /**
     * Where one house's footprint centroid lands on screen, in pixels — from
     * the ground source, not from the effects layer, so it exists at any
     * altitude and is the anchor the sprite is supposed to stand on. Null for
     * a row with no footprint: there is no centroid to compare against.
     */
    footprintScreenPosition(id) {
      const property = (getProperties() || []).find((row) => row.id === id);
      if (!property || !ground.hasFootprint(property)) return null;
      return ground.screenPositionFor(property);
    },
    /** The shared height source's own account of itself. */
    get ground() { return ground.report; },

    setEnabled(next) {
      enabled = Boolean(next);
      pulses.setEnabled(enabled);
      refresh();
      return enabled;
    },
    toggle() {
      return this.setEnabled(!enabled);
    },
    setDealVision(strategy, analysis = null, { caption = null } = {}) {
      dealStrategy = strategy || null;
      dealCaption = caption || null;
      governorRequestRender('investor-deal-vision');
      return dealStrategy;
    },
    get dealVision() { return { strategy: dealStrategy, caption: dealCaption }; },
    /**
     * @param {string[]|null} ids
     * @param {{lit?:boolean}} [options] `lit: false` leaves every member dim
     *   until `ignite` reaches it — the FIND_MONEY choreography.
     */
    setShortlist(ids, { lit = true } = {}) {
      layer.setShortlist(ids, { lit });
      effects.setShortlist(ids);
      governorRequestRender('investor-shortlist');
      return Array.isArray(ids) ? ids.slice() : [];
    },
    /** Light one match. Returns false for an id with no marker. */
    ignite(id) {
      const lit = layer.ignite(id);
      governorRequestRender('investor-ignite');
      return lit;
    },
    /** Light every match still waiting — a cancelled ignition ends here. */
    igniteAll() {
      layer.igniteAll();
      governorRequestRender('investor-ignite');
    },
    /** The gold beacon climbs from the roof. */
    raiseBeacon(id) {
      const started = layer.raiseBeacon(id);
      governorRequestRender('investor-beacon');
      return started;
    },
    /** The bookmark falls onto the house. */
    dropBookmark(id) {
      const dropped = layer.dropBookmark(id);
      governorRequestRender('investor-bookmark');
      return dropped;
    },
    /** One marker's anchor on screen, in pixels, or null. */
    screenPositionFor(id) { return layer.screenPositionFor(id); },
    /** The house whose card is showing; its label yields to the card. */
    setCardOn(id) { layer.setCardOn(id); governorRequestRender('investor-card'); },
    /** Which world is under the effects: the draped outline exists only in the clear one. */
    setWorld(world) {
      const next = effects.setWorld(world);
      governorRequestRender('investor-world');
      return next;
    },
    setTopPick(id) {
      layer.setTopPick(id);
      effects.setTopPick(id);
      // The ring needs the house, not just its id: it is a disc centred on the
      // property's own coordinate, which by now is its footprint centroid.
      pulses.setTopPick(id ? (getProperties() || []).find((row) => row.id === id) || null : null);
      governorRequestRender('investor-top-pick');
      return id || null;
    },
    setSaved(id) {
      savedId = id || null;
      layer.setSaved(id);
      effects.setSaved(id);
      governorRequestRender('investor-saved');
      return id || null;
    },
    setFocused(id) {
      layer.setFocused(id);
      effects.setFocused(id);
      governorRequestRender('investor-focus');
    },
    /**
     * Freeze the pulse clock while the camera flies. Markers stay *visible* and
     * in place — only the animation stops, because two things moving at once is
     * what read as clunky. An orbit is not a flight and never calls this.
     */
    setFlightActive(active) {
      layer.freeze(Boolean(active));
      effects.freeze(Boolean(active));
      syncHold();
      return Boolean(active);
    },
    /**
     * Fire the scan wave: one draped ring crossing the whole board before the
     * matches light.
     *
     * Given a shortlist it spans those houses; given nothing it spans the whole
     * inventory, which is what "find me money" over a cold board should sweep.
     */
    startScan(points = null) {
      const rows = Array.isArray(points) && points.length ? points : (getProperties() || []);
      pulses.startScan(rows, effects.seconds);
      governorRequestRender('investor-scan');
      return pulses.scanning;
    },
    /** Ids the user has saved — Drive Mode never lets these drop to quiet. */
    get savedIds() { return savedId ? [savedId] : []; },
    /** True while a drive owns the emphasis rules. */
    get driveMode() { return driveMode; },
    /**
     * Enter or leave Drive Mode.
     *
     * Leaving clears the weights as well as the flag: a stale activation map
     * would keep a house suspended after the drive ended, and the house that
     * happened to be behind the camera at the end would simply not be there.
     */
    setDriveMode(next) {
      driveMode = Boolean(next);
      pulses.setRouteVisible(driveMode);
      if (!driveMode) {
        layer.setDriveActivations(null);
        effects.setDriveActivations(null);
      }
      governorRequestRender('investor-drive-mode');
      return driveMode;
    },
    /** Hand the drive's route over to be drawn faintly on the road. */
    setDriveRoute(coordinates) { return pulses.setRoute(coordinates); },
    /** One frame of Drive Mode emphasis. */
    setDriveActivations(map) {
      layer.setDriveActivations(map);
      effects.setDriveActivations(map);
      return map ? map.size : 0;
    },

    /** Ground-pulse state, for the headed probes. */
    get pulses() {
      return {
        supported: pulses.supported,
        ringId: pulses.ringId,
        scanning: pulses.scanning,
        routeShown: pulses.routeShown,
      };
    },
    rebuild() {
      built = false;
      ground.reset();
      effects.rebuild();
      refresh();
    },
    pickPropertyId(picked) { return layer.idFrom(picked) || effects.idFrom(picked); },
    destroy() {
      destroyed = true;
      try { removePulseTick?.(); } catch { /* already gone */ }
      pulses.destroy();
      handler.destroy();
      if (typeof removeMove === 'function') removeMove();
      layer.destroy();
      effects.destroy();
      releaseContinuousRender(HOLD_ID);
      reducedPolicy.destroy();
    },
  };
}
