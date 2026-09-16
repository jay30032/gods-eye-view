import test from 'node:test';
import assert from 'node:assert/strict';
import { ACCEPTANCE_PHRASES } from '../conversation.js';
import { INTENTS, buildPlaceVocabulary, matchPlaces, parseCommand, suggestFor } from './parse.js';

/**
 * One row per utterance: what was said, the intent it must produce, and the
 * slots that must be present. Slots are checked as a subset — a row lists what
 * matters, not every key the parser happens to fill.
 */
const TABLE = Object.freeze([
  // --- the five acceptance phrases, exactly ---
  ['Find me money', 'find_money', {}],
  ['Why?', 'why', {}],
  ['Show me the deal', 'show_deal', {}],
  ['Assume rehab is twenty thousand higher', 'what_if', { field: 'rehab', op: 'plus', value: 20000 }],
  ['Save it', 'save', {}],

  // --- hunting ---
  ['find money', 'find_money', {}],
  ["where's the money", 'find_money', {}],
  ['where is the money', 'find_money', {}],
  ['show me opportunities', 'find_money', {}],
  ['find me money in kirkwood', 'find_money', { neighborhood: 'Kirkwood' }],
  ['find foreclosures under 250k in dekalb', 'find_money', {
    signalType: 'FORECLOSURE', county: 'dekalb', maxPurchase: 250000,
  }],
  ['show me tax sales', 'find_money', { signalType: 'TAX_SALE' }],
  ['show me foreclosures', 'find_money', { signalType: 'FORECLOSURE' }],
  ['find pre-foreclosures', 'find_money', { signalType: 'PREFORECLOSURE' }],
  ['show me distressed', 'find_money', { signalType: 'DISTRESS' }],
  ['find listings', 'find_money', { signalType: 'LISTED_OPPORTUNITY' }],
  ['best brrrr', 'find_money', { strategy: 'brrrr' }],
  ["what's the best flip", 'find_money', { strategy: 'flip' }],
  ['top 3 rentals in decatur', 'find_money', { strategy: 'rental', limit: 3, city: 'Decatur' }],
  ['find flips under 200k', 'find_money', { strategy: 'flip', maxPurchase: 200000 }],
  ['show me wholesale deals in east point', 'find_money', { strategy: 'wholesale', city: 'East Point' }],
  ['find me money in fulton', 'find_money', { county: 'fulton' }],
  ['any foreclosures in grant park', 'find_money', { signalType: 'FORECLOSURE', neighborhood: 'Grant Park' }],
  ['top 5', 'find_money', { limit: 5 }],
  ['find rentals below 300k', 'find_money', { strategy: 'rental', maxPurchase: 300000 }],

  // --- focus ---
  ['show me 214 sycamore', 'focus', { query: '214 sycamore' }],
  ['go to belvedere', 'focus', { query: 'belvedere' }],
  ['number two', 'focus', { ordinal: 2 }],
  ['the second one', 'focus', { ordinal: 2 }],
  ['number 3', 'focus', { ordinal: 3 }],
  ['next', 'focus', { step: 'next' }],
  ['previous', 'focus', { step: 'previous' }],
  ['back', 'focus', { step: 'previous' }],
  ['top pick', 'focus', { step: 'top' }],
  ['the gold one', 'focus', { step: 'top' }],

  // --- why ---
  ['why', 'why', {}],
  ['why this', 'why', {}],
  ['why this matters', 'why', {}],
  ['explain', 'why', {}],
  ['why not wholesale', 'why', { strategy: 'wholesale' }],
  ['why is rental thin', 'why', { strategy: 'rental' }],
  ['why not brrrr', 'why', { strategy: 'brrrr' }],

  // --- the deal ---
  ['show the deal', 'show_deal', {}],
  ['underwrite it', 'show_deal', {}],
  ['run the numbers', 'show_deal', {}],
  ['show me the deal as a rental', 'show_deal', { strategy: 'rental' }],
  ['run it as a rental', 'show_deal', { strategy: 'rental' }],
  ['what about brrrr', 'show_deal', { strategy: 'brrrr' }],
  ['wholesale it', 'show_deal', { strategy: 'wholesale' }],
  ['flip it', 'show_deal', { strategy: 'flip' }],

  // --- compare ---
  ['compare', 'compare', {}],
  ['compare all four', 'compare', {}],
  ['show me every strategy', 'compare', {}],
  ['which strategy is best', 'compare', {}],

  // --- what-ifs ---
  ['rehab plus 15k', 'what_if', { field: 'rehab', op: 'plus', value: 15000 }],
  ['rehab is 60', 'what_if', { field: 'rehab', op: 'set', value: 60000 }],
  ['assume arv is 400', 'what_if', { field: 'arv', op: 'set', value: 400000 }],
  ['what if i pay 110', 'what_if', { field: 'purchase', op: 'set', value: 110000 }],
  ['offer 195,000', 'what_if', { field: 'purchase', op: 'set', value: 195000 }],
  ['rent 2800', 'what_if', { field: 'rent', op: 'set', value: 2800 }],
  ['rate 6.5', 'what_if', { field: 'rate', op: 'set', value: 0.065 }],
  ['hold 9 months', 'what_if', { field: 'hold', op: 'set', value: 9 }],
  ['rehab 20 percent higher', 'what_if', { field: 'rehab', op: 'scale', value: 20 }],
  ['ltv 80', 'what_if', { field: 'ltv', op: 'set', value: 0.8 }],
  ['down payment 30', 'what_if', { field: 'downPayment', op: 'set', value: 0.3 }],
  ['assume repairs are 20k lower', 'what_if', { field: 'rehab', op: 'minus', value: 20000 }],
  ['sell it for half a million', 'what_if', { field: 'arv', op: 'set', value: 500000 }],

  // --- assumptions ---
  ['reset the numbers', 'reset_assumptions', {}],
  ['reset', 'reset_assumptions', {}],
  ['undo the changes', 'reset_assumptions', {}],
  ['start over on the numbers', 'reset_assumptions', {}],

  // --- saving ---
  ['save this', 'save', {}],
  ['bookmark', 'save', {}],
  ['save it with note call the agent tuesday', 'save', { note: 'call the agent tuesday' }],
  ['save as maybe', 'save', { note: 'maybe' }],
  ['unsave', 'unsave', {}],
  ['remove it', 'unsave', {}],
  ['drop it from saved', 'unsave', {}],
  ['show saved', 'show_saved', {}],

  // --- navigation and session ---
  ['zoom out', 'world', {}],
  ['back to the market', 'world', {}],
  ['vision off', 'vision_off', {}],
  ['turn on opportunity vision', 'vision_on', {}],
  // --- sound and voice: session switches ---
  ['sound off', 'sound_off', {}],
  ['sound on', 'sound_on', {}],
  ['mute', 'sound_off', {}],
  ['turn the sounds off', 'sound_off', {}],
  ['unmute', 'sound_on', {}],
  ['voice on', 'voice_on', {}],
  ['voice off', 'voice_off', {}],
  ['read it out loud', 'voice_on', {}],
  ['stop the voice', 'voice_off', {}],
  ['start drive', 'start_drive', {}],
  ['stop drive', 'stop_drive', {}],
  // --- x-ray: see through the photo world, and end it early ---
  ['x-ray', 'xray', {}],
  ['xray', 'xray', {}],
  ['x ray it', 'xray', {}],
  ['see through', 'xray', {}],
  ['x-ray vision', 'xray', {}],
  ['solid', 'solid', {}],
  ['go solid', 'solid', {}],
  ['make it solid', 'solid', {}],
  ['x-ray off', 'solid', {}],
  ['stop the x-ray', 'solid', {}],
  // --- the lot, standing still ---
  ['show me the lot', 'show_lot', {}],
  ['show me the parcel', 'show_lot', {}],
  ['where is the lot', 'show_lot', {}],
  ['lot lines', 'show_lot', {}],
  ['help', 'help', {}],
  ['what can i say', 'help', {}],
]);

