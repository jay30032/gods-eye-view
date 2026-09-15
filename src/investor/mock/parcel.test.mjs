import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PARCEL_END_M,
  PARCEL_MAX_AREA_M2,
  PARCEL_SIDE_M,
  SQ_M_PER_ACRE,
  convexHull,
  distanceM,
  footprintCentroid,
  nominalParcel,
  orientedBoundingBox,
  parcelFromFootprint,
  ringArea,
  setbackScale,
  toGeo,
  toLocal,
} from './parcel.js';

const ORIGIN = Object.freeze({ lat: 33.7590, lng: -84.3072 });
const M_PER_DEG_LAT = 111_320;

/** A rectangle `w` x `d` metres, rotated `deg` clockwise from north, as [lon,lat]. */
function house(w, d, deg = 0, origin = ORIGIN) {
  const rad = (deg * Math.PI) / 180;
  return [[w / 2, d / 2], [-w / 2, d / 2], [-w / 2, -d / 2], [w / 2, -d / 2]]
    .map(([x, y]) => [x * Math.cos(rad) - y * Math.sin(rad), x * Math.sin(rad) + y * Math.cos(rad)])
    .map((point) => toGeo(point, origin));
}

/** Side lengths of a four-corner ring, sorted short to long. */
function sides(ring) {
  const out = [];
  for (let i = 0; i < ring.length; i += 1) {
    out.push(distanceM(ring[i], ring[(i + 1) % ring.length]));
  }
  return out.sort((a, b) => a - b);
}

test('the local projection round-trips at a building scale', () => {
  for (const point of [[-84.3072, 33.7590], [-84.3061, 33.7598], [-84.3090, 33.7571]]) {
    const back = toGeo(toLocal(point, ORIGIN), ORIGIN);
    assert.ok(Math.abs(back[0] - point[0]) < 1e-9, 'lng drifted');
    assert.ok(Math.abs(back[1] - point[1]) < 1e-9, 'lat drifted');
  }
});

test('the centroid is the centre of area, not the average of the vertices', () => {
  // A square with one side traced at high resolution. A vertex average would be
  // dragged toward the dense edge; the area centroid must not move at all.
  const square = house(20, 20);
  const dense = [square[0]];
  for (let i = 1; i <= 20; i += 1) {
    dense.push([
      square[0][0] + (square[1][0] - square[0][0]) * (i / 21),
      square[0][1] + (square[1][1] - square[0][1]) * (i / 21),
    ]);
  }
  dense.push(square[1], square[2], square[3]);

  const centroid = footprintCentroid(dense);
  assert.ok(Math.abs(centroid.lat - ORIGIN.lat) < 1e-7, `lat moved to ${centroid.lat}`);
  assert.ok(Math.abs(centroid.lng - ORIGIN.lng) < 1e-7, `lng moved to ${centroid.lng}`);

  // Whereas a plain vertex mean genuinely is off — proving the test has teeth.
  const mean = dense.reduce((acc, p) => [acc[0] + p[0], acc[1] + p[1]], [0, 0])
    .map((v) => v / dense.length);
  assert.ok(Math.abs(mean[1] - ORIGIN.lat) > 1e-6, 'the vertex mean should be wrong here');
});

test('a closed ring and an open one give the same centroid and area', () => {
  const open = house(14, 10);
  const closed = [...open, open[0]];
  assert.deepEqual(footprintCentroid(closed), footprintCentroid(open));
  assert.equal(ringArea(closed.map((p) => toLocal(p, ORIGIN))),
    ringArea(open.map((p) => toLocal(p, ORIGIN))));
});

test('the bounding box sits square on the walls, not square on north', () => {
  for (const angle of [0, 17, 30, 45, 62, 88, 133]) {
    const ring = house(12, 8, angle).map((p) => toLocal(p, ORIGIN));
    const box = orientedBoundingBox(ring);
    assert.ok(Math.abs(box.halfLong * 2 - 12) < 0.05, `long axis at ${angle}° is ${box.halfLong * 2}`);
    assert.ok(Math.abs(box.halfShort * 2 - 8) < 0.05, `short axis at ${angle}° is ${box.halfShort * 2}`);
    // An axis-aligned box round a rotated house would be larger than the house.
    assert.ok(Math.abs(box.areaM2 - 96) < 1, `area at ${angle}° is ${box.areaM2}`);
  }
});

