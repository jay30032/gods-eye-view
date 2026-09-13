/**
 * Which way round should the camera approach this house?
 *
 * HERO used to fly to a fixed heading of 35 degrees for every property on the
 * board. On an open corner lot that is fine. On the other side of a mature oak
 * — which in Oakhurst is most of them — it lands the camera behind a tree and
 * the house the product just told you to look at is a few pixels of roof
 * through foliage.
 *
 * So before the hero flight, eight headings are tried and scored, and the
 * camera goes to the one that can actually see the building. The score is the
 * fraction of the footprint's corners and centroid that are *unoccluded* from
 * that camera position — rays cast against the loaded tiles, which is the only
 * honest way to ask the question, because the thing in the way is Google's
 * photogrammetry and nothing in this repository knows where its trees are.
 *
 * This module is the pure half: the candidate list and the choice. The ray
 * casting lives in `director.js`, because it needs a scene.
 */

import { angleBetweenDeg, normalizeDeg } from './orientation.js';

/**
 * How many headings to try.
 *
 * Eight is 45 degrees apart, which is fine enough that a gap between two trees
 * is usually found and coarse enough that the whole sweep is forty ray casts
 * rather than hundreds. The camera does not need the optimal angle; it needs to
 * not be behind a tree.
 */
export const HEADING_COUNT = 8;

/**
 * Scores this close count as tied.
 *
 * With five sample points a score moves in fifths, so anything under a fifth is
 * noise from a ray clipping a gutter. Treating near-equal angles as tied is
 * what lets the street-facing preference do its job instead of losing to a
 * back-garden angle that happened to see one more corner.
 */
export const TIE_EPSILON = 0.2;

/** The headings to evaluate, evenly spaced from north. */
export function candidateHeadings(count = HEADING_COUNT) {
  const n = Math.max(1, Math.floor(count));
  return Array.from({ length: n }, (_, i) => normalizeDeg((i * 360) / n));
}

/**
 * Pick the heading to fly.
 *
 * Best score wins. Among scores within `TIE_EPSILON` of the best, the one
 * closest to the street-facing heading wins — a house is *meant* to be seen
 * from the street, so when two angles are equally clear the front is the one a
 * person would have chosen. With no street heading the lowest bearing wins,
 * which is arbitrary but deterministic, and a deterministic camera is testable
 * where a coin-toss is not.
 *
 * @param {Array<{headingDeg:number, score:number}>} scored
 * @param {number|null} streetHeadingDeg camera heading that looks at the front
 * @returns {{headingDeg:number, score:number, tied:number,
 *   reason:'clear'|'street-tiebreak'|'all-equal'}|null}
 */
export function pickBestHeading(scored, streetHeadingDeg = null) {
  const rows = (scored || []).filter(
    (row) => Number.isFinite(row?.headingDeg) && Number.isFinite(row?.score),
  );
  if (!rows.length) return null;

  const best = Math.max(...rows.map((row) => row.score));
  const tied = rows.filter((row) => best - row.score <= TIE_EPSILON);

  // Every angle equally good (or equally bad) is worth saying out loud: it
  // means the occlusion test told us nothing, usually because no tiles were
  // loaded to cast against.
  const allEqual = tied.length === rows.length;

  if (Number.isFinite(streetHeadingDeg)) {
    let winner = tied[0];
    let closest = angleBetweenDeg(winner.headingDeg, streetHeadingDeg);
    for (const row of tied.slice(1)) {
      const delta = angleBetweenDeg(row.headingDeg, streetHeadingDeg);
      if (delta < closest) {
        closest = delta;
        winner = row;
      }
    }
    return {
      headingDeg: winner.headingDeg,
      score: winner.score,
      tied: tied.length,
      reason: allEqual ? 'all-equal' : (tied.length > 1 ? 'street-tiebreak' : 'clear'),
    };
  }

  const winner = [...tied].sort((a, b) => a.headingDeg - b.headingDeg)[0];
  return {
    headingDeg: winner.headingDeg,
    score: winner.score,
    tied: tied.length,
    reason: allEqual ? 'all-equal' : 'clear',
  };
}

/**
 * The points a heading is scored against: every footprint corner plus the
 * centroid.
 *
 * The centroid matters because a footprint's corners can all be visible through
 * gaps while the middle of the roof — the part that fills the frame — is behind
 * a canopy. Corners alone would score that angle perfect.
 *
 * Capped hard, because an ornate OSM footprint can carry fifty nodes and every
 * one of them costs a `pickFromRay` against the tileset, eight times over. At
 * nine sample points a headed run showed a 433 ms frame at the moment of focus —
 * a visible stall on the one flight the demo is built around. Four corners plus
 * the centroid is five rays per heading, forty for the sweep, and measures the
 * same thing: the corners bound the building and the centroid catches a canopy
 * over the middle of it.
 *
 * Evenly sampled rather than truncated, so the cap never quietly scores only
 * one wall of the house.
 */
export const MAX_SAMPLE_CORNERS = 4;

export function samplePoints(ring, centroid) {
  const points = [];
  const corners = (ring || []).filter((p) => Array.isArray(p) && p.length >= 2);
  if (corners.length) {
    const step = Math.max(1, Math.ceil(corners.length / MAX_SAMPLE_CORNERS));
    for (let i = 0; i < corners.length; i += step) points.push(corners[i]);
  }
  if (centroid && Number.isFinite(centroid.lng) && Number.isFinite(centroid.lat)) {
    points.push([centroid.lng, centroid.lat]);
  }
  return points;
}
