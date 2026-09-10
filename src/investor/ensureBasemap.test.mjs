import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { _resetRenderGovernorForTest } from '../renderGovernor.js';
import {
  assertInvestorGlobeReady,
  countShowingImageryLayers,
  ensureKeylessVisibleBasemap,
  inspectKeylessGlobe,
  keylessGlobeLooksEmpty,
  probeEsriWorldImagery,
  requestSceneRender,
  shouldSkipKeylessBasemap,
} from './ensureBasemap.js';

const here = dirname(fileURLToPath(import.meta.url));

function createMockViewer() {
  const layers = [];
  return {
    imageryLayers: {
      get length() { return layers.length; },
      get(i) { return layers[i]; },
      add(layer) { layers.push(layer); return layer; },
      removeAll() { layers.length = 0; },
    },
    scene: {
      globe: { show: false },
      renders: 0,
      requestRender() { this.renders += 1; },
    },
    container: {
      querySelector() {
        return { width: 1280, height: 720, clientWidth: 1280, clientHeight: 720 };
      },
    },
  };
}

function createMockController(viewer, { esri = 'ok' } = {}) {
  return {
    _imageryLayer: null,
    _lastError: null,
    _activeId: null,
    googleTileset: null,
    getActiveId() { return this._activeId; },
    getState() { return { activeId: this._activeId, lastError: this._lastError }; },
    async setStack(id) {
      viewer.imageryLayers.removeAll();
      this._imageryLayer = null;
      if (id === 'esri-imagery') {
        if (esri === 'throw') throw new Error('Esri fromUrl failed');
        if (esri === 'empty') {
          this._activeId = 'esri-imagery';
          this._lastError = null;
          viewer.scene.globe.show = true;
          return this.getState();
        }
        if (esri === 'construct-fallback') {
          const layer = { show: true, imageryProvider: {} };
          viewer.imageryLayers.add(layer);
          this._imageryLayer = layer;
          this._activeId = 'osm';
          this._lastError = 'Esri Satellite is unavailable; using OSM';
          viewer.scene.globe.show = true;
          return this.getState();
        }
      }
      const layer = { show: true, imageryProvider: {} };
      viewer.imageryLayers.add(layer);
      this._imageryLayer = layer;
      this._activeId = id;
      this._lastError = null;
      viewer.scene.globe.show = true;
      return this.getState();
    },
  };
}

function createDocument() {
  const nodes = new Map();
  const documentRef = {
    body: { appendChild(el) { nodes.set(el.id, el); } },
    getElementById(id) { return nodes.get(id) || null; },
    createElement() {
      return {
        id: '',
        hidden: false,
        textContent: '',
        innerHTML: '',
        setAttribute() {},
      };
    },
  };
  return documentRef;
}

function createTimers() {
  const pending = new Map();
  let next = 0;
  return {
    setTimeout(fn) {
      const id = ++next;
      pending.set(id, fn);
      return id;
    },
    clearTimeout(id) { pending.delete(id); },
    flush() {
      const run = [...pending.values()];
      pending.clear();
      for (const fn of run) fn();
    },
  };
}

test('keyless inspect treats a hidden globe or zero layers as empty', () => {
  const viewer = createMockViewer();
  const inspect = inspectKeylessGlobe(viewer, { getActiveId: () => null, getState: () => ({}) });
  assert.equal(inspect.globeShow, false);
  assert.equal(inspect.imageryLayerCount, 0);
  assert.equal(keylessGlobeLooksEmpty(inspect), true);
  assert.equal(countShowingImageryLayers(viewer), 0);
});

test('an already-attached imagery layer skips a second Esri setStack', async () => {
  _resetRenderGovernorForTest();
  const viewer = createMockViewer();
  let switches = 0;
  const mapStackController = createMockController(viewer, { esri: 'ok' });
  const original = mapStackController.setStack.bind(mapStackController);
  mapStackController.setStack = async (id) => {
    switches += 1;
    return original(id);
  };
  await original('esri-imagery');
  const result = await ensureKeylessVisibleBasemap({
    viewer,
    mapStackController,
    documentRef: createDocument(),
    fetchImpl: async () => ({ ok: true }),
    timers: createTimers(),
    holdMs: 0,
  });
  assert.equal(result.ok, true);
  assert.equal(result.imageryLayerCount > 0, true);
  assert.equal(switches, 0);
});

test('keyless investor init attaches a visible imagery layer and shows the globe', async () => {
  _resetRenderGovernorForTest();
  const viewer = createMockViewer();
  const mapStackController = createMockController(viewer, { esri: 'ok' });
  const documentRef = createDocument();
  const result = await ensureKeylessVisibleBasemap({
    viewer,
    mapStackController,
    documentRef,
    fetchImpl: async () => ({ ok: true }),
    timers: createTimers(),
    holdMs: 0,
  });
  assert.equal(result.skipped, false);
  assert.equal(result.globeShow, true);
  assert.equal(result.imageryLayerCount > 0, true);
  assert.equal(result.activeId, 'esri-imagery');
  assert.equal(result.ok, true);
  assert.equal(viewer.scene.globe.show, true);
  assert.equal(viewer.scene.renders > 0, true);
});

