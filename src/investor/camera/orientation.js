/**
 * Which way round is this house?
 *
 * "Show me the back" is a question about the *building*, not about the compass,
 * and a footprint on its own cannot answer it. Two things are needed: which
 * edge is the front, and what camera heading looks at a given side.
 *
 * **The front is the edge facing the street.** `scripts/fetch-streets.mjs`
 * stores, per row, the compass bearing from the footprint centroid to the
 * nearest point on the nearest residential way. This module turns that bearing
 * into the footprint edge that actually faces it, and returns that edge's
 * outward normal — the direction you would be standing if you were looking at
 * the front door.
 *
 * **Without a street it falls back to the long axis.** A detached house
 * presents its long wall to the street, so the front normal is perpendicular to
 * the footprint's long axis. That convention is right more often than not and
 * openly a guess: the two perpendiculars are 180 degrees apart and nothing in
 * the geometry says which one is the garden, so the fallback picks one
 * deterministically rather than pretending to know.
 *
 * Pure geometry — no Cesium, no viewer, no data imports beyond the local
 * tangent-plane helpers. Everything here is a function of (ring, bearing).
 */

import { footprintCentroid, orientedBoundingBox, toLocal } from '../mock/parcel.js';

const DEG = Math.PI / 180;

/** The four sides of a house, named the way a person names them. */
export const SIDES = Object.freeze(['front', 'back', 'left', 'right']);

/** Compass words to bearings. */
export const COMPASS = Object.freeze({
  north: 0,
  northeast: 45,
  east: 90,
  southeast: 135,
  south: 180,
  southwest: 225,
  west: 270,
  northwest: 315,
});

/**
 * How far an edge's outward normal may sit from the street bearing and still be
 * considered a candidate for "the front".
 *
 * Past 75 degrees an edge is a side wall, not a frontage, however close to the
 * road its midpoint happens to fall — which is what keeps a corner lot's long
 * flank from being read as the front just because the street wraps around it.
 */
const FRONT_NORMAL_TOLERANCE_DEG = 75;

/** Normalise any angle into [0, 360). */
export function normalizeDeg(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return ((n % 360) + 360) % 360;
}

/** Smallest absolute angle between two bearings, 0..180. */
export function angleBetweenDeg(a, b) {
  const diff = Math.abs(normalizeDeg(a) - normalizeDeg(b));
  return diff > 180 ? 360 - diff : diff;
}

/** Bearing of a local [east, north] vector. */
function bearingOf([east, north]) {
  return normalizeDeg(Math.atan2(east, north) / DEG);
}

/**
 * Compass bearing of the footprint's long axis.
 *
 * @returns {number|null} 0..180 — an axis has no direction, only an
 *   orientation, so 10 degrees and 190 degrees are the same axis.
 */
export function longAxisBearingDeg(ring) {
  const centroid = footprintCentroid(ring);
  if (!centroid) return null;
  const local = (ring || []).map((point) => toLocal(point, centroid));
  const box = orientedBoundingBox(local);
  if (!box) return null;
  return normalizeDeg(bearingOf(box.u)) % 180;
}

/**
 * The outward normal of every edge of a footprint, with its midpoint.
 *
 * Outward is decided against the centroid: of the two perpendiculars to an
 * edge, the outward one is the one pointing away from the middle of the
 * building. That works for any simple polygon, concave ones included, which
 * matters because an L-shaped house is a perfectly ordinary house.
 */
function edgesOf(ring) {
  const centroid = footprintCentroid(ring);
  if (!centroid) return [];
  const local = (ring || []).map((point) => toLocal(point, centroid));
  if (local.length < 3) return [];

  const edges = [];
  for (let i = 0; i < local.length; i += 1) {
    const a = local[i];
    const b = local[(i + 1) % local.length];
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const length = Math.hypot(dx, dy);
    if (length < 1e-6) continue;
    const midpoint = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    // Both perpendiculars; keep the one pointing away from the centroid, which
    // sits at the origin of this local frame.
    let normal = [dy / length, -dx / length];
    if (normal[0] * midpoint[0] + normal[1] * midpoint[1] < 0) {
      normal = [-normal[0], -normal[1]];
    }
    edges.push({ midpoint, normal, length, normalDeg: bearingOf(normal) });
  }
  return edges;
}

/**
 * The direction the front of this house faces.
 *
 * @param {Array<Array<number>>} ring outer [lon,lat] footprint ring
 * @param {number|null} streetBearingDeg bearing from the centroid to the
 *   nearest street, from `geometry.street.bearingDeg`
 * @returns {{bearingDeg:number, source:'street'|'long-axis'}|null}
 */
