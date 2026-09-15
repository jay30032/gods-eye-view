/**
 * The route, as geometry: a spline through it, distances along it, and where
 * anything else sits relative to it.
 *
 * `mock/sixRoute.js` is 38 vertices of road, which is the right amount of data
 * and the wrong amount of smoothness — driven straight, the camera would change
 * heading in a step at every junction node. So the polyline is resampled
 * through a **Catmull-Rom** spline, which passes exactly through every vertex
 * (unlike a B-spline, which would cut the corners and put the camera in a
 * garden) while giving a continuous tangent to steer by.
 *
 * Everything here works in a **local east/north metre frame** anchored at the
 * route's first vertex. At neighbourhood scale that is indistinguishable from
 * doing it properly on the ellipsoid, and it means distances, projections and
 * bearings are all ordinary plane geometry rather than great-circle work.
 *
 * Pure: no Cesium, no clock, no state. The camera, the activation rules and
 * both position sources all read from this and none of them re-derive it.
 */

import { metresPerDegreeLng } from '../mock/parcel.js';

const M_PER_DEG_LAT = 111_320;
const DEG = Math.PI / 180;

/** Spacing of the resampled spline. Fine enough that a bend reads as a curve. */
export const SPLINE_SPACING_M = 4;

/** Convert a [lon,lat] to local [east,north] metres about an origin. */
export function toLocal(point, origin) {
  const mLng = metresPerDegreeLng(origin.lat);
  return [(point[0] - origin.lng) * mLng, (point[1] - origin.lat) * M_PER_DEG_LAT];
}

/** Inverse of {@link toLocal}, back to {lat, lng}. */
export function toGeo(point, origin) {
  const mLng = metresPerDegreeLng(origin.lat);
  return {
    lng: origin.lng + point[0] / mLng,
    lat: origin.lat + point[1] / M_PER_DEG_LAT,
  };
}

/** Normalise any angle into [0, 360). */
export function normalizeDeg(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return ((n % 360) + 360) % 360;
}

/** Signed smallest turn from `from` to `to`, in [-180, 180]. */
export function deltaDeg(from, to) {
  let delta = normalizeDeg(to) - normalizeDeg(from);
  if (delta > 180) delta -= 360;
  if (delta < -180) delta += 360;
  return delta;
}

/** Compass bearing of a local [east, north] vector. */
export function bearingOf([east, north]) {
  return normalizeDeg(Math.atan2(east, north) / DEG);
}

/**
 * One Catmull-Rom segment, centripetal enough for our purposes.
 *
 * The uniform form is used rather than the centripetal parameterisation: road
 * vertices are already roughly evenly spaced after the fetcher's 1 m simplify,
 * which is the condition under which uniform Catmull-Rom behaves, and the
 * resampler below re-spaces the output by arc length anyway.
 */
export function catmullRom(p0, p1, p2, p3, t) {
  const t2 = t * t;
  const t3 = t2 * t;
  const at = (a, b, c, d) => 0.5 * (
    2 * b
    + (c - a) * t
    + (2 * a - 5 * b + 4 * c - d) * t2
    + (3 * b - 3 * c + d - a) * t3
  );
  return [at(p0[0], p1[0], p2[0], p3[0]), at(p0[1], p1[1], p2[1], p3[1])];
}

/**
 * Resample a closed polyline into a dense, evenly spaced spline.
 *
 * Closed is the operative word: the control points wrap, so the loop's join is
 * as smooth as every other bend rather than a corner the camera snaps around
 * on the last metre of the drive.
 *
 * @param {Array<Array<number>>} local closed ring in local metres
 * @param {number} spacingM target spacing of the output
 * @returns {Array<Array<number>>} densified ring, first point repeated at the end
 */
export function resampleClosed(local, spacingM = SPLINE_SPACING_M) {
  const points = local.slice();
  // A route whose last vertex duplicates its first is already closed; the wrap
  // below supplies the closing segment, so drop the duplicate or the spline
  // stalls on a zero-length span.
  if (points.length > 1) {
    const [fx, fy] = points[0];
    const [lx, ly] = points[points.length - 1];
    if (Math.hypot(fx - lx, fy - ly) < 0.5) points.pop();
  }
  const n = points.length;
  if (n < 3) return points.slice();

  const at = (i) => points[((i % n) + n) % n];
  const dense = [];
  for (let i = 0; i < n; i += 1) {
    const p0 = at(i - 1);
    const p1 = at(i);
    const p2 = at(i + 1);
    const p3 = at(i + 2);
    const span = Math.hypot(p2[0] - p1[0], p2[1] - p1[1]);
    const steps = Math.max(1, Math.ceil(span / spacingM));
    for (let s = 0; s < steps; s += 1) {
      dense.push(catmullRom(p0, p1, p2, p3, s / steps));
    }
  }
  dense.push(dense[0].slice()); // close it
  return dense;
}

