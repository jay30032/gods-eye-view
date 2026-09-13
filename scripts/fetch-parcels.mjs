#!/usr/bin/env node
/**
 * Real county parcel polygons for the mock rows.
 *
 * `fetch-footprints.mjs` gives every row a real OSM *building*. The lot around
 * it was, until now, synthesised — the footprint's oriented bounding box pushed
 * out by guessed setbacks. Reviewed on the tiles that box was plainly the wrong
 * object: it lay across the street and around a neighbour's house while drawn
 * in the gold that is supposed to mean "this property". So the synthetic parcel
 * is no longer rendered at all, and this script goes and gets the real one where
 * a county publishes it.
 *
 * Both counties the board covers serve parcels over public, keyless ArcGIS REST:
 *
 *   DeKalb  https://dcgis.dekalbcountyga.gov/hosted/rest/services/Parcels/MapServer/0
 *   Fulton  https://gismaps.fultoncountyga.gov/arcgispub2/rest/services/
 *             PropertyMapViewer/PropertyMapViewer/MapServer/11
 *
 * The query is point-in-polygon at the row's **footprint centroid**, not at the
 * authored coordinate: the centroid is the middle of the roof, so the parcel it
 * lands in is the parcel that house stands on. An authored coordinate can sit in
 * the street or in next door's garden, which is how you acquire a confident
 * outline around the wrong lot.
 *
 * ## Only geometry is kept
 *
 * These layers are cadastral: every response carries the current owner's NAME
 * and MAILING ADDRESS. This repository's rows are invented, and every signal on
 * them — the foreclosures, the tax sales, the delinquencies — is fiction. Writing
 * a real person's name next to a fabricated Notice of Sale Under Power would be
 * defamatory in effect whatever the disclaimer said, so the owner, address and
 * assessment fields are dropped at the parse boundary and never reach the tree.
 * What is written is the ring, the public parcel identifier, and the area.
 *
 * Run by hand, like `fetch-footprints.mjs`, and for the same reason: a unit
 * suite that depends on someone else's server is a unit suite that fails when
 * their server is busy.
 *
 *   node scripts/fetch-parcels.mjs                # both datasets
 *   node scripts/fetch-parcels.mjs --dataset six  # just the six-house scene
 *   node scripts/fetch-parcels.mjs --dry-run      # report, write nothing
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ATLANTA_DECATUR_PROPERTIES } from '../src/investor/mock/atlantaDecatur.js';
import { SIX_HOUSE_PROPERTIES } from '../src/investor/mock/sixHouse.js';
import { ATLANTA_DECATUR_GEOMETRY } from '../src/investor/mock/atlantaDecaturGeometry.js';
import { SIX_HOUSE_GEOMETRY } from '../src/investor/mock/sixHouseGeometry.js';
import { footprintCentroid, ringArea, toLocal, SQ_M_PER_ACRE } from '../src/investor/mock/parcel.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const DATASETS = {
  atlanta: {
    rows: ATLANTA_DECATUR_PROPERTIES,
    geometry: ATLANTA_DECATUR_GEOMETRY,
    title: 'Atlanta / Decatur mock rows',
    geometryPath: join(ROOT, 'src/investor/mock/atlantaDecaturGeometry.js'),
  },
  six: {
    rows: SIX_HOUSE_PROPERTIES,
    geometry: SIX_HOUSE_GEOMETRY,
    title: 'six-house Oakhurst scene (?scene=six)',
    geometryPath: join(ROOT, 'src/investor/mock/sixHouseGeometry.js'),
  },
};

/**
 * One public parcel layer per county.
 *
 * `source` is what lands in the data and what `nearFieldEffects.js` allow-lists
 * before it will draw a lot line at all. A ring with any other source — notably
 * `'synthetic'` — is data, not a survey, and is never rendered.
 */
const COUNTIES = {
  dekalb: {
    source: 'dekalb-gis',
    attribution: 'DeKalb County GIS Department',
    url: 'https://dcgis.dekalbcountyga.gov/hosted/rest/services/Parcels/MapServer/0/query',
    idField: 'PARCELID',
  },
  fulton: {
    source: 'fulton-gis',
    attribution: 'Fulton County GIS (Property Map Viewer)',
    url: 'https://gismaps.fultoncountyga.gov/arcgispub2/rest/services/PropertyMapViewer/PropertyMapViewer/MapServer/11/query',
    idField: 'ParcelID',
  },
};

