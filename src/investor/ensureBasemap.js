/**
 * Keyless investor basemap — force a painted Earth, not credits-only black/gray.
 *
 * Viewer is constructed with `baseLayer: false`, so the ellipsoid starts with
 * ZERO ImageryLayers. MapStackController can add Esri World Imagery and stamp
 * the required “Powered by Esri” credit on provider *construction*. That credit
 * is not proof tiles attached or painted. Combined with requestRenderMode
 * (governorRequestRender is a no-op until install), the first frames stay a
 * black void; a later camera move can reveal a gray ellipsoid with no imagery.
 *
 * This module:
 *   1. Forces globe.show when there is no photoreal tileset
 *   2. Tries Esri, then immediately falls back to OSM on any failure
 *   3. Calls scene.requestRender() directly (not only the governor)
 *   4. Holds continuous render through first-hunt / first tiles
 *   5. Asserts ImageryLayer count > 0 after the stack is ready
 *
 * No Cesium import — safe for Node smoke tests with a mocked viewer.
 */

import {
  holdContinuousRender,
  releaseContinuousRender,
} from '../renderGovernor.js';
import {
  cesiumCanvasIsLive,
  hideInvestorGlobeError,
  showInvestorGlobeError,
} from './globeReveal.js';

export const INVESTOR_BASEMAP_HOLD = 'investor-basemap';
export const INVESTOR_HUNT_HOLD = 'investor-first-hunt';

export const ESRI_WORLD_IMAGERY_URL =
  'https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer';

const IMAGERY_FAILED_COPY =
  'The WebGL canvas is live, but no imagery layer is covering the globe. '
  + 'Esri World Imagery failed and the OSM fallback did not attach. '
  + 'Cesium credits can appear without a painted Earth.';

const GRAY_VOID_COPY =
  'Earth imagery failed after the Atlanta / Decatur descent. '
  + 'The gray globe is an empty ellipsoid — not a loading market. '
  + 'Esri tiles did not paint; OSM fallback is missing.';

export function shouldSkipKeylessBasemap({ tileset, googleTileset } = {}) {
  return Boolean(tileset || googleTileset);
}

export function countShowingImageryLayers(viewer) {
  const layers = viewer?.imageryLayers;
  if (!layers) return 0;
  const len = Number(layers.length || 0);
  let showing = 0;
  for (let i = 0; i < len; i += 1) {
    const layer = typeof layers.get === 'function' ? layers.get(i) : layers[i];
    if (layer && layer.show !== false) showing += 1;
  }
  return showing;
}

export function inspectKeylessGlobe(viewer, mapStackController) {
  const state = typeof mapStackController?.getState === 'function'
    ? mapStackController.getState()
    : null;
  const controllerHasLayer = Boolean(
    mapStackController?._imageryLayer
    && mapStackController._imageryLayer.show !== false,
  );
  return {
    globeShow: viewer?.scene?.globe?.show === true,
    imageryLayerCount: countShowingImageryLayers(viewer),
    controllerHasLayer,
    activeId: mapStackController?.getActiveId?.() || state?.activeId || null,
    lastError: state?.lastError || mapStackController?._lastError || null,
  };
}

export function keylessGlobeLooksEmpty(inspect) {
  if (!inspect) return true;
  return inspect.globeShow !== true || Number(inspect.imageryLayerCount || 0) < 1;
}

export function requestSceneRender(viewer) {
  try {
    viewer?.scene?.requestRender?.();
  } catch {
    // Viewer teardown or a stub without a scene must not throw.
  }
}

export function kickRenderBurst(viewer, {
  times = 10,
  intervalMs = 200,
  timers = globalThis,
} = {}) {
  requestSceneRender(viewer);
  const ids = [];
  const schedule = timers?.setTimeout?.bind(timers);
  if (typeof schedule !== 'function') return () => {};
  for (let i = 1; i < times; i += 1) {
    ids.push(schedule(() => requestSceneRender(viewer), intervalMs * i));
  }
  return () => {
    const clear = timers?.clearTimeout?.bind(timers);
    if (typeof clear !== 'function') return;
    for (const id of ids) clear(id);
  };
}

