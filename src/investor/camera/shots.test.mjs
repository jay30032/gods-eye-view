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
  markerRiseDeg,
  subjectTiltDeg,
  offsetByHeading,
  padBounds,
  revealShot,
  stagingShot,
  worldShot,
  worldToggleTarget,
  DRIVE_CHASE,
  driveChaseShot,
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
  assert.equal(shot.pitchDeg, -25);
  assert.equal(shot.headingDeg, 264);

  // The aim point, not the camera, is what sits over the cluster.
  const centroid = {
    lat: ATLANTA_DECATUR_PROPERTIES.reduce((s, p) => s + p.lat, 0) / ATLANTA_DECATUR_PROPERTIES.length,
    lng: ATLANTA_DECATUR_PROPERTIES.reduce((s, p) => s + p.lng, 0) / ATLANTA_DECATUR_PROPERTIES.length,
  };
  assert.ok(metresBetween(CRUISE.aim, centroid) < 2_500, 'aim should sit near the property centroid');
  // And the camera is set back behind it, not on top of it.
  assert.ok(metresBetween(CRUISE.aim, shot) > 2_000, 'camera must be set back at -25');
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

test('HERO sits exactly 150m from the house, just below centre frame', () => {
  const house = ATLANTA_DECATUR_PROPERTIES[0];
  const shot = heroShot(house);
  assert.equal(shot.headingDeg, 35);
  assert.equal(HERO.rangeM, 150);
  assert.equal(HERO.pitchDeg, -45);

  // The stated range is to the HOUSE, so the slant distance must be exactly it.
  const ground = metresBetween(house, shot);
  const slant = Math.hypot(ground, shot.heightM);
  assert.ok(Math.abs(slant - HERO.rangeM) < 1, `slant range ${slant.toFixed(1)} should be 150`);
  const expectedAltitude = HERO.rangeM * Math.sin(45 * Math.PI / 180);
  assert.ok(Math.abs(shot.heightM - expectedAltitude) < 0.5);

  // 0.55 down the frame is a twentieth below centre: 3 degrees of tilt at 60 FOV,
  // then part way back up towards the marker floating above the roof.
  assert.ok(Math.abs(subjectTiltDeg() - 3) < 1e-9, `tilt is ${subjectTiltDeg()}`);
  const rise = markerRiseDeg();
  assert.ok(rise > 4 && rise < 7, `marker rise is ${rise} deg`);
  assert.ok(
    Math.abs(shot.pitchDeg - (HERO.pitchDeg + 3 + rise * HERO.markerRiseShare)) < 1e-9,
    `rendered pitch ${shot.pitchDeg}`,
  );
  // Only part of the marker rise is taken: all of it centres the MARKER and
  // drops the house to 70% down the frame, against the command bar.
  assert.ok(HERO.markerRiseShare > 0 && HERO.markerRiseShare < 1);
  // Both corrections tilt UP: the subject drops down the frame, and the marker
  // floats above the roof so the lens has to rise to meet it.
  assert.ok(shot.pitchDeg > HERO.pitchDeg, 'the framed pitch is shallower than the depression');
  // The framing anchors to the subject's ground, not whatever the camera stands on.
  assert.equal(shot.groundAnchor.lat, house.lat);
  assert.equal(shot.groundAnchor.lng, house.lng);
  assert.ok(shot.pitchDeg < 0, 'the camera still looks down, never at the sky');
  // And it must stay inside the user pitch clamp or the clamp would fight it.
  assert.ok(shot.pitchDeg >= -70 && shot.pitchDeg <= -20);
});

