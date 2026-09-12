/**
 * Synthetic parcels from real building footprints.
 *
 * There is no free, redistributable parcel polygon for DeKalb or Fulton, and
 * guessing a lot line from an address is worse than admitting the guess. So the
 * footprint — which *is* real, from OpenStreetMap — is the only surveyed thing
 * here, and the parcel around it is openly synthetic: the footprint's
 * **oriented** bounding box pushed out by typical residential setbacks.
 *
 * Oriented, not axis-aligned. A house at 40 degrees to north gets a north-up
 * bbox a third larger than the house, and the parcel drawn from it reads as a
 * lot belonging to nobody. The min-area rectangle sits square on the walls.
 *
 * Which way the setbacks go is decided by the box itself: a detached house
 * presents its **long** wall to the street, so the long axis runs parallel to
 * the street and the short axis runs front-to-back. Side setbacks (9 m) widen
 * the long axis; front and back setbacks (18 m) deepen the short one.
 *
 * The cap is the important part. Expanding a 12 x 10 m house by those setbacks
 * gives 30 x 46 m — 0.34 acres, a normal Decatur lot. Expanding a 30 m
 * small-multifamily footprint the same way would claim half a block. So the
 * setbacks are scaled down together until the parcel fits 0.35 acres, and the
 * scale can only reach zero: the parcel is never smaller than the box around
 * the house it belongs to.
 *
 * Pure geometry, no Cesium. Everything runs in a local east/north tangent plane
 * in metres around the footprint centroid, which at a building's scale is
 * indistinguishable from doing it properly on the ellipsoid.
 */

const M_PER_DEG_LAT = 111_320;
const DEG = Math.PI / 180;

/** Setback from each side wall to the neighbouring lot line. */
export const PARCEL_SIDE_M = 9;
/** Setback from the front wall to the street and from the back wall to the rear line. */
export const PARCEL_END_M = 18;
export const PARCEL_MAX_ACRES = 0.35;
export const SQ_M_PER_ACRE = 4046.8564224;
export const PARCEL_MAX_AREA_M2 = PARCEL_MAX_ACRES * SQ_M_PER_ACRE;

export function metresPerDegreeLng(lat) {
  return M_PER_DEG_LAT * Math.cos((Number(lat) || 0) * DEG);
}

/** Project [lon,lat] to local [east,north] metres about an origin. */
export function toLocal(point, origin) {
  const mLng = metresPerDegreeLng(origin.lat);
  return [
    (point[0] - origin.lng) * mLng,
    (point[1] - origin.lat) * M_PER_DEG_LAT,
  ];
}

/** Inverse of {@link toLocal}. */
export function toGeo(point, origin) {
  const mLng = metresPerDegreeLng(origin.lat);
  return [
    origin.lng + point[0] / mLng,
    origin.lat + point[1] / M_PER_DEG_LAT,
  ];
}

/** Signed area of a closed or open ring, in the ring's own units. */
export function ringArea(ring) {
  const points = stripClose(ring);
  let sum = 0;
  for (let i = 0; i < points.length; i += 1) {
    const [x1, y1] = points[i];
    const [x2, y2] = points[(i + 1) % points.length];
    sum += x1 * y2 - x2 * y1;
  }
  return sum / 2;
}

function stripClose(ring) {
  const points = (ring || []).filter((p) => Array.isArray(p) && p.length >= 2);
  if (points.length > 1) {
    const first = points[0];
    const last = points[points.length - 1];
    if (first[0] === last[0] && first[1] === last[1]) return points.slice(0, -1);
  }
  return points;
}

/**
 * Area-weighted centroid of a [lon,lat] ring. This is the point every row's
 * coordinate snaps to, so it has to be the centre of the *roof*, not the
 * average of however many vertices the mapper happened to draw — a bay window
 * traced with nine nodes would drag a vertex average into the garden.
 */
