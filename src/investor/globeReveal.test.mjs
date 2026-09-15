import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  cesiumCanvasIsLive,
  investorGlobeCssContract,
  showInvestorGlobeError,
} from './globeReveal.js';

const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../../style.css'), 'utf8');

test('investor chrome does not paint an opaque plate over the Cesium globe', () => {
  const contract = investorGlobeCssContract(css);
  assert.equal(contract.shellHasNoOpaqueFill, true);
  assert.equal(contract.vignetteIsInsetShadowNotFill, true);
  assert.equal(contract.loadingScreenTransparent, true);
  assert.equal(contract.hidesScopeMask, true);
  assert.equal(contract.hidesWorldOverlay, true);
});

test('a live Cesium canvas must have a real drawing buffer', () => {
  assert.equal(cesiumCanvasIsLive({ querySelector: () => null }), false);
  assert.equal(cesiumCanvasIsLive({ querySelector: () => ({ width: 0, height: 0, clientWidth: 0, clientHeight: 0 }) }), false);
  assert.equal(cesiumCanvasIsLive({ querySelector: () => ({ width: 1280, height: 720, clientWidth: 1280, clientHeight: 720 }) }), true);
});

test('WebGL failure shows a dedicated globe error, not a silent void', () => {
  const nodes = new Map();
  const documentRef = {
    body: { appendChild(el) { nodes.set(el.id, el); } },
    getElementById(id) { return nodes.get(id) || null; },
    createElement() {
      return { id: '', hidden: false, setAttribute() {}, innerHTML: '' };
    },
  };
  const el = showInvestorGlobeError('The browser supports WebGL, but initialization failed.', documentRef);
  assert.match(el.innerHTML, /The globe could not start/);
  assert.match(el.innerHTML, /initialization failed/);
  assert.equal(el.hidden, false);
});
