/**
 * Demo markets for TerraSignal Investor Phase 1.
 * Only Atlanta / Decatur ships. Coordinates are WGS84.
 */

export const MARKETS = Object.freeze({
  atlanta: Object.freeze({
    id: 'atlanta',
    name: 'Atlanta / Decatur',
    city: 'Atlanta',
    region: 'Decatur · East Atlanta · Kirkwood',
    lat: 33.7748,
    lng: -84.2963,
    globeLng: -84.39,
    globeLat: 33.75,
    // Ground elevation above the WGS84 ellipsoid. Camera altitudes in the shot
    // list are above GROUND; Cartesian3.fromDegrees takes ellipsoid height, so
    // without this a 111 m hero camera sits ~200 m underground in Decatur.
    groundElevationM: 310,
    overviewHeightM: 14000,
    huntHeightM: 2200,
    streetHeightM: 420,
    bounds: Object.freeze({
      south: 33.62,
      west: -84.48,
      north: 33.91,
      east: -84.20,
    }),
    greeting: 'Where are we hunting today?',
  }),
});

export function resolveMarket(id = 'atlanta') {
  const key = String(id || 'atlanta').trim().toLowerCase();
  return MARKETS[key] || MARKETS.atlanta;
}

export function isInsideMarket(lat, lng, market = MARKETS.atlanta) {
  const { bounds } = market;
  return lat >= bounds.south && lat <= bounds.north && lng >= bounds.west && lng <= bounds.east;
}
