/**
 * The fictional-address rule.
 *
 * Every row in this repository is invented, and every signal on it — the
 * foreclosures, the tax sales, the code-enforcement files, the delinquencies —
 * is fiction. The footprints and lot lines under them are real, because a demo
 * that outlines nothing real does not read as a demo of anything. That leaves
 * one thing that must never line up:
 *
 *   **A mock signal is never attached to a real site address.**
 *
 * A row may stand on a real building. It may not also *name* that building. The
 * moment an authored address matches the address the county has for the parcel
 * the footprint sits on, the product stops saying "here is roughly what this
 * looks like" and starts saying "this specific house is in foreclosure" about a
 * house that is not.
 *
 * The rule is enforced two ways. `fetch-parcels.mjs` refuses to write a parcel
 * whose site address matches the row it belongs to, and `siteAddress.test.mjs`
 * checks every row in both datasets against the stored addresses on every
 * `npm test` — so a later hand-edit of an authored address is caught even
 * though no fetcher has run since.
 *
 * ## Why the county's site address is stored at all
 *
 * It is the one piece of county data kept beyond the geometry, and it is kept
 * precisely so the rule above can be *checked* rather than merely asserted.
 * Without it the test would have nothing to compare against.
 *
 * It is public record and it is the property's own address, which is a
 * different category from the **owner's name and mailing address** — those are
 * dropped at the parse boundary and are never stored (see `fetch-parcels.mjs`).
 * It also adds no identifying power the file did not already have: every record
 * already carries the exact footprint polygon and the county parcel id, either
 * of which locates the property far more precisely than a street address.
 *
 * Pure string handling, no data imports, so the test and the fetcher share one
 * definition of "the same address".
 */

/**
 * Street-type abbreviations, collapsed to one spelling.
 *
 * The two sides of the comparison are written by different hands: the authored
 * rows use postal abbreviations ("915 Mead Rd") and the counties spell them out
 * ("1305 Oakview Road"). Without this, every comparison would come back
 * "different" and the rule would pass by accident forever, which is worse than
 * having no rule at all.
 */
const STREET_TYPES = Object.freeze({
  rd: 'road',
  road: 'road',
  st: 'street',
  street: 'street',
  ave: 'avenue',
  av: 'avenue',
  avenue: 'avenue',
  dr: 'drive',
  drive: 'drive',
  ln: 'lane',
  lane: 'lane',
  ct: 'court',
  court: 'court',
  pl: 'place',
  place: 'place',
  blvd: 'boulevard',
  boulevard: 'boulevard',
  ter: 'terrace',
  terr: 'terrace',
  terrace: 'terrace',
  trl: 'trail',
  trail: 'trail',
  pkwy: 'parkway',
  parkway: 'parkway',
  cir: 'circle',
  circle: 'circle',
  hwy: 'highway',
  highway: 'highway',
  sq: 'square',
  square: 'square',
  way: 'way',
  run: 'run',
  row: 'row',
  walk: 'walk',
  path: 'path',
});

/** Compass suffixes, likewise. "NE" and "Northeast" are the same street. */
const DIRECTIONS = Object.freeze({
  n: 'n',
  north: 'n',
  s: 's',
  south: 's',
  e: 'e',
  east: 'e',
  w: 'w',
  west: 'w',
  ne: 'ne',
  northeast: 'ne',
  nw: 'nw',
  northwest: 'nw',
  se: 'se',
  southeast: 'se',
  sw: 'sw',
  southwest: 'sw',
});

function tokenize(address) {
  return String(address || '')
    // Everything from the first comma is city, state and postcode. Cutting
    // there first is what keeps the "East" of "East Point" from being read as
    // the trailing directional of "2799 Main St" — which would have made that
    // row's key differ from the county's for a reason that has nothing to do
    // with the street, and a false "different" is the dangerous direction: it
    // lets a real address through in silence.
    .split(',')[0]
    .toLowerCase()
    .replace(/[.,#]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .filter(Boolean);
}

/**
 * The house number and street of an address, canonicalised.
 *
 * Parsing is anchored on the **street type**, not on commas, because the two
 * formats punctuate differently: an authored row reads
 * "915 Mead Rd, Decatur, GA 30030" and DeKalb returns
 * "1305 Oakview Road Decatur, GA 30030" — with the city running straight on
 * after the street with no comma at all. Anchoring on the suffix means
 * everything after it can simply be dropped, so no list of city names is needed
 * and "East Point" never has to be told apart from the direction "east".
 *
 * The key is therefore `<number> [leading direction] <street name> <type>`. A
 * *leading* direction is kept because it is unambiguously part of the name —
 * "North Highland Ave" — while a trailing one is dropped for the reason above.
 *
 * @returns {{number:string, street:string, key:string}|null} null when there is
 *   no house number and street to compare
 */
export function addressKey(address) {
  const tokens = tokenize(address);
  if (tokens.length < 2) return null;

  // A leading house number, possibly hyphenated or with a unit letter (12A).
  const first = tokens[0];
  if (!/^\d+[a-z]?(-\d+[a-z]?)?$/.test(first)) return null;
  const number = first.replace(/[a-z]/g, '');

  const rest = tokens.slice(1);
  // Where the street type sits. The FIRST one wins: "Main St" inside
  // "Main St Court" would be the odd case, and taking the first keeps a city
  // that happens to contain a street word from being read as the suffix.
  const typeAt = rest.findIndex((token) => Object.hasOwn(STREET_TYPES, token));

  let nameTokens;
  let type = '';
  if (typeAt > 0) {
    nameTokens = rest.slice(0, typeAt);
    type = STREET_TYPES[rest[typeAt]];
    // Whatever follows the street type is dropped, INCLUDING a trailing
    // directional. It cannot be told from a city: "2799 Main St, East Point"
    // and "2799 Main Street East Point" differ only in a comma, and reading
    // that "East" as a quadrant made the same address compare as two. Dropping
    // it can only make two streets look alike — "Main St NE" and "Main St SW" —
    // which fails the rule LOUDLY and gets investigated. Keeping it could let a
    // genuine match through in silence, and that is the failure that matters.
  } else {
    // No recognised street type: keep everything up to the first token that
    // looks like a state or a postcode and hope the two sides agree.
    const stop = rest.findIndex((token) => /^\d{5}$/.test(token) || token === 'ga' || token === 'georgia');
    nameTokens = stop >= 0 ? rest.slice(0, stop) : rest;
  }

  // A leading directional belongs to the street name: "North Highland Ave".
  const leading = nameTokens.length > 1 && Object.hasOwn(DIRECTIONS, nameTokens[0])
    ? DIRECTIONS[nameTokens[0]]
    : '';
  if (leading) nameTokens = nameTokens.slice(1);

  const street = nameTokens.join(' ').trim();
  if (!street) return null;

  const parts = [leading, street, type].filter(Boolean);
  return { number, street, key: `${number} ${parts.join(' ')}`.trim() };
}

/**
 * Do two addresses name the same house number on the same street?
 *
 * Deliberately ignores city, state and postcode: two different cities can hold
 * the same street name, but a mock row landing on "1305 Oakview Road" while the
 * county calls that same parcel "1305 Oakview Road" is the violation whether or
 * not the trailing text agrees. Comparing less is the safer direction here —
 * a false "same" fails the test loudly, a false "different" would let a real
 * address through quietly.
 *
 * @returns {boolean} false when either address cannot be parsed at all
 */
export function sameStreetAddress(a, b) {
  const left = addressKey(a);
  const right = addressKey(b);
  if (!left || !right) return false;
  return left.key === right.key;
}
