#!/usr/bin/env node
/**
 * Real building footprints for the mock inventory, from OpenStreetMap.
 *
 * The addresses and the money in `atlantaDecatur.js` are invented. The
 * *geometry* is not, and it cannot be: the near-field effects layer paints a
 * glowing outline around a specific roof, and a house drawn 15 m off is a house
 * pointing at the wrong family's home. So the footprints come from OSM and
 * nowhere else.
 *
 * Explicitly NOT from Google's 3D tiles. The tileset is licensed imagery, not a
 * data source — deriving vector geometry from it is a terms violation and the
 * result could not be committed to this repo. Overpass or nothing.
 *
 * For each row this asks Overpass for buildings within 120 m, keeps the ones
 * that read as a dwelling, and takes the nearest of the best-tagged tier. If
 * nothing qualifies the row gets `footprint: null` and is reported: the effects
 * layer degrades to a parcel glow and a beacon, which says "somewhere here"
 * honestly, instead of outlining a neighbour.
 *
 * Run once, by hand. Not part of `npm test` — a unit suite that depends on a
 * third-party API is a unit suite that fails when someone else's server is busy.
 *
 *   node scripts/fetch-footprints.mjs [--dry-run] [--no-snap] [--only ID,ID]
 *
 * Output: src/investor/mock/atlantaDecaturGeometry.js, plus in-place lat/lng
 * snapping of each row in atlantaDecatur.js to its footprint centroid.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { ATLANTA_DECATUR_PROPERTIES } from '../src/investor/mock/atlantaDecatur.js';
import { SIX_HOUSE_PROPERTIES } from '../src/investor/mock/sixHouse.js';
import {
  PARCEL_END_M,
  PARCEL_MAX_ACRES,
  PARCEL_SIDE_M,
  distanceM,
  footprintCentroid,
  parcelFromFootprint,
} from '../src/investor/mock/parcel.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * The two authored datasets, each with the file its geometry is written to and
 * the file whose lat/lng get snapped. Same pipeline for both — the six-house
 * scene is a separate block of rows, not a separate kind of data.
 */
const DATASETS = {
  atlanta: {
    rows: ATLANTA_DECATUR_PROPERTIES,
    exportName: 'ATLANTA_DECATUR_GEOMETRY',
    title: 'Atlanta / Decatur mock rows',
    geometryPath: join(ROOT, 'src/investor/mock/atlantaDecaturGeometry.js'),
    datasetPath: join(ROOT, 'src/investor/mock/atlantaDecatur.js'),
  },
  six: {
    rows: SIX_HOUSE_PROPERTIES,
    exportName: 'SIX_HOUSE_GEOMETRY',
    title: 'six-house Oakhurst scene (?scene=six)',
    geometryPath: join(ROOT, 'src/investor/mock/sixHouseGeometry.js'),
    datasetPath: join(ROOT, 'src/investor/mock/sixHouse.js'),
  },
};

const SEARCH_RADIUS_M = 120;
const ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
];
const REQUEST_TIMEOUT_MS = 45_000;
/**
 * Overpass answers undici's default User-Agent with a bare `406 Not
 * Acceptable` — not a rate limit, not a bad query, just a refusal to serve an
 * unidentified client. The first run of this script missed all 30 rows for
 * that reason alone. Identify the caller.
 */
const USER_AGENT = 'terrasignal-investor/1.0 (github.com/gods-eye-view; mock footprint fetch)';
const POLITE_GAP_MS = 1_100;
const MAX_ATTEMPTS = 3;

/**
 * Tag tiers, best first. A dwelling tag beats a bare `building=yes` at any
 * distance, because "the nearest polygon" and "the nearest house" are not the
 * same question and only the second one is being asked.
 */
const TIERS = [
  new Set(['house', 'detached', 'semidetached_house', 'bungalow', 'residential', 'terrace']),
  new Set(['yes']),
];

