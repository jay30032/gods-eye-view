/**
 * The one ground under every property. The photo world's height source.
 *
 * ## The bug this replaces
 *
 * The far-field markers and the near-field effects each sampled the ground
 * under a house for themselves, with the same code, at different moments. The
 * markers sampled on the first camera move after boot — from space, against
 * whichever coarse Google tile happened to be loaded — and, having got a
 * finite number, never sampled again; only the *market-constant fallback* was
 * ever retried. The effects sampled when the camera dropped below 1,500 m,
 * against refined tiles. Two samples, two LODs, two grounds: the sprite for
 * DEMO-SIX-001 stood at 305.3 m (a 291.3 m coarse sample plus its 14 m rise)
 * while the tiles under it, and the tint, the outline and the lot line drawn
 * on them, sat at 282.7 m. How far apart the two ended up depended on network
 * timing, which is why a machine that streamed tiles slowly saw sprites a long
 * way above their roofs and a fast one saw them nearly right.
 *
 * It was not terrain. The photo world's globe is hidden and its provider is
 * the ellipsoid; `globe.getHeight` returns undefined there. But the old code
 * did consult `globe.getHeight` as a second source, which is the route by
 * which a terrain provider *could* have been double-counted — so that route is
 * closed here too.
 *
 * ## The rule
 *
 * One entry per property, one number in it, and every layer reads that number:
 *
 *   - The **anchor** is the footprint centroid when the row has a footprint,
 *     otherwise the row's coordinate. A sprite, a column, a tint volume and the
 *     screen position the smoke check compares are all this one point.
 *   - The **height** comes from `scene.sampleHeight` at the anchor — the tiles
 *     on screen, whatever world they belong to — with the market's ground
 *     constant as the only fallback. Never the globe's terrain provider.
 *   - A sample has a **quality**: `market` (fallback), `coarse` (taken with the
 *     camera above the near-field ceiling, where the tiles under a house are
 *     an approximation) or `fine` (taken at or below it). A fine sample is
 *     final. A coarse one is taken again, once, when the camera first comes
 *     down into the near field. A market one is retried a bounded number of
 *     times, then once more when the camera is in the near field.
 *   - `refresh()` says which properties changed, so the layers that already
 *     placed geometry on the old number can move it. That is what keeps the
 *     sprite and the effects together regardless of when each was built.
 *
 * The pure rules — quality from altitude, whether an entry needs another
 * sample, the anchor for a row — are exported for the unit tests; the Cesium
 * half takes `Cesium` and the scene as arguments.
 */

import { footprintCentroid } from '../mock/parcel.js';
import { geometryFor } from '../mock/geometry.js';
import { NEAR_FIELD_MAX_HEIGHT_M } from './effects/signalMotion.js';

/**
 * Below this camera height above the market's ground the tiles under a house
 * are refined enough to trust. It is the near-field ceiling on purpose: the
 * outlines and the tint are drawn on exactly those tiles, so a height sampled
 * there is the height they sit at.
 */
export const GROUND_FINE_AGL_M = NEAR_FIELD_MAX_HEIGHT_M;

export const GROUND_QUALITY = Object.freeze({ MARKET: 'market', COARSE: 'coarse', FINE: 'fine' });
const RANK = Object.freeze({ market: 0, coarse: 1, fine: 2 });

/** Retries for a row with no geometry under it yet. Bounded, or a keyless boot samples forever. */
export const GROUND_MARKET_ATTEMPTS = 8;
/** `refresh()` samples at most this often; camera.changed fires every frame of a flight. */
export const GROUND_SAMPLE_INTERVAL_MS = 400;
/** A height that moved less than this is the same height. */
export const GROUND_CHANGE_M = 0.25;

/** A number, or null. Absence is never zero — zero is sea level here. */
function finiteOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * The quality a sample taken now would have, from the camera's height above
 * the market's ground. An unknown height is coarse: it must never promote a
 * sample to final.
 */
export function qualityForAgl(cameraAglM) {
  const agl = finiteOrNull(cameraAglM);
  if (agl === null) return GROUND_QUALITY.COARSE;
  return agl <= GROUND_FINE_AGL_M ? GROUND_QUALITY.FINE : GROUND_QUALITY.COARSE;
}

