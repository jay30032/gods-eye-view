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
 *   3. Calls scene.requestRender() bursts (not a long continuous hold)
 *   4. Asserts ImageryLayer count > 0 after the stack is ready
 *   5. 8s watchdog → #ts-globe-error if imagery never appears
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
export const INVESTOR_BRIEF_HOLD_MS = 2500;
export const INVESTOR_INIT_WATCHDOG_MS = 8000;

const INIT_WATCHDOG_COPY =
  'Earth imagery did not appear within 8 seconds. The HUD should stay usable. '
  + 'Cesium credits can appear without a painted globe.';

export const ESRI_WORLD_IMAGERY_URL =
  'https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer';

const IMAGERY_FAILED_COPY =
  'The WebGL canvas is live, but no imagery layer is covering the globe. '
  + 'Esri World Imagery failed and the OSM fallback did not attach. '
  + 'Cesium credits can appear without a painted Earth.';

const MISSING_CANVAS_COPY =
  'Cesium did not create a usable WebGL canvas. Credits can still appear '
  + 'in the corner. Earth cannot paint until the canvas exists and has a '
  + 'drawing buffer.';

const ZERO_BUFFER_COPY =
  'The Cesium canvas has no drawing buffer (it is missing or 0×0). '
  + 'The black void behind the HUD is not a painted globe.';

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

export function releaseInvestorBootHolds() {
  releaseContinuousRender(INVESTOR_BASEMAP_HOLD);
  releaseContinuousRender(INVESTOR_HUNT_HOLD);
}

/**
 * Wait until Cesium paints one frame, then yield. Used to defer heavy
 * investor session work (opportunity entities, drive) until the globe has
 * had a chance to request imagery without a continuous 60 fps hold.
 */
export function waitForFirstInvestorFrame(viewer, {
  timeoutMs = 2000,
  timers = globalThis,
} = {}) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (reason) => {
      if (done) return;
      done = true;
      resolve(reason);
    };
    requestSceneRender(viewer);
    const scene = viewer?.scene;
    let remove = null;
    try {
      remove = scene?.postRender?.addEventListener?.(() => {
        try { remove?.(); } catch { /* ignore */ }
        finish('post-render');
      });
    } catch {
      remove = null;
    }
    const globe = scene?.globe;
    let removeTiles = null;
    try {
      removeTiles = globe?.tileLoadProgressEvent?.addEventListener?.((queued) => {
        if (queued === 0) return;
        try { removeTiles?.(); } catch { /* ignore */ }
        finish('tile-progress');
      });
    } catch {
      removeTiles = null;
    }
    const raf = timers.requestAnimationFrame || globalThis.requestAnimationFrame;
    if (typeof raf === 'function') {
      raf(() => requestSceneRender(viewer));
    }
    timers.setTimeout?.(() => {
      try { remove?.(); } catch { /* ignore */ }
      try { removeTiles?.(); } catch { /* ignore */ }
      finish('timeout');
    }, timeoutMs);
  });
}

