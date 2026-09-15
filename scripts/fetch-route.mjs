#!/usr/bin/env node
/**
 * The drive-mode route: one road-following loop past all six DEMO-SIX houses.
 *
 * Drive Mode v1 drives real roads. The old simulated route was a list of houses
 * and a camera that teleported between them; this replaces it with an actual
 * polyline that a car could follow, fetched once and committed. **The app never
 * calls a routing service at runtime** — a demo that needs someone else's
 * server to start is a demo that fails when their server is busy.
 *
 * ## Where the waypoints come from
 *
 * Not the roofs. Each row's `street` block already holds the bearing and
 * distance from the footprint centroid to the nearest point on the nearest
 * residential way, so stepping that far along that bearing lands on the road
 * **in front of the house** — the street-facing side, which is the side the
 * drive is supposed to pass. Routing between roofs would ask OSRM to find its
 * way to the middle of a building and let it pick whichever kerb it liked.
 *
 * ## The loop
 *
 * OSRM's `/trip` service solves the visiting order and closes the loop, which
 * is the right shape for a drive that ends where it began. `/route` would take
 * the six points in the order given and produce whatever zig-zag that implied.
 *
 * ## The assertion that matters
 *
 * **Never a straight line through a yard.** OSRM can return a bee-line when a
 * waypoint fails to snap to the network, and the result looks fine in a list of
 * coordinates and disastrous on the globe. So every vertex of the finished
 * route is checked against OSM's own highway geometry, fetched from Overpass,
 * and the script refuses to write if any of them is more than 8 m from a road.
 *
 *   node scripts/fetch-route.mjs             # fetch, verify, write
 *   node scripts/fetch-route.mjs --dry-run   # fetch and verify, write nothing
 */
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { SIX_HOUSE_GEOMETRY } from '../src/investor/mock/sixHouseGeometry.js';
import { SIX_HOUSE_PROPERTIES } from '../src/investor/mock/sixHouse.js';
import { metresPerDegreeLng } from '../src/investor/mock/parcel.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_PATH = join(ROOT, 'src/investor/mock/sixRoute.js');

const M_PER_DEG_LAT = 111_320;
const DEG = Math.PI / 180;

const OSRM = 'https://router.project-osrm.org';
const OVERPASS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
];
/**
 * Both services refuse or throttle an unidentified client — Overpass answers
 * undici's default User-Agent with a bare 406, which `fetch-footprints.mjs`
 * lost a whole run to. Say who is calling.
 */
const USER_AGENT = 'terrasignal-investor/1.0 (github.com/gods-eye-view; one-time drive route fetch)';
const REQUEST_TIMEOUT_MS = 60_000;

/** How far a route vertex may sit from the nearest mapped road. */
export const MAX_OFF_ROAD_M = 8;
/** Ways a drive can legitimately follow. */
const DRIVEABLE = [
  'residential', 'living_street', 'unclassified', 'tertiary', 'tertiary_link',
  'secondary', 'secondary_link', 'primary', 'primary_link', 'service',
];
/** Padding on the query box so a road just outside the route still counts. */
const BBOX_PAD_M = 120;
/** Slack on the per-segment bounding-box reject. Comfortably over the limit. */
const REJECT_PAD_M = 60;

const HAS = (name) => process.argv.includes(`--${name}`);
const DRY_RUN = HAS('dry-run');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const number = (value, digits) => Number(Number(value).toFixed(digits));

/** [lon,lat] to local [east,north] metres about an origin. */
function toLocal(point, origin) {
  const mLng = metresPerDegreeLng(origin.lat);
  return [(point[0] - origin.lng) * mLng, (point[1] - origin.lat) * M_PER_DEG_LAT];
}

/** Ground distance in metres between two [lon,lat] points. */
function distanceM(a, b) {
  const mLng = metresPerDegreeLng((a[1] + b[1]) / 2);
  return Math.hypot((a[0] - b[0]) * mLng, (a[1] - b[1]) * M_PER_DEG_LAT);
}

/** Distance from p to segment ab, all in local metres. */
function pointToSegmentM(p, a, b) {
  const abx = b[0] - a[0];
  const aby = b[1] - a[1];
  const lenSq = abx * abx + aby * aby;
  if (lenSq < 1e-9) return Math.hypot(p[0] - a[0], p[1] - a[1]);
  let t = ((p[0] - a[0]) * abx + (p[1] - a[1]) * aby) / lenSq;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p[0] - (a[0] + abx * t), p[1] - (a[1] + aby * t));
}

