import {
  governorRequestRender,
  holdContinuousRender,
  releaseContinuousRender,
} from '../../renderGovernor.js';
import { cameraHeightM, isNearMarket, lodFromHeight } from '../lod.js';
import { createMarkerLayer } from './markers.js';
import { createNearFieldEffects } from './effects/nearFieldEffects.js';
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
  let dealCaption = null;
  let destroyed = false;
  let built = false;

  function reduced() {
    return reducedPolicy.reduced;
  }

  const layer = createMarkerLayer({ viewer, Cesium, market, getProperties, reduced });
  const effects = createNearFieldEffects({ viewer, Cesium, market, getProperties, reduced });

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
    if (!built) {
      built = true;
      layer.build();
    } else if (!isSpace() && layer.groundIsEstimated) {
      // The first build ran before tiles streamed in, so ground heights were
      // guessed. Now that there is geometry underneath, place them properly —
      // markers and camera must agree on where the ground is.
      layer.refreshGround();
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
      };
    },
    /** Screen positions of shown markers — used by the headed smoke check. */
    screenPositions() { return layer.screenPositions(); },

    setEnabled(next) {
      enabled = Boolean(next);
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
    setShortlist(ids) {
      layer.setShortlist(ids);
      effects.setShortlist(ids);
      governorRequestRender('investor-shortlist');
      return Array.isArray(ids) ? ids.slice() : [];
    },
    setTopPick(id) {
      layer.setTopPick(id);
      effects.setTopPick(id);
      governorRequestRender('investor-top-pick');
      return id || null;
    },
    setSaved(id) {
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
     * The scan sweep was a ground-clamped ellipse and went with the rest of
     * them. The shortlist resolving on screen is the reveal now.
     */
    startScan() {
      governorRequestRender('investor-scan');
    },
    rebuild() {
      built = false;
      effects.rebuild();
      refresh();
    },
    pickPropertyId(picked) { return layer.idFrom(picked) || effects.idFrom(picked); },
    destroy() {
      destroyed = true;
      handler.destroy();
      if (typeof removeMove === 'function') removeMove();
      layer.destroy();
      effects.destroy();
      releaseContinuousRender(HOLD_ID);
      reducedPolicy.destroy();
    },
  };
}
