/**
 * The six-house scene — `?scene=six`.
 *
 * The thirty-row board is spread across the metro on purpose: it is a market,
 * and a market is what CRUISE is for. That makes it the wrong dataset for
 * showing the near-field effects, because no six of those rows sit close enough
 * together to be in frame at once — the tightest 600 m cluster in the whole set
 * holds two houses, and they share a signal type.
 *
 * So this is its own block: six houses in Oakhurst inside about 500 m, covering
 * all five signal types, which is the only way a single shot can show a red
 * heartbeat, an amber shimmer and a cyan segment travelling round a parcel at
 * the same time. That is the scene's entire reason to exist.
 *
 * Same schema, same validator, same derived scores as the main board. Nothing
 * here says which house is gold: the ranking decides, exactly as it does for
 * `findMoney`. Addresses and money are invented; only the footprints these rows
 * snap to are real (see `sixHouseGeometry.js`).
 */

function signal(type, confidence, effectiveDate, source) {
  return { type, confidence, effectiveDate, source };
}

function deal(purchase, rehab, arv, rent) {
  return { purchase, rehab, arv, rent };
}

const CHAMPION = 'MOCK/notice-of-sale — The Champion';
const SERVICER = 'MOCK/90-day delinquency — servicer feed';
const TAX_LIST = 'MOCK/DeKalb Tax Commissioner tax sale list';
const CODE = 'MOCK/code enforcement — DeKalb County';
const FMLS = 'MOCK/FMLS listing under comps';

export const SIX_HOUSE_PROPERTIES = Object.freeze([
  Object.freeze({
    id: 'DEMO-SIX-001',
    demo: true,
    address: '621 Third Ave, Decatur, GA 30030',
    neighborhood: 'Oakhurst',
    city: 'Decatur',
    county: 'dekalb',
    lat: 33.758444,
    lng: -84.307451,
    propertyType: 'sfr',
    beds: 3,
    baths: 2,
    sqft: 1740,
    yearBuilt: 1941,
    estimatedValue: 432000,
    estimatedEquityPct: 0.52,
    signals: [
      signal('FORECLOSURE', 0.94, '2026-08-05', CHAMPION),
    ],
    deal: deal(238000, 36000, 432000, 2900),
    note: 'Corner lot two streets off the Oakhurst village, tarp on the back slope since spring.',
  }),
  Object.freeze({
    id: 'DEMO-SIX-002',
    demo: true,
    address: '1344 Oakview Rd, Decatur, GA 30030',
    neighborhood: 'Oakhurst',
    city: 'Decatur',
    county: 'dekalb',
    lat: 33.757991,
    lng: -84.304421,
    propertyType: 'sfr',
    beds: 3,
    baths: 1,
    sqft: 1410,
    yearBuilt: 1929,
    estimatedValue: 388000,
    estimatedEquityPct: 0.34,
    signals: [
      signal('PREFORECLOSURE', 0.86, '2026-07-22', SERVICER),
    ],
    deal: deal(279000, 34000, 388000, 2550),
    note: 'Bungalow with a screened porch and a driveway that has not been cleared in months.',
  }),
  Object.freeze({
    id: 'DEMO-SIX-003',
    demo: true,
    address: '208 Winter Ave, Decatur, GA 30030',
    neighborhood: 'Oakhurst',
    city: 'Decatur',
    county: 'dekalb',
    lat: 33.757382,
    lng: -84.308008,
    propertyType: 'duplex',
    beds: 4,
    baths: 2,
    sqft: 2040,
    yearBuilt: 1953,
    estimatedValue: 455000,
    estimatedEquityPct: 0.44,
    signals: [
      signal('TAX_SALE', 0.88, '2026-08-11', TAX_LIST),
    ],
    deal: deal(281000, 49000, 455000, 3350),
    note: 'Side-by-side duplex backing onto the creek path, one unit dark all summer.',
  }),
  Object.freeze({
    id: 'DEMO-SIX-004',
    demo: true,
    address: '915 Mead Rd, Decatur, GA 30030',
    neighborhood: 'Oakhurst',
    city: 'Decatur',
    county: 'dekalb',
    lat: 33.756525,
    lng: -84.305219,
    propertyType: 'sfr',
    beds: 2,
    baths: 1,
    sqft: 1180,
    yearBuilt: 1936,
    estimatedValue: 341000,
    estimatedEquityPct: 0.31,
    signals: [
      signal('DISTRESS', 0.74, '2026-08-28', CODE),
    ],
    deal: deal(252000, 41000, 341000, 2200),
    note: 'Small frame cottage with an open county file on the rear addition and a leaning fence.',
  }),
  Object.freeze({
    id: 'DEMO-SIX-005',
    demo: true,
    address: '477 East Lake Dr, Decatur, GA 30030',
    neighborhood: 'Oakhurst',
    city: 'Decatur',
    county: 'dekalb',
    lat: 33.755604,
    lng: -84.307434,
    propertyType: 'townhouse',
    beds: 3,
    baths: 3,
    sqft: 1620,
    yearBuilt: 2004,
    estimatedValue: 398000,
    estimatedEquityPct: 0.27,
    signals: [
      signal('LISTED_OPPORTUNITY', 0.71, '2026-08-30', FMLS),
    ],
    deal: deal(312000, 18000, 398000, 2500),
    note: 'End unit facing the park, on the market since midsummer with no photographs of the kitchen.',
  }),
  Object.freeze({
    id: 'DEMO-SIX-006',
    demo: true,
    address: '1102 Fayetteville Rd, Decatur, GA 30030',
    neighborhood: 'Oakhurst',
    city: 'Decatur',
    county: 'dekalb',
    lat: 33.757876,
    lng: -84.306283,
    propertyType: 'sfr',
    beds: 4,
    baths: 2,
    sqft: 1960,
    yearBuilt: 1958,
    estimatedValue: 419000,
    estimatedEquityPct: 0.40,
    signals: [
      signal('FORECLOSURE', 0.83, '2026-09-02', CHAMPION),
      signal('DISTRESS', 0.69, '2026-08-14', CODE),
    ],
    deal: deal(273000, 45000, 419000, 2800),
    note: 'Split level under the power easement, gutters down on the north side and a boarded basement door.',
  }),
]);