/**
 * The point on the road in front of a house.
 *
 * `street.bearingDeg` runs from the footprint centroid to the nearest point on
 * the nearest residential way, and `street.distanceM` is how far that is — so
 * this is exactly the kerb the house faces.
 */
function streetSideWaypoint(record) {
  const centroid = record?.centroid;
  const street = record?.street;
  if (!centroid || !Number.isFinite(street?.bearingDeg) || !Number.isFinite(street?.distanceM)) {
    return null;
  }
  const mLng = metresPerDegreeLng(centroid.lat);
  return [
    centroid.lng + (Math.sin(street.bearingDeg * DEG) * street.distanceM) / mLng,
    centroid.lat + (Math.cos(street.bearingDeg * DEG) * street.distanceM) / M_PER_DEG_LAT,
  ];
}

async function getJson(url, options = {}) {
  const response = await fetch(url, {
    headers: { Accept: 'application/json', 'User-Agent': USER_AGENT },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    ...options,
  });
  if (!response.ok) throw new Error(`HTTP ${response.status} from ${new URL(url).host}`);
  return response.json();
}

/**
 * A closed, road-following loop through the waypoints.
 *
 * `roundtrip=true` with `source=first` returns to where it started, which is
 * what makes the drive replayable without a jump at the end. `steps=false`
 * because nothing here reads turn instructions — only the geometry.
 */
async function fetchTrip(waypoints) {
  const coords = waypoints.map(([lon, lat]) => `${lon.toFixed(6)},${lat.toFixed(6)}`).join(';');
  const url = `${OSRM}/trip/v1/driving/${coords}`
    + '?roundtrip=true&source=first&overview=full&geometries=geojson&steps=false&annotations=false';
  const body = await getJson(url);
  if (body.code !== 'Ok') throw new Error(`OSRM: ${body.code} ${body.message || ''}`);
  const trip = body.trips?.[0];
  if (!trip?.geometry?.coordinates?.length) throw new Error('OSRM returned no geometry');
  return {
    coordinates: trip.geometry.coordinates,
    distanceM: trip.distance,
    durationS: trip.duration,
    // Which visiting order it settled on, so the report can show it.
    order: (body.waypoints || [])
      .map((w, i) => ({ i, at: w.waypoint_index }))
      .sort((a, b) => a.at - b.at)
      .map((w) => w.i),
  };
}

/** Every driveable way near the route, straight from OSM. */
async function fetchHighways(bbox) {
  const filter = DRIVEABLE.join('|');
  const query = `[out:json][timeout:90];`
    + `way(${bbox.south},${bbox.west},${bbox.north},${bbox.east})[highway~"^(${filter})$"];`
    + `out geom;`;
  let lastError = 'unknown';
  for (let attempt = 0; attempt < OVERPASS.length * 2; attempt += 1) {
    const endpoint = OVERPASS[attempt % OVERPASS.length];
    try {
      const body = await getJson(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Accept: 'application/json',
          'User-Agent': USER_AGENT,
        },
        body: `data=${encodeURIComponent(query)}`,
      });
      const ways = (body.elements || []).filter((e) => Array.isArray(e.geometry) && e.geometry.length > 1);
      if (ways.length) return ways;
      lastError = 'no highways returned';
    } catch (error) {
      lastError = String(error?.message || error);
    }
    await sleep(1_200 * (attempt + 1));
  }
  throw new Error(`Overpass: ${lastError}`);
}

/**
 * How far every vertex of the route is from the nearest mapped road.
 *
 * This is the guard against the failure that actually looks fine in the data
 * and terrible on the globe: a waypoint that failed to snap, leaving OSRM to
 * draw a straight line across somebody's garden.
 */
function offRoadReport(coordinates, ways) {
  const origin = { lng: coordinates[0][0], lat: coordinates[0][1] };
  const segments = [];
  for (const way of ways) {
    const points = way.geometry.map((n) => toLocal([n.lon, n.lat], origin));
    for (let i = 0; i + 1 < points.length; i += 1) segments.push([points[i], points[i + 1]]);
  }
  let worst = { distanceM: 0, index: -1 };
  const offenders = [];
  coordinates.forEach((coordinate, index) => {
    const p = toLocal(coordinate, origin);
    let nearest = Infinity;
    for (const [a, b] of segments) {
      // Cheap reject before the exact distance. It must be the segment's
      // BOUNDING BOX, not the distance to its endpoints: a long straight road
      // passing a metre away has both endpoints far off, and rejecting on
      // endpoint distance threw away the only segment that mattered — which
      // reported the vertex as infinitely far from any road.
      if (p[0] < Math.min(a[0], b[0]) - REJECT_PAD_M) continue;
      if (p[0] > Math.max(a[0], b[0]) + REJECT_PAD_M) continue;
      if (p[1] < Math.min(a[1], b[1]) - REJECT_PAD_M) continue;
      if (p[1] > Math.max(a[1], b[1]) + REJECT_PAD_M) continue;
      const d = pointToSegmentM(p, a, b);
      if (d < nearest) nearest = d;
      if (nearest < 0.5) break;
    }
    if (nearest > worst.distanceM) worst = { distanceM: nearest, index };
    if (nearest > MAX_OFF_ROAD_M) offenders.push({ index, distanceM: nearest, coordinate });
  });
  return { worst, offenders, segments: segments.length };
}

