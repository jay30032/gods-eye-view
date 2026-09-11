/**
 * The investor camera, as a named shot list.
 *
 * Every number a camera move depends on lives here and nowhere else. The module
 * is pure geometry — no Cesium, no viewer — so the whole shot list is unit
 * testable and a designer can retune the demo by editing constants.
 *
 * The important modelling choice: a shot is defined by the **aim point** (what
 * the audience is looking at) plus heading, pitch and either altitude or range.
 * The camera position is derived from that. `Cesium.camera.flyTo({destination})`
 * takes the *camera* position, so "centred on Kirkwood" naively written as a
 * destination actually puts Kirkwood behind the camera at any pitch other than
 * straight down. Deriving position from aim is what makes the framing mean what
 * it says.
 */

const M_PER_DEG_LAT = 111_320;
const DEG = Math.PI / 180;

export const SHOTS = Object.freeze([
  'WORLD', 'STAGING', 'CRUISE', 'REVEAL', 'HERO', 'HOP', 'DRIVE',
]);

/** Seconds per transition. Nothing in the product picks its own duration. */
export const DURATIONS = Object.freeze({
  worldToStaging: 3.5,
  stagingToCruise: 3.0,
  cruiseToReveal: 2.5,
  toHero: 2.0,
  hop: 2.5,
  heroToCruise: 2.0,
  toDrive: 2.0,
  /** Let REVEAL breathe before dropping to HERO — otherwise it is never seen. */
  revealDwell: 0.8,
});

/** Parked globe: the view the app opens on. */
export const WORLD = Object.freeze({
  heightM: 18_000_000,
  headingDeg: 0,
  pitchDeg: -90,
});

/**
 * Straight down over the metro at 40 km. This shot exists to be *boring*: it
 * gives Google's 3D tiles for the whole market a few seconds to stream in at a
 * coarse LOD before the descent, which is what stops tiles popping in mid-flight.
 */
export const STAGING = Object.freeze({
  altitudeM: 40_000,
  headingDeg: 0,
  pitchDeg: -90,
});

/**
 * The market view after the descent.
 *
 * Heading 264 is the bearing from this aim point to downtown Atlanta
 * (33.7550, -84.3900), so the skyline sits on the horizon. `shots.test.mjs`
 * recomputes that bearing and fails if the constant drifts away from it.
 */
export const CRUISE = Object.freeze({
  // Midway between Decatur Square and Kirkwood — the dense side of the board.
  // The 30-property centroid is (33.7625, -84.3274), so this frames the cluster.
  aim: Object.freeze({ lat: 33.7640, lng: -84.3110 }),
  altitudeM: 1_800,
  headingDeg: 264,
  // -25 puts the horizon — and the downtown skyline on it — in the top strip
  // of the frame. At -35 the top of frame sat 5 degrees BELOW horizontal, so
  // there was no sky in shot at all and nothing for a skyline to sit on.
  pitchDeg: -25,
});

/** Fit the shortlist, with room around it. */
export const REVEAL = Object.freeze({
  paddingPct: 0.25,
  pitchDeg: -45,
  headingDeg: 264,
  minAltitudeM: 900,
  maxAltitudeM: 2_500,
});

/**
 * The focused house.
 *
 * These three requirements are over-determined: at range 180 with the camera
 * looking down 38 degrees, the house lands dead centre. Putting it in the lower
 * third means the lens has to tilt UP off the house by the angle that a sixth
 * of the frame subtends — 10 degrees at a 60 degree vertical FOV.
 *
 * So `pitchDeg` is the **geometric depression to the house**, which is what
 * sets the camera position and keeps the range exactly 180. The camera's
 * rendered pitch is that plus the framing tilt: -38 + 10 = **-28**.
 */
export const HERO = Object.freeze({
  rangeM: 180,
  /** Depression from camera to house — sets position, not the rendered pitch. */
  pitchDeg: -38,
  headingDeg: 35,
  /** Fraction of frame height the subject sits below centre (lower third). */
  lowerThirdFraction: 1 / 6,
  orbitDegPerSec: 2,
  /** One revolution, then stop: a parked demo must not hold the GPU forever. */
  orbitMaxDeg: 360,
});

/** Between two houses: up and over, so it reads as a hop rather than a slide. */
export const HOP = Object.freeze({
  minApexAltitudeM: 500,
  apexPitchDeg: -60,
});

/** Chase camera for the simulated drive. */
export const DRIVE = Object.freeze({
  behindM: 120,
  aboveM: 90,
  pitchDeg: -25,
});

export function clamp(value, min, max) {
  return Math.min(max, Math.max(min, Number(value) || 0));
}

