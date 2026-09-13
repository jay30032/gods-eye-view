#!/usr/bin/env node
/**
 * The street each house faces.
 *
 * "Show me the front" is only answerable if the product knows which way the
 * front is, and a building footprint on its own does not say. The convention
 * that a detached house presents its long wall to the street is a decent guess
 * and it is wrong often enough to matter — corner lots, flag lots, and anything
 * on a curve. So the front is derived from the real thing: the nearest
 * residential way in OpenStreetMap.
 *
 * What gets stored per row is a `street` block:
 *
 *   bearingDeg  compass bearing FROM the footprint centroid TO the nearest
 *               point on that street — i.e. the direction the front faces
 *   distanceM   how far away it is, so an implausible match can be spotted
 *   name        the street's name, for the report and for eyeballing it
 *   osmId       the way, so the claim is checkable
 *
 * `camera/orientation.js` turns that bearing into the footprint edge that
 * actually faces the street, and falls back to the long-axis convention for any
 * row this script could not resolve.
 *
 * Run by hand, like `fetch-footprints.mjs` and `fetch-parcels.mjs`, and for the
 * same reason: a unit suite that depends on Overpass is a unit suite that fails
 * when Overpass is busy.
 *
 *   node scripts/fetch-streets.mjs                # both datasets
 *   node scripts/fetch-streets.mjs --dataset six
 *   node scripts/fetch-streets.mjs --dry-run
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ATLANTA_DECATUR_GEOMETRY } from '../src/investor/mock/atlantaDecaturGeometry.js';
import { SIX_HOUSE_GEOMETRY } from '../src/investor/mock/sixHouseGeometry.js';
import { footprintCentroid, metresPerDegreeLng } from '../src/investor/mock/parcel.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const M_PER_DEG_LAT = 111_320;
const DEG = Math.PI / 180;

const DATASETS = {
  atlanta: {
    geometry: ATLANTA_DECATUR_GEOMETRY,
    title: 'Atlanta / Decatur mock rows',
    geometryPath: join(ROOT, 'src/investor/mock/atlantaDecaturGeometry.js'),
  },
  six: {
    geometry: SIX_HOUSE_GEOMETRY,
    title: 'six-house Oakhurst scene (?scene=six)',
    geometryPath: join(ROOT, 'src/investor/mock/sixHouseGeometry.js'),
  },
};

const SEARCH_RADIUS_M = 150;
const ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
];
/**
 * Overpass answers undici's default User-Agent with a bare 406. Identify the
 * caller — `fetch-footprints.mjs` learned this the hard way and lost a whole
 * run to it.
 */
const USER_AGENT = 'terrasignal-investor/1.0 (github.com/gods-eye-view; mock street bearing fetch)';
const REQUEST_TIMEOUT_MS = 45_000;
const POLITE_GAP_MS = 1_100;
const MAX_ATTEMPTS = 3;

/**
 * Ways a house can be said to front onto.
 *
 * `service` is deliberately absent: an alley or a parking aisle behind a house
 * is the nearest way remarkably often, and calling that the front would put the
 * "front" camera in the back garden.
 */
const STREET_TYPES = ['residential', 'living_street', 'unclassified', 'tertiary', 'secondary', 'primary'];

const arg = (name, fallback = null) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--')
    ? process.argv[i + 1]
    : fallback;
};
const HAS = (name) => process.argv.includes(`--${name}`);
const DRY_RUN = HAS('dry-run');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const number = (value, digits) => Number(Number(value).toFixed(digits));

/** [lon,lat] to local [east,north] metres about an origin. */
function toLocal(point, origin) {
  const mLng = metresPerDegreeLng(origin.lat);
  return [(point[0] - origin.lng) * mLng, (point[1] - origin.lat) * M_PER_DEG_LAT];
}

/** Closest point on segment ab to p, all in local metres. */
function closestOnSegment(p, a, b) {
  const abx = b[0] - a[0];
  const aby = b[1] - a[1];
  const lenSq = abx * abx + aby * aby;
  if (lenSq < 1e-9) return a;
  let t = ((p[0] - a[0]) * abx + (p[1] - a[1]) * aby) / lenSq;
  t = Math.max(0, Math.min(1, t));
  return [a[0] + abx * t, a[1] + aby * t];
}

function overpassQuery(lat, lng) {
  const filter = STREET_TYPES.join('|');
  return `[out:json][timeout:60];
way(around:${SEARCH_RADIUS_M},${lat},${lng})[highway~"^(${filter})$"];
out geom;`;
}

async function overpass(lat, lng) {
  let lastError = 'unknown';
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
        body: `data=${encodeURIComponent(overpassQuery(lat, lng))}`,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (!response.ok) {
        lastError = `HTTP ${response.status}`;
        await sleep(POLITE_GAP_MS * attempt);
        continue;
      }
      const body = await response.json();
      return { ok: true, elements: Array.isArray(body?.elements) ? body.elements : [] };
    } catch (error) {
      lastError = String(error?.message || error);
      await sleep(POLITE_GAP_MS * attempt);
    }
  }
  return { ok: false, reason: lastError, transport: true };
}

/**
 * The nearest street to a footprint centroid, and the bearing to it.
 *
 * The bearing is measured to the closest point ON the way, not to the way's
 * nearest node: nodes on a straight residential street can be fifty metres
 * apart, and using them would swing the "front" by tens of degrees depending on
 * where the mapper happened to click.
 */