test('every utterance in the table parses to its intent and slots', () => {
  const failures = [];
  for (const [utterance, intent, slots] of TABLE) {
    const parsed = parseCommand(utterance);
    if (!parsed) {
      failures.push(`${utterance} → null`);
      continue;
    }
    if (parsed.intent !== intent) {
      failures.push(`${utterance} → ${parsed.intent} (want ${intent})`);
      continue;
    }
    for (const [key, value] of Object.entries(slots)) {
      if (parsed.slots[key] !== value) {
        failures.push(`${utterance} → slots.${key}=${JSON.stringify(parsed.slots[key])} (want ${JSON.stringify(value)})`);
      }
    }
  }
  assert.deepEqual(failures, []);
});

test('the table is broad enough to be worth trusting', () => {
  assert.ok(TABLE.length >= 60, `only ${TABLE.length} utterances`);
  const covered = new Set(TABLE.map(([, intent]) => intent));
  for (const intent of ['find_money', 'focus', 'why', 'show_deal', 'compare', 'what_if',
    'reset_assumptions', 'save', 'unsave', 'show_saved', 'world', 'help']) {
    assert.ok(covered.has(intent), `no utterance covers ${intent}`);
  }
});

test('the five acceptance phrases parse exactly, punctuation and case aside', () => {
  const expected = ['find_money', 'why', 'show_deal', 'what_if', 'save'];
  ACCEPTANCE_PHRASES.forEach((phrase, index) => {
    assert.equal(parseCommand(phrase).intent, expected[index], phrase);
    assert.equal(parseCommand(phrase.toUpperCase()).intent, expected[index], phrase);
    assert.equal(parseCommand(`${phrase}.`).intent, expected[index], phrase);
    assert.equal(parseCommand(`  ${phrase}!  `).intent, expected[index], phrase);
  });
});