/** Building values that are definitively not the house on the row. */
const SKIP_BUILDING = new Set([
  'apartments', 'commercial', 'retail', 'office', 'industrial', 'warehouse',
  'school', 'university', 'college', 'kindergarten', 'church', 'chapel',
  'cathedral', 'mosque', 'synagogue', 'temple', 'religious', 'civic',
  'government', 'public', 'hospital', 'hotel', 'supermarket', 'garage',
  'garages', 'carport', 'shed', 'roof', 'hut', 'service', 'barn',
  'greenhouse', 'construction', 'ruins', 'transportation', 'train_station',
  'stadium', 'sports_hall', 'parking', 'fire_station', 'dormitory',
]);

/**
 * Non-building tags that unmask a `building=yes` as somewhere with a front
 * desk. Decatur Square is ringed with them, and the row nearest the Square
 * would otherwise light up the city hall.
 */
const SKIP_TAG_KEYS = ['amenity', 'shop', 'tourism', 'office', 'leisure', 'healthcare', 'craft', 'club'];

/**
 * A footprint this small is a shed, a porch roof, or a traced garage. The floor
 * started at 45 and let a 46 m² outbuilding win a row whose house is 1,740
 * sqft; the smallest dwelling on either board is 1,180 sqft, which cannot have
 * a footprint under about 70 m² on any number of storeys.
 */
const MIN_FOOTPRINT_M2 = 70;
/** A footprint this large is not a single-family roof, whatever it claims. */
const MAX_FOOTPRINT_M2 = 1_200;

const args = process.argv.slice(2);
const HAS = (name) => args.includes(`--${name}`);
const arg = (name, fallback = null) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : fallback;
};
const DRY_RUN = HAS('dry-run');
const NO_SNAP = HAS('no-snap');
const ONLY = (arg('only') || '').split(',').map((s) => s.trim()).filter(Boolean);
const DATASET_KEY = arg('dataset', 'atlanta');
const DATASET = DATASETS[DATASET_KEY];
if (!DATASET) {
  console.error(`unknown --dataset ${DATASET_KEY}; expected one of ${Object.keys(DATASETS).join(', ')}`);
  process.exit(1);
}
const { geometryPath: GEOMETRY_PATH, datasetPath: DATASET_PATH } = DATASET;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function overpassQuery(lat, lng) {
  return `[out:json][timeout:40];`
    + `(way["building"](around:${SEARCH_RADIUS_M},${lat},${lng});`
    + `relation["building"]["type"="multipolygon"](around:${SEARCH_RADIUS_M},${lat},${lng}););`
    + `out geom;`;
}

async function overpass(lat, lng) {
  let lastError = null;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    const endpoint = ENDPOINTS[(attempt - 1) % ENDPOINTS.length];
    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Accept: 'application/json',
          'User-Agent': USER_AGENT,
        },
        // A raw encoded string, not URLSearchParams: undici sets no charset on
        // the latter and Overpass has been seen to object to that too.
        body: `data=${encodeURIComponent(overpassQuery(lat, lng))}`,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (response.status === 429 || response.status === 504) {
        lastError = new Error(`HTTP ${response.status} from ${new URL(endpoint).host}`);
        await sleep(3_000 * attempt);
        continue;
      }
      if (!response.ok) throw new Error(`HTTP ${response.status} from ${new URL(endpoint).host}`);
      return await response.json();
    } catch (error) {
      lastError = error;
      await sleep(1_500 * attempt);
    }
  }
  throw lastError || new Error('overpass failed');
}

/** Planar area in m² of a [lon,lat] ring, for the size sanity gates. */
function ringAreaM2(ring) {
  const centroid = footprintCentroid(ring);
  if (!centroid) return 0;
  const mLng = 111_320 * Math.cos((centroid.lat * Math.PI) / 180);
  let sum = 0;
  for (let i = 0; i < ring.length; i += 1) {
    const a = ring[i];
    const b = ring[(i + 1) % ring.length];
    sum += ((a[0] - centroid.lng) * mLng) * ((b[1] - centroid.lat) * 111_320)
      - ((b[0] - centroid.lng) * mLng) * ((a[1] - centroid.lat) * 111_320);
  }
  return Math.abs(sum / 2);
}

