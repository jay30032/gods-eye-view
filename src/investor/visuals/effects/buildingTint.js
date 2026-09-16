/**
 * The building tint: the focused house lit up rather than merely outlined.
 *
 * An outline says *which* house. It does not make the house itself read as
 * selected — at HERO the eye still lands on the roof, and the roof looks like
 * every other roof on the street. So the top pick and the focused house get a
 * translucent gold volume extruded from their footprint, classified onto
 * Google's 3D tiles, which paints the actual photogrammetry of that building
 * and stops at its walls.
 *
 * ## Why two volumes rather than a gradient
 *
 * `ClassificationPrimitive` colours whatever tile geometry falls inside its
 * volume, and it colours it *flat*: the classification path takes a per-instance
 * colour, not a material, so there is no fragment-varying gradient to be had.
 * "Strongest at the edges" is therefore built out of geometry instead of out of
 * a shader — two stacked volumes:
 *
 *   1. a **fill** over the whole footprint at a low alpha, so the roof reads as
 *      tinted rather than as outlined;
 *   2. an **edge band** — the same footprint with an inset copy punched out of
 *      it as a hole — at a higher alpha, so the rim is where the colour
 *      concentrates.
 *
 * They are translucent and they overlap nowhere, so the rim carries the band's
 * alpha and the middle carries the fill's. The result falls off towards the
 * centre of the roof, which is what keeps the house looking lit rather than
 * painted over.
 *
 * Pure geometry here; `nearFieldEffects.js` owns the Cesium half.
 */

import { footprintCentroid, toGeo, toLocal } from '../../mock/parcel.js';
import { brightnessFor, goldBreathFor, motionFor } from './signalMotion.js';

/**
 * How far up the tint is extruded, in metres above the footprint's ground.
 *
 * 9 m is a little over a two-storey house, which is what the board is made of.
 * The volume has to *contain* the roof geometry it is meant to colour — a
 * classification volume that stops at the eaves leaves the top of the roof
 * untinted, which reads as a bug rather than as a highlight. Going much higher
 * is worse: the volume starts catching the tree canopy overhanging the house.
 */
export const TINT_HEIGHT_M = 9;

/** Alpha of the fill over the whole roof. Deliberately faint. */
export const TINT_FILL_ALPHA = 0.10;
/** Alpha of the rim band, where the colour is supposed to gather. */
export const TINT_EDGE_ALPHA = 0.30;
/** How far in from the wall the bright band runs, in metres. */
export const TINT_EDGE_BAND_M = 1.6;

/**
 * Shrink a footprint ring towards its own centroid by roughly `metresIn`.
 *
 * A true polygon offset (mitred, self-intersection aware) is a lot of machinery
 * for a band 1.6 m wide on a building 12 m across. Scaling about the centroid
 * gives the same answer to within a few centimetres on the compact, convex-ish
 * shapes house footprints actually are, and — the part that matters — it can
 * never produce a self-intersecting ring, because a uniform scale of a simple
 * polygon is a simple polygon. A mitred offset can, and an invalid hole is a
 * Cesium DeveloperError that stops the render loop.
 *
 * The scale is derived from the ring's mean radius, so a big footprint and a
 * small one both get a band of about the requested width.
 *
 * @param {Array<Array<number>>} ring outer [lon,lat] ring
 * @param {number} metresIn how far to pull the wall inward
 * @returns {Array<Array<number>>|null} the inset ring, or null if it collapses
 */
export function insetRing(ring, metresIn = TINT_EDGE_BAND_M) {
  if (!Array.isArray(ring) || ring.length < 3) return null;
  const centroid = footprintCentroid(ring);
  if (!centroid) return null;

  const local = ring.map((point) => toLocal(point, centroid));
  const radii = local.map(([x, y]) => Math.hypot(x, y));
  const meanRadius = radii.reduce((sum, r) => sum + r, 0) / radii.length;
  if (!Number.isFinite(meanRadius) || meanRadius <= 0) return null;

  const scale = 1 - metresIn / meanRadius;
  // A band wider than the building has no inside. Say so rather than returning
  // an inverted ring, which would draw a hole bigger than the polygon it is in.
  if (!Number.isFinite(scale) || scale <= 0.15) return null;

  return local.map(([x, y]) => toGeo([x * scale, y * scale], centroid));
}

/**
 * Which world draws the draped footprint outline.
 *
 * Only the parked Clear View. On Google's photogrammetry the draped line
 * wobbles over roof edges — the mesh is not the building's true edge, and a
 * line that traces the mesh reads as sloppy. The rim band carries the shape
 * in the photo world; the outline stays only for the tree-free experiment,
 * whose OSM boxes have edges a line can honestly follow.
 */
export function outlineDrawnIn(world) {
  return world === 'clear';
}

/**
 * The rim's brightness floor: at the bottom of a beat the band is still this
 * fraction of its full alpha, so a house never blinks off between pulses.
 */
