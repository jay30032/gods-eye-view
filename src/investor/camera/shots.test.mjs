import test from 'node:test';
import assert from 'node:assert/strict';
import { ATLANTA_DECATUR_PROPERTIES } from '../mock/atlantaDecatur.js';
import { resolveMarket } from '../markets.js';
import {
  CRUISE,
  DRIVE,
  DURATIONS,
  HERO,
  HOP,
  REVEAL,
  STAGING,
  altitudeToFit,
  boundsOf,
  cameraFromAim,
  cruiseShot,
  driveShot,
  durationFor,
  headingBetween,
  heroShot,
  hopApexShot,
  lowerThirdTiltDeg,
  offsetByHeading,
  padBounds,
  revealShot,
  stagingShot,
  worldShot,
} from './shots.js';

const market = resolveMarket('atlanta');
const M_PER_DEG_LAT = 111_320;
const metresBetween = (a, b) => Math.hypot(
  (a.lat - b.lat) * M_PER_DEG_LAT,
  (a.lng - b.lng) * M_PER_DEG_LAT * Math.cos(a.lat * Math.PI / 180),
);

test('every shot is a complete, finite camera pose', () => {
  const shots = [
    worldShot(market),
    stagingShot(market),
    cruiseShot(),
    revealShot(ATLANTA_DECATUR_PROPERTIES.slice(0, 4)),
    heroShot(ATLANTA_DECATUR_PROPERTIES[0]),
    hopApexShot(ATLANTA_DECATUR_PROPERTIES[0], ATLANTA_DECATUR_PROPERTIES[1], 300),
    driveShot(ATLANTA_DECATUR_PROPERTIES[0], 90),
  ];
  for (const shot of shots) {
    assert.ok(shot.name, 'shot has a name');
    for (const key of ['lat', 'lng', 'heightM', 'headingDeg', 'pitchDeg']) {
      assert.ok(Number.isFinite(shot[key]), `${shot.name}.${key} is ${shot[key]}`);
    }
    assert.ok(shot.heightM > 0, `${shot.name} is underground`);
    assert.ok(shot.pitchDeg < 0, `${shot.name} looks up, not down`);
    assert.ok(Math.abs(shot.lat) <= 90 && Math.abs(shot.lng) <= 180);
  }
});

test('the camera sets back from its aim point, so the aim is what is framed', () => {
  const aim = { lat: 33.76, lng: -84.31 };
  // At 45 degrees the set-back equals the altitude.
  const shot = cameraFromAim(aim, { headingDeg: 0, pitchDeg: -45, altitudeM: 1000 });
  assert.ok(Math.abs(metresBetween(aim, shot) - 1000) < 5, 'set-back should equal altitude at -45');
  // Heading 0 looks north, so the camera sits SOUTH of the aim.
  assert.ok(shot.lat < aim.lat, 'camera is behind the aim point');

  // Straight down means no set-back at all.
  const nadir = cameraFromAim(aim, { headingDeg: 0, pitchDeg: -90, altitudeM: 1000 });
  assert.ok(metresBetween(aim, nadir) < 1, 'nadir camera sits over its aim');
});

test('offsetByHeading moves the right distance in the right direction', () => {
  const from = { lat: 33.76, lng: -84.31 };
  for (const [heading, check] of [
    [0, (to) => to.lat > from.lat && Math.abs(to.lng - from.lng) < 1e-9],
    [90, (to) => to.lng > from.lng && Math.abs(to.lat - from.lat) < 1e-9],
    [180, (to) => to.lat < from.lat],
    [270, (to) => to.lng < from.lng],
  ]) {
    const to = offsetByHeading(from, heading, 1000);
    assert.ok(check(to), `heading ${heading} went the wrong way`);
    assert.ok(Math.abs(metresBetween(from, to) - 1000) < 2, `heading ${heading} wrong distance`);
  }
});

test('STAGING is a nadir hold high enough to stream the whole metro', () => {
  const shot = stagingShot(market);
  assert.equal(shot.heightM, 40_000);
  assert.equal(shot.pitchDeg, -90);
  assert.ok(metresBetween({ lat: market.lat, lng: market.lng }, shot) < 1, 'directly overhead');
  assert.equal(STAGING.altitudeM, 40_000);
});