function closeRing(points) {
  if (points.length < 3) return points;
  const first = points[0];
  const last = points[points.length - 1];
  if (first[0] === last[0] && first[1] === last[1]) return points.slice(0, -1);
  return points;
}

/** [lon,lat] rings for one Overpass element: outer first, then any holes. */
function ringsOf(element) {
  const toRing = (geometry) => closeRing(
    (geometry || [])
      .filter((n) => Number.isFinite(n?.lon) && Number.isFinite(n?.lat))
      .map((n) => [Number(n.lon.toFixed(7)), Number(n.lat.toFixed(7))]),
  );
  if (element.type === 'way') {
    const ring = toRing(element.geometry);
    return ring.length >= 3 ? [ring] : null;
  }
  if (element.type === 'relation') {
    const outers = [];
    const inners = [];
    for (const member of element.members || []) {
      if (member.type !== 'way') continue;
      const ring = toRing(member.geometry);
      if (ring.length < 3) continue;
      (member.role === 'inner' ? inners : outers).push(ring);
    }
    if (!outers.length) return null;
    // One building, one roof: the largest outer ring is the one to draw.
    outers.sort((a, b) => ringAreaM2(b) - ringAreaM2(a));
    return [outers[0], ...inners];
  }
  return null;
}

function tierOf(tags) {
  const value = String(tags?.building || '').toLowerCase();
  if (!value || SKIP_BUILDING.has(value)) return -1;
  for (const key of SKIP_TAG_KEYS) {
    if (tags[key]) return -1;
  }
  for (let i = 0; i < TIERS.length; i += 1) {
    if (TIERS[i].has(value)) return i;
  }
  return -1;
}

/**
 * The nearest qualifying dwelling to a row's authored coordinate.
 * @returns {{rings:Array, tier:number, distanceM:number, osm:string, tags:object}|null}
 */
function pickBuilding(elements, lat, lng) {
  const target = [lng, lat];
  const candidates = [];
  for (const element of elements || []) {
    const tier = tierOf(element.tags || {});
    if (tier < 0) continue;
    const rings = ringsOf(element);
    if (!rings) continue;
    const area = ringAreaM2(rings[0]);
    if (area < MIN_FOOTPRINT_M2 || area > MAX_FOOTPRINT_M2) continue;
    const centroid = footprintCentroid(rings[0]);
    if (!centroid) continue;
    const distance = distanceM(target, [centroid.lng, centroid.lat]);
    if (distance > SEARCH_RADIUS_M) continue;
    candidates.push({
      rings,
      tier,
      distanceM: distance,
      areaM2: area,
      osm: `${element.type}/${element.id}`,
      tags: element.tags || {},
      centroid,
    });
  }
  if (!candidates.length) return null;
  candidates.sort((a, b) => (a.tier - b.tier) || (a.distanceM - b.distanceM));
  return candidates[0];
}

const number = (value, digits) => Number(Number(value).toFixed(digits));

function formatRing(ring, indent) {
  const pad = ' '.repeat(indent);
  return `[\n${ring.map(([lon, latitude]) => `${pad}  [${number(lon, 7)}, ${number(latitude, 7)}],`).join('\n')}\n${pad}]`;
}