test('the hull ignores points inside the footprint', () => {
  const ring = house(20, 20).map((p) => toLocal(p, ORIGIN));
  const withInterior = [...ring, [0, 0], [1, 2], [-3, 1]];
  assert.equal(convexHull(withInterior).length, 4);
});

// ---------------------------------------------------------------------------
// parcel generation from a footprint
// ---------------------------------------------------------------------------

test('a typical house gets the full setbacks: 9 m sides, 18 m front and back', () => {
  // 12 m wide (the street frontage) by 10 m deep.
  const parcel = parcelFromFootprint(house(12, 10));
  assert.equal(parcel.source, 'synthetic');
  assert.equal(parcel.ring.length, 4);
  assert.equal(parcel.setbackScale, 1, 'this lot fits inside the cap unscaled');

  const [shortSide, , , longSide] = [...sides(parcel.ring), null].slice(0, 4).concat([null]);
  const lengths = sides(parcel.ring);
  // Long axis 12 + 2x9 = 30; short axis 10 + 2x18 = 46. The *lot* is deeper
  // than it is wide even though the house is wider than it is deep.
  assert.ok(Math.abs(lengths[0] - 30) < 0.1, `side setback wrong: ${lengths[0]}`);
  assert.ok(Math.abs(lengths[3] - 46) < 0.1, `end setback wrong: ${lengths[3]}`);
  assert.ok(Math.abs(parcel.areaM2 - 30 * 46) < 2);
  assert.ok(parcel.areaAcres > 0.33 && parcel.areaAcres <= 0.35, `${parcel.areaAcres} acres`);
  assert.ok(shortSide <= longSide || true);
});

test('the parcel keeps the house orientation whatever angle it sits at', () => {
  for (const angle of [0, 23, 45, 71, 119]) {
    const parcel = parcelFromFootprint(house(12, 10, angle));
    const lengths = sides(parcel.ring);
    assert.ok(Math.abs(lengths[0] - 30) < 0.2, `${angle}°: ${lengths[0]}`);
    assert.ok(Math.abs(lengths[3] - 46) < 0.2, `${angle}°: ${lengths[3]}`);
  }
});

test('the parcel is centred on the footprint and contains it', () => {
  const ring = house(12, 10, 35);
  const parcel = parcelFromFootprint(ring);
  const centre = footprintCentroid(ring);
  assert.ok(Math.abs(parcel.centroid.lat - centre.lat) < 1e-9);
  assert.ok(Math.abs(parcel.centroid.lng - centre.lng) < 1e-9);
  // Every corner of the house is inside the lot.
  const local = parcel.ring.map((p) => toLocal(p, centre));
  const inside = ([x, y]) => {
    let hit = false;
    for (let i = 0, j = local.length - 1; i < local.length; j = i, i += 1) {
      const [xi, yi] = local[i];
      const [xj, yj] = local[j];
      if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) hit = !hit;
    }
    return hit;
  };
  for (const corner of ring.map((p) => toLocal(p, centre))) {
    assert.ok(inside(corner), `a house corner fell outside its own lot: ${corner}`);
  }
});

test('no parcel exceeds 0.35 acres unless the building already does', () => {
  // The cap binds the *setbacks*, which is the only thing it can bind. A house
  // whose own bounding box is larger than the cap gets that box and nothing
  // added — the alternative is a lot line drawn through the living room.
  for (const [w, d] of [[12, 10], [20, 14], [30, 22], [40, 30], [60, 45], [80, 60]]) {
    const parcel = parcelFromFootprint(house(w, d));
    const footprintBox = w * d;
    const limit = Math.max(PARCEL_MAX_AREA_M2, footprintBox);
    assert.ok(
      parcel.areaM2 <= limit + 1,
      `${w}x${d} produced ${parcel.areaAcres.toFixed(3)} acres`,
    );
    assert.ok(parcel.areaM2 >= footprintBox - 1, `${w}x${d} lot is smaller than the house`);
  }
  assert.ok(Math.abs(PARCEL_MAX_AREA_M2 / SQ_M_PER_ACRE - 0.35) < 1e-9);
});

