/**
 * Natural-language command parsing for TerraSignal Investor.
 *
 * Phase 1 shipped five exact phrases. This reads the way an investor actually
 * talks — "find foreclosures under 250k in dekalb", "what if i pay 110",
 * "why not wholesale" — and turns it into an intent plus slots. It is a
 * vocabulary-and-ordering parser, not a model: every branch is inspectable and
 * every utterance in parse.test.mjs is pinned.
 *
 * Order is the whole design. The five acceptance phrases match exactly, before
 * anything else, so the demo can never be broken by a new pattern. After that,
 * the more specific a pattern is, the earlier it runs — `rent 2800` is a
 * what-if, `top 3 rentals` is a hunt, and only the leftovers reach `focus`.
 */
import { ATLANTA_DECATUR_PROPERTIES } from '../mock/atlantaDecatur.js';
import { parseNumber, scaleForField } from './numbers.js';

export const INTENTS = Object.freeze([
  'find_money', 'focus', 'why', 'show_deal', 'compare', 'what_if',
  'reset_assumptions', 'save', 'unsave', 'show_saved', 'start_drive',
  'stop_drive', 'drive_next', 'drive_skip', 'world', 'vision_on', 'vision_off',
  'help', 'unknown',
]);

/** The five that must never stop working, matched before any pattern. */
const ACCEPTANCE = Object.freeze({
  'find me money': { intent: 'find_money', slots: {} },
  why: { intent: 'why', slots: {} },
  'show me the deal': { intent: 'show_deal', slots: {} },
  'assume rehab is twenty thousand higher': {
    intent: 'what_if',
    slots: { field: 'rehab', op: 'plus', value: 20000 },
  },
  'save it': { intent: 'save', slots: {} },
});

const SIGNAL_WORDS = Object.freeze([
  // Longest and most specific first: "pre-foreclosure" contains "foreclosure".
  [/\b(pre[\s-]?foreclosures?|delinquent|delinquency|late (?:notes?|mortgages?|payments?))\b/, 'PREFORECLOSURE'],
  [/\b(tax[\s-]?sales?|tax[\s-]?deeds?|fi\.? ?fa\.?)\b/, 'TAX_SALE'],
  [/\b(foreclosures?|notices? of sale|sale under power)\b/, 'FORECLOSURE'],
  [/\b(distressed|distress|vacants?|vacancies)\b/, 'DISTRESS'],
  [/\b(listed|listings?|under comps)\b/, 'LISTED_OPPORTUNITY'],
]);

const STRATEGY_WORDS = Object.freeze([
  [/\bbrrrrr*\b/, 'brrrr'],
  [/\b(wholesales?|wholesaling|assignments?)\b/, 'wholesale'],
  [/\b(flips?|flipping)\b/, 'flip'],
  [/\b(rentals?|rents?|cash[\s-]?flow|buy and hold)\b/, 'rental'],
]);

/**
 * Field synonyms, longest phrase first so "down payment" never reads as the
 * "down" that means minus, and "after repair value" never as "repair".
 */
const FIELD_WORDS = Object.freeze([
  [/\bafter[\s-]?repair[\s-]?value\b/, 'arv'],
  [/\bdown[\s-]?payment\b/, 'downPayment'],
  [/\bloan[\s-]?to[\s-]?value\b/, 'ltv'],
  [/\brefi ltv\b/, 'ltv'],
  [/\bmortgage rate\b/, 'rate'],
  [/\bconstruction budget\b/, 'rehab'],
  [/\bsell it for\b/, 'arv'],
  [/\bbuy it for\b/, 'purchase'],
  [/\b(rehabs?|repairs?|renovations?|renos?)\b/, 'rehab'],
  [/\barv\b/, 'arv'],
  [/\b(resale|exit)\b/, 'arv'],
  [/\b(purchase|price|pay|offer|entry|contract)\b/, 'purchase'],
  [/\brents?\b/, 'rent'],
  [/\b(rate|interest)\b/, 'rate'],
  [/\bltv\b/, 'ltv'],
  [/\b(hold|months?)\b/, 'hold'],
  [/\bdown\b/, 'downPayment'],
]);