function ensureAside(id, documentRef) {
  if (!documentRef?.body) return null;
  let el = documentRef.getElementById?.(id);
  if (!el && documentRef.createElement) {
    el = documentRef.createElement('aside');
    el.id = id;
    el.setAttribute?.('role', 'status');
    documentRef.body.appendChild(el);
  }
  return el || null;
}

export function showBasemapToast(message, documentRef = globalThis.document) {
  const el = ensureAside('ts-basemap-toast', documentRef);
  if (!el) return null;
  el.hidden = false;
  el.textContent = String(message || '');
  return el;
}

export function hideBasemapToast(documentRef = globalThis.document) {
  const el = documentRef?.getElementById?.('ts-basemap-toast');
  if (el) el.hidden = true;
}

export function showImageryStatus(message, documentRef = globalThis.document) {
  const el = ensureAside('ts-imagery-status', documentRef);
  if (!el) return null;
  el.hidden = false;
  el.textContent = String(message || 'Loading Earth imagery…');
  return el;
}

export function hideImageryStatus(documentRef = globalThis.document) {
  const el = documentRef?.getElementById?.('ts-imagery-status');
  if (el) el.hidden = true;
}

export function resolveCesiumContainer(viewer, container, documentRef = globalThis.document) {
  return container
    || viewer?.container
    || viewer?.cesiumWidget?.container
    || documentRef?.getElementById?.('cesiumContainer')
    || null;
}

export function assertInvestorGlobeReady({
  viewer,
  container,
  mapStackController,
  documentRef = globalThis.document,
  message = IMAGERY_FAILED_COPY,
} = {}) {
  const inspect = inspectKeylessGlobe(viewer, mapStackController);
  const canvasLive = cesiumCanvasIsLive(resolveCesiumContainer(viewer, container, documentRef));
  const empty = keylessGlobeLooksEmpty(inspect);
  if (canvasLive && empty) {
    showInvestorGlobeError(message, documentRef);
    showImageryStatus(
      'Earth imagery failed — the black or gray globe is empty, not a market view.',
      documentRef,
    );
    return { ...inspect, ok: false, empty: true, canvasLive, asserted: true };
  }
  if (!empty) {
    hideInvestorGlobeError(documentRef);
    hideImageryStatus(documentRef);
  }
  return { ...inspect, ok: !empty, empty, canvasLive, asserted: true };
}

export async function probeEsriWorldImagery({
  fetchImpl = globalThis.fetch,
  timeoutMs = 3500,
  url = ESRI_WORLD_IMAGERY_URL,
} = {}) {
  if (typeof fetchImpl !== 'function') {
    return { ok: true, skipped: true, reason: 'no-fetch' };
  }
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  let timer = null;
  try {
    if (controller && timeoutMs > 0) {
      timer = globalThis.setTimeout?.(() => controller.abort(), timeoutMs);
    }
    const response = await fetchImpl(`${url}?f=json`, {
      method: 'GET',
      signal: controller?.signal,
    });
    if (!response || response.ok === false) {
      return { ok: false, skipped: false, reason: `http-${response?.status || 'error'}` };
    }
    return { ok: true, skipped: false, reason: null };
  } catch (error) {
    return { ok: false, skipped: false, reason: error?.name || error?.message || 'fetch-failed' };
  } finally {
    if (timer) globalThis.clearTimeout?.(timer);
  }
}

function toastEsriFallback(reason, { documentRef, styleManager } = {}) {
  const text = reason || 'Esri Satellite is unavailable; using OSM';
  try { styleManager?._showToast?.(text); } catch { /* optional */ }
  showBasemapToast(text, documentRef);
}

function attachFirstEsriErrorFallback(mapStackController, onFail) {
  const provider = mapStackController?._activeImageryProvider
    || mapStackController?._imageryLayer?.imageryProvider;
  const errorEvent = provider?.errorEvent;
  if (!errorEvent?.addEventListener) return () => {};
  let fired = false;
  const remove = errorEvent.addEventListener(() => {
    if (fired) return;
    fired = true;
    onFail();
  });
  return typeof remove === 'function' ? remove : () => {};
}

