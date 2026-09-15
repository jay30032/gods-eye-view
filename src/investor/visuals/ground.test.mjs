/**
 * The one ground under every property.
 *
 * The rules that decide *when* a height is sampled again are what failed
 * silently before: a coarse sample taken from space was kept for the whole
 * session because only the market fallback was ever retried. These pin the
 * rules, and the controller test pins that a coarse entry is re-sampled once
 * the camera comes down and that the change is reported to the layers.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  GROUND_CHANGE_M,
  GROUND_FINE_AGL_M,
  GROUND_MARKET_ATTEMPTS,
  GROUND_QUALITY,
  GROUND_SAMPLE_INTERVAL_MS,
  anchorFor,
  createGroundSource,
  needsSample,
  qualityForAgl,
} from './ground.js';
import { NEAR_FIELD_MAX_HEIGHT_M } from './effects/signalMotion.js';

test('the fine band is the near-field ceiling, so a height is sampled where the outlines are drawn', () => {
  assert.equal(GROUND_FINE_AGL_M, NEAR_FIELD_MAX_HEIGHT_M);
  assert.equal(GROUND_FINE_AGL_M, 1500);
});

test('quality from altitude, and an unknown altitude is never fine', () => {
  assert.equal(qualityForAgl(0), GROUND_QUALITY.FINE);
  assert.equal(qualityForAgl(867), GROUND_QUALITY.FINE);
  assert.equal(qualityForAgl(1500), GROUND_QUALITY.FINE);
  assert.equal(qualityForAgl(1501), GROUND_QUALITY.COARSE);
  assert.equal(qualityForAgl(12_000), GROUND_QUALITY.COARSE);
  // Number(null) is 0, and 0 m AGL would be "fine". Absence must not promote.
  for (const value of [null, undefined, NaN, Infinity, '', 'high']) {
    assert.equal(qualityForAgl(value), GROUND_QUALITY.COARSE, String(value));
  }
});

test('a fine sample is final; a coarse one waits for a fine camera; market retries are bounded', () => {
  const fine = { quality: 'fine', attempts: 1 };
  const coarse = { quality: 'coarse', attempts: 1 };
  const market = { quality: 'market', attempts: 0 };
  assert.equal(needsSample(null, 'coarse'), true, 'no entry: sample');
  assert.equal(needsSample(fine, 'fine'), false);
  assert.equal(needsSample(fine, 'coarse'), false);
  assert.equal(needsSample(coarse, 'coarse'), false, 'coarse again is no better');
  assert.equal(needsSample(coarse, 'fine'), true, 'the one retry that matters');
  assert.equal(needsSample(market, 'coarse'), true);
  assert.equal(needsSample({ quality: 'market', attempts: GROUND_MARKET_ATTEMPTS }, 'coarse'), false);
  // Out of attempts, but the camera has just come into the near field: once more.
  assert.equal(needsSample({ quality: 'market', attempts: GROUND_MARKET_ATTEMPTS }, 'fine'), true);
  assert.equal(needsSample({ quality: 'market', attempts: GROUND_MARKET_ATTEMPTS, fineAttempted: true }, 'fine'), false);
});

test('the anchor is the footprint centroid when there is one, the coordinate when not', () => {
  const property = { id: 'p', lat: 33.7, lng: -84.3 };
  const square = [[-84.301, 33.701], [-84.300, 33.701], [-84.300, 33.702], [-84.301, 33.702]];
  const a = anchorFor(property, square);
  assert.equal(a.fromFootprint, true);
  assert.ok(Math.abs(a.lng - -84.3005) < 1e-6 && Math.abs(a.lat - 33.7015) < 1e-6);
  const b = anchorFor(property, null);
  assert.deepEqual(b, { lat: 33.7, lng: -84.3, fromFootprint: false });
  assert.equal(anchorFor(property, [[0, 0]]).fromFootprint, false, 'two points are not a ring');
});

// ---------------------------------------------------------------------------
// The controller
// ---------------------------------------------------------------------------

function fakeCesium() {
  return {
    Cartographic: { fromDegrees: (lng, lat) => ({ lng, lat }) },
    Cartesian3: { fromDegrees: (lng, lat, h) => ({ lng, lat, h }) },
    SceneTransforms: { worldToWindowCoordinates: (_scene, world) => ({ x: world.lng, y: world.h }) },
  };
}

function harness({ heights, agl = 12_000, supported = true } = {}) {
  // `heights(lat, lng)` returns the tile height the scene would sample now.
  let clock = 1000;
  let cameraAgl = agl;
  let sampler = heights;
  const excludedSeen = [];
  const scene = {
    get sampleHeightSupported() { return supported; },
    sampleHeight(carto, excluded) { excludedSeen.push(excluded); return sampler(carto.lat, carto.lng); },
  };
  const properties = [
    { id: 'A', lat: 33.7584, lng: -84.3074 },
    { id: 'B', lat: 33.7590, lng: -84.3080 },
  ];
  const ring = [[-84.3075, 33.7583], [-84.3073, 33.7583], [-84.3073, 33.7585], [-84.3075, 33.7585]];
  const ground = createGroundSource({
    Cesium: fakeCesium(),
    scene,
    market: { groundElevationM: 310 },
    getProperties: () => properties,
    getGeometry: (id) => (id === 'A' ? { building: { footprint: [ring] } } : null),
    getCameraAglM: () => cameraAgl,
    excluded: () => ['sprites'],
    now: () => clock,
  });
  return {
    ground, properties, scene, excludedSeen,
    set agl(v) { cameraAgl = v; },
    set sampler(fn) { sampler = fn; },
    advance(ms) { clock += ms; },
  };
}

test('one number per property, read by everyone: height, anchor, position and screen agree', () => {
  const h = harness({ heights: () => 291.3, agl: 12_000 });
  const [a] = h.properties;
  assert.equal(h.ground.heightFor(a), 291.3);
  const anchor = h.ground.anchorFor(a);
  assert.equal(anchor.fromFootprint, true, 'A is anchored on its footprint');
  assert.equal(anchor.quality, GROUND_QUALITY.COARSE, 'sampled from space: coarse');
  assert.equal(h.ground.positionFor(a).h, 291.3);
  assert.equal(h.ground.positionFor(a, 120).h, 411.3);
  assert.equal(h.ground.screenPositionFor(a).y, 291.3);
  assert.equal(h.ground.samples, 1, 'reading it four ways sampled once');
  assert.deepEqual(h.excludedSeen, [['sprites']], 'our own primitives are excluded from the sample');
});

test('the bug: a coarse sample from space is re-taken once the camera is in the near field', () => {
  const h = harness({ heights: () => 291.3, agl: 12_000 });
  const [a, b] = h.properties;
  let changed = h.ground.refresh();
  assert.deepEqual(changed.sort(), ['A', 'B'], 'first refresh places everything');
  assert.equal(h.ground.heightFor(a), 291.3);

  // Descending, still coarse: nothing is re-sampled however often the camera moves.
  h.sampler = () => 289.0;
  h.agl = 5_000;
  h.advance(GROUND_SAMPLE_INTERVAL_MS + 1);
  assert.deepEqual(h.ground.refresh(), []);
  assert.equal(h.ground.heightFor(a), 291.3, 'a coarse sample is not replaced by another coarse one');

  // Into the near field: one more sample, the real one, and the change is reported.
  h.sampler = () => 282.7;
  h.agl = 867;
  h.advance(GROUND_SAMPLE_INTERVAL_MS + 1);
  changed = h.ground.refresh();
  assert.deepEqual(changed.sort(), ['A', 'B']);
  assert.equal(h.ground.heightFor(a), 282.7);
  assert.equal(h.ground.anchorFor(a).quality, GROUND_QUALITY.FINE);

  // Fine is final: a later, different reading does not move the ground again.
  h.sampler = () => 250;
  h.advance(GROUND_SAMPLE_INTERVAL_MS + 1);
  assert.deepEqual(h.ground.refresh(), []);
  assert.equal(h.ground.heightFor(b), 282.7);
  assert.equal(h.ground.report.fine, 2);
});

test('no geometry yet is the market constant, retried a bounded number of times, then once more when fine', () => {
  const h = harness({ heights: () => undefined, agl: 12_000 });
  const [a] = h.properties;
  assert.equal(h.ground.heightFor(a), 310);
  assert.equal(h.ground.anchorFor(a).quality, GROUND_QUALITY.MARKET);
  for (let i = 0; i < 20; i += 1) {
    h.advance(GROUND_SAMPLE_INTERVAL_MS + 1);
    h.ground.refresh();
  }
  const attempts = h.ground.report.entries.find((r) => r.id === 'A').attempts;
  assert.equal(attempts, GROUND_MARKET_ATTEMPTS, 'stops retrying');
  // Tiles arrive as the camera drops: the one extra fine attempt finds them.
  h.sampler = () => 282.7;
  h.agl = 900;
  h.advance(GROUND_SAMPLE_INTERVAL_MS + 1);
  assert.deepEqual(h.ground.refresh().sort(), ['A', 'B']);
  assert.equal(h.ground.heightFor(a), 282.7);
  assert.equal(h.ground.anchorFor(a).quality, GROUND_QUALITY.FINE);
});

test('a sample that does not move the ground is not a change', () => {
  const h = harness({ heights: () => 291.3, agl: 12_000 });
  h.ground.refresh();
  h.sampler = () => 291.3 + GROUND_CHANGE_M / 2;
  h.agl = 800;
  h.advance(GROUND_SAMPLE_INTERVAL_MS + 1);
  const changed = h.ground.refresh();
  // Quality changed (coarse → fine) so it IS reported, once…
  assert.deepEqual(changed.sort(), ['A', 'B']);
  // …but the height itself is the same to within the tolerance.
  assert.ok(Math.abs(h.ground.heightFor(h.properties[0]) - 291.3) <= GROUND_CHANGE_M);
});

test('refresh is throttled, and a forced refresh is not', () => {
  const h = harness({ heights: () => undefined, agl: 12_000 });
  h.ground.refresh();
  const before = h.ground.samples;
  h.ground.refresh();
  h.ground.refresh();
  assert.equal(h.ground.samples, before, 'camera.changed every frame does not sample every frame');
  h.ground.refresh({ force: true });
  assert.equal(h.ground.samples, before + 2);
});

test('sampleHeight unsupported, or throwing, is the market constant and not a crash', () => {
  const unsupported = harness({ heights: () => 5, supported: false });
  assert.equal(unsupported.ground.heightFor(unsupported.properties[0]), 310);
  const throwing = harness({ heights: () => { throw new Error('no context'); } });
  assert.equal(throwing.ground.heightFor(throwing.properties[0]), 310);
  assert.equal(throwing.ground.anchorFor(throwing.properties[0]).source, 'market');
});

test('the report names every entry, its quality and where the camera was', () => {
  const h = harness({ heights: () => 291.3, agl: 12_000 });
  h.ground.refresh();
  const { entries, log, coarse, fine, market } = h.ground.report;
  assert.equal(entries.length, 2);
  assert.deepEqual([coarse, fine, market], [2, 0, 0]);
  assert.equal(entries[0].sampledAtAglM, 12_000);
  assert.equal(entries[0].fromFootprint, true);
  assert.equal(entries[1].fromFootprint, false);
  assert.equal(log.length, 2);
  assert.equal(log[0].source, 'tiles');
});