function renderGeometryFile(records, generatedAt) {
  const entries = records.map((record) => {
    const { id, building, parcel } = record;
    const buildingBlock = building
      ? `Object.freeze({
      source: 'osm',
      osmId: '${building.osm}',
      buildingTag: '${String(building.tags.building)}',
      distanceFromAuthoredM: ${number(building.distanceM, 1)},
      areaM2: ${number(building.areaM2, 1)},
      footprint: Object.freeze([
${building.rings.map((ring) => `        Object.freeze(${formatRing(ring, 8)}),`).join('\n')}
      ]),
    })`
      : `Object.freeze({
      source: 'osm',
      osmId: null,
      // No qualifying dwelling within ${SEARCH_RADIUS_M} m. The effects layer
      // degrades to the parcel glow and the beacon rather than outlining a
      // building that is not this one.
      footprint: null,
      reason: ${JSON.stringify(record.reason || 'no candidate')},
    })`;
    const parcelBlock = parcel
      ? `Object.freeze({
      source: 'synthetic',
      areaM2: ${number(parcel.areaM2, 1)},
      areaAcres: ${number(parcel.areaAcres, 4)},
      headingDeg: ${number(parcel.headingDeg, 1)},
      setbackScale: ${number(parcel.setbackScale, 3)},
      ring: Object.freeze(${formatRing(parcel.ring, 6)}),
    })`
      : 'null';
    return `  '${id}': Object.freeze({
    id: '${id}',
    centroid: ${record.centroid
      ? `Object.freeze({ lat: ${number(record.centroid.lat, 7)}, lng: ${number(record.centroid.lng, 7)} })`
      : 'null'},
    shiftM: ${record.shiftM == null ? 'null' : number(record.shiftM, 2)},
    building: ${buildingBlock},
    parcel: ${parcelBlock},
  }),`;
  });

  const withFootprint = records.filter((r) => r.building).length;
  return `/**
 * Building footprints and synthetic parcels for the ${DATASET.title}.
 *
 * GENERATED by \`node scripts/fetch-footprints.mjs\` on ${generatedAt}.
 * Do not hand-edit: re-run the script.
 *
 * ---------------------------------------------------------------------------
 * Building footprints (\`building.footprint\`, \`building.source === 'osm'\`)
 * are derived from OpenStreetMap data, © OpenStreetMap contributors, available
 * under the Open Database License (ODbL) v1.0:
 *   https://www.openstreetmap.org/copyright
 *   https://opendatacommons.org/licenses/odbl/1-0/
 * Any public use of this data must carry that attribution and share alike.
 *
 * The footprints are the ONLY surveyed geometry here. Nothing in this file is
 * derived from Google's photorealistic 3D tiles — that tileset is licensed
 * imagery, not a data source, and vectorising it would be a terms violation as
 * well as unredistributable.
 *
 * \`parcel\` is NOT a real lot line. There is no free parcel polygon for DeKalb
 * or Fulton, so each one is synthesised from the footprint's oriented bounding
 * box pushed out ${PARCEL_SIDE_M} m at the sides and ${PARCEL_END_M} m front and back, capped at
 * ${PARCEL_MAX_ACRES} acres (see \`parcel.js\`). It marks roughly where a lot would be. It
 * is not a survey and must never be presented as one.
 *
 * ${withFootprint} of ${records.length} rows resolved to a footprint.
 * ---------------------------------------------------------------------------
 */

export const ${DATASET.exportName} = Object.freeze({
${entries.join('\n')}
});

/** @returns {object|null} geometry record for a property id */
export function ${DATASET.exportName === 'SIX_HOUSE_GEOMETRY' ? 'sixHouseGeometryFor' : 'geometryFor'}(id) {
  return ${DATASET.exportName}[String(id || '').trim()] || null;
}

/** @returns {Array<Array<number>>|null} outer [lon,lat] ring of the building */
export function ${DATASET.exportName === 'SIX_HOUSE_GEOMETRY' ? 'sixHouseFootprintRing' : 'footprintRing'}(id) {
  return ${DATASET.exportName === 'SIX_HOUSE_GEOMETRY' ? 'sixHouseGeometryFor' : 'geometryFor'}(id)?.building?.footprint?.[0] || null;
}

/** @returns {Array<Array<number>>|null} the synthetic parcel ring */
export function ${DATASET.exportName === 'SIX_HOUSE_GEOMETRY' ? 'sixHouseParcelRing' : 'parcelRing'}(id) {
  return ${DATASET.exportName === 'SIX_HOUSE_GEOMETRY' ? 'sixHouseGeometryFor' : 'geometryFor'}(id)?.parcel?.ring || null;
}

/** Rows whose footprint lookup found nothing — these degrade to a parcel glow. */
export const ${DATASET.exportName === 'SIX_HOUSE_GEOMETRY' ? 'SIX_HOUSE_ROWS_WITHOUT_FOOTPRINT' : 'ROWS_WITHOUT_FOOTPRINT'} = Object.freeze([
${records.filter((r) => !r.building).map((r) => `  '${r.id}',`).join('\n')}
]);
`;
}