export function scheduleInvestorImageryWatchdog({
  viewer,
  mapStackController,
  documentRef = globalThis.document,
  container = null,
  delayMs = INVESTOR_INIT_WATCHDOG_MS,
  timers = globalThis,
} = {}) {
  const tid = timers.setTimeout?.(() => {
    releaseInvestorBootHolds();
    const inspect = inspectKeylessGlobe(viewer, mapStackController);
    const canvas = findCesiumCanvas(viewer, container, documentRef);
    if (keylessGlobeLooksEmpty(inspect) || !canvas) {
      assertInvestorGlobeReady({
        viewer,
        container,
        mapStackController,
        documentRef,
        message: INIT_WATCHDOG_COPY,
      });
      showBasemapToast('Earth still not visible after 8 seconds.', documentRef);
    } else {
      hideImageryStatus(documentRef);
    }
  }, delayMs);
  return () => timers.clearTimeout?.(tid);
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

export function findCesiumCanvas(viewer, container, documentRef = globalThis.document) {
  const host = resolveCesiumContainer(viewer, container, documentRef);
  const fromHost = host?.querySelector?.('canvas');
  if (fromHost) return fromHost;
  return documentRef?.querySelector?.('#cesiumContainer canvas')
    || viewer?.scene?.canvas
    || viewer?.canvas
    || null;
}

export function withTimeout(promise, ms, label = 'operation', timers = globalThis) {
  const task = Promise.resolve(promise);
  if (!(ms > 0)) return task;
  return new Promise((resolve, reject) => {
    const tid = timers.setTimeout?.(() => {
      reject(new Error(`${label} timed out after ${ms}ms`));
    }, ms);
    task.then(
      (value) => {
        timers.clearTimeout?.(tid);
        resolve(value);
      },
      (error) => {
        timers.clearTimeout?.(tid);
        reject(error);
      },
    );
  });
}

export function assertInvestorGlobeReady({
  viewer,
  container,
  mapStackController,
  documentRef = globalThis.document,
  message = IMAGERY_FAILED_COPY,
} = {}) {
  const inspect = inspectKeylessGlobe(viewer, mapStackController);
  const host = resolveCesiumContainer(viewer, container, documentRef);
  const canvas = findCesiumCanvas(viewer, host, documentRef);
  const canvasLive = cesiumCanvasIsLive(host) || cesiumCanvasIsLive({
    querySelector: () => canvas,
  });
  const empty = keylessGlobeLooksEmpty(inspect);
  if (!canvas) {
    showInvestorGlobeError(MISSING_CANVAS_COPY, documentRef);
    hideImageryStatus(documentRef);
    return {
      ...inspect,
      ok: false,
      empty: true,
      canvasLive: false,
      missingCanvas: true,
      asserted: true,
    };
  }
  if (!canvasLive) {
    showInvestorGlobeError(ZERO_BUFFER_COPY, documentRef);
    hideImageryStatus(documentRef);
    return {
      ...inspect,
      ok: false,
      empty: true,
      canvasLive: false,
      missingCanvas: false,
      asserted: true,
    };
  }
  if (empty) {
    showInvestorGlobeError(message, documentRef);
    showImageryStatus(
      'Earth imagery failed — the black or gray globe is empty, not a market view.',
      documentRef,
    );
    return { ...inspect, ok: false, empty: true, canvasLive, missingCanvas: false, asserted: true };
  }
  hideInvestorGlobeError(documentRef);
  hideImageryStatus(documentRef);
  return { ...inspect, ok: true, empty: false, canvasLive, missingCanvas: false, asserted: true };
}

export async function probeEsriWorldImagery({
  fetchImpl = globalThis.fetch,
  timeoutMs = 3500,
  url = ESRI_WORLD_IMAGERY_URL,
  timers = globalThis,
} = {}) {
  if (typeof fetchImpl !== 'function') {
    return { ok: true, skipped: true, reason: 'no-fetch' };
  }
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  try {
    const response = await withTimeout(
      fetchImpl(`${url}?f=json`, {
        method: 'GET',
        signal: controller?.signal,
      }),
      timeoutMs,
      'Esri probe',
      timers,
    );
    if (!response || response.ok === false) {
      try { controller?.abort?.(); } catch { /* ignore */ }
      return { ok: false, skipped: false, reason: `http-${response?.status || 'error'}` };
    }
    return { ok: true, skipped: false, reason: null };
  } catch (error) {
    try { controller?.abort?.(); } catch { /* ignore */ }
    return { ok: false, skipped: false, reason: error?.name || error?.message || 'fetch-failed' };
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
  holdMs = 0,
  briefHoldMs = 0,
  stackTimeoutMs = 5000,
  phase = 'boot',
} = {}) {
  if (shouldSkipKeylessBasemap({
    tileset,
    googleTileset: googleTileset || mapStackController?.googleTileset,
  })) {
    return { ok: true, skipped: true, empty: false, globeShow: false, imageryLayerCount: 0 };
  }

  if (viewer?.scene?.globe) viewer.scene.globe.show = true;
  try { viewer?.resize?.(); } catch { /* optional */ }
  requestSceneRender(viewer);

  const host = resolveCesiumContainer(viewer, container, documentRef);
  const canvasLiveNow = () => {
    const canvas = findCesiumCanvas(viewer, host, documentRef);
    return cesiumCanvasIsLive(host) || cesiumCanvasIsLive({ querySelector: () => canvas });
  };
  // Never hold the first-hunt modal in continuous mode — that pegs a laptop
  // GPU at 60 fps before imagery paints. A brief basemap hold is optional
  // and always released; first frames use requestRender bursts.
  releaseContinuousRender(INVESTOR_HUNT_HOLD);
  const holdCap = Math.max(0, Number(holdMs) || 0, Number(briefHoldMs) || 0);
  const allowBriefHold = holdCap > 0 && holdCap <= INVESTOR_BRIEF_HOLD_MS && canvasLiveNow();
  if (allowBriefHold) {
    holdContinuousRender(INVESTOR_BASEMAP_HOLD);
    try {
      viewer?.scene?.globe?.tileLoadProgressEvent?.addEventListener?.((queued) => {
        if (queued > 0) releaseContinuousRender(INVESTOR_BASEMAP_HOLD);
      });
    } catch {
      // Globe tile events are optional on stubs.
    }
  } else {
    releaseInvestorBootHolds();
  }

  const message = phase === 'after-market' ? GRAY_VOID_COPY : IMAGERY_FAILED_COPY;
  showImageryStatus('Loading Earth imagery…', documentRef);

  let usedFallback = false;
  let fallbackReason = null;
  let esriAttempted = false;

  const failToOsm = async (reason) => {
    usedFallback = true;
    fallbackReason = reason;
    toastEsriFallback(reason, { documentRef, styleManager });
    try {
      await withTimeout(
        activateStack(mapStackController, 'osm'),
        stackTimeoutMs,
        'OSM map stack',
        timers,
      );
    } catch {
      // Last-ditch: still force the ellipsoid on so a later assert can speak.
    }
    if (viewer?.scene?.globe) viewer.scene.globe.show = true;
    requestSceneRender(viewer);
  };

  const alreadyPainted = !keylessGlobeLooksEmpty(inspectKeylessGlobe(viewer, mapStackController));
  if (alreadyPainted) {
    probe = false;
  }

  if (probe) {
    const probed = await probeEsriWorldImagery({ fetchImpl, timers });
    if (!probed.ok && !probed.skipped) {
      esriAttempted = true;
      await failToOsm('Esri Satellite is unreachable; using OSM');
    }
  }

  if (!usedFallback && !alreadyPainted) {
    esriAttempted = true;
    try {
      const state = await withTimeout(
        activateStack(mapStackController, 'esri-imagery'),
        stackTimeoutMs,
        'Esri map stack',
        timers,
      );
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

  kickRenderBurst(viewer, { times: 8, intervalMs: 180, timers });
  if (allowBriefHold) {
    timers.setTimeout?.(() => releaseInvestorBootHolds(), holdCap);
  } else {
    releaseInvestorBootHolds();
  }

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
