/**
 * The rules of the tree-free world.
 *
 * Everything here decides what is on screen or which building is which, and
 * both are the kind of thing that fails silently: a gold tint one house to the
 * left looks exactly like a gold tint on the right house unless you know the
 * street.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  BUILDING_BASE_CSS,
  BUILDING_FOCUS_CSS,
  BUILDING_GOLD_CSS,
  BUILDING_MATCH_RADIUS_M,
  OSM_BUILDINGS_ASSET_ID,
  WORLDS,
  WORLD_FADE_MS,
  WORLD_STACKS,
  buildingAnchorsFor,
  buildingColorFor,
  matchBuilding,
  metresBetween,
  readWorldFromLocation,
  worldFadeState,
} from './clearView.js';

test('the two worlds are the two map stacks the controller already owns', () => {
  // Terrain, imagery and the Google tileset's visibility are solved there,
  // including the generation guards that keep a slow provider from stomping a
  // fast one. This module adds buildings and nothing else.
  assert.equal(WORLD_STACKS[WORLDS.PHOTO], 'photoreal');
  assert.equal(WORLD_STACKS[WORLDS.CLEAR], 'bing-aerial');
  assert.equal(OSM_BUILDINGS_ASSET_ID, 96188);
});

// ---------------------------------------------------------------------------
// Matching a building to a property
// ---------------------------------------------------------------------------

/** Two houses on the same side of an Oakhurst street, about 22 m apart. */
const ANCHORS = [
  { id: 'SIX-001', lat: 33.75820, lng: -84.30700 },
  { id: 'SIX-002', lat: 33.75820, lng: -84.30676 },
];

test('metres between two coordinates, in the plane', () => {
  assert.ok(Math.abs(metresBetween(ANCHORS[0], ANCHORS[1]) - 22.2) < 0.5);
  assert.equal(metresBetween(null, ANCHORS[0]), Infinity);
  assert.equal(metresBetween(ANCHORS[0], { lat: NaN, lng: 0 }), Infinity);
});

test('a building within six metres of a footprint centroid is that house', () => {
  assert.equal(BUILDING_MATCH_RADIUS_M, 6);
  const hit = matchBuilding({ lat: 33.758204, lng: -84.307005 }, ANCHORS);
  assert.equal(hit.id, 'SIX-001');
  assert.ok(hit.distanceM < 1);
});

test('and one seven metres away is not', () => {
  // OSM Buildings carries one representative coordinate per building, and it is
  // not always the polygon centroid — the radius absorbs that offset. Past it,
  // an unmatched building is the draped footprint fill standing in, which is
  // correct; a wrong match is a gold tint on the neighbour, which is not.
  const away = { lat: 33.75820 + 7 / 111320, lng: -84.30700 };
  assert.equal(matchBuilding(away, ANCHORS), null);
});

test('the nearest anchor wins, not the first one listed', () => {
  // Two anchors can both be in range on a dense block. Taking the first would
  // make the answer depend on the order of the inventory.
  const between = { lat: 33.75820, lng: -84.306885 };
  const near = matchBuilding(between, ANCHORS, { radiusM: 15 });
  const reversed = matchBuilding(between, [...ANCHORS].reverse(), { radiusM: 15 });
  assert.equal(near.id, reversed.id);
});

test('the neighbour is never claimed: half the house spacing is well outside', () => {
  const spacingM = metresBetween(ANCHORS[0], ANCHORS[1]);
  assert.ok(BUILDING_MATCH_RADIUS_M < spacingM / 2,
    `a ${BUILDING_MATCH_RADIUS_M} m radius on ${spacingM.toFixed(1)} m spacing can be ambiguous`);
});

test('anchors come from the footprint centroid, never the stored coordinate', () => {
  /**
   * An authored coordinate can sit in the street or in next door's garden —
   * Phase 1 moved the marker and the parcel onto the footprint for exactly
   * that reason. Matching from the stored point would hand the gold tint to
   * whichever building happened to be nearer it.
   */
  const ring = [
    [-84.30701, 33.75819], [-84.30699, 33.75819],
    [-84.30699, 33.75821], [-84.30701, 33.75821], [-84.30701, 33.75819],
  ];
  const anchors = buildingAnchorsFor(
    [{ id: 'SIX-001', lat: 33.75700, lng: -84.30900 }],
    { getGeometry: () => ({ building: { footprint: [ring] } }) },
  );
  assert.equal(anchors.length, 1);
  assert.ok(Math.abs(anchors[0].lat - 33.75820) < 1e-4);
  assert.ok(Math.abs(anchors[0].lng - (-84.30700)) < 1e-4);
});