test('CRUISE frames the dense side of the board', () => {
  const shot = cruiseShot();
  assert.equal(shot.heightM, 1_800);
  assert.equal(shot.pitchDeg, -35);
  assert.equal(shot.headingDeg, 20);

  // The aim point, not the camera, is what sits over the cluster.
  const centroid = {
    lat: ATLANTA_DECATUR_PROPERTIES.reduce((s, p) => s + p.lat, 0) / ATLANTA_DECATUR_PROPERTIES.length,
    lng: ATLANTA_DECATUR_PROPERTIES.reduce((s, p) => s + p.lng, 0) / ATLANTA_DECATUR_PROPERTIES.length,
  };
  assert.ok(metresBetween(CRUISE.aim, centroid) < 2_500, 'aim should sit near the property centroid');
  // And the camera is set back behind it, not on top of it.
  assert.ok(metresBetween(CRUISE.aim, shot) > 2_000, 'camera must be set back at -35');
});

test('REVEAL fits the shortlist with padding and respects its altitude clamp', () => {
  const four = ATLANTA_DECATUR_PROPERTIES.slice(0, 4);
  const shot = revealShot(four);
  assert.equal(shot.pitchDeg, -45);
  assert.ok(shot.heightM >= REVEAL.minAltitudeM && shot.heightM <= REVEAL.maxAltitudeM,
    `altitude ${shot.heightM} outside clamp`);

  // A tight cluster clamps to the floor; a spread one clamps to the ceiling.
  const tight = revealShot([
    { lat: 33.76, lng: -84.31 }, { lat: 33.7601, lng: -84.3101 },
  ]);
  assert.equal(tight.heightM, REVEAL.minAltitudeM);
  const wide = revealShot([
    { lat: 33.60, lng: -84.50 }, { lat: 33.95, lng: -84.15 },
  ]);
  assert.equal(wide.heightM, REVEAL.maxAltitudeM);

  // No points is not a crash; it is the market view.
  assert.equal(revealShot([]).name, 'CRUISE');
  assert.equal(revealShot(null).name, 'CRUISE');
});

test('padding widens the box by a quarter of its own span', () => {
  const box = padBounds({ south: 33.70, north: 33.80, west: -84.40, east: -84.30 }, 0.25);
  assert.ok(Math.abs((box.north - box.south) - 0.15) < 1e-9, 'lat span grows 25% each side');
  assert.ok(Math.abs((box.east - box.west) - 0.15) < 1e-9);
  // Centre is preserved.
  assert.ok(Math.abs((box.north + box.south) / 2 - 33.75) < 1e-9);
});

test('a degenerate bounding box still produces a usable frame', () => {
  const single = boundsOf([{ lat: 33.76, lng: -84.31 }]);
  assert.equal(single.north, single.south);
  const box = padBounds(single);
  assert.ok(box.north > box.south, 'a single point gets a real span');
  const shot = revealShot([{ lat: 33.76, lng: -84.31 }]);
  assert.ok(shot.heightM >= REVEAL.minAltitudeM);
});

test('HERO sits exactly 180m from the house and frames it low', () => {
  const house = ATLANTA_DECATUR_PROPERTIES[0];
  const shot = heroShot(house);
  assert.equal(shot.headingDeg, 35);

  // The stated range is to the HOUSE, so the slant distance must be exactly it.
  const ground = metresBetween(house, shot);
  const slant = Math.hypot(ground, shot.heightM);
  assert.ok(Math.abs(slant - HERO.rangeM) < 1, `slant range ${slant.toFixed(1)} should be 180`);
  const expectedAltitude = HERO.rangeM * Math.sin(38 * Math.PI / 180);
  assert.ok(Math.abs(shot.heightM - expectedAltitude) < 0.5);

  // Rendered pitch is the depression tilted up by the lower-third angle.
  assert.ok(Math.abs(lowerThirdTiltDeg() - 10) < 1e-9, 'a sixth of 60 degrees is 10');
  assert.ok(Math.abs(shot.pitchDeg - (HERO.pitchDeg + 10)) < 1e-9,
    `rendered pitch ${shot.pitchDeg} should be -28`);
  assert.ok(shot.pitchDeg < 0, 'the camera still looks down, never at the sky');
});