const PLUS_WORDS = /\b(higher|more|plus|up|add|increase|raise|over)\b/;
const MINUS_WORDS = /\b(lower|less|minus|down|cut|drop|reduce|under)\b/;

const ORDINAL_WORDS = Object.freeze({
  first: 1, second: 2, third: 3, fourth: 4, fifth: 5,
  sixth: 6, seventh: 7, eighth: 8, ninth: 9, tenth: 10,
  one: 1, two: 2, three: 3, four: 4, five: 5,
  six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
});

/** What `unknown` suggests, ranked by token overlap with what was said. */
const SUGGESTIONS = Object.freeze([
  'find me money',
  'find foreclosures under 250k in dekalb',
  'show me tax sales',
  'best brrrr',
  'show me the deal',
  'why',
  'compare',
  'assume rehab is twenty thousand higher',
  'reset the numbers',
  'save it',
  'next',
  'zoom out',
  'help',
]);

export function normalizeUtterance(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/[–—]/g, '-')
    .replace(/[.!?,]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function words(text) {
  return String(text || '').split(/[^a-z0-9']+/i).filter(Boolean);
}

/**
 * Place names come from the dataset, never a hard-coded list — a new market
 * becomes searchable by being added to the inventory.
 */
export function buildPlaceVocabulary(properties = ATLANTA_DECATUR_PROPERTIES) {
  const entries = [];
  const seen = new Set();
  const add = (value, kind) => {
    const phrase = String(value || '').trim().toLowerCase();
    if (!phrase) return;
    const key = `${kind}:${phrase}`;
    if (seen.has(key)) return;
    seen.add(key);
    entries.push({ phrase, tokens: words(phrase), kind, value });
  };
  for (const property of properties || []) {
    add(property.neighborhood, 'neighborhood');
    add(property.city, 'city');
    add(property.county, 'county');
  }
  // Longest phrase wins, so "east point" never reads as the city "atlanta"
  // just because both are present, and "decatur square" beats "decatur".
  entries.sort((a, b) => b.tokens.length - a.tokens.length || a.phrase.localeCompare(b.phrase));
  return entries;
}

let defaultPlaces = null;
function places(vocabulary) {
  if (vocabulary) return vocabulary;
  if (!defaultPlaces) defaultPlaces = buildPlaceVocabulary();
  return defaultPlaces;
}

function containsTokens(haystack, needle) {
  if (!needle.length || needle.length > haystack.length) return false;
  for (let i = 0; i + needle.length <= haystack.length; i += 1) {
    let hit = true;
    for (let j = 0; j < needle.length; j += 1) {
      if (haystack[i + j] !== needle[j]) { hit = false; break; }
    }
    if (hit) return true;
  }
  return false;
}

/** Every place the utterance names, at most one of each kind. */
export function matchPlaces(normalized, vocabulary) {
  const tokens = words(normalized);
  const found = {};
  for (const entry of places(vocabulary)) {
    if (found[entry.kind]) continue;
    if (containsTokens(tokens, entry.tokens)) found[entry.kind] = entry.value;
  }
  return found;
}

function matchFirst(table, normalized) {
  for (const [pattern, value] of table) {
    if (pattern.test(normalized)) return value;
  }
  return null;
}

export function matchSignalType(normalized) {
  return matchFirst(SIGNAL_WORDS, normalized);
}

export function matchStrategy(normalized) {
  return matchFirst(STRATEGY_WORDS, normalized);
}

function matchField(normalized) {
  for (const [pattern, field] of FIELD_WORDS) {
    const hit = pattern.exec(normalized);
    if (hit) return { field, matched: hit[0] };
  }
  return null;
}

/** "under 250k", "below 300", "max 200k", "less than 150k". */
function matchPriceCap(normalized) {
  const capped = /\b(?:under|below|less than|no more than|max(?:imum)?|cheaper than|up to)\s+(.+)$/.exec(normalized);
  if (!capped) return null;
  const number = parseNumber(capped[1]);
  if (!number || number.kind === 'percent') return null;
  return scaleForField('purchase', number.value);
}

function matchLimit(normalized) {
  const top = /\btop\s+(\d+|one|two|three|four|five|six|seven|eight|nine|ten)\b/.exec(normalized);
  if (!top) return null;
  const raw = top[1];
  const value = /^\d+$/.test(raw) ? Number(raw) : ORDINAL_WORDS[raw];
  return Number.isFinite(value) && value > 0 ? value : null;
}

function matchMinScore(normalized) {
  const scored = /\b(?:score|composite|scoring)\s+(?:over|above|at least|of)?\s*(\d{1,3})\b/.exec(normalized);
  if (!scored) return null;
  const value = Number(scored[1]);
  return Number.isFinite(value) ? Math.min(100, Math.max(0, value)) : null;
}

function result(intent, slots, raw, normalized, confidence) {
  return {
    intent,
    slots: slots || {},
    phrase: raw,
    normalized,
    confidence,
  };
}

function findMoneySlots(normalized, vocabulary) {
  const slots = {};
  const place = matchPlaces(normalized, vocabulary);
  if (place.neighborhood) slots.neighborhood = place.neighborhood;
  if (place.city) slots.city = place.city;
  if (place.county) slots.county = place.county;
  const signalType = matchSignalType(normalized);
  if (signalType) slots.signalType = signalType;
  const strategy = matchStrategy(normalized);
  // "tax sales" is a signal, not a strategy; only claim a strategy when the
  // signal did not already explain the same words.
  if (strategy && !(signalType === 'TAX_SALE' && strategy === 'wholesale')) {
    slots.strategy = strategy;
  }
  const maxPurchase = matchPriceCap(normalized);
  if (maxPurchase != null) slots.maxPurchase = maxPurchase;
  const minScore = matchMinScore(normalized);
  if (minScore != null) slots.minScore = minScore;
  const limit = matchLimit(normalized);
  if (limit != null) slots.limit = limit;
  return slots;
}

/**
 * A what-if needs a field *and* something to do to it. "rent" alone is a hunt
 * for rentals; "rent 2800" is a change to this deal.
 */
function parseWhatIf(normalized) {
  const hit = matchField(normalized);
  if (!hit) return null;
  const { field } = hit;

  const number = parseNumber(normalized);
  if (!number) return null;
  // The field's own name is not a direction: "down payment" is not "down".
  const rest = normalized.replace(hit.matched, ' ');
  const plus = PLUS_WORDS.test(rest);
  const minus = MINUS_WORDS.test(rest);

  // "20 percent higher" scales; a bare percent on a rate/ltv field sets it.
  if (number.kind === 'percent' && (plus || minus) && field !== 'rate' && field !== 'ltv' && field !== 'downPayment') {
    return { field, op: 'scale', value: minus ? -number.value : number.value };
  }

  const value = scaleForField(field, number.value);
  if (plus && !minus) return { field, op: 'plus', value };
  if (minus && !plus) return { field, op: 'minus', value };
  return { field, op: 'set', value };
}

function parseFocusSlots(normalized) {
  if (/\b(next|forward)\b/.test(normalized)) return { step: 'next' };
  if (/\b(previous|prior|back|last one|go back)\b/.test(normalized)) return { step: 'previous' };
  if (/\b(top pick|gold one|gold pick|the gold|best one|winner)\b/.test(normalized)) return { step: 'top' };

  const numbered = /\b(?:number|no\.?|#)\s*(\d+)\b/.exec(normalized);
  if (numbered) return { ordinal: Number(numbered[1]) };
  const word = /\b(?:number\s+)?(first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth)\b/.exec(normalized);
  if (word) return { ordinal: ORDINAL_WORDS[word[1]] };
  const spelled = /\bnumber\s+(one|two|three|four|five|six|seven|eight|nine|ten)\b/.exec(normalized);
  if (spelled) return { ordinal: ORDINAL_WORDS[spelled[1]] };
  return null;
}

/** The closest supported phrase, by how many words it shares with the input. */
export function suggestFor(normalized) {
  const said = new Set(words(normalized));
  let best = SUGGESTIONS[0];
  let bestScore = -1;
  for (const candidate of SUGGESTIONS) {
    const tokens = words(candidate);
    const overlap = tokens.filter((token) => said.has(token)).length;
    const score = overlap - tokens.length * 0.01;
    if (score > bestScore) {
      bestScore = score;
      best = candidate;
    }
  }
  return best;
}

/**
 * @param {string} text what the user typed or said
 * @param {{places?:Array}} [options] place vocabulary override (tests, other markets)
 * @returns {{intent:string, slots:object, phrase:string, normalized:string, confidence:number}|null}
 */
export function parseCommand(text, options = {}) {
  const raw = String(text || '').trim();
  if (!raw) return null;
  const normalized = normalizeUtterance(raw);
  const vocabulary = options.places || null;

  // 1. The five acceptance phrases, exactly, before any pattern can claim them.
  if (Object.hasOwn(ACCEPTANCE, normalized)) {
    const hit = ACCEPTANCE[normalized];
    return result(hit.intent, { ...hit.slots }, raw, normalized, 1);
  }

  // 2. Session-level commands that never take slots.
  if (/^(help|what can i say|what can you do|commands|what do i say)\b/.test(normalized)) {
    return result('help', {}, raw, normalized, 1);
  }
  if (/\b(reset|undo|start over|clear)\b/.test(normalized)
    && /\b(numbers?|assumptions?|changes?|overrides?|deal)\b/.test(normalized)) {
    return result('reset_assumptions', {}, raw, normalized, 0.95);
  }
  if (/^reset$/.test(normalized)) {
    return result('reset_assumptions', {}, raw, normalized, 0.9);
  }
  if (/\bvision\b/.test(normalized) || /opportunity vision/.test(normalized)) {
    if (/\b(off|hide|stop|disable)\b/.test(normalized)) return result('vision_off', {}, raw, normalized, 0.95);
    if (/\b(on|show|start|enable)\b/.test(normalized)) return result('vision_on', {}, raw, normalized, 0.95);
  }
  if (/\b(zoom out|back to the market|reset the map|show me the market|world view|whole market)\b/.test(normalized)) {
    return result('world', {}, raw, normalized, 0.95);
  }

  // 3. Drive, before "next" can be read as moving the focus cursor.
  if (/\b(stop|end|quit|exit)\b.*\bdrive\b|\bdrive\b.*\b(stop|off)\b/.test(normalized)) {
    return result('stop_drive', {}, raw, normalized, 0.95);
  }
  if (/\b(start|begin|let's|lets)\b.*\bdriv/.test(normalized) || /^drive( demo)?$/.test(normalized)) {
    return result('start_drive', {}, raw, normalized, 0.95);
  }
  if (/\bdrive\b.*\bnext\b|\bnext (stop|house|property)\b/.test(normalized)) {
    return result('drive_next', {}, raw, normalized, 0.9);
  }
  if (/\bskip\b/.test(normalized)) {
    return result('drive_skip', {}, raw, normalized, 0.9);
  }

  // 4. Saved.
  if (/\b(unsave|un-save|remove it|drop it|forget it|take it off)\b/.test(normalized)
    || /\bremove\b.*\bsaved?\b/.test(normalized)) {
    return result('unsave', {}, raw, normalized, 0.95);
  }
  if (/^(show|open|see|list)\b.*\bsaved\b/.test(normalized) || /^saved$/.test(normalized)) {
    return result('show_saved', {}, raw, normalized, 0.95);
  }
  if (/\b(save|bookmark|keep)\b/.test(normalized) && !/\bsaved\b/.test(normalized)) {
    const slots = {};
    const noted = /\b(?:with (?:a )?note|note|as|labell?ed|tagged)\s+(.+)$/.exec(normalized);
    if (noted) slots.note = noted[1].trim();
    return result('save', slots, raw, normalized, 0.9);
  }

  // 5. Compare, before a strategy word can send this to show_deal.
  if (/\bcompare\b|\b(every|all)\s+(four\s+)?(strateg|path|way)/.test(normalized)
    || /\bwhich (strategy|path|way)\b/.test(normalized)
    || /\ball four\b/.test(normalized)) {
    return result('compare', {}, raw, normalized, 0.95);
  }

  // 6. What-ifs: a field plus a number beats every looser reading of the words.
  const whatIf = parseWhatIf(normalized);
  if (whatIf) {
    const hypothetical = /\b(what if|assume|suppose|say|pretend)\b/.test(normalized);
    return result('what_if', whatIf, raw, normalized, hypothetical ? 0.95 : 0.85);
  }

  // 7. Why, with or without a strategy to justify.
  if (/\bwhy\b|what(?:'s| is) special|^explain\b/.test(normalized)) {
    const slots = {};
    const strategy = matchStrategy(normalized);
    if (strategy) slots.strategy = strategy;
    return result('why', slots, raw, normalized, 0.9);
  }

  // 8. The deal, with an optional strategy to run it as.
  const dealPhrase = /\b(show me the deal|show the deal|the deal|underwrite|run the numbers|deal vision|run it|model it)\b/
    .test(normalized);
  const asStrategy = /\b(as|into|like)\s+an?\b/.test(normalized) || /\bwhat about\b/.test(normalized);
  const strategyIt = /\b(flip|rental|rent|brrrrr*|wholesale)\s+it\b/.test(normalized);
  if (dealPhrase || asStrategy || strategyIt) {
    const slots = {};
    const strategy = matchStrategy(normalized);
    if (strategy) slots.strategy = strategy;
    return result('show_deal', slots, raw, normalized, dealPhrase ? 0.95 : 0.85);
  }

  // 9. Moving around the shortlist.
  const focusStep = parseFocusSlots(normalized);
  if (focusStep) return result('focus', focusStep, raw, normalized, 0.9);

  // 10. Hunting. A signal or strategy word with hunt framing, a place, a cap,
  //     or a "best/top" superlative is a search, not a request to focus.
  const huntVerb = /\b(find|hunt|search|look for|show me|show|give me|any|where)\b/.test(normalized);
  const superlative = /\b(best|top|strongest|highest)\b/.test(normalized);
  const moneyPhrase = /\b(find(?: me)? money|where(?:'s| is) the money|opportunities|deals?)\b/.test(normalized);
  const signalType = matchSignalType(normalized);
  const strategy = matchStrategy(normalized);
  const cap = matchPriceCap(normalized);
  const place = matchPlaces(normalized, vocabulary);
  const hasPlace = Boolean(place.neighborhood || place.city || place.county);

  const limit = matchLimit(normalized);
  if (moneyPhrase
    || ((signalType || strategy) && (huntVerb || superlative || hasPlace || cap != null))
    || (superlative && (signalType || strategy))
    || (huntVerb && hasPlace)
    || limit != null) {
    return result('find_money', findMoneySlots(normalized, vocabulary), raw, normalized, moneyPhrase ? 0.95 : 0.85);
  }

  // 11. Anything else naming a place or an address is a focus request.
  const focusVerb = /^(go to|take me to|fly to|jump to|open|focus on|focus)\b/.test(normalized);
  if (focusVerb || huntVerb || hasPlace || /\b\d{1,5}\s+\w+/.test(normalized)) {
    const query = normalized
      .replace(/^(show me|show|go to|take me to|jump to|find|fly to|open|focus on|focus)\s+/, '')
      .replace(/^the\s+/, '')
      .trim();
    if (query) return result('focus', { query }, raw, normalized, 0.7);
  }

  return result('unknown', { suggestion: suggestFor(normalized) }, raw, normalized, 0.2);
}