test('Esri construction or probe failure immediately uses OSM and toasts', async () => {
  _resetRenderGovernorForTest();
  const viewer = createMockViewer();
  const mapStackController = createMockController(viewer, { esri: 'throw' });
  const documentRef = createDocument();
  const result = await ensureKeylessVisibleBasemap({
    viewer,
    mapStackController,
    documentRef,
    fetchImpl: async () => ({ ok: false, status: 503 }),
    timers: createTimers(),
    holdMs: 0,
  });
  assert.equal(result.usedFallback, true);
  assert.equal(result.activeId, 'osm');
  assert.equal(result.globeShow, true);
  assert.equal(result.imageryLayerCount > 0, true);
  const toast = documentRef.getElementById('ts-basemap-toast');
  assert.equal(toast.hidden, false);
  assert.match(toast.textContent, /OSM/);
});

test('Esri layer that never attaches falls back to OSM', async () => {
  _resetRenderGovernorForTest();
  const viewer = createMockViewer();
  const mapStackController = createMockController(viewer, { esri: 'empty' });
  const result = await ensureKeylessVisibleBasemap({
    viewer,
    mapStackController,
    documentRef: createDocument(),
    fetchImpl: async () => ({ ok: true }),
    timers: createTimers(),
    holdMs: 0,
    probe: false,
  });
  assert.equal(result.usedFallback, true);
  assert.equal(result.activeId, 'osm');
  assert.equal(result.imageryLayerCount > 0, true);
  assert.equal(result.globeShow, true);
});

test('runtime assert fires when the canvas is live but the globe is empty', () => {
  const viewer = createMockViewer();
  const documentRef = createDocument();
  const result = assertInvestorGlobeReady({
    viewer,
    mapStackController: createMockController(viewer),
    documentRef,
  });
  assert.equal(result.ok, false);
  assert.equal(result.empty, true);
  const banner = documentRef.getElementById('ts-globe-error');
  assert.equal(banner.hidden, false);
  assert.match(banner.innerHTML, /imagery layer/i);
});

test('runtime assert fires when Cesium never created a canvas', () => {
  const viewer = createMockViewer();
  viewer.container = { querySelector: () => null };
  const documentRef = createDocument();
  const result = assertInvestorGlobeReady({
    viewer,
    mapStackController: createMockController(viewer),
    documentRef,
  });
  assert.equal(result.ok, false);
  assert.equal(result.missingCanvas, true);
  const banner = documentRef.getElementById('ts-globe-error');
  assert.equal(banner.hidden, false);
  assert.match(banner.innerHTML, /canvas/i);
});

test('photoreal tileset skips the keyless ellipsoid force', async () => {
  assert.equal(shouldSkipKeylessBasemap({ tileset: { show: true } }), true);
  const result = await ensureKeylessVisibleBasemap({
    viewer: createMockViewer(),
    mapStackController: { googleTileset: { show: true } },
    tileset: { show: true },
  });
  assert.equal(result.skipped, true);
});

test('Esri probe reports HTTP and network failure', async () => {
  const down = await probeEsriWorldImagery({
    fetchImpl: async () => ({ ok: false, status: 502 }),
  });
  assert.equal(down.ok, false);
  const boom = await probeEsriWorldImagery({
    fetchImpl: async () => { throw new Error('blocked'); },
  });
  assert.equal(boom.ok, false);
  const skip = await probeEsriWorldImagery({ fetchImpl: null });
  assert.equal(skip.skipped, true);
});

test('requestSceneRender is safe on a stub viewer', () => {
  const viewer = createMockViewer();
  requestSceneRender(viewer);
  requestSceneRender(null);
  assert.equal(viewer.scene.renders, 1);
});

test('main.js holds investor render and re-asserts a keyless basemap after restore', () => {
  const main = readFileSync(join(here, '../main.js'), 'utf8');
  assert.match(main, /ensureKeylessVisibleBasemap/);
  assert.match(main, /holdContinuousRender\(INVESTOR_BASEMAP_HOLD\)/);
  assert.match(main, /holdContinuousRender\(INVESTOR_HUNT_HOLD\)/);
  const governorAt = main.indexOf('installRenderGovernor(viewer)');
  const holdAt = main.indexOf('holdContinuousRender(INVESTOR_BASEMAP_HOLD)');
  assert.equal(holdAt > 0 && holdAt < governorAt, true, 'basemap hold must register before the governor installs');
});

test('MapStackController requests a scene frame even before the governor is installed', () => {
  const src = readFileSync(join(here, '../mapStackController.js'), 'utf8');
  assert.match(
    src,
    /baseLayer: false/,
    'the controller must document that Viewer starts with zero imagery',
  );
  assert.match(src, /this\.viewer\?\.scene\?\.requestRender\?\.\(\)/);
  assert.match(
    src,
    /this\.viewer\.imageryLayers\.add\(this\._imageryLayer/,
    'esri/osm path must add an ImageryLayer that covers the globe',
  );
  assert.match(
    src,
    /void this\._setWorldTerrainEnabled/,
    'Re:Earth terrain must not block the first imagery frame',
  );
});

test('investor session re-asserts imagery after Atlanta/Decatur descent', () => {
  const session = readFileSync(join(here, 'session.js'), 'utf8');
  assert.match(session, /ensureKeylessVisibleBasemap/);
  assert.match(session, /after-market/);
  assert.match(session, /INVESTOR_HUNT_HOLD/);
});

test('StyleManager refuses a keyless photoreal restore that would hide the globe', () => {
  const ui = readFileSync(join(here, '../ui.js'), 'utf8');
  assert.match(ui, /stackId === 'photoreal'/);
  assert.match(ui, /!this\.mapStackController\.googleTileset/);
  assert.match(ui, /terrasignal-investor/);
});