test('a row with no footprint is never matched, and never throws', () => {
  // The draped footprint fill stands in. That is the documented fallback.
  assert.deepEqual(buildingAnchorsFor([{ id: 'X' }], { getGeometry: () => null }), []);
  assert.deepEqual(buildingAnchorsFor(null, { getGeometry: () => null }), []);
});

// ---------------------------------------------------------------------------
// How buildings are painted
// ---------------------------------------------------------------------------

test('exactly one building is ever gold', () => {
  // A board where three houses are lit is a board that has not answered the
  // question. Every other building is the same grey, so the signal effects
  // carry all the colour on screen.
  const ids = ['A', 'B', 'C', 'D'];
  const colors = ids.map((id) => buildingColorFor(id, { topPickId: 'B', focusedId: 'B' }));
  assert.equal(colors.filter((c) => c === BUILDING_GOLD_CSS).length, 1);
  assert.equal(colors.filter((c) => c === BUILDING_BASE_CSS).length, 3);
});

test('the top pick outranks the focused house when they differ', () => {
  assert.equal(buildingColorFor('A', { topPickId: 'A', focusedId: 'B' }), BUILDING_GOLD_CSS);
  assert.equal(buildingColorFor('B', { topPickId: 'A', focusedId: 'B' }), BUILDING_FOCUS_CSS);
  assert.notEqual(BUILDING_FOCUS_CSS, BUILDING_GOLD_CSS);
});

test('an unmatched building is grey, not gold by accident', () => {
  assert.equal(buildingColorFor(null, { topPickId: 'A' }), BUILDING_BASE_CSS);
  assert.equal(buildingColorFor(undefined, { topPickId: null }), BUILDING_BASE_CSS);
});

// ---------------------------------------------------------------------------
// The cross-fade
// ---------------------------------------------------------------------------

test('the world cross-fade is 600 ms and dips rather than cutting', () => {
  assert.equal(WORLD_FADE_MS, 600);
  const start = worldFadeState(0);
  const middle = worldFadeState(WORLD_FADE_MS / 2);
  const end = worldFadeState(WORLD_FADE_MS);
  assert.equal(start.scrim, 0, 'the scene is not dimmed before the switch begins');
  assert.ok(middle.scrim > 0.6, `the dip only reached ${middle.scrim}`);
  assert.ok(Math.abs(end.scrim) < 1e-9, 'and it comes all the way back');
  assert.equal(end.done, true);
});

test('the swap happens at the bottom of the dip, not at the start', () => {
  // The darkest frame is the one instant where a provider changing over is
  // invisible. Anywhere else it is a hard cut with a fade around it.
  assert.equal(worldFadeState(0).atSwap, false);
  assert.equal(worldFadeState(WORLD_FADE_MS * 0.49).atSwap, false);
  assert.equal(worldFadeState(WORLD_FADE_MS * 0.5).atSwap, true);
  assert.equal(worldFadeState(WORLD_FADE_MS).atSwap, true);
});

test('the dip is symmetric and never overshoots', () => {
  for (let ms = -200; ms <= 1200; ms += 10) {
    const { scrim } = worldFadeState(ms);
    assert.ok(scrim >= 0 && scrim <= 0.68 + 1e-9, `scrim ${scrim} at ${ms} ms`);
  }
  for (let ms = 0; ms <= WORLD_FADE_MS / 2; ms += 10) {
    const a = worldFadeState(ms).scrim;
    const b = worldFadeState(WORLD_FADE_MS - ms).scrim;
    assert.ok(Math.abs(a - b) < 1e-9, `not symmetric at ${ms} ms`);
  }
});

// ---------------------------------------------------------------------------
// The way in: a URL, and only a URL
// ---------------------------------------------------------------------------

test('?world=clear opens the experiment; nothing else does', () => {
  assert.equal(readWorldFromLocation({ search: '?scene=six&world=clear' }), WORLDS.CLEAR);
  assert.equal(readWorldFromLocation({ search: '?world=ClearView' }), WORLDS.CLEAR);
  assert.equal(readWorldFromLocation({ search: '?world=photo' }), WORLDS.PHOTO);
  assert.equal(readWorldFromLocation({ search: '?scene=six' }), null);
  // The TREES chip and `?trees=off` are gone from the product with it.
  assert.equal(readWorldFromLocation({ search: '?trees=off' }), null);
  assert.equal(readWorldFromLocation({ search: '?trees=0' }), null);
  assert.equal(readWorldFromLocation({ search: '' }), null);
  assert.equal(readWorldFromLocation(undefined), null);
});

test('no remembered choice: the module exports no storage at all', async () => {
  const exported = await import('./clearView.js');
  for (const name of ['CLEAR_VIEW_STORAGE_KEY', 'readWorldPreference', 'writeWorldPreference']) {
    assert.equal(name in exported, false, `${name} should be gone`);
  }
});