test('a bare why is not the same command as why-not-a-strategy', () => {
  assert.deepEqual(parseCommand('why').slots, {});
  assert.equal(parseCommand('why not wholesale').slots.strategy, 'wholesale');
  assert.equal(parseCommand('why').intent, parseCommand('why not wholesale').intent);
});

test('nonsense is unknown and suggests the nearest real phrase', () => {
  const parsed = parseCommand('banana pancakes');
  assert.equal(parsed.intent, 'unknown');
  assert.ok(parsed.slots.suggestion, 'unknown must suggest something');
  assert.ok(parsed.confidence < 0.5);
  // The suggestion is a phrase the parser actually understands.
  assert.notEqual(parseCommand(parsed.slots.suggestion).intent, 'unknown');
  assert.equal(typeof suggestFor('save the thing'), 'string');
});

test('empty input is not a command', () => {
  assert.equal(parseCommand(''), null);
  assert.equal(parseCommand('   '), null);
  assert.equal(parseCommand(null), null);
});

test('place vocabulary is built from the data, not hard-coded', () => {
  const custom = buildPlaceVocabulary([
    { neighborhood: 'Riverside', city: 'Macon', county: 'bibb' },
  ]);
  const found = matchPlaces('find me money in riverside', custom);
  assert.equal(found.neighborhood, 'Riverside');
  // The Atlanta vocabulary is not consulted when another market is passed.
  assert.equal(matchPlaces('find me money in kirkwood', custom).neighborhood, undefined);
  assert.equal(parseCommand('find money in macon', { places: custom }).slots.city, 'Macon');
});

test('the longest place name wins over a shorter one inside it', () => {
  assert.equal(parseCommand('find foreclosures in east point').slots.city, 'East Point');
  assert.equal(parseCommand('show me tax sales in decatur').slots.city, 'Decatur');
});

// ---------------------------------------------------------------------------
// Any-angle camera commands
// ---------------------------------------------------------------------------

const CAMERA_TABLE = Object.freeze([
  // --- sides ---
  ['show me the back', 'camera_angle', { side: 'back' }],
  ['show me the front', 'camera_angle', { side: 'front' }],
  ['show me the left side', 'camera_angle', { side: 'left' }],
  ['show me the right side', 'camera_angle', { side: 'right' }],
  ['see the rear', 'camera_angle', { side: 'back' }],
  ['left side', 'camera_angle', { side: 'left' }],

  // --- compass ---
  ['from the north', 'camera_angle', { compass: 'north' }],
  ['from the south', 'camera_angle', { compass: 'south' }],
  ['from the east', 'camera_angle', { compass: 'east' }],
  ['from the west', 'camera_angle', { compass: 'west' }],
  ['from the south-east', 'camera_angle', { compass: 'southeast' }],
  ['from northwest', 'camera_angle', { compass: 'northwest' }],

  // --- the street ---
  ['from the street', 'camera_angle', { side: 'front', viaStreet: true }],
  ['street view', 'camera_angle', { side: 'front', viaStreet: true }],

  // --- range and height ---
  ['closer', 'camera_angle', { range: 'closer' }],
  ['zoom in', 'camera_angle', { range: 'closer' }],
  ['farther', 'camera_angle', { range: 'farther' }],
  ['further', 'camera_angle', { range: 'farther' }],
  ['back up', 'camera_angle', { range: 'farther' }],
  ['pull back', 'camera_angle', { range: 'farther' }],
  ['higher', 'camera_angle', { height: 'higher' }],
  ['go up', 'camera_angle', { height: 'higher' }],
  ['lower', 'camera_angle', { height: 'lower' }],
  ['street level', 'camera_angle', { height: 'lower' }],

  // --- orbit ---
  ['orbit', 'camera_angle', { orbit: 'start' }],
  ['orbit it', 'camera_angle', { orbit: 'start' }],
  ['go around', 'camera_angle', { orbit: 'start' }],
  ['circle the house', 'camera_angle', { orbit: 'start' }],
  ['stop', 'camera_angle', { orbit: 'stop' }],
  ['stop orbiting', 'camera_angle', { orbit: 'stop' }],
  ['stop spinning', 'camera_angle', { orbit: 'stop' }],
]);