/**
 * Rewrite one row's lat/lng in place. Deliberately surgical: it matches the
 * two lines that follow an id and nothing else, so a bad regex cannot quietly
 * rewrite a dollar figure somewhere further down the file.
 */
function snapCoordinates(source, records) {
  let out = source;
  let changed = 0;
  for (const record of records) {
    if (!record.centroid) continue;
    const pattern = new RegExp(
      `(id: '${record.id}',[\\s\\S]{0,600}?\\n    lat: )(-?[0-9.]+)(,\\n    lng: )(-?[0-9.]+)(,)`,
    );
    const match = out.match(pattern);
    if (!match) {
      console.warn(`  ! could not locate lat/lng block for ${record.id} — left alone`);
      continue;
    }
    out = out.replace(
      pattern,
      `$1${number(record.centroid.lat, 6)}$3${number(record.centroid.lng, 6)}$5`,
    );
    changed += 1;
  }
  return { out, changed };
}

/**
 * Re-use the previous run's geometry for any row this run failed to resolve.
 * Mutates `records` in place and returns the ids it rescued.
 */
async function carryForward(records) {
  let previous = null;
  try {
    previous = await import(pathToFileURL(GEOMETRY_PATH).href + `?t=${Date.now()}`);
  } catch {
    return []; // first run, or the file was deleted on purpose
  }
  const table = previous?.[DATASET.exportName];
  if (!table) return [];
  const rescued = [];
  for (const record of records) {
    if (record.building) continue;
    const old = table[record.id];
    if (!old?.building?.footprint) continue;
    record.building = {
      rings: old.building.footprint.map((ring) => ring.map((point) => [...point])),
      tier: 0,
      distanceM: Number(old.building.distanceFromAuthoredM) || 0,
      areaM2: Number(old.building.areaM2) || 0,
      osm: old.building.osmId,
      tags: { building: old.building.buildingTag || 'yes' },
      centroid: old.centroid ? { ...old.centroid } : null,
    };
    record.parcel = old.parcel
      ? {
        ring: old.parcel.ring.map((point) => [...point]),
        areaM2: old.parcel.areaM2,
        areaAcres: old.parcel.areaAcres,
        headingDeg: old.parcel.headingDeg,
        setbackScale: old.parcel.setbackScale,
        source: 'synthetic',
      }
      : null;
    record.centroid = record.building.centroid;
    record.shiftM = record.building.distanceM;
    record.reason = null;
    rescued.push(record.id);
  }
  return rescued;
}