const USER_AGENT = 'terrasignal-investor/1.0 (github.com/gods-eye-view; mock parcel fetch)';
const REQUEST_TIMEOUT_MS = 45_000;
const POLITE_GAP_MS = 400;
const MAX_ATTEMPTS = 3;

/**
 * Sanity bounds on a residential lot, in square metres.
 *
 * A cadastral layer will happily hand back a subdivision common area, a road
 * right-of-way, a church or the whole apartment complex if the centroid lands in
 * one. Anything outside this band is refused and the row keeps no lot line,
 * which is the same answer as "this county has nothing for you" and equally
 * honest.
 *
 * The ceiling is 2 acres and it earns its keep: on the first run DEMO-SIX-004
 * resolved to a 5.67-acre DeKalb parcel classed E1 — Oakhurst Elementary
 * School, whose grounds the row's OSM footprint happens to stand on. Drawing
 * that ring would have reproduced the bug this whole change exists to fix, at
 * the scale of a city block. An in-town Atlanta or Decatur house does not sit
 * on two acres; anything that says otherwise is not the lot for this house.
 */
const MIN_PARCEL_M2 = 120;
const MAX_PARCEL_M2 = 2 * SQ_M_PER_ACRE;

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

/** Is a [lon,lat] point inside a ring? Ray casting, good enough at lot scale. */
function pointInRing(point, ring) {
  const [x, y] = point;
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    const straddles = (yi > y) !== (yj > y);
    if (straddles && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Area of a [lon,lat] ring in square metres, via a local tangent plane. */
function ringAreaM2(ring) {
  if (!Array.isArray(ring) || ring.length < 3) return 0;
  const origin = { lng: ring[0][0], lat: ring[0][1] };
  return Math.abs(ringArea(ring.map((p) => toLocal(p, origin))));
}

/**
 * Drop the closing duplicate vertex and any repeated points.
 *
 * ArcGIS closes its rings; `GroundPolylineGeometry` is asked to `loop`, so a
 * duplicated first/last vertex becomes a zero-length segment, which Cesium
 * rejects outright.
 */
function cleanRing(ring) {
  const out = [];
  for (const point of ring) {
    if (!Array.isArray(point) || point.length < 2) continue;
    const lon = Number(point[0]);
    const lat = Number(point[1]);
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue;
    const last = out[out.length - 1];
    if (last && Math.abs(last[0] - lon) < 1e-9 && Math.abs(last[1] - lat) < 1e-9) continue;
    out.push([lon, lat]);
  }
  while (out.length > 1) {
    const first = out[0];
    const last = out[out.length - 1];
    if (Math.abs(first[0] - last[0]) < 1e-9 && Math.abs(first[1] - last[1]) < 1e-9) out.pop();
    else break;
  }
  return out;
}

/**
 * The parcel containing a point, or a reason there is not one.
 *
 * Every attribute except the public parcel id is discarded here — see the file
 * header. Nothing downstream ever sees an owner name because nothing downstream
 * is ever handed one.
 */
async function queryParcel(county, { lat, lng }) {
  const config = COUNTIES[county];
  if (!config) return { ok: false, reason: `no parcel layer configured for county ${county}` };

  const params = new URLSearchParams({
    geometry: JSON.stringify({ x: lng, y: lat, spatialReference: { wkid: 4326 } }),
    geometryType: 'esriGeometryPoint',
    inSR: '4326',
    spatialRel: 'esriSpatialRelIntersects',
    outFields: config.idField,
    returnGeometry: 'true',
    outSR: '4326',
    f: 'json',
  });

  let lastError = 'unknown';
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    try {
      const response = await fetch(`${config.url}?${params}`, {
        headers: { Accept: 'application/json', 'User-Agent': USER_AGENT },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (!response.ok) {
        lastError = `HTTP ${response.status}`;
        await sleep(POLITE_GAP_MS * attempt);
        continue;
      }
      const body = await response.json();
      if (body?.error) {
        lastError = `service error ${body.error.code}: ${body.error.message}`;
        await sleep(POLITE_GAP_MS * attempt);
        continue;
      }
      const features = Array.isArray(body?.features) ? body.features : [];
      if (!features.length) return { ok: false, reason: 'no parcel at the footprint centroid' };

      // Rings first: an ArcGIS polygon may carry holes and islands, and the one
      // that matters is the one the roof is standing in.
      const candidates = [];
      for (const feature of features) {
        for (const raw of feature?.geometry?.rings || []) {
          const ring = cleanRing(raw);
          if (ring.length >= 3) candidates.push({ ring, feature });
        }
      }
      const hit = candidates.find(({ ring }) => pointInRing([lng, lat], ring));
      if (!hit) return { ok: false, reason: 'parcel returned but the centroid is outside its ring' };

      const areaM2 = ringAreaM2(hit.ring);
      if (areaM2 < MIN_PARCEL_M2 || areaM2 > MAX_PARCEL_M2) {
        return { ok: false, reason: `implausible lot area ${Math.round(areaM2)} m²` };
      }

      return {
        ok: true,
        parcel: {
          source: config.source,
          attribution: config.attribution,
          // The public cadastral identifier. Not personal data, and it is what
          // makes the claim checkable against the county's own viewer.
          parcelId: String(hit.feature?.attributes?.[config.idField] ?? '').trim() || null,
          areaM2,
          areaAcres: areaM2 / SQ_M_PER_ACRE,
          ring: hit.ring,
        },
      };
    } catch (error) {
      lastError = String(error?.message || error);
      await sleep(POLITE_GAP_MS * attempt);
    }
  }
  return { ok: false, reason: `transport failure: ${lastError}`, transport: true };
}

function formatRing(ring, indent) {
  const pad = ' '.repeat(indent);
  return `[\n${ring.map(([lon, lat]) => `${pad}  [${number(lon, 7)}, ${number(lat, 7)}],`).join('\n')}\n${pad}]`;
}

function renderParcelBlock(parcel) {
  if (!parcel) return 'null';
  if (parcel.source !== 'dekalb-gis' && parcel.source !== 'fulton-gis') {
    // An existing synthetic block, passed through untouched.
    return parcel.raw;
  }
  return `Object.freeze({
      source: '${parcel.source}',
      attribution: ${JSON.stringify(parcel.attribution)},
      parcelId: ${parcel.parcelId ? `'${parcel.parcelId}'` : 'null'},
      areaM2: ${number(parcel.areaM2, 1)},
      areaAcres: ${number(parcel.areaAcres, 4)},
      ring: Object.freeze(${formatRing(parcel.ring, 6)}),
    })`;
}

/**
 * Replace one row's `parcel:` block in the generated geometry file.
 *
 * Deliberately anchored on the generator's own formatting — the entry opener
 * for that exact id, then the entry's closing `  }),` — so a mistake cannot
 * reach past the row it is editing and rewrite someone else's geometry.
 */
function replaceParcelBlock(source, id, block) {
  const opener = `  '${id}': Object.freeze({\n`;
  const start = source.indexOf(opener);
  if (start < 0) return { source, ok: false, reason: 'id not found in geometry file' };
  const endMarker = '\n  }),\n';
  const end = source.indexOf(endMarker, start);
  if (end < 0) return { source, ok: false, reason: 'entry never closed' };

  const entry = source.slice(start, end + endMarker.length);
  const parcelAt = entry.indexOf('\n    parcel: ');
  if (parcelAt < 0) return { source, ok: false, reason: 'entry carries no parcel field' };

  const head = entry.slice(0, parcelAt);
  const rewritten = `${head}\n    parcel: ${block},\n  }),\n`;
  return { source: source.slice(0, start) + rewritten + source.slice(end + endMarker.length), ok: true };
}

/** Swap the file header's synthetic-parcel paragraph for what is now true. */
function rewriteHeader(source, stats, generatedAt) {
  // The title line is written by fetch-footprints.mjs and is no longer true.
  source = source.replace(
    /^( \* Building footprints and )synthetic parcels( for the )/m,
    '$1county parcels$2',
  );
  const open = ' * `parcel` is NOT a real lot line.';
  const start = source.indexOf(open);
  if (start < 0) return source;
  const close = source.indexOf(' * ---------------------------------------------------------------------------\n */', start);
  if (close < 0) return source;

  const replacement = ` * \`parcel\` is a REAL county lot line wherever \`parcel.source\` is
 * \`'dekalb-gis'\` or \`'fulton-gis'\`. Those rings come from the counties' public
 * ArcGIS REST parcel layers, fetched by \`node scripts/fetch-parcels.mjs\` on
 * ${generatedAt}, and each block carries its own \`attribution\`:
 *
 *   DeKalb County GIS Department
 *   Fulton County GIS (Property Map Viewer)
 *
 * ONLY the ring, the public parcel identifier and the area are kept. Those
 * layers are cadastral and also serve the current owner's name and mailing
 * address; the rows in this repository are invented and every signal on them is
 * fiction, so no owner identity is stored here and none ever should be.
 *
 * A row whose \`parcel.source\` is still \`'synthetic'\` has NO county polygon —
 * that block is the old oriented-bounding-box guess, it is kept only as data,
 * and the near-field layer refuses to draw it. Such a row renders its building
 * outline and nothing else.
 *
 * ${stats.real} of ${stats.total} rows carry a surveyed county parcel.
`;
  return source.slice(0, start) + replacement + source.slice(close);
}

async function run(key) {
  const dataset = DATASETS[key];
  const countyOf = new Map(dataset.rows.map((row) => [row.id, row.county]));
  const generatedAt = new Date().toISOString().slice(0, 10);

  const results = [];
  for (const [id, record] of Object.entries(dataset.geometry)) {
    const ring = record?.building?.footprint?.[0] || null;
    if (!ring) {
      results.push({ id, ok: false, reason: 'no footprint — nothing to look up' });
      continue;
    }
    const centroid = footprintCentroid(ring);
    const county = countyOf.get(id);
    const found = await queryParcel(county, centroid);
    results.push({ id, county, ...found });
    process.stdout.write(
      found.ok
        ? `  ${id}  ${county.padEnd(6)}  ${found.parcel.parcelId || '(no id)'}  `
          + `${Math.round(found.parcel.areaM2)} m² / ${found.parcel.areaAcres.toFixed(2)} ac\n`
        : `  ${id}  ${String(county).padEnd(6)}  — ${found.reason}\n`,
    );
    await sleep(POLITE_GAP_MS);
  }

  const found = results.filter((r) => r.ok);
  const transportFailures = results.filter((r) => r.transport);

  /**
   * A run where every row failed in transport is a broken client, not a county
   * without parcels in it — the same rule `fetch-footprints.mjs` learned the
   * hard way. Refuse to write rather than quietly deleting good geometry.
   */
  if (transportFailures.length && !found.length) {
    console.error(`\n${key}: every lookup failed in transport — refusing to write.`);
    console.error(`  first failure: ${transportFailures[0].reason}`);
    return { key, wrote: false, found: 0, total: results.length };
  }

  if (DRY_RUN) {
    console.log(`\n${key}: ${found.length}/${results.length} parcels found (dry run, nothing written)`);
    return { key, wrote: false, found: found.length, total: results.length };
  }

  let source = readFileSync(dataset.geometryPath, 'utf8');
  let written = 0;
  for (const result of results) {
    if (!result.ok) continue; // carry the existing block forward untouched
    const outcome = replaceParcelBlock(source, result.id, renderParcelBlock(result.parcel));
    if (!outcome.ok) {
      console.error(`  ${result.id}: could not rewrite — ${outcome.reason}`);
      continue;
    }
    source = outcome.source;
    written += 1;
  }
  source = rewriteHeader(source, { real: written, total: results.length }, generatedAt);
  writeFileSync(dataset.geometryPath, source);
  console.log(`\n${key}: wrote ${written} county parcels into ${dataset.geometryPath}`);
  return { key, wrote: true, found: found.length, total: results.length };
}

async function main() {
  const only = arg('dataset');
  const keys = only ? [only] : Object.keys(DATASETS);
  for (const key of keys) {
    if (!DATASETS[key]) {
      console.error(`unknown dataset "${key}" — expected one of ${Object.keys(DATASETS).join(', ')}`);
      process.exitCode = 1;
      return;
    }
    console.log(`\n=== ${key}: ${DATASETS[key].title} ===`);
    await run(key);
  }
}

main().catch((error) => {
  console.error(`fetch-parcels failed: ${error.message}`);
  process.exit(1);
});