test('the subject sits below centre, never above it', () => {
  assert.ok(HERO.subjectFrameFraction > 0.5, 'above centre would sit under the HUD');
  assert.ok(HERO.subjectFrameFraction < 0.75, 'too low and the command bar covers it');
  assert.equal(subjectTiltDeg(60 * Math.PI / 180, 0.5), 0, 'dead centre needs no tilt');
  assert.ok(subjectTiltDeg(60 * Math.PI / 180, 0.6) > 0, 'lower in frame means tilting up');
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

test('CRUISE actually points at the downtown skyline', () => {
  // The heading is not a taste call: it is the bearing to downtown Atlanta from
  // the aim point. Recomputed here so moving the aim without moving the heading
  // fails loudly instead of quietly pointing at Scottdale.
  const downtown = { lat: 33.7550, lng: -84.3900 };
  const bearing = headingBetween(CRUISE.aim, downtown);
  assert.ok(Math.abs(bearing - CRUISE.headingDeg) < 3,
    `heading ${CRUISE.headingDeg} but the skyline bears ${bearing.toFixed(1)}`);
  assert.equal(CRUISE.headingDeg, 264);
});

test('WORLD comes back to the market first, and only then goes to space', () => {
  // The old behaviour threw the user out to the globe from anywhere, which is
  // almost never what someone pressing WORLD mid-hunt wants.
  for (const shot of ['HERO', 'REVEAL', 'DRIVE', 'HOP', 'STAGING', 'WORLD']) {
    assert.equal(worldToggleTarget(shot), 'CRUISE', `${shot} should return to the market`);
  }
  assert.equal(worldToggleTarget('CRUISE'), 'WORLD', 'a second press goes to the globe');
  // And a third press comes back, so it is a toggle rather than a dead end.
  assert.equal(worldToggleTarget(worldToggleTarget('CRUISE')), 'CRUISE');
  assert.equal(worldToggleTarget(undefined), 'CRUISE');
});

test('REVEAL dwells long enough to be seen but not long enough to drag', () => {
  assert.ok(DURATIONS.revealDwell >= 0.5, 'a shot nobody sees is not a shot');
  assert.ok(DURATIONS.revealDwell <= 1.5, 'the demo should not stall on it');
});

test('the hero orbit is capped at one revolution', () => {
  assert.equal(HERO.orbitMaxDeg, 360);
  assert.equal(HERO.orbitDegPerSec, 5);
  const seconds = HERO.orbitMaxDeg / HERO.orbitDegPerSec;
  assert.equal(seconds, 72, 'one revolution at 5 deg/s is 72 seconds');
});

test('CRUISE actually has sky in frame, so the skyline has a horizon', () => {
  // The top of frame is (half the vertical FOV) above the view centre. With the
  // centre at CRUISE.pitchDeg, the top must clear horizontal or there is no sky
  // in shot — which is exactly why -35 could not show a skyline.
  const halfFovDeg = 30;
  const topOfFrameDeg = CRUISE.pitchDeg + halfFovDeg;
  assert.ok(topOfFrameDeg > 0, `top of frame is ${topOfFrameDeg} deg — still below horizontal`);
  // ...but not so shallow that the board falls out of the bottom of the frame.
  assert.ok(CRUISE.pitchDeg <= -20, 'too shallow and most pulses leave the screen');
});

// ---------------------------------------------------------------------------
// Drive Mode's chase camera
// ---------------------------------------------------------------------------

test('the chase camera clears the Oakhurst canopy', () => {
  // 38 m at -22 was the first cut. The geometry was right and the
  // neighbourhood was wrong: Oakhurst's oaks top out around 25-30 m, and a
  // shallow camera at that height spends a residential block looking through
  // them. A headed run's gold frame was tree tops.
  assert.ok(DRIVE_CHASE.heightM >= 45, `${DRIVE_CHASE.heightM} m is back in the canopy`);
  // And not so high it stops being a drive and starts being a map.
  assert.ok(DRIVE_CHASE.heightM <= 80, `${DRIVE_CHASE.heightM} m reads as a plan view`);
});

test('the chase camera keeps the "coming up" feel', () => {
  const pitch = Math.abs(DRIVE_CHASE.pitchDeg);
  // Shallow enough that the frame is mostly road ahead with houses arriving
  // into it. HERO looks down at 45 because it is ABOUT a parcel; a drive is
  // about what is coming, and at that angle it would be a plan view.
  assert.ok(pitch < Math.abs(HERO.pitchDeg), 'a drive must be shallower than HERO');
  assert.ok(pitch <= 40, `${pitch} degrees is looking at the block you are on`);
  // Steep enough to look OVER a canopy rather than into one.
  assert.ok(pitch >= 28, `${pitch} degrees looks through the trees, not over them`);
});

test('the chase pose sits back along the travel bearing, not over the fix', () => {
  // That set-back is what makes it a chase camera: the tracked position stays
  // ahead in frame instead of directly underneath.
  const position = { lat: 33.7582, lng: -84.3074 };
  const shot = driveChaseShot(position, 90);
  assert.equal(shot.name, 'DRIVE');
  assert.equal(shot.heightM, DRIVE_CHASE.heightM);
  assert.equal(shot.pitchDeg, DRIVE_CHASE.pitchDeg);
  assert.equal(shot.headingDeg, 90);
  // Heading east means the camera is to the WEST of the position.
  assert.ok(shot.lng < position.lng, 'the camera should be behind, not on top');
  assert.ok(Math.abs(shot.lat - position.lat) < 1e-6, 'and squarely behind');
  const back = metresBetween(position, shot);
  assert.ok(Math.abs(back - DRIVE_CHASE.behindM) < 1, `set back ${back.toFixed(1)} m`);
  // Altitude is measured from the ground under the ROAD, not under the camera.
  assert.equal(shot.groundAnchor.lat, position.lat);
  assert.equal(shot.groundAnchor.lng, position.lng);
});

test('a look offset turns the lens without moving the camera', () => {
  // "Look left" is a glance out of the side window, not the drive changing
  // course — so the position is identical and only the heading moves.
  const position = { lat: 33.7582, lng: -84.3074 };
  const ahead = driveChaseShot(position, 90);
  const left = driveChaseShot(position, 90, { lookOffsetDeg: DRIVE_CHASE.lookLeftDeg });
  assert.equal(left.lat, ahead.lat);
  assert.equal(left.lng, ahead.lng);
  assert.notEqual(left.headingDeg, ahead.headingDeg);
  assert.ok(left.headingDeg >= 0 && left.headingDeg < 360, 'a look must stay a bearing');

  // Left and right are opposite hands.
  const right = driveChaseShot(position, 90, { lookOffsetDeg: DRIVE_CHASE.lookRightDeg });
  assert.ok(DRIVE_CHASE.lookLeftDeg < 0 && DRIVE_CHASE.lookRightDeg > 0);
  assert.notEqual(left.headingDeg, right.headingDeg);

  // Overhead steepens the pitch and never looks past straight down.
  const overhead = driveChaseShot(position, 90, { pitchDeg: DRIVE_CHASE.overheadPitchDeg });
  assert.ok(overhead.pitchDeg < DRIVE_CHASE.pitchDeg);
  assert.ok(overhead.pitchDeg > -90);
});

test('the chase pose wraps its heading rather than emitting 400 degrees', () => {
  const position = { lat: 33.7582, lng: -84.3074 };
  for (const heading of [0, 350, 359.9]) {
    const shot = driveChaseShot(position, heading, { lookOffsetDeg: DRIVE_CHASE.lookRightDeg });
    assert.ok(shot.headingDeg >= 0 && shot.headingDeg < 360, `heading ${shot.headingDeg}`);
  }
});