test('HOP rises above both ends and lands over the midpoint', () => {
  const a = ATLANTA_DECATUR_PROPERTIES[0];
  const b = ATLANTA_DECATUR_PROPERTIES[5];
  const low = hopApexShot(a, b, 100);
  assert.equal(low.heightM, HOP.minApexAltitudeM, 'a low camera still rises to the floor');
  const high = hopApexShot(a, b, 1400);
  assert.equal(high.heightM, 1400, 'a high camera does not drop to hop');

  const midpoint = { lat: (a.lat + b.lat) / 2, lng: (a.lng + b.lng) / 2 };
  // At -60 the set-back is altitude/tan(60), so the camera is near the midpoint.
  const expectedSetBack = HOP.minApexAltitudeM / Math.tan(60 * Math.PI / 180);
  assert.ok(Math.abs(metresBetween(midpoint, low) - expectedSetBack) < 5);
});

test('DRIVE trails the route by 120m at 90m up', () => {
  const house = ATLANTA_DECATUR_PROPERTIES[0];
  const shot = driveShot(house, 90); // travelling due east
  assert.equal(shot.heightM, DRIVE.aboveM);
  assert.equal(shot.pitchDeg, -25);
  assert.equal(shot.headingDeg, 90);
  assert.ok(Math.abs(metresBetween(house, shot) - DRIVE.behindM) < 2);
  assert.ok(shot.lng < house.lng, 'heading east means trailing to the west');
});

test('route heading points from one house to the next', () => {
  const north = headingBetween({ lat: 33.70, lng: -84.30 }, { lat: 33.80, lng: -84.30 });
  assert.ok(Math.abs(north - 0) < 0.5 || Math.abs(north - 360) < 0.5);
  const east = headingBetween({ lat: 33.75, lng: -84.40 }, { lat: 33.75, lng: -84.30 });
  assert.ok(Math.abs(east - 90) < 0.5);
  const west = headingBetween({ lat: 33.75, lng: -84.30 }, { lat: 33.75, lng: -84.40 });
  assert.ok(Math.abs(west - 270) < 0.5);
});

test('durations come from one table and are all deliberate', () => {
  assert.equal(durationFor('WORLD', 'STAGING'), 3.5);
  assert.equal(durationFor('STAGING', 'CRUISE'), 3.0);
  assert.equal(durationFor('CRUISE', 'REVEAL'), 2.5);
  assert.equal(durationFor('REVEAL', 'HERO'), 2.0);
  assert.equal(durationFor('CRUISE', 'HERO'), 2.0);
  assert.equal(durationFor('HERO', 'HOP'), 2.5);
  assert.equal(durationFor('HERO', 'CRUISE'), 2.0);
  for (const value of Object.values(DURATIONS)) {
    assert.ok(value > 0 && value <= 5, `duration ${value}s is outside a watchable range`);
  }
});

test('altitudeToFit grows with the span it has to cover', () => {
  assert.ok(altitudeToFit(2000) > altitudeToFit(1000));
  // At a 60 degree vertical FOV the altitude to fit a span is span/2 / tan(30).
  assert.ok(Math.abs(altitudeToFit(2000) - (1000 / Math.tan(30 * Math.PI / 180))) < 1e-6);
});

test('shot geometry is deterministic', () => {
  const house = ATLANTA_DECATUR_PROPERTIES[3];
  assert.deepEqual(heroShot(house), heroShot(house));
  assert.deepEqual(cruiseShot(), cruiseShot());
  assert.deepEqual(revealShot(ATLANTA_DECATUR_PROPERTIES.slice(0, 4)),
    revealShot(ATLANTA_DECATUR_PROPERTIES.slice(0, 4)));
});

test('the documented skyline bearing does not match the shipped heading', () => {
  // CRUISE.headingDeg is 20 as specified. Downtown Atlanta is almost due west
  // of the aim point, so heading 20 cannot put the skyline on the horizon.
  // Pinned so the discrepancy is a decision on the record, not a silent bug.
  const downtown = { lat: 33.7550, lng: -84.3900 };
  const bearing = headingBetween(CRUISE.aim, downtown);
  assert.ok(Math.abs(bearing - 264) < 3, `skyline bears ${bearing.toFixed(1)}`);
  assert.equal(CRUISE.headingDeg, 20);
});