test('every footprint the fetch script will accept produces a capped lot', () => {
  // fetch-footprints.mjs refuses anything over 1,200 m², which is comfortably
  // under the 1,416 m² cap — so in practice no shipped parcel is over 0.35 ac.
  const MAX_ACCEPTED_FOOTPRINT_M2 = 1_200;
  for (let area = 70; area <= MAX_ACCEPTED_FOOTPRINT_M2; area += 10) {
    for (const ratio of [1, 1.5, 2.5, 4]) {
      const w = Math.sqrt(area * ratio);
      const parcel = parcelFromFootprint(house(w, area / w));
      assert.ok(
        parcel.areaM2 <= PARCEL_MAX_AREA_M2 + 1,
        `${area} m² at ${ratio}:1 produced ${parcel.areaAcres.toFixed(3)} acres`,
      );
    }
  }
});

test('a footprint already over the cap keeps its own box, never a smaller one', () => {
  // 80 x 60 is 4,800 m², well past the 1,416 m² cap. The setbacks go to zero;
  // they must not go negative and cut a lot line through the building.
  const parcel = parcelFromFootprint(house(80, 60));
  assert.equal(parcel.setbackScale, 0);
  const lengths = sides(parcel.ring);
  assert.ok(Math.abs(lengths[0] - 60) < 0.2, `short side shrank to ${lengths[0]}`);
  assert.ok(Math.abs(lengths[3] - 80) < 0.2, `long side shrank to ${lengths[3]}`);
});

test('setbacks scale down together so the lot keeps its proportions', () => {
  const scale = setbackScale(30, 22);
  assert.ok(scale > 0 && scale < 1, `expected a partial scale, got ${scale}`);
  const long = 30 + 2 * PARCEL_SIDE_M * scale;
  const short = 22 + 2 * PARCEL_END_M * scale;
  assert.ok(Math.abs(long * short - PARCEL_MAX_AREA_M2) < 1, 'the scaled lot does not meet the cap');
  // Monotonic: a bigger house never gets a bigger setback.
  let previous = Infinity;
  for (let w = 8; w <= 60; w += 2) {
    const next = setbackScale(w, w * 0.75);
    assert.ok(next <= previous + 1e-9, `scale rose at ${w} m`);
    previous = next;
  }
});

test('a degenerate footprint yields no parcel rather than a broken one', () => {
  assert.equal(parcelFromFootprint([]), null);
  assert.equal(parcelFromFootprint([[-84.3, 33.7]]), null);
  assert.equal(parcelFromFootprint([[-84.3, 33.7], [-84.31, 33.71]]), null);
  assert.equal(parcelFromFootprint(null), null);
});

test('the degrade path is an honest nominal lot, flagged as approximate', () => {
  const parcel = nominalParcel(ORIGIN.lat, ORIGIN.lng);
  assert.equal(parcel.approximate, true);
  assert.equal(parcel.source, 'synthetic');
  assert.ok(parcel.areaM2 <= PARCEL_MAX_AREA_M2);
  assert.equal(parcel.ring.length, 4);
  assert.ok(Math.abs(parcel.centroid.lat - ORIGIN.lat) < 1e-12);
  assert.equal(nominalParcel(Number.NaN, ORIGIN.lng), null);
  assert.equal(nominalParcel(null, null), null);
});

test('distances are metres, and a degree of latitude still measures right', () => {
  assert.ok(Math.abs(distanceM([-84.3, 33.75], [-84.3, 33.76]) - 0.01 * M_PER_DEG_LAT) < 1);
  assert.equal(distanceM([-84.3, 33.75], [-84.3, 33.75]), 0);
});
