import test from 'node:test';
import assert from 'node:assert/strict';
import { lodFromHeight } from './lod.js';
import { clusterProperties } from './visuals/signalClusterer.js';
import { breathe, prefersReducedMotion } from './visuals/reducedMotionPolicy.js';
import { createMockPropertyProvider } from './mock/provider.js';

test('LOD bands step from globe to street without skipping', () => {
  assert.equal(lodFromHeight(8_000_000).id, 'globe');
  assert.equal(lodFromHeight(400_000).id, 'regional');
  assert.equal(lodFromHeight(40_000).id, 'city');
  assert.equal(lodFromHeight(5_000).id, 'neighborhood');
  assert.equal(lodFromHeight(400).id, 'street');
  assert.equal(lodFromHeight(40_000).showPulses, true);
  assert.equal(lodFromHeight(8_000_000).showPulses, false);
});

test('clusterer collapses the market at globe LOD and expands at street', () => {
  const rows = createMockPropertyProvider().list();
  const globe = clusterProperties(rows, 'globe');
  const street = clusterProperties(rows, 'street');
  assert.ok(globe.length < rows.length);
  assert.equal(street.length, rows.length);
});

test('breathe stays between 0 and 1 and reduced-motion can be read', () => {
  const a = breathe(0, 2800);
  const b = breathe(1400, 2800);
  assert.ok(a >= 0 && a <= 1);
  assert.ok(b >= 0 && b <= 1);
  assert.equal(typeof prefersReducedMotion(() => ({ matches: true })), 'boolean');
  assert.equal(prefersReducedMotion(() => ({ matches: true })), true);
});