function boundsOf(coordinates, padM) {
  const lats = coordinates.map((c) => c[1]);
  const lngs = coordinates.map((c) => c[0]);
  const midLat = (Math.min(...lats) + Math.max(...lats)) / 2;
  const padLat = padM / M_PER_DEG_LAT;
  const padLng = padM / metresPerDegreeLng(midLat);
  return {
    south: Math.min(...lats) - padLat,
    north: Math.max(...lats) + padLat,
    west: Math.min(...lngs) - padLng,
    east: Math.max(...lngs) + padLng,
  };
}

/** Running length of a [lon,lat] polyline, in metres. */
function polylineLengthM(coordinates) {
  let total = 0;
  for (let i = 1; i < coordinates.length; i += 1) total += distanceM(coordinates[i - 1], coordinates[i]);
  return total;
}

/**
 * Drop vertices that add nothing.
 *
 * OSRM returns a vertex per OSM node, which on a straight residential block is
 * several within a metre of each other. The spline that reads this is smoother
 * and cheaper with the redundant ones gone, and a 1 m tolerance cannot move the
 * line off the road.
 */
function simplify(coordinates, toleranceM = 1) {
  const out = [coordinates[0]];
  for (let i = 1; i < coordinates.length - 1; i += 1) {
    if (distanceM(out[out.length - 1], coordinates[i]) >= toleranceM) out.push(coordinates[i]);
  }
  out.push(coordinates[coordinates.length - 1]);
  return out;
}

function render(route, houses, generatedAt) {
  const rows = route.coordinates
    .map(([lon, lat]) => `  [${number(lon, 6)}, ${number(lat, 6)}],`)
    .join('\n');
  return `/**
 * The Drive Mode v1 route: one road-following loop past all six DEMO-SIX houses.
 *
 * GENERATED by \`node scripts/fetch-route.mjs\` on ${generatedAt}.
 * Do not hand-edit: re-run the script.
 *
 * ---------------------------------------------------------------------------
 * The road geometry is derived from OpenStreetMap data, © OpenStreetMap
 * contributors, available under the Open Database License (ODbL) v1.0:
 *   https://www.openstreetmap.org/copyright
 *   https://opendatacommons.org/licenses/odbl/1-0/
 * Any public use of this data must carry that attribution and share alike.
 *
 * The visiting order and the road-following geometry were solved once by the
 * public OSRM demo server (router.project-osrm.org), which routes on the same
 * OpenStreetMap data. **Nothing in the app calls a routing service at runtime.**
 *
 * Waypoints are the street-facing side of each house — the point on the nearest
 * residential way that the footprint faces — not the roofs, so the loop passes
 * the front of every property rather than routing to the middle of a building.
 *
 * Every vertex below was checked against OSM's own highway geometry and sits
 * within ${MAX_OFF_ROAD_M} m of a mapped road (worst: ${number(route.worstOffRoadM, 2)} m). The route never
 * cuts across a yard.
 * ---------------------------------------------------------------------------
 */

/** Closed loop of [lon, lat] vertices, in travel order. */
export const SIX_ROUTE = Object.freeze([
${rows}
].map((point) => Object.freeze(point)));

/** Total length of the loop in metres, measured along the polyline. */
export const SIX_ROUTE_LENGTH_M = ${number(route.lengthM, 1)};

/** What the routing engine estimated a car would take, in seconds. */
export const SIX_ROUTE_DRIVE_SECONDS = ${number(route.durationS, 1)};

/** Worst distance from any vertex to a mapped road, in metres. */
export const SIX_ROUTE_MAX_OFF_ROAD_M = ${number(route.worstOffRoadM, 2)};

/** The houses the loop was built to pass, in the order it reaches them. */
export const SIX_ROUTE_HOUSES = Object.freeze([
${houses.map((h) => `  Object.freeze({ id: '${h.id}', street: ${JSON.stringify(h.street)}, alongM: ${number(h.alongM, 1)} }),`).join('\n')}
]);

export const SIX_ROUTE_ATTRIBUTION = Object.freeze({
  data: '© OpenStreetMap contributors',
  licence: 'ODbL 1.0',
  url: 'https://www.openstreetmap.org/copyright',
  routing: 'OSRM demo server (router.project-osrm.org), one-time fetch',
});
`;
}

