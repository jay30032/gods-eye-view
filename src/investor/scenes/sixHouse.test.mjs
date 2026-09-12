import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SIX_CLUSTER_MAX_SPAN_M,
  SIX_CRUISE_ALTITUDE_M,
  SIX_HOUSE_COUNT,
  buildSixHouseScene,
  clusterCentre,
  clusterSpanM,
  distanceBetween,
  goldPickFor,
  readSceneMode,
  signalTypesIn,
  sixHouseRows,
} from './sixHouse.js';
import { createMockPropertyProvider } from '../mock/provider.js';
import { validateProperty, SIGNAL_TYPES } from '../mock/schema.js';
import { NEAR_FIELD_MAX_HEIGHT_M } from '../visuals/effects/signalMotion.js';
import { CLUSTER_CRUISE, clusterCruiseShot, cruiseShot } from '../camera/shots.js';
import { geometryFor } from '../mock/geometry.js';
import { DEMO_STEPS } from '../demoSequence.js';

const NOW = Date.UTC(2026, 8, 10);
const enriched = () => createMockPropertyProvider({ dataset: 'six', now: NOW }).list();

test('?scene=six is recognised and nothing else is', () => {
  assert.equal(readSceneMode({ search: '?scene=six' }), 'six');
  assert.equal(readSceneMode({ search: '?scene=6' }), 'six');
  assert.equal(readSceneMode({ search: '?demo=1&scene=SIX' }), 'six');
  assert.equal(readSceneMode({ search: '?scene=seven' }), null);
  assert.equal(readSceneMode({ search: '?demo=1' }), null);
  assert.equal(readSceneMode({ search: '' }), null);
  assert.equal(readSceneMode(undefined), null);
});

test('the scene is six rows covering all five signal types', () => {
  const rows = sixHouseRows();
  assert.equal(rows.length, SIX_HOUSE_COUNT);
  const types = signalTypesIn(rows);
  assert.equal(types.size, SIGNAL_TYPES.length, `types present: ${[...types].join(', ')}`);
  for (const type of SIGNAL_TYPES) {
    assert.ok(types.has(type), `no ${type} in the six-house scene`);
  }
});

test('the six houses are within about 600 m of each other', () => {
  const span = clusterSpanM(sixHouseRows());
  assert.ok(span > 0, 'the rows are all on the same spot');
  assert.ok(span <= SIX_CLUSTER_MAX_SPAN_M, `the cluster spans ${span.toFixed(0)} m`);
  // Every house is inside the establishing shot, not just the extremes.
  const centre = clusterCentre(sixHouseRows());
  for (const row of sixHouseRows()) {
    assert.ok(distanceBetween(centre, row) <= SIX_CLUSTER_MAX_SPAN_M / 2 + 1, row.id);
  }
});

test('every row validates and carries a real OSM footprint', () => {
  for (const row of sixHouseRows()) {
    assert.deepEqual(validateProperty(row), [], row.id);
    assert.match(row.id, /^DEMO-SIX-/);
    const geometry = geometryFor(row.id);
    assert.ok(geometry, `${row.id} has no geometry record`);
    assert.equal(geometry.building.source, 'osm', row.id);
    assert.ok(Array.isArray(geometry.building.footprint), `${row.id} has no footprint`);
    assert.ok(geometry.building.footprint[0].length >= 3, row.id);
    assert.equal(geometry.parcel.source, 'synthetic', row.id);
    // The row sits on its own roof, not near it.
    assert.ok(
      distanceBetween(row, geometry.centroid) < 1,
      `${row.id} is ${distanceBetween(row, geometry.centroid).toFixed(1)} m off its footprint`,
    );
  }
});

test('the gold house is the head of the ranking, not something the scene typed', () => {
  const rows = enriched();
  const scene = buildSixHouseScene(rows);
  const best = Math.max(...rows.map((row) => row.composite));
  assert.equal(scene.gold.composite, best);
  assert.equal(scene.goldId, rows.find((row) => row.composite === best).id);

  // Nothing in the authored dataset names the winner.
  for (const row of sixHouseRows()) {
    assert.equal(Object.hasOwn(row, 'composite'), false, row.id);
    assert.equal(Object.hasOwn(row, 'opportunityScore'), false, row.id);
  }
  // And the ranking is decisive rather than a coin toss between two houses.
  const sorted = rows.map((row) => row.composite).sort((a, b) => b - a);
  assert.ok(sorted[0] - sorted[1] >= 5, `gold wins by only ${sorted[0] - sorted[1]}`);
});