/**
 * Should this entry be sampled (again) if a sample now would have `quality`?
 *
 * No entry: yes. Fine: never. Coarse: only for a fine sample. Market: while
 * attempts remain, and — attempts or not — once the camera is in the near
 * field, because that is the one moment a retry is likely to succeed.
 */
export function needsSample(entry, quality, { maxAttempts = GROUND_MARKET_ATTEMPTS } = {}) {
  if (!entry) return true;
  if (entry.quality === GROUND_QUALITY.FINE) return false;
  if (entry.quality === GROUND_QUALITY.COARSE) return quality === GROUND_QUALITY.FINE;
  // market
  if (quality === GROUND_QUALITY.FINE && !entry.fineAttempted) return true;
  return (entry.attempts || 0) < maxAttempts;
}

/**
 * Where a row is anchored: its footprint centroid, or its coordinate.
 *
 * @param {{id:string, lat:number, lng:number}} property
 * @param {Array<Array<number>>|null} footprint outer [lon,lat] ring, or null
 */
export function anchorFor(property, footprint = null) {
  const centroid = Array.isArray(footprint) && footprint.length >= 3
    ? footprintCentroid(footprint)
    : null;
  if (centroid && Number.isFinite(centroid.lat) && Number.isFinite(centroid.lng)) {
    return { lat: centroid.lat, lng: centroid.lng, fromFootprint: true };
  }
  return { lat: Number(property?.lat), lng: Number(property?.lng), fromFootprint: false };
}

/**
 * @param {{Cesium:object, scene:object, market:object, getProperties:Function,
 *   getGeometry?:Function, getCameraAglM:Function, excluded?:Function,
 *   now?:Function}} deps
 *   `excluded` returns the primitives the sample must not hit — our own
 *   sprites and beacons stand exactly on the anchor, and a sample that
 *   returned their height would freeze the ground at whatever it was.
 */
