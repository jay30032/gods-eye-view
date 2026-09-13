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
 * Should this house be tinted at all?
 *
 * Only the two houses the product is actively pointing at. Tinting the whole
 * board would turn a highlight into a colour wash and answer nothing.
 */
export function tintAppliesTo(id, { focusedId = null, topPickId = null } = {}) {
  if (!id) return false;
  return id === focusedId || id === topPickId;
}