test('goldPickFor breaks a tie deterministically instead of by array order', () => {
  const tied = [
    { id: 'B', composite: 80 },
    { id: 'A', composite: 80 },
  ];
  assert.equal(goldPickFor(tied).id, 'A');
  assert.equal(goldPickFor([...tied].reverse()).id, 'A');
  assert.equal(goldPickFor([]), null);
});

test('the establishing shot is 900 m over the cluster and inside the near field', () => {
  const scene = buildSixHouseScene(enriched());
  assert.equal(scene.altitudeM, SIX_CRUISE_ALTITUDE_M);
  assert.equal(CLUSTER_CRUISE.altitudeM, SIX_CRUISE_ALTITUDE_M);
  // The whole point: the effects layer is already up when the shot settles.
  assert.ok(
    SIX_CRUISE_ALTITUDE_M < NEAR_FIELD_MAX_HEIGHT_M,
    'the six-house cruise would arrive above the near-field ceiling',
  );

  const shot = clusterCruiseShot(scene.rows);
  assert.equal(shot.name, 'CRUISE', 'the shot name must not churn — probes wait on it');
  assert.equal(shot.heightM, SIX_CRUISE_ALTITUDE_M);
  assert.ok(shot.pitchDeg < 0 && shot.pitchDeg > -90);
  // The camera sits back from the aim point, so it is NOT over the centroid.
  const centre = clusterCentre(scene.rows);
  assert.ok(distanceBetween(shot, centre) > 100, 'the camera was placed on top of its subject');
  // But it aims at it: the set-back runs opposite the heading.
  assert.ok(shot.groundAnchor);
  assert.ok(Math.abs(shot.groundAnchor.lat - centre.lat) < 1e-9);
  assert.ok(Math.abs(shot.groundAnchor.lng - centre.lng) < 1e-9);
});

test('an empty cluster falls back to the market cruise rather than aiming at nowhere', () => {
  assert.deepEqual(clusterCruiseShot([]), cruiseShot());
  assert.deepEqual(clusterCruiseShot(null), cruiseShot());
  assert.deepEqual(clusterCruiseShot([{ lat: Number.NaN, lng: 1 }]), cruiseShot());
});

test('the scene rides the same provider, validator and scoring as the market board', () => {
  const rows = enriched();
  assert.equal(rows.length, SIX_HOUSE_COUNT);
  for (const row of rows) {
    assert.equal(Object.isFrozen(row), true, row.id);
    assert.ok(Number.isInteger(row.composite), row.id);
    assert.ok(row.drivers.length >= 3, row.id);
    // Enriched rows are deliberately not round-trippable into the dataset.
    assert.notDeepEqual(validateProperty(row), []);
  }
  assert.equal(createMockPropertyProvider({ dataset: 'six', now: NOW }).dataset, 'six');
  assert.throws(() => createMockPropertyProvider({ dataset: 'nope' }), /Unknown mock dataset/);
});

test('the market board is untouched by the scene existing', () => {
  const market = createMockPropertyProvider({ now: NOW });
  assert.equal(market.dataset, 'atlanta');
  assert.equal(market.list().length, 30);
  assert.equal(market.getById('DEMO-SIX-001'), null, 'the scene leaked into the market board');
});

test('the demo rail carries the scene as its own entry and sends no new phrase', () => {
  const step = DEMO_STEPS.find((row) => row.id === 'six');
  assert.ok(step, 'the six-house scene is not on the demo rail');
  assert.equal(step.kind, 'scene');
  assert.equal(step.phrase, null, 'a scene entry must not add an acceptance phrase');
  assert.match(step.href, /scene=six/);
  assert.ok(step.cta);
  assert.equal(DEMO_STEPS.at(-1).id, 'six', 'the scene should come after the conversation');
});