export function metresPerDegreeLng(lat) {
  return M_PER_DEG_LAT * Math.cos((Number(lat) || 0) * DEG);
}

/** Move a lat/lng by a ground distance along a compass heading. */
export function offsetByHeading({ lat, lng }, headingDeg, distanceM) {
  const heading = (Number(headingDeg) || 0) * DEG;
  const north = Math.cos(heading) * distanceM;
  const east = Math.sin(heading) * distanceM;
  return {
    lat: lat + north / M_PER_DEG_LAT,
    lng: lng + east / metresPerDegreeLng(lat),
  };
}

/**
 * Camera position for an aim point. At pitch p the camera sits
 * `altitude / tan(|p|)` metres *back* along the heading — that horizontal
 * set-back is exactly what a naive `destination: aim` gets wrong.
 */
export function cameraFromAim(aim, { headingDeg, pitchDeg, altitudeM }) {
  const pitch = Math.abs(Number(pitchDeg) || 90);
  const setBack = pitch >= 89.5 ? 0 : altitudeM / Math.tan(pitch * DEG);
  const position = offsetByHeading(aim, headingDeg + 180, setBack);
  return {
    lat: position.lat,
    lng: position.lng,
    heightM: altitudeM,
    headingDeg,
    pitchDeg: -pitch,
  };
}

export function worldShot(market) {
  return {
    name: 'WORLD',
    lat: market.globeLat,
    lng: market.globeLng,
    heightM: WORLD.heightM,
    headingDeg: WORLD.headingDeg,
    pitchDeg: WORLD.pitchDeg,
  };
}

export function stagingShot(market) {
  return {
    name: 'STAGING',
    ...cameraFromAim({ lat: market.lat, lng: market.lng }, {
      headingDeg: STAGING.headingDeg,
      pitchDeg: STAGING.pitchDeg,
      altitudeM: STAGING.altitudeM,
    }),
  };
}

export function cruiseShot() {
  return {
    name: 'CRUISE',
    ...cameraFromAim(CRUISE.aim, {
      headingDeg: CRUISE.headingDeg,
      pitchDeg: CRUISE.pitchDeg,
      altitudeM: CRUISE.altitudeM,
    }),
  };
}

/** Lat/lng bounding box of some points, or null. */
export function boundsOf(points) {
  const rows = (points || []).filter((p) => Number.isFinite(p?.lat) && Number.isFinite(p?.lng));
  if (!rows.length) return null;
  return {
    south: Math.min(...rows.map((p) => p.lat)),
    north: Math.max(...rows.map((p) => p.lat)),
    west: Math.min(...rows.map((p) => p.lng)),
    east: Math.max(...rows.map((p) => p.lng)),
  };
}

/** Widen a box by a fraction of its own span, with a floor so a single point still frames. */
export function padBounds(bounds, pct = REVEAL.paddingPct, minSpanM = 400) {
  const latSpan = Math.max(bounds.north - bounds.south, minSpanM / M_PER_DEG_LAT);
  const centreLat = (bounds.north + bounds.south) / 2;
  const lngSpan = Math.max(bounds.east - bounds.west, minSpanM / metresPerDegreeLng(centreLat));
  const padLat = latSpan * pct;
  const padLng = lngSpan * pct;
  return {
    south: centreLat - latSpan / 2 - padLat,
    north: centreLat + latSpan / 2 + padLat,
    west: (bounds.east + bounds.west) / 2 - lngSpan / 2 - padLng,
    east: (bounds.east + bounds.west) / 2 + lngSpan / 2 + padLng,
  };
}

/**
 * Altitude that fits a ground span in frame, before clamping.
 * @param {number} spanM the larger ground dimension to fit
 * @param {number} fovRad vertical field of view
 */
export function altitudeToFit(spanM, fovRad = 60 * DEG) {
  return (spanM / 2) / Math.tan(fovRad / 2);
}

/** Frame the shortlist: bbox + padding, pitch -45, altitude clamped. */
export function revealShot(points, { fovRad = 60 * DEG } = {}) {
  const raw = boundsOf(points);
  if (!raw) return cruiseShot();
  const box = padBounds(raw);
  const centre = {
    lat: (box.north + box.south) / 2,
    lng: (box.east + box.west) / 2,
  };
  const spanM = Math.max(
    (box.north - box.south) * M_PER_DEG_LAT,
    (box.east - box.west) * metresPerDegreeLng(centre.lat),
  );
  const altitudeM = clamp(altitudeToFit(spanM, fovRad), REVEAL.minAltitudeM, REVEAL.maxAltitudeM);
  return {
    name: 'REVEAL',
    ...cameraFromAim(centre, {
      headingDeg: REVEAL.headingDeg,
      pitchDeg: REVEAL.pitchDeg,
      altitudeM,
    }),
  };
}