function nearestStreet(elements, centroid) {
  let best = null;
  for (const way of elements) {
    const geometry = Array.isArray(way?.geometry) ? way.geometry : [];
    if (geometry.length < 2) continue;
    const points = geometry.map((node) => toLocal([node.lon, node.lat], centroid));
    for (let i = 0; i + 1 < points.length; i += 1) {
      const hit = closestOnSegment([0, 0], points[i], points[i + 1]);
      const distance = Math.hypot(hit[0], hit[1]);
      if (!best || distance < best.distance) {
        best = {
          distance,
          point: hit,
          name: way.tags?.name || null,
          highway: way.tags?.highway || null,
          osmId: `way/${way.id}`,
        };
      }
    }
  }
  if (!best) return null;
  // Compass bearing from the house to the street: atan2(east, north).
  const bearing = ((Math.atan2(best.point[0], best.point[1]) / DEG) + 360) % 360;
  return { ...best, bearingDeg: bearing };
}

function renderStreetBlock(street) {
  if (!street) {
    return `Object.freeze({
      source: 'osm',
      osmId: null,
      // No residential way within ${SEARCH_RADIUS_M} m. orientation.js falls back to
      // the long-axis convention for this row.
      bearingDeg: null,
    })`;
  }
  return `Object.freeze({
      source: 'osm',
      osmId: '${street.osmId}',
      name: ${street.name ? JSON.stringify(street.name) : 'null'},
      highway: '${street.highway}',
      bearingDeg: ${number(street.bearingDeg, 1)},
      distanceM: ${number(street.distance, 1)},
    })`;
}

/**
 * Insert or replace one row's `street:` block, anchored on the generator's own
 * formatting so a mistake cannot reach past the entry it is editing.
 */
function writeStreetBlock(source, id, block) {
  const opener = `  '${id}': Object.freeze({\n`;
  const start = source.indexOf(opener);
  if (start < 0) return { source, ok: false, reason: 'id not found' };
  const endMarker = '\n  }),\n';
  const end = source.indexOf(endMarker, start);
  if (end < 0) return { source, ok: false, reason: 'entry never closed' };

  const entry = source.slice(start, end + endMarker.length);
  const existing = entry.indexOf('\n    street: ');
  let rewritten;
  if (existing >= 0) {
    rewritten = `${entry.slice(0, existing)}\n    street: ${block},\n  }),\n`;
  } else {
    // Append just before the entry's closing brace.
    const body = entry.slice(0, entry.length - endMarker.length);
    rewritten = `${body}\n    street: ${block},\n  }),\n`;
  }
  return { source: source.slice(0, start) + rewritten + source.slice(end + endMarker.length), ok: true };
}

async function run(key) {
  const dataset = DATASETS[key];
  const results = [];

  for (const [id, record] of Object.entries(dataset.geometry)) {
    const ring = record?.building?.footprint?.[0] || null;
    if (!ring) {
      results.push({ id, ok: false, reason: 'no footprint — nothing to orient' });
      continue;
    }
    const centroid = footprintCentroid(ring);
    const answer = await overpass(centroid.lat, centroid.lng);
    if (!answer.ok) {
      results.push({ id, ok: false, transport: true, reason: answer.reason });
      process.stdout.write(`  ${id}  — transport failure: ${answer.reason}\n`);
      await sleep(POLITE_GAP_MS);
      continue;
    }
    const street = nearestStreet(answer.elements, centroid);
    results.push({ id, ok: Boolean(street), street });
    process.stdout.write(
      street
        ? `  ${id}  ${String(street.name || street.highway).padEnd(22)}  `
          + `bearing ${street.bearingDeg.toFixed(0).padStart(3)}°  ${street.distance.toFixed(0)} m\n`
        : `  ${id}  — no residential way within ${SEARCH_RADIUS_M} m\n`,
    );
    await sleep(POLITE_GAP_MS);
  }

  const found = results.filter((r) => r.ok);
  const transport = results.filter((r) => r.transport);

  // Same rule as the other two fetchers: a run that failed in transport
  // everywhere is a broken client, not a neighbourhood without roads.
  if (transport.length && !found.length) {
    console.error(`\n${key}: every lookup failed in transport — refusing to write.`);
    return { key, wrote: false };
  }
  if (DRY_RUN) {
    console.log(`\n${key}: ${found.length}/${results.length} street bearings (dry run)`);
    return { key, wrote: false };
  }

  let source = readFileSync(dataset.geometryPath, 'utf8');
  let written = 0;
  for (const result of results) {
    // A transport failure carries the existing block forward rather than
    // replacing a good bearing with a null.
    if (result.transport) continue;
    const outcome = writeStreetBlock(source, result.id, renderStreetBlock(result.street));
    if (!outcome.ok) {
      console.error(`  ${result.id}: could not write — ${outcome.reason}`);
      continue;
    }
    source = outcome.source;
    written += 1;
  }
  writeFileSync(dataset.geometryPath, source);
  console.log(`\n${key}: wrote ${written} street blocks (${found.length} with a bearing)`);
  return { key, wrote: true };
}

async function main() {
  const only = arg('dataset');
  const keys = only ? [only] : Object.keys(DATASETS);
  for (const key of keys) {
    if (!DATASETS[key]) {
      console.error(`unknown dataset "${key}"`);
      process.exitCode = 1;
      return;
    }
    console.log(`\n=== ${key}: ${DATASETS[key].title} ===`);
    await run(key);
  }
}

main().catch((error) => {
  console.error(`fetch-streets failed: ${error.message}`);
  process.exit(1);
});