export function footprintCentroid(ring) {
  const points = stripClose(ring);
  if (!points.length) return null;
  if (points.length < 3) {
    return { lng: points[0][0], lat: points[0][1] };
  }
  const origin = { lng: points[0][0], lat: points[0][1] };
  const local = points.map((p) => toLocal(p, origin));
  const area = ringArea(local);
  if (Math.abs(area) < 1e-9) {
    const mean = local.reduce((acc, p) => [acc[0] + p[0], acc[1] + p[1]], [0, 0]);
    const [lng, lat] = toGeo([mean[0] / local.length, mean[1] / local.length], origin);
    return { lng, lat };
  }
  let cx = 0;
  let cy = 0;
  for (let i = 0; i < local.length; i += 1) {
    const [x1, y1] = local[i];
    const [x2, y2] = local[(i + 1) % local.length];
    const cross = x1 * y2 - x2 * y1;
    cx += (x1 + x2) * cross;
    cy += (y1 + y2) * cross;
  }
  const [lng, lat] = toGeo([cx / (6 * area), cy / (6 * area)], origin);
  return { lng, lat };
}

/** Monotone-chain convex hull of local [x,y] points, counter-clockwise. */
export function convexHull(points) {
  const sorted = [...points].sort((a, b) => (a[0] - b[0]) || (a[1] - b[1]));
  if (sorted.length < 3) return sorted;
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const build = (list) => {
    const out = [];
    for (const p of list) {
      while (out.length >= 2 && cross(out[out.length - 2], out[out.length - 1], p) <= 0) out.pop();
      out.push(p);
    }
    out.pop();
    return out;
  };
  return [...build(sorted), ...build([...sorted].reverse())];
}

/**
 * Minimum-area rectangle over a set of local points (rotating calipers).
 *
 * @returns {{centre:[number,number], u:[number,number], v:[number,number],
 *   halfLong:number, halfShort:number, areaM2:number}} `u` is the unit vector
 *   along the LONG axis, `v` along the short one.
 */
export function orientedBoundingBox(points) {
  const hull = convexHull(points);
  if (hull.length < 2) return null;
  let best = null;
  for (let i = 0; i < hull.length; i += 1) {
    const a = hull[i];
    const b = hull[(i + 1) % hull.length];
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const length = Math.hypot(dx, dy);
    if (length < 1e-9) continue;
    const ux = dx / length;
    const uy = dy / length;
    let minU = Infinity; let maxU = -Infinity;
    let minV = Infinity; let maxV = -Infinity;
    for (const [x, y] of hull) {
      const pu = x * ux + y * uy;
      const pv = -x * uy + y * ux;
      if (pu < minU) minU = pu;
      if (pu > maxU) maxU = pu;
      if (pv < minV) minV = pv;
      if (pv > maxV) maxV = pv;
    }
    const area = (maxU - minU) * (maxV - minV);
    if (!best || area < best.area) {
      best = { area, ux, uy, minU, maxU, minV, maxV };
    }
  }
  if (!best) return null;
  const { ux, uy, minU, maxU, minV, maxV } = best;
  const midU = (minU + maxU) / 2;
  const midV = (minV + maxV) / 2;
  const centre = [midU * ux - midV * uy, midU * uy + midV * ux];
  const extentU = maxU - minU;
  const extentV = maxV - minV;
  // Name the axes by length, not by which hull edge happened to win.
  const uIsLong = extentU >= extentV;
  const long = uIsLong ? [ux, uy] : [-uy, ux];
  const short = uIsLong ? [-uy, ux] : [ux, uy];
  return {
    centre,
    u: long,
    v: short,
    halfLong: Math.max(extentU, extentV) / 2,
    halfShort: Math.min(extentU, extentV) / 2,
    areaM2: extentU * extentV,
  };
}

/**
 * How far to push the setbacks out before the parcel breaks the acreage cap.
 *
 * Both setbacks scale by the same factor so the lot keeps its proportions, and
 * the factor is clamped into [0, 1] — never negative, so a footprint that is
 * already over the cap gets its own bounding box and not a lot line running
 * through the living room.
 *
 * @returns {number} 0..1
 */
