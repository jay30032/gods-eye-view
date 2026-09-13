/**
 * The DeKalb and Fulton public parcel layers, and what counts as residential.
 *
 * Shared by `fetch-parcels.mjs`, which wants the lot polygon, and by
 * `fetch-footprints.mjs`, which wants only to know whether a candidate building
 * is standing on a residential lot before it claims that building is somebody's
 * house.
 *
 * That second use exists because of a real miss. `DEMO-SIX-004` — authored as
 * "915 Mead Rd", a single-family row — matched OSM way/51282519, a `building=yes`
 * with no `amenity` tag and a perfectly ordinary 240 m² footprint. It is a
 * building on the grounds of **Oakhurst Elementary School**. No tag rule can
 * catch that: the tags are indistinguishable from a large house. The county
 * knows, though — the parcel under it is classed `E1`, exempt — so the check
 * that works is to ask the county what the land is, not to ask OSM what the
 * roof is.
 *
 * ## Class codes
 *
 * Both counties use the same Georgia convention in the field named below, and
 * sampling ~1,000 parcels around each market shows the same shape:
 *
 *   DeKalb  (CLASSDSCRP)  R3 x941, E1 x48, C3 x32, E3, E2, R9, E6, E5, R4, C9
 *   Fulton  (ClassCode)   R3 x1324, C3 x56, E1 x30, U3, I3, H3, C4, E2, R4 ...
 *
 * `R` is residential. `C` commercial, `E` exempt (schools, churches, parks),
 * `I` industrial, `U` utility, `H` historic/other. So the test is the leading
 * letter, and anything else — including a missing code — is **not** a
 * confirmed house lot.
 */

const USER_AGENT = 'terrasignal-investor/1.0 (github.com/gods-eye-view; mock geometry fetch)';
const REQUEST_TIMEOUT_MS = 45_000;
const MAX_ATTEMPTS = 3;
const RETRY_GAP_MS = 400;

export const COUNTIES = Object.freeze({
  dekalb: Object.freeze({
    source: 'dekalb-gis',
    attribution: 'DeKalb County GIS Department',
    url: 'https://dcgis.dekalbcountyga.gov/hosted/rest/services/Parcels/MapServer/0/query',
    idField: 'PARCELID',
    classField: 'CLASSDSCRP',
    siteAddressField: 'SITEADDRESS',
  }),
  fulton: Object.freeze({
    source: 'fulton-gis',
    attribution: 'Fulton County GIS (Property Map Viewer)',
    url: 'https://gismaps.fultoncountyga.gov/arcgispub2/rest/services/PropertyMapViewer/PropertyMapViewer/MapServer/11/query',
    idField: 'ParcelID',
    classField: 'ClassCode',
    siteAddressField: 'Address',
  }),
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Is this a residential lot?
 *
 * Deliberately three-valued rather than boolean. "The county says this is a
 * house lot", "the county says it is a school", and "the county did not
 * answer" are three different facts, and collapsing the third into either of
 * the others is how a network blip either rejects every building in the market
 * or quietly re-admits the school.
 *
 * @returns {true|false|null} null when there is no code to judge
 */
export function isResidentialClass(code) {
  const value = String(code ?? '').trim().toUpperCase();
  if (!value) return null;
  return value.startsWith('R');
}

/**
 * The parcel containing a point.
 *
 * Returns only what may be stored: the ring, the public parcel identifier, the
 * area, the class code, and the parcel's own SITE address. These layers are
 * cadastral and also serve the current owner's NAME and MAILING address — the
 * rows in this repository are invented and every signal on them is fiction, so
 * owner identity is dropped here, at the boundary, and never reaches a caller.
 *
 * The site address is a different category: it is the property's public address
 * rather than a person, and it is kept for one purpose only — so the
 * fictional-address rule in `src/investor/mock/siteAddress.js` can be checked
 * instead of merely asserted. Nothing renders it.
 *
 * @returns {{ok:true, feature:object}|{ok:false, reason:string, transport?:boolean}}
 */
export async function queryParcelAt(county, { lat, lng }, { geometry = true } = {}) {
  const config = COUNTIES[county];
  if (!config) return { ok: false, reason: `no parcel layer for county ${county}` };

  const params = new URLSearchParams({
    geometry: JSON.stringify({ x: lng, y: lat, spatialReference: { wkid: 4326 } }),
    geometryType: 'esriGeometryPoint',
    inSR: '4326',
    spatialRel: 'esriSpatialRelIntersects',
    outFields: `${config.idField},${config.classField},${config.siteAddressField}`,
    returnGeometry: geometry ? 'true' : 'false',
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
        await sleep(RETRY_GAP_MS * attempt);
        continue;
      }
      const body = await response.json();
      if (body?.error) {
        lastError = `service error ${body.error.code}: ${body.error.message}`;
        await sleep(RETRY_GAP_MS * attempt);
        continue;
      }
      const features = Array.isArray(body?.features) ? body.features : [];
      if (!features.length) return { ok: false, reason: 'no parcel at that point' };
      return { ok: true, features, config };
    } catch (error) {
      lastError = String(error?.message || error);
      await sleep(RETRY_GAP_MS * attempt);
    }
  }
  return { ok: false, reason: `transport failure: ${lastError}`, transport: true };
}

/**
 * What class of land is this point on?
 *
 * The cheap version of {@link queryParcelAt} — no geometry over the wire,
 * because the caller only wants to know whether to keep looking.
 *
 * @returns {{residential:true|false|null, classCode:string|null,
 *   parcelId:string|null, reason?:string, transport?:boolean}}
 */
export async function landClassAt(county, point) {
  const answer = await queryParcelAt(county, point, { geometry: false });
  if (!answer.ok) {
    return {
      residential: null,
      classCode: null,
      parcelId: null,
      reason: answer.reason,
      transport: Boolean(answer.transport),
    };
  }
  const attributes = answer.features[0]?.attributes || {};
  const classCode = attributes[answer.config.classField] ?? null;
  return {
    residential: isResidentialClass(classCode),
    classCode: classCode === null ? null : String(classCode).trim(),
    parcelId: String(attributes[answer.config.idField] ?? '').trim() || null,
  };
}