test('every any-angle phrase resolves to a camera move', () => {
  for (const [utterance, intent, slots] of CAMERA_TABLE) {
    const parsed = parseCommand(utterance);
    assert.ok(parsed, `"${utterance}" parsed to nothing`);
    assert.equal(parsed.intent, intent, `"${utterance}"`);
    for (const [key, value] of Object.entries(slots)) {
      assert.equal(parsed.slots[key], value, `"${utterance}" slot ${key}`);
    }
  }
});

test('a camera move never steals a phrase that already meant something else', () => {
  // These are the collisions that actually exist in the vocabulary, and each
  // one is a phrase the demo depends on.
  const untouched = [
    ['find me money', 'find_money'],
    ['why', 'why'],
    ['show me the deal', 'show_deal'],
    ['assume rehab is twenty thousand higher', 'what_if'],
    ['save it', 'save'],
    // "best one" is the shortlist's head, not a camera angle.
    ['show me the best one', 'focus'],
    // "back" as a cursor step, not the back of a house.
    ['go back', 'focus'],
    // "stop drive" belongs to the drive, which is matched earlier.
    ['stop drive', 'stop_drive'],
    ['next', 'focus'],
    // "zoom out" is the market view and predates the camera vocabulary.
    ['zoom out', 'world'],
    // A what-if still wins when there is a field AND a number.
    ['rent 2800 higher', 'what_if'],
    ['show me foreclosures in kirkwood', 'find_money'],
  ];
  for (const [utterance, intent] of untouched) {
    assert.equal(parseCommand(utterance).intent, intent, `"${utterance}"`);
  }
});

test('the five acceptance phrases still match exactly, camera vocabulary or not', () => {
  for (const phrase of ACCEPTANCE_PHRASES) {
    const parsed = parseCommand(phrase);
    assert.ok(parsed, phrase);
    assert.equal(parsed.confidence, 1, `${phrase} is no longer an exact match`);
    assert.notEqual(parsed.intent, 'camera_angle', `${phrase} was stolen by the camera`);
  }
});

test('camera_angle is a declared intent', () => {
  assert.ok(INTENTS.includes('camera_angle'));
});


// ---------------------------------------------------------------------------
// Drive Mode v2 entry
// ---------------------------------------------------------------------------

test('every entry is the 3D chase drive, including "drive in 3D"', () => {
  // There is one driving view. The 3D phrases are still accepted because
  // people say them, not because they select anything.
  for (const phrase of [
    'drive', 'start the drive', 'drive through this neighborhood',
    'drive in 3D', 'drive through the neighborhood in 3d', 'drive with the chase camera',
  ]) {
    const parsed = parseCommand(phrase);
    assert.equal(parsed.intent, 'start_drive', phrase);
    assert.equal(parsed.slots.view, 'chase', phrase);
  }
});

test('"from the street" is a street-view request, not just a front wall', () => {
  const parsed = parseCommand('from the street');
  assert.equal(parsed.intent, 'camera_angle');
  assert.equal(parsed.slots.streetView, true);
  // The front-wall framing is kept as the fallback for a house with no
  // panorama coverage, so the slot still carries it.
  assert.equal(parsed.slots.side, 'front');
  assert.equal(parseCommand('street view').slots.streetView, true);
});

test('x-ray does not collide with Opportunity Vision or with "solid deal"', () => {
  // "x-ray vision" contains "vision"; the vision toggle must not claim it.
  assert.equal(parseCommand('x-ray vision').intent, 'xray');
  assert.equal(parseCommand('vision off').intent, 'vision_off');
  // "solid" is a command only on its own; a question with the word in it is
  // still whatever question it was.
  assert.notEqual(parseCommand('is it a solid deal').intent, 'solid');
  // "how big is the lot" is a question about land, not a camera command —
  // the drive's view director answers it, the parser does not.
  assert.equal(parseCommand('how big is the lot').intent, 'unknown');
  // Clear View's vocabulary is gone from the product.
  for (const gone of ['trees off', 'clear view', 'trees on', 'photo view']) {
    assert.equal(parseCommand(gone).intent, 'unknown', gone);
  }
  for (const intent of ['xray', 'solid', 'show_lot']) assert.ok(INTENTS.includes(intent), intent);
  for (const intent of ['clear_view', 'photo_view']) assert.ok(!INTENTS.includes(intent), intent);
});