async function main() {
  const rows = DATASET.rows.filter((row) => !ONLY.length || ONLY.includes(row.id));
  console.log(`Overpass: ${DATASET_KEY} — ${rows.length} rows, ${SEARCH_RADIUS_M} m radius,`
    + ' nearest dwelling wins.\n');

  const records = [];
  const failures = [];

  for (const [index, row] of rows.entries()) {
    const label = `${String(index + 1).padStart(2)}/${rows.length} ${row.id}`;
    let picked = null;
    let reason = null;
    try {
      const data = await overpass(row.lat, row.lng);
      picked = pickBuilding(data.elements, row.lat, row.lng);
      if (!picked) reason = `no residential building within ${SEARCH_RADIUS_M} m`;
    } catch (error) {
      reason = `overpass error: ${String(error?.message || error).slice(0, 120)}`;
    }

    if (!picked) {
      failures.push({ id: row.id, address: row.address, reason });
      records.push({ id: row.id, building: null, parcel: null, centroid: null, shiftM: null, reason });
      console.log(`${label}  MISS  ${reason}`);
    } else {
      const parcel = parcelFromFootprint(picked.rings[0]);
      const shiftM = distanceM([row.lng, row.lat], [picked.centroid.lng, picked.centroid.lat]);
      records.push({
        id: row.id,
        building: picked,
        parcel,
        centroid: picked.centroid,
        shiftM,
      });
      console.log(`${label}  ${picked.osm.padEnd(16)} building=${String(picked.tags.building).padEnd(12)}`
        + ` ${picked.areaM2.toFixed(0).padStart(4)} m²  shift ${shiftM.toFixed(1).padStart(5)} m`
        + `  lot ${parcel ? parcel.areaAcres.toFixed(3) : '  -  '} ac`);
    }
    if (index < rows.length - 1) await sleep(POLITE_GAP_MS);
  }

  // Overpass is a shared, rate-limited, third-party service and a run that
  // gets throttled halfway through is normal. Carrying forward is not an
  // optimisation: without it, one 429 silently replaces a real footprint with
  // a null and the effects layer quietly degrades a house that was fine
  // yesterday. A miss may add a row to the degrade list; it may never remove
  // one from the surveyed list.
  const carried = await carryForward(records);
  if (carried.length) {
    console.log(`\ncarried ${carried.length} existing footprint(s) through a missed lookup:`
      + ` ${carried.join(', ')}`);
  }

  const resolvedCount = records.filter((r) => r.building).length;
  // A run where *every* row missed is a broken client, not a market without
  // houses in it — writing that file would quietly replace real geometry with
  // thirty nulls and the effects layer would degrade everywhere at once.
  if (!resolvedCount && !DRY_RUN) {
    console.error(`\nAll ${records.length} rows missed. Refusing to write ${GEOMETRY_PATH}`
      + ' — this is a transport failure, not an empty market. Nothing was changed.');
    process.exit(1);
  }

  const generatedAt = new Date().toISOString().slice(0, 10);
  const file = renderGeometryFile(records, generatedAt);

  if (DRY_RUN) {
    console.log(`\n--dry-run: would write ${GEOMETRY_PATH} (${file.length} bytes)`);
  } else {
    writeFileSync(GEOMETRY_PATH, file);
    console.log(`\nwrote ${GEOMETRY_PATH}`);
    if (!NO_SNAP) {
      const source = readFileSync(DATASET_PATH, 'utf8');
      const { out, changed } = snapCoordinates(source, records);
      writeFileSync(DATASET_PATH, out);
      console.log(`snapped ${changed} rows in ${DATASET_PATH}`);
    }
  }

  const resolved = records.filter((r) => r.building);
  const shifts = resolved.map((r) => r.shiftM).sort((a, b) => a - b);
  console.log(`\n${resolved.length}/${records.length} footprints resolved.`);
  if (shifts.length) {
    console.log(`coordinate shift: min ${shifts[0].toFixed(1)} m · median `
      + `${shifts[Math.floor(shifts.length / 2)].toFixed(1)} m · max ${shifts.at(-1).toFixed(1)} m`);
  }
  if (failures.length) {
    console.log(`\n${failures.length} row(s) without a footprint — these degrade to parcel glow + beacon:`);
    for (const f of failures) console.log(`  ${f.id}  ${f.address}\n      ${f.reason}`);
  }
}

main().catch((error) => {
  console.error(`fetch-footprints failed: ${error?.stack || error}`);
  process.exit(1);
});