export const RIM_ALPHA_FLOOR = 0.45;
/** Length of the travelling segment as a fraction of the loop. */
export const RIM_TRAVEL_WIDTH = 0.10;
/** How much the travelling segment lifts the rim above its band alpha. */
export const RIM_TRAVEL_LIFT = 1.6;

/**
 * Rim band alpha for a signal at a moment on the shared clock.
 *
 * The per-signal motion that used to breathe on the draped outline lands
 * here: the heartbeat, the double pulse and the shimmer are the same
 * envelopes, read as the rim's alpha rather than a glow width. Gold rims
 * breathe on the gold breath. Always inside [TINT_EDGE_ALPHA * floor,
 * TINT_EDGE_ALPHA].
 */
export function rimAlphaFor(type, seconds, { reduced = false, gold = false } = {}) {
  const value = gold
    ? goldBreathFor(seconds, { reduced })
    : brightnessFor(type, seconds, { reduced });
  const band = RIM_ALPHA_FLOOR + (1 - RIM_ALPHA_FLOOR) * Math.min(1, Math.max(0, value));
  return TINT_EDGE_ALPHA * band;
}

/** Fraction along the ring's perimeter at which each vertex sits, 0 at the first. */
export function edgeFractions(ring) {
  const points = openRing(ring);
  if (points.length < 3) return [];
  const centroid = footprintCentroid(points);
  const local = points.map((point) => toLocal(point, centroid));
  const lengths = local.map(([x, y], i) => {
    const [nx, ny] = local[(i + 1) % local.length];
    return Math.hypot(nx - x, ny - y);
  });
  const total = lengths.reduce((sum, l) => sum + l, 0);
  if (!(total > 0)) return points.map(() => 0);
  let cursor = 0;
  return lengths.map((length) => {
    const at = cursor / total;
    cursor += length;
    return at;
  });
}

/** A ring without its closing duplicate, if it carried one. */
export function openRing(ring) {
  if (!Array.isArray(ring)) return [];
  const points = ring.filter((p) => Array.isArray(p) && Number.isFinite(p[0]) && Number.isFinite(p[1]));
  if (points.length > 1) {
    const [a, b] = [points[0], points[points.length - 1]];
    if (Math.abs(a[0] - b[0]) < 1e-12 && Math.abs(a[1] - b[1]) < 1e-12) points.pop();
  }
  return points;
}

/**
 * The rim band cut into one quad per wall.
 *
 * `insetRing` scales about the centroid, so inner and outer vertices
 * correspond one to one and quad i is the strip along wall i. The quads share
 * edges and never overlap, which is what lets a travelling segment light one
 * wall at a time without translucent volumes stacking where they meet.
 *
 * @returns {Array<{ring:Array, start:number, mid:number, end:number}>}
 *   each quad as a 4-point ring plus its perimeter fractions
 */
export function rimSegments(outerRing, innerRing) {
  const outer = openRing(outerRing);
  const inner = openRing(innerRing);
  if (outer.length < 3 || inner.length !== outer.length) return [];
  const fractions = edgeFractions(outer);
  return outer.map((point, i) => {
    const j = (i + 1) % outer.length;
    const start = fractions[i];
    const end = j === 0 ? 1 : fractions[j];
    return {
      ring: [point, outer[j], inner[j], inner[i]],
      start,
      end,
      mid: (start + end) / 2,
    };
  });
}

/**
 * How lit a point on the loop is by the travelling segment, 0..1.
 *
 * Distance is measured the short way round the loop so the head crosses the
 * seam without a flicker — the same rule the old outline shader used.
 */
export function travelLitFor(fraction, head, { width = RIM_TRAVEL_WIDTH } = {}) {
  const f = ((Number(fraction) % 1) + 1) % 1;
  const h = ((Number(head) % 1) + 1) % 1;
  if (!Number.isFinite(f) || !Number.isFinite(h)) return 0;
  let d = Math.abs(f - h);
  d = Math.min(d, 1 - d);
  const w = Math.max(0.01, width);
  if (d >= w) return 0;
  const t = d / w;
  return 1 - t * t * (3 - 2 * t);
}

/** Where the travelling head is on the loop for a signal, or null if it does not travel. */
export function travelHeadFor(type, seconds) {
  const rate = motionFor(type).travelPerSec;
  if (!(rate > 0)) return null;
  const t = Number(seconds);
  if (!Number.isFinite(t)) return 0;
  return ((t * rate) % 1 + 1) % 1;
}

/**
 * Should this house wear the gold fill?
 *
 * Only the two houses the product is actively pointing at. The rim band is on
 * every house in the near field — it is the shape — but filling the whole
 * board would turn a highlight into a colour wash and answer nothing.
 */
export function tintAppliesTo(id, { focusedId = null, topPickId = null } = {}) {
  if (!id) return false;
  return id === focusedId || id === topPickId;
}
