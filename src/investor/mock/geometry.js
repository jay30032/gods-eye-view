/**
 * One lookup across every authored dataset's geometry.
 *
 * The two geometry files are generated separately — `fetch-footprints.mjs`
 * runs per dataset and each writes its own — but ids are globally unique, so
 * consumers should never have to know which block a row came from. The effects
 * layer asks this and gets a footprint or it gets null.
 */
import { geometryFor as atlantaGeometryFor } from './atlantaDecaturGeometry.js';
import { sixHouseGeometryFor } from './sixHouseGeometry.js';

export function geometryFor(id) {
  const key = String(id || '').trim();
  if (!key) return null;
  return atlantaGeometryFor(key) || sixHouseGeometryFor(key) || null;
}