async function activateStack(mapStackController, id) {
  if (!mapStackController?.setStack) return null;
  return mapStackController.setStack(id, { silent: true });
}

/**
 * Force a visible keyless raster on the ellipsoid.
 * @returns {Promise<object>} inspect + fallback metadata
 */
export async function ensureKeylessVisibleBasemap({
  viewer,
  mapStackController,
  styleManager = null,
  tileset = null,
  googleTileset = null,
  documentRef = globalThis.document,
  container = null,
  fetchImpl = globalThis.fetch,
  timers = globalThis,
  probe = true,
  holdMs = 8000,
  phase = 'boot',
} = {}) {
  if (shouldSkipKeylessBasemap({
    tileset,
    googleTileset: googleTileset || mapStackController?.googleTileset,
  })) {
    return { ok: true, skipped: true, empty: false, globeShow: false, imageryLayerCount: 0 };
  }

  holdContinuousRender(INVESTOR_BASEMAP_HOLD);
  if (viewer?.scene?.globe) viewer.scene.globe.show = true;
  requestSceneRender(viewer);
  showImageryStatus('Loading Earth imagery…', documentRef);

  let usedFallback = false;
  let fallbackReason = null;
  let esriAttempted = false;

  const failToOsm = async (reason) => {
    usedFallback = true;
    fallbackReason = reason;
    toastEsriFallback(reason, { documentRef, styleManager });
    await activateStack(mapStackController, 'osm');
    if (viewer?.scene?.globe) viewer.scene.globe.show = true;
    requestSceneRender(viewer);
  };

  if (probe) {
    const probed = await probeEsriWorldImagery({ fetchImpl });
    if (!probed.ok && !probed.skipped) {
      esriAttempted = true;
      await failToOsm('Esri Satellite is unreachable; using OSM');
    }
  }

  if (!usedFallback) {
    esriAttempted = true;
    try {
      const state = await activateStack(mapStackController, 'esri-imagery');
      if (viewer?.scene?.globe) viewer.scene.globe.show = true;
      requestSceneRender(viewer);
      const afterEsri = inspectKeylessGlobe(viewer, mapStackController);
      const landedOsm = afterEsri.activeId === 'osm';
      const esriEmpty = keylessGlobeLooksEmpty(afterEsri);
      const esriErrored = Boolean(afterEsri.lastError || state?.lastError);
      if (landedOsm || esriEmpty || esriErrored) {
        const reason = afterEsri.lastError
          || state?.lastError
          || (esriEmpty
            ? 'Esri Satellite did not attach an imagery layer; using OSM'
            : 'Esri Satellite is unavailable; using OSM');
        if (landedOsm && !esriEmpty) {
          usedFallback = true;
          fallbackReason = reason;
          toastEsriFallback(reason, { documentRef, styleManager });
        } else {
          await failToOsm(reason);
        }
      }
    } catch (error) {
      await failToOsm(error?.message || 'Esri Satellite failed; using OSM');
    }
  }

  let inspect = inspectKeylessGlobe(viewer, mapStackController);
  if (keylessGlobeLooksEmpty(inspect)) {
    await failToOsm(fallbackReason || 'No imagery layer on the globe; using OSM');
    inspect = inspectKeylessGlobe(viewer, mapStackController);
  }

  if (!usedFallback && inspect.activeId === 'esri-imagery') {
    attachFirstEsriErrorFallback(mapStackController, () => {
      void failToOsm('Esri Satellite tile requests failed; using OSM');
    });
  }

  kickRenderBurst(viewer, { timers });
  const release = timers?.setTimeout?.bind(timers);
  if (typeof release === 'function' && holdMs > 0) {
    release(() => releaseContinuousRender(INVESTOR_BASEMAP_HOLD), holdMs);
  }

  const message = phase === 'after-market' ? GRAY_VOID_COPY : IMAGERY_FAILED_COPY;
  const asserted = assertInvestorGlobeReady({
    viewer,
    container,
    mapStackController,
    documentRef,
    message,
  });

  return {
    ...asserted,
    usedFallback,
    fallbackReason,
    esriAttempted,
    skipped: false,
    phase,
  };
}
