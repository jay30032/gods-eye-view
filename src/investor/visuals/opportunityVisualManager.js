import {
  governorRequestRender,
  holdContinuousRender,
  releaseContinuousRender,
} from '../../renderGovernor.js';
import { cameraHeightM, isNearMarket, lodFromHeight } from '../lod.js';
import { createMarkerLayer } from './markers.js';
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
    syncHold();
  }

  const handler = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas);

  handler.setInputAction((movement) => {
    if (destroyed) return;
    const id = layer.idFrom(viewer.scene.pick(movement.endPosition));
    const canvas = viewer.scene.canvas;
    if (canvas?.style) canvas.style.cursor = id ? 'pointer' : '';
    layer.setHovered(id);
    governorRequestRender('investor-hover');
  }, Cesium.ScreenSpaceEventType.MOUSE_MOVE);

  handler.setInputAction((movement) => {
    if (destroyed) return;
    const id = layer.idFrom(viewer.scene.pick(movement.position));
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
      governorRequestRender('investor-shortlist');
      return Array.isArray(ids) ? ids.slice() : [];
    },
    setTopPick(id) {
      layer.setTopPick(id);
      governorRequestRender('investor-top-pick');
      return id || null;
    },
    setSaved(id) {
      layer.setSaved(id);
      governorRequestRender('investor-saved');
      return id || null;
    },
    setFocused(id) {
      layer.setFocused(id);
      governorRequestRender('investor-focus');
    },
    /**
     * Freeze the pulse clock while the camera flies. Markers stay *visible* and
     * in place — only the animation stops, because two things moving at once is
     * what read as clunky. An orbit is not a flight and never calls this.
     */
    setFlightActive(active) {
      layer.freeze(Boolean(active));
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
      refresh();
    },
    pickPropertyId(picked) { return layer.idFrom(picked); },
    destroy() {
      destroyed = true;
      handler.destroy();
      if (typeof removeMove === 'function') removeMove();
      layer.destroy();
      releaseContinuousRender(HOLD_ID);
      reducedPolicy.destroy();
    },
  };
}