export function createGroundSource({
  Cesium,
  scene,
  market,
  getProperties,
  getGeometry = geometryFor,
  getCameraAglM = () => null,
  excluded = () => [],
  now = () => (globalThis.performance?.now?.() ?? Date.now()),
} = {}) {
  /** id → entry */
  const entries = new Map();
  /** The last samples taken, newest last, for the headed check to print. */
  const log = [];
  const LOG_CAP = 60;
  let lastSampledAt = null;
  let samples = 0;

  function marketHeight() {
    return Number(market?.groundElevationM) || 0;
  }

  function footprintFor(property) {
    try { return getGeometry(property?.id)?.building?.footprint?.[0] || null; } catch { return null; }
  }

  function sampleTiles(lat, lng) {
    try {
      if (!scene?.sampleHeightSupported) return null;
      const carto = Cesium.Cartographic.fromDegrees(lng, lat);
      const list = excluded() || [];
      const sampled = scene.sampleHeight(carto, list.length ? list : undefined);
      return finiteOrNull(sampled);
    } catch {
      return null;
    }
  }

  function record(entry, aglM) {
    log.push({
      id: entry.id, heightM: entry.heightM, quality: entry.quality, source: entry.source,
      aglM: aglM === null ? null : Math.round(aglM), at: Math.round(entry.updatedAt),
    });
    if (log.length > LOG_CAP) log.shift();
  }

  /** Take a sample for one entry now. Returns true if the height or quality changed. */
  function sample(entry, quality, aglM) {
    const before = { heightM: entry.heightM, quality: entry.quality };
    const tiles = sampleTiles(entry.lat, entry.lng);
    samples += 1;
    entry.attempts = (entry.attempts || 0) + 1;
    if (quality === GROUND_QUALITY.FINE) entry.fineAttempted = true;
    if (tiles !== null) {
      entry.heightM = tiles;
      entry.quality = quality;
      entry.source = 'tiles';
    } else {
      entry.heightM = marketHeight();
      entry.quality = GROUND_QUALITY.MARKET;
      entry.source = 'market';
    }
    entry.sampledAtAglM = aglM;
    entry.updatedAt = now();
    record(entry, aglM);
    return before.quality !== entry.quality
      || Math.abs((before.heightM ?? NaN) - entry.heightM) > GROUND_CHANGE_M
      || !Number.isFinite(before.heightM);
  }

  function ensure(property) {
    if (!property?.id) return null;
    let entry = entries.get(property.id);
    if (!entry) {
      const anchor = anchorFor(property, footprintFor(property));
      entry = {
        id: property.id,
        lat: anchor.lat,
        lng: anchor.lng,
        fromFootprint: anchor.fromFootprint,
        heightM: null,
        quality: null,
        source: null,
        attempts: 0,
        fineAttempted: false,
        sampledAtAglM: null,
        updatedAt: 0,
      };
      entries.set(property.id, entry);
      const aglM = finiteOrNull(getCameraAglM());
      sample(entry, qualityForAgl(aglM), aglM);
    }
    return entry;
  }

  return {
    get fineAglM() { return GROUND_FINE_AGL_M; },
    get size() { return entries.size; },
    get samples() { return samples; },

    /** The ground under a property, in metres above the ellipsoid. */
    heightFor(property) {
      return ensure(property)?.heightM ?? marketHeight();
    },
    /** `{lat, lng, heightM, quality, fromFootprint}` for a property. */
    anchorFor(property) {
      const entry = ensure(property);
      if (!entry) return null;
      return {
        lat: entry.lat, lng: entry.lng, heightM: entry.heightM,
        quality: entry.quality, source: entry.source, fromFootprint: entry.fromFootprint,
      };
    },
    /** The anchor as a Cartesian3, `liftM` above the ground. */
    positionFor(property, liftM = 0) {
      const entry = ensure(property);
      if (!entry) return null;
      return Cesium.Cartesian3.fromDegrees(entry.lng, entry.lat, entry.heightM + (Number(liftM) || 0));
    },
    /** The anchor projected to the window, or null when off screen / unprojectable. */
    screenPositionFor(property) {
      const entry = ensure(property);
      if (!entry) return null;
      try {
        const world = Cesium.Cartesian3.fromDegrees(entry.lng, entry.lat, entry.heightM);
        const point = Cesium.SceneTransforms.worldToWindowCoordinates?.(scene, world)
          || Cesium.SceneTransforms.wgs84ToWindowCoordinates?.(scene, world);
        return point ? { x: point.x, y: point.y } : null;
      } catch {
        return null;
      }
    },
    /** Does this row's anchor come from a real footprint? */
    hasFootprint(property) {
      return Boolean(ensure(property)?.fromFootprint);
    },

    /**
     * Re-sample whatever can still improve. Throttled; returns the ids whose
     * ground moved so the layers standing on it can move too.
     *
     * @param {{force?:boolean}} [options]
     * @returns {string[]} changed property ids
     */
    refresh({ force = false } = {}) {
      const stamp = now();
      if (!force && lastSampledAt !== null && stamp - lastSampledAt < GROUND_SAMPLE_INTERVAL_MS) {
        return [];
      }
      const aglM = finiteOrNull(getCameraAglM());
      const quality = qualityForAgl(aglM);
      const changed = [];
      let sampledAny = false;
      for (const property of getProperties?.() || []) {
        if (!property?.id) continue;
        const existing = entries.get(property.id);
        if (!existing) {
          ensure(property);
          changed.push(property.id);
          sampledAny = true;
          continue;
        }
        if (!needsSample(existing, quality)) continue;
        sampledAny = true;
        if (sample(existing, quality, aglM)) changed.push(property.id);
      }
      if (sampledAny) lastSampledAt = stamp;
      return changed;
    },

    /** Forget a row (or everything) so the next read samples afresh. */
    reset(id = null) {
      if (id) entries.delete(id);
      else entries.clear();
    },

    /** What the headed check prints: every entry, and the last samples taken. */
    get report() {
      const rows = [...entries.values()].map((e) => ({
        id: e.id,
        heightM: e.heightM === null ? null : Math.round(e.heightM * 100) / 100,
        quality: e.quality,
        source: e.source,
        fromFootprint: e.fromFootprint,
        attempts: e.attempts,
        sampledAtAglM: e.sampledAtAglM === null ? null : Math.round(e.sampledAtAglM),
      })).sort((a, b) => a.id.localeCompare(b.id));
      return {
        fineAglM: GROUND_FINE_AGL_M,
        samples,
        entries: rows,
        fine: rows.filter((r) => r.quality === GROUND_QUALITY.FINE).length,
        coarse: rows.filter((r) => r.quality === GROUND_QUALITY.COARSE).length,
        market: rows.filter((r) => r.quality === GROUND_QUALITY.MARKET).length,
        log: [...log],
      };
    },
  };
}