/** Distance along the polyline of the point nearest to a waypoint. */
function alongMFor(coordinates, waypoint) {
  const origin = { lng: coordinates[0][0], lat: coordinates[0][1] };
  const p = toLocal(waypoint, origin);
  let along = 0;
  let best = { distance: Infinity, along: 0 };
  for (let i = 0; i + 1 < coordinates.length; i += 1) {
    const a = toLocal(coordinates[i], origin);
    const b = toLocal(coordinates[i + 1], origin);
    const segment = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const d = pointToSegmentM(p, a, b);
    if (d < best.distance) {
      const abx = b[0] - a[0];
      const aby = b[1] - a[1];
      const lenSq = abx * abx + aby * aby;
      const t = lenSq < 1e-9 ? 0 : Math.max(0, Math.min(1,
        ((p[0] - a[0]) * abx + (p[1] - a[1]) * aby) / lenSq));
      best = { distance: d, along: along + segment * t };
    }
    along += segment;
  }
  return best;
}

async function main() {
  const rows = SIX_HOUSE_PROPERTIES;
  const waypoints = [];
  for (const row of rows) {
    const record = SIX_HOUSE_GEOMETRY[row.id];
    const point = streetSideWaypoint(record);
    if (!point) {
      console.error(`${row.id}: no street bearing — cannot place a waypoint. `
        + 'Run scripts/fetch-streets.mjs first.');
      process.exit(1);
    }
    waypoints.push({ id: row.id, point, street: record.street.name || record.street.highway });
    console.log(`  ${row.id}  ${String(record.street.name).padEnd(16)} `
      + `${point[1].toFixed(6)}, ${point[0].toFixed(6)}`);
  }

  console.log('\nsolving the loop with OSRM...');
  const trip = await fetchTrip(waypoints.map((w) => w.point));
  const coordinates = simplify(trip.coordinates);
  const lengthM = polylineLengthM(coordinates);
  console.log(`  ${trip.coordinates.length} vertices -> ${coordinates.length} after simplify`);
  console.log(`  loop length ${lengthM.toFixed(0)} m · OSRM says ${trip.distanceM.toFixed(0)} m`
    + ` · ${trip.durationS.toFixed(0)} s of driving`);

  console.log('\nverifying every vertex sits on a road...');
  const ways = await fetchHighways(boundsOf(coordinates, BBOX_PAD_M));
  const report = offRoadReport(coordinates, ways);
  console.log(`  ${ways.length} ways / ${report.segments} segments from Overpass`);
  console.log(`  worst vertex is ${report.worst.distanceM.toFixed(2)} m from a road `
    + `(index ${report.worst.index}, limit ${MAX_OFF_ROAD_M} m)`);

  if (report.offenders.length) {
    console.error(`\nREFUSING TO WRITE: ${report.offenders.length} vertices are off-road.`);
    for (const bad of report.offenders.slice(0, 8)) {
      console.error(`  vertex ${bad.index} is ${bad.distanceM.toFixed(1)} m from any road `
        + `(${bad.coordinate[1].toFixed(6)}, ${bad.coordinate[0].toFixed(6)})`);
    }
    console.error('  A route that leaves the road is a route through somebody\'s yard.');
    process.exit(1);
  }

  const houses = waypoints
    .map((w) => ({ id: w.id, street: w.street, alongM: alongMFor(coordinates, w.point).along }))
    .sort((a, b) => a.alongM - b.alongM);
  console.log('\n  passing order:');
  for (const house of houses) {
    console.log(`    ${house.alongM.toFixed(0).padStart(4)} m  ${house.id}  ${house.street}`);
  }

  if (DRY_RUN) {
    console.log('\n--dry-run: nothing written.');
    return;
  }
  const file = render(
    { coordinates, lengthM, durationS: trip.durationS, worstOffRoadM: report.worst.distanceM },
    houses,
    new Date().toISOString().slice(0, 10),
  );
  writeFileSync(OUT_PATH, file);
  console.log(`\nwrote ${OUT_PATH} — ${coordinates.length} vertices, ${lengthM.toFixed(0)} m`);
}

main().catch((error) => {
  console.error(`fetch-route failed: ${error.message}`);
  process.exit(1);
});
