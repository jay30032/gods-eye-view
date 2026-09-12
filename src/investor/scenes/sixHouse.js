/**
 * The six-house scene — the shot the near-field effects were built for.
 *
 * Everything in this module is pure: which rows are in the scene, where the
 * camera sits over them, how wide the cluster is, and which house is gold.
 * `session.js` calls it; it calls nothing back.
 *
 * The one rule worth stating out loud: **nothing here decides the gold house.**
 * `goldPickFor` returns the head of the composite ranking, the same ranking
 * `findMoney` uses, for the same reason Phase 1 deleted the hand-typed
 * TOP-PICK signal — a scene that could paint its own favourite gold would be
 * free to disagree with the underwriting sitting next to it.
 */
import { SIX_HOUSE_PROPERTIES } from '../mock/sixHouse.js';
import { compositeScore } from '../mock/schema.js';

/** Camera altitude above ground for the establishing shot over the cluster. */
export const SIX_CRUISE_ALTITUDE_M = 900;
/** What "about 600 m of each other" is allowed to mean before the scene is wrong. */
export const SIX_CLUSTER_MAX_SPAN_M = 600;
export const SIX_HOUSE_COUNT = 6;

const M_PER_DEG_LAT = 111_320;

function metresPerDegreeLng(lat) {
  return M_PER_DEG_LAT * Math.cos((Number(lat) || 0) * Math.PI / 180);
}

/** Ground distance in metres between two {lat,lng} points. */
export function distanceBetween(a, b) {
  const mLng = metresPerDegreeLng((a.lat + b.lat) / 2);
  return Math.hypot((a.lng - b.lng) * mLng, (a.lat - b.lat) * M_PER_DEG_LAT);
}

/** Which scene the URL asks for. `?scene=six`, and nothing else so far. */
export function readSceneMode(location = globalThis.location) {
  try {
    const value = String(new URLSearchParams(location?.search || '').get('scene') || '')
      .trim()
      .toLowerCase();
    if (value === 'six' || value === '6' || value === 'six-house') return 'six';
  } catch {
    // no window
  }
  return null;
}

export function sixHouseRows() {
  return SIX_HOUSE_PROPERTIES.slice();
}

/** Mean position of the cluster — what the establishing shot aims at. */
export function clusterCentre(rows) {
  const points = (rows || []).filter((r) => Number.isFinite(r?.lat) && Number.isFinite(r?.lng));
  if (!points.length) return null;
  return {
    lat: points.reduce((sum, r) => sum + r.lat, 0) / points.length,
    lng: points.reduce((sum, r) => sum + r.lng, 0) / points.length,
  };
}

/** The widest gap between any two houses in the scene. */
export function clusterSpanM(rows) {
  const points = (rows || []).filter((r) => Number.isFinite(r?.lat) && Number.isFinite(r?.lng));
  let max = 0;
  for (let i = 0; i < points.length; i += 1) {
    for (let j = i + 1; j < points.length; j += 1) {
      max = Math.max(max, distanceBetween(points[i], points[j]));
    }
  }
  return max;
}

/** Every signal type present across the scene. */
export function signalTypesIn(rows) {
  const types = new Set();
  for (const row of rows || []) {
    for (const signal of row?.signals || []) types.add(signal.type);
  }
  return types;
}

/**
 * The gold house: the head of the composite ranking.
 * @returns {object|null} the property, not just its id, so callers can frame it
 */
export function goldPickFor(rows) {
  const ranked = (rows || [])
    .filter(Boolean)
    .map((row) => ({ row, score: compositeScore(row) }))
    .sort((a, b) => b.score - a.score || String(a.row.id).localeCompare(String(b.row.id)));
  return ranked[0]?.row || null;
}

/**
 * The whole scene as one object, so the session does not assemble it by hand.
 * @returns {{rows:Array, centre:object, spanM:number, goldId:string|null,
 *   altitudeM:number, types:Array<string>}}
 */
export function buildSixHouseScene(rows = sixHouseRows()) {
  const gold = goldPickFor(rows);
  return {
    rows,
    centre: clusterCentre(rows),
    spanM: clusterSpanM(rows),
    goldId: gold?.id || null,
    gold,
    altitudeM: SIX_CRUISE_ALTITUDE_M,
    types: [...signalTypesIn(rows)].sort(),
  };
}