/**
 * Everything the drive needs to know about the road, precomputed once.
 *
 * @param {Array<Array<number>>} coordinates [lon,lat] vertices from sixRoute.js
 * @returns {{origin:object, points:Array, cumulative:Array<number>,
 *   lengthM:number, bearings:Array<number>}}
 */
export function buildRoute(coordinates, { spacingM = SPLINE_SPACING_M } = {}) {
  const rows = (coordinates || []).filter(
    (c) => Array.isArray(c) && Number.isFinite(c[0]) && Number.isFinite(c[1]),
  );
  if (rows.length < 3) {
    return { origin: null, points: [], cumulative: [], lengthM: 0, bearings: [] };
  }
  const origin = { lng: rows[0][0], lat: rows[0][1] };
  const points = resampleClosed(rows.map((c) => toLocal(c, origin)), spacingM);

  const cumulative = [0];
  for (let i = 1; i < points.length; i += 1) {
    const dx = points[i][0] - points[i - 1][0];
    const dy = points[i][1] - points[i - 1][1];
    cumulative.push(cumulative[i - 1] + Math.hypot(dx, dy));
  }

  // Tangent bearing at each sample, from the segment it starts.
  const bearings = points.map((_, i) => {
    const a = points[Math.max(0, i - 1)];
    const b = points[Math.min(points.length - 1, i + 1)];
    return bearingOf([b[0] - a[0], b[1] - a[1]]);
  });

  return { origin, points, cumulative, lengthM: cumulative[cumulative.length - 1], bearings };
}

/** Wrap a distance into [0, lengthM) — the route is a loop. */
export function wrapDistance(distanceM, lengthM) {
  if (!(lengthM > 0)) return 0;
  const d = Number(distanceM);
  if (!Number.isFinite(d)) return 0;
  return ((d % lengthM) + lengthM) % lengthM;
}

/** Index of the last sample at or before `distanceM`. Binary search. */
function indexAt(cumulative, distanceM) {
  let low = 0;
  let high = cumulative.length - 1;
  while (low < high) {
    const mid = (low + high + 1) >> 1;
    if (cumulative[mid] <= distanceM) low = mid;
    else high = mid - 1;
  }
  return low;
}

/**
 * Where the route is at a distance along it, and which way it is heading.
 *
 * @returns {{lat:number, lng:number, bearingDeg:number, local:Array<number>}|null}
 */
export function pointAt(route, distanceM) {
  if (!route?.points?.length) return null;
  const d = wrapDistance(distanceM, route.lengthM);
  const i = indexAt(route.cumulative, d);
  const j = Math.min(i + 1, route.points.length - 1);
  const span = route.cumulative[j] - route.cumulative[i];
  const t = span > 1e-9 ? (d - route.cumulative[i]) / span : 0;
  const local = [
    route.points[i][0] + (route.points[j][0] - route.points[i][0]) * t,
    route.points[i][1] + (route.points[j][1] - route.points[i][1]) * t,
  ];
  const bearingDeg = i === j
    ? route.bearings[i]
    : bearingOf([route.points[j][0] - route.points[i][0], route.points[j][1] - route.points[i][1]]);
  return { ...toGeo(local, route.origin), bearingDeg, local };
}

/**
 * Project a point onto the route.
 *
 * @returns {{alongM:number, offsetM:number, side:'left'|'right'|'on',
 *   bearingDeg:number}|null} `offsetM` is the perpendicular distance and `side`
 *   is which hand it falls on for someone travelling in the route's direction.
 */
export function projectOnto(route, point) {
  if (!route?.points?.length || !Number.isFinite(point?.lat) || !Number.isFinite(point?.lng)) {
    return null;
  }
  const p = toLocal([point.lng, point.lat], route.origin);
  let best = { distance: Infinity, alongM: 0, index: 0, t: 0 };
  for (let i = 0; i + 1 < route.points.length; i += 1) {
    const a = route.points[i];
    const b = route.points[i + 1];
    const abx = b[0] - a[0];
    const aby = b[1] - a[1];
    const lenSq = abx * abx + aby * aby;
    if (lenSq < 1e-12) continue;
    let t = ((p[0] - a[0]) * abx + (p[1] - a[1]) * aby) / lenSq;
    t = Math.max(0, Math.min(1, t));
    const cx = a[0] + abx * t;
    const cy = a[1] + aby * t;
    const distance = Math.hypot(p[0] - cx, p[1] - cy);
    if (distance < best.distance) {
      best = {
        distance,
        alongM: route.cumulative[i] + Math.sqrt(lenSq) * t,
        index: i,
        t,
      };
    }
  }
  if (!Number.isFinite(best.distance)) return null;

  const a = route.points[best.index];
  const b = route.points[best.index + 1];
  const bearingDeg = bearingOf([b[0] - a[0], b[1] - a[1]]);
  return {
    alongM: best.alongM,
    offsetM: best.distance,
    bearingDeg,
    side: sideOf(bearingDeg, a, p),
  };
}