export function frontNormalDeg(ring, streetBearingDeg = null) {
  const edges = edgesOf(ring);
  if (!edges.length) return null;

  if (Number.isFinite(streetBearingDeg)) {
    const street = normalizeDeg(streetBearingDeg);
    const toStreet = [Math.sin(street * DEG), Math.cos(street * DEG)];
    const facing = edges.filter(
      (edge) => angleBetweenDeg(edge.normalDeg, street) <= FRONT_NORMAL_TOLERANCE_DEG,
    );
    if (facing.length) {
      // Of the edges that face the street, the front is the one nearest it —
      // measured as how far its midpoint projects along the street direction.
      // A longer wall breaks a tie, because a frontage is the long side of a
      // house and a porch return is not.
      let best = null;
      for (const edge of facing) {
        const reach = edge.midpoint[0] * toStreet[0] + edge.midpoint[1] * toStreet[1];
        if (!best || reach > best.reach + 0.25
          || (Math.abs(reach - best.reach) <= 0.25 && edge.length > best.edge.length)) {
          best = { reach, edge };
        }
      }
      return { bearingDeg: best.edge.normalDeg, source: 'street' };
    }
  }

  // No street, or nothing faces it: the long-wall convention.
  const axis = longAxisBearingDeg(ring);
  if (axis === null) return null;
  return { bearingDeg: normalizeDeg(axis + 90), source: 'long-axis' };
}

/**
 * Outward direction of one named side, given where the front faces.
 *
 * Left and right are the viewer's, standing in the street looking at the front —
 * which is the only reading a person means by "the left side of the house".
 * Facing the front means looking along `front + 180`; your left hand points 90
 * degrees anticlockwise of that, which is `front + 90`.
 */
export function sideNormalDeg(side, frontBearingDeg) {
  const front = normalizeDeg(frontBearingDeg);
  switch (side) {
    case 'front': return front;
    case 'back': return normalizeDeg(front + 180);
    case 'left': return normalizeDeg(front + 90);
    case 'right': return normalizeDeg(front - 90);
    default: return front;
  }
}

/**
 * Camera heading that looks AT a side.
 *
 * A shot's heading is the direction the camera looks, and `cameraFromRange`
 * puts the camera the opposite way from its target — so to see the wall whose
 * outward normal is N, stand out at bearing N from the house and look back
 * along N + 180.
 */
export function headingForSide(side, frontBearingDeg) {
  return normalizeDeg(sideNormalDeg(side, frontBearingDeg) + 180);
}

/** Camera heading for "from the north" and friends: stand there, look back. */
export function headingForCompass(compass) {
  const bearing = COMPASS[String(compass || '').toLowerCase()];
  return Number.isFinite(bearing) ? normalizeDeg(bearing + 180) : null;
}

// ---------------------------------------------------------------------------
// Range and pitch steps
// ---------------------------------------------------------------------------

/** Closest the camera may get to a house, in metres of slant range. */
export const MIN_RANGE_M = 60;
/** Furthest "farther" will take you before it stops being a house shot. */
export const MAX_RANGE_M = 900;
/** One "closer" or "farther" is a definite move, not a nudge. */
export const RANGE_STEP = 0.6;

/** Shallowest depression. Below this the camera is looking at rooftops edge-on. */
export const MIN_PITCH_DEG = 12;
/** Steepest. 90 would be straight down, which reads as a site plan, not a house. */
export const MAX_PITCH_DEG = 78;
/** One "higher" or "lower". */
export const PITCH_STEP_DEG = 14;

export function clampRangeM(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return MIN_RANGE_M;
  return Math.min(MAX_RANGE_M, Math.max(MIN_RANGE_M, n));
}

export function clampPitchDeg(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return MIN_PITCH_DEG;
  return Math.min(MAX_PITCH_DEG, Math.max(MIN_PITCH_DEG, n));
}

/** "closer" divides the range, "farther" multiplies it. Both clamp. */
export function stepRangeM(currentM, direction) {
  const current = clampRangeM(currentM);
  if (direction === 'closer') return clampRangeM(current * RANGE_STEP);
  if (direction === 'farther') return clampRangeM(current / RANGE_STEP);
  return current;
}

/**
 * "higher" climbs, which means a STEEPER depression onto the house.
 *
 * Pitch is carried through this module as a positive depression angle, the way
 * `shots.js` writes `HERO.pitchDeg`, so higher is a larger number. The sign is
 * put back on at the point the shot is built.
 */
export function stepPitchDeg(currentDeg, direction) {
  const current = clampPitchDeg(currentDeg);
  if (direction === 'higher') return clampPitchDeg(current + PITCH_STEP_DEG);
  if (direction === 'lower') return clampPitchDeg(current - PITCH_STEP_DEG);
  return current;
}