/**
 * Camera pose at a fixed slant range and depression from a target. Unlike
 * `cameraFromAim` this pins the distance to the subject, which is what "range
 * 180 m from the house" asks for.
 */
export function cameraFromRange(target, { headingDeg, pitchDeg, rangeM }) {
  const pitch = Math.abs(Number(pitchDeg) || 0);
  const altitudeM = rangeM * Math.sin(pitch * DEG);
  const setBack = rangeM * Math.cos(pitch * DEG);
  const position = offsetByHeading(target, headingDeg + 180, setBack);
  return {
    lat: position.lat,
    lng: position.lng,
    heightM: altitudeM,
    headingDeg,
    pitchDeg: -pitch,
  };
}

/**
 * Degrees to tilt the lens up so the subject falls `fraction` of the frame
 * below centre. A sixth of a 60 degree frame is 10 degrees.
 */
export function lowerThirdTiltDeg(fovRad = 60 * DEG, fraction = HERO.lowerThirdFraction) {
  return (fovRad / DEG) * fraction;
}

/** The focused house: 180 m out, framed low, never looking up at the sky. */
export function heroShot(property, { headingDeg = HERO.headingDeg, fovRad = 60 * DEG } = {}) {
  const pose = cameraFromRange({ lat: property.lat, lng: property.lng }, {
    headingDeg,
    pitchDeg: HERO.pitchDeg,
    rangeM: HERO.rangeM,
  });
  // Tilt up off the subject to drop it down the frame, but never past level.
  const tilt = lowerThirdTiltDeg(fovRad);
  const framed = Math.min(-1, pose.pitchDeg + tilt);
  return { name: 'HERO', ...pose, pitchDeg: framed };
}

/** The apex of a hop: above the midpoint, high enough to read as a rise. */
export function hopApexShot(from, to, currentHeightM = 0) {
  const midpoint = {
    lat: (from.lat + to.lat) / 2,
    lng: (from.lng + to.lng) / 2,
  };
  const altitudeM = Math.max(Number(currentHeightM) || 0, HOP.minApexAltitudeM);
  return {
    name: 'HOP',
    ...cameraFromAim(midpoint, {
      headingDeg: HERO.headingDeg,
      pitchDeg: HOP.apexPitchDeg,
      altitudeM,
    }),
  };
}

/** Chase the route: behind and above, looking along the heading of travel. */
export function driveShot(property, routeHeadingDeg = HERO.headingDeg) {
  const position = offsetByHeading(
    { lat: property.lat, lng: property.lng },
    routeHeadingDeg + 180,
    DRIVE.behindM,
  );
  return {
    name: 'DRIVE',
    lat: position.lat,
    lng: position.lng,
    heightM: DRIVE.aboveM,
    headingDeg: routeHeadingDeg,
    pitchDeg: DRIVE.pitchDeg,
  };
}

/**
 * What the WORLD button does next.
 *
 * From anywhere in the market it brings you back to the market view — the
 * common case, and the one that used to throw the user out to space. Pressing
 * it again *from* the market is an explicit "all the way out".
 */
export function worldToggleTarget(currentShot) {
  return currentShot === 'CRUISE' ? 'WORLD' : 'CRUISE';
}

/** Compass heading from one point to another, 0-360. */
export function headingBetween(from, to) {
  const lat1 = from.lat * DEG;
  const lat2 = to.lat * DEG;
  const dLng = (to.lng - from.lng) * DEG;
  const y = Math.sin(dLng) * Math.cos(lat2);
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLng);
  return ((Math.atan2(y, x) / DEG) + 360) % 360;
}

/** Seconds for a transition, by the shot being left and the shot being entered. */
export function durationFor(fromName, toName) {
  if (toName === 'STAGING') return DURATIONS.worldToStaging;
  if (toName === 'CRUISE') {
    if (fromName === 'STAGING') return DURATIONS.stagingToCruise;
    if (fromName === 'HERO' || fromName === 'REVEAL') return DURATIONS.heroToCruise;
    return DURATIONS.stagingToCruise;
  }
  if (toName === 'REVEAL') return DURATIONS.cruiseToReveal;
  if (toName === 'HERO') return DURATIONS.toHero;
  if (toName === 'HOP') return DURATIONS.hop;
  if (toName === 'DRIVE') return DURATIONS.toDrive;
  return DURATIONS.toHero;
}