/** Which hand a point falls on, for someone facing `bearingDeg` at `from`. */
function sideOf(bearingDeg, from, point) {
  // Cross product of the travel direction with the vector to the point. In an
  // east/north frame a positive cross means the point is to the LEFT.
  const heading = bearingDeg * DEG;
  const fx = Math.sin(heading);
  const fy = Math.cos(heading);
  const vx = point[0] - from[0];
  const vy = point[1] - from[1];
  const cross = fx * vy - fy * vx;
  if (Math.abs(cross) < 0.5) return 'on';
  return cross > 0 ? 'left' : 'right';
}

/**
 * Which side of the traveller a point is on, right now.
 *
 * Computed from the **travel bearing at that moment**, not from the route's
 * shape — which is the whole point. On a loop the same house is on your left
 * going one way and your right coming back, and a drive that said "on your
 * left" from a stored value would be wrong half the time.
 *
 * @param {{lat:number,lng:number}} from where the traveller is
 * @param {number} bearingDeg which way they are facing
 * @param {{lat:number,lng:number}} target
 * @returns {'left'|'right'|'ahead'}
 */
export function sideFromBearing(from, bearingDeg, target) {
  if (!Number.isFinite(from?.lat) || !Number.isFinite(target?.lat)) return 'ahead';
  const origin = { lat: from.lat, lng: from.lng };
  const p = toLocal([target.lng, target.lat], origin);
  const heading = normalizeDeg(bearingDeg) * DEG;
  const fx = Math.sin(heading);
  const fy = Math.cos(heading);
  const cross = fx * p[1] - fy * p[0];
  const along = fx * p[0] + fy * p[1];
  // Nearly straight ahead is not a side. The threshold is an angle, not a
  // distance, so a house 200 m up the road does not become "on your left"
  // because of two metres of lateral offset.
  const lateral = Math.abs(cross);
  if (lateral < Math.abs(along) * 0.18) return 'ahead';
  return cross > 0 ? 'left' : 'right';
}

/**
 * Signed distance from the traveller to a point on the route, forwards.
 *
 * On a loop "behind" is ambiguous — everything is ahead if you drive far
 * enough. So anything more than half the loop ahead is reported as *behind*
 * instead, which is what a person means and what the activation rules need.
 *
 * @returns {number} positive ahead, negative behind
 */
export function signedAheadM(route, fromAlongM, targetAlongM) {
  const length = route?.lengthM || 0;
  if (!(length > 0)) return 0;
  let delta = wrapDistance(targetAlongM - fromAlongM, length);
  if (delta > length / 2) delta -= length;
  return delta;
}

// ---------------------------------------------------------------------------
// Heading smoothing
// ---------------------------------------------------------------------------

/**
 * Time constant of the heading filter, in seconds.
 *
 * The camera must turn a corner over about a second rather than snapping to the
 * new tangent the instant the spline does. Too small and junctions read as
 * cuts; too large and the camera is still turning half a block after the bend,
 * which looks like drift.
 */
export const HEADING_TAU_S = 0.9;

/**
 * One step of a low-pass filter on a compass heading.
 *
 * Angles cannot be averaged directly — filtering 359 towards 1 the naive way
 * takes the long way round through 180 and spins the camera. So the filter runs
 * on the *shortest signed delta* and the result is re-normalised.
 *
 * The coefficient is derived from elapsed time rather than fixed per frame, so
 * the turn takes the same wall-clock time at 30 fps as at 60 and a dropped
 * frame does not leave the camera behind.
 *
 * @param {number|null} previous last smoothed heading, or null to snap
 * @param {number} target the heading to approach
 * @param {number} dtSeconds time since the last step
 * @returns {number} the new smoothed heading, 0..360
 */
export function smoothHeading(previous, target, dtSeconds, { tauS = HEADING_TAU_S } = {}) {
  if (previous === null || previous === undefined || !Number.isFinite(previous)) {
    return normalizeDeg(target);
  }
  const dt = Number(dtSeconds);
  if (!Number.isFinite(dt) || dt <= 0) return normalizeDeg(previous);
  const tau = Math.max(1e-3, Number(tauS) || HEADING_TAU_S);
  const alpha = 1 - Math.exp(-dt / tau);
  return normalizeDeg(previous + deltaDeg(previous, target) * alpha);
}