export function setbackScale(longM, shortM, {
  sideM = PARCEL_SIDE_M,
  endM = PARCEL_END_M,
  maxAreaM2 = PARCEL_MAX_AREA_M2,
} = {}) {
  const a = 4 * sideM * endM;
  const b = 2 * endM * longM + 2 * sideM * shortM;
  const c = longM * shortM - maxAreaM2;
  if (c >= 0) return 0;
  if (a <= 0) return b > 0 ? Math.min(1, -c / b) : 1;
  const root = (-b + Math.sqrt(b * b - 4 * a * c)) / (2 * a);
  if (!Number.isFinite(root)) return 0;
  return Math.min(1, Math.max(0, root));
}

/**
 * A synthetic parcel around a real footprint.
 *
 * @param {Array<Array<number>>} ring outer footprint ring as [lon,lat]
 * @returns {{ring:Array<Array<number>>, areaM2:number, areaAcres:number,
 *   centroid:{lat:number,lng:number}, headingDeg:number, setbackScale:number,
 *   source:'synthetic'}|null}
 */
export function parcelFromFootprint(ring, options = {}) {
  const points = stripClose(ring);
  if (points.length < 3) return null;
  const centroid = footprintCentroid(points);
  if (!centroid) return null;
  const local = points.map((p) => toLocal(p, centroid));
  const box = orientedBoundingBox(local);
  if (!box) return null;

  const longM = box.halfLong * 2;
  const shortM = box.halfShort * 2;
  const sideM = Number.isFinite(options.sideM) ? options.sideM : PARCEL_SIDE_M;
  const endM = Number.isFinite(options.endM) ? options.endM : PARCEL_END_M;
  const maxAreaM2 = Number.isFinite(options.maxAreaM2) ? options.maxAreaM2 : PARCEL_MAX_AREA_M2;
  const scale = setbackScale(longM, shortM, { sideM, endM, maxAreaM2 });

  const halfLong = box.halfLong + sideM * scale;
  const halfShort = box.halfShort + endM * scale;
  const corners = [[1, 1], [-1, 1], [-1, -1], [1, -1]].map(([su, sv]) => {
    const x = box.centre[0] + box.u[0] * su * halfLong + box.v[0] * sv * halfShort;
    const y = box.centre[1] + box.u[1] * su * halfLong + box.v[1] * sv * halfShort;
    return toGeo([x, y], centroid);
  });

  const areaM2 = halfLong * 2 * halfShort * 2;
  return {
    ring: corners,
    areaM2,
    areaAcres: areaM2 / SQ_M_PER_ACRE,
    centroid,
    // Compass bearing of the long axis — the street frontage direction.
    headingDeg: ((Math.atan2(box.u[0], box.u[1]) / DEG) + 360) % 360,
    setbackScale: scale,
    source: 'synthetic',
  };
}

/** Great-circle-ish distance in metres between two [lon,lat] points. */
export function distanceM(a, b) {
  const mLng = metresPerDegreeLng((a[1] + b[1]) / 2);
  return Math.hypot((a[0] - b[0]) * mLng, (a[1] - b[1]) * M_PER_DEG_LAT);
}

/**
 * The degrade path: a nominal lot around a bare coordinate.
 *
 * Used only when Overpass found no dwelling for a row. It is deliberately
 * north-aligned and exactly median-sized, because it is *not* a claim about a
 * particular house — it says "somewhere about here" and the effects layer draws
 * it as a soft glow with no building outline and no column. Orienting it to
 * look surveyed would be the lie worth avoiding.
 */
export function nominalParcel(lat, lng, { widthM = 27, depthM = 42 } = {}) {
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  const centroid = { lat, lng };
  const halfW = widthM / 2;
  const halfD = depthM / 2;
  const ring = [[halfW, halfD], [-halfW, halfD], [-halfW, -halfD], [halfW, -halfD]]
    .map((point) => toGeo(point, centroid));
  const areaM2 = widthM * depthM;
  return {
    ring,
    areaM2,
    areaAcres: areaM2 / SQ_M_PER_ACRE,
    centroid,
    headingDeg: 90,
    setbackScale: 0,
    source: 'synthetic',
    approximate: true,
  };
}
