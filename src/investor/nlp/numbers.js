/**
 * Money and quantity parsing for spoken and typed investor commands.
 *
 * People do not say "195000". They say "one ninety five", "195k", "$195,000",
 * "a hundred and ten", "half a million". And they leave the magnitude off
 * entirely — "rehab is 60" means sixty thousand, "rate 6.5" means 6.5%. The
 * first half of this module reads the number; `scaleForField` supplies the
 * magnitude the field implies.
 */

const UNITS = Object.freeze({
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7,
  eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13,
  fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18,
  nineteen: 19,
});

const TENS = Object.freeze({
  twenty: 20, thirty: 30, forty: 40, fourty: 40, fifty: 50,
  sixty: 60, seventy: 70, eighty: 80, ninety: 90,
});

const SCALES = Object.freeze({
  hundred: 100,
  thousand: 1000,
  k: 1000,
  grand: 1000,
  million: 1_000_000,
  mil: 1_000_000,
  m: 1_000_000,
});

/** Suffixes that make a bare number money rather than a count. */
const MONEY_SUFFIX = Object.freeze({
  k: 1000, grand: 1000, thousand: 1000,
  m: 1_000_000, mil: 1_000_000, million: 1_000_000,
});

const WORD_TOKEN = /^[a-z]+$/;

function isWordNumberToken(token) {
  return Object.hasOwn(UNITS, token)
    || Object.hasOwn(TENS, token)
    || Object.hasOwn(SCALES, token)
    || token === 'half'
    || token === 'a'
    || token === 'an'
    || token === 'and';
}

/**
 * Standard accumulate-and-carry word-number reader. `current` collects the
 * group being built ("two hundred fifty"); a thousand/million scale flushes it
 * into the running total.
 */
function readWordNumber(tokens, start) {
  let total = 0;
  let current = 0;
  let seen = false;
  let index = start;
  let lastMeaningful = start;

  for (; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === 'and') {
      if (!seen) break;
      continue;
    }
    if (token === 'a' || token === 'an') {
      // "a hundred" is one hundred; the "a" in "half a million" is filler.
      if (current === 0) current = 1;
      continue;
    }
    if (token === 'half') {
      current = current === 0 ? 0.5 : current * 0.5;
      seen = true;
      lastMeaningful = index;
      continue;
    }
    if (Object.hasOwn(UNITS, token)) {
      current += UNITS[token];
      seen = true;
      lastMeaningful = index;
      continue;
    }
    if (Object.hasOwn(TENS, token)) {
      current += TENS[token];
      seen = true;
      lastMeaningful = index;
      continue;
    }
    if (Object.hasOwn(SCALES, token)) {
      const scale = SCALES[token];
      if (scale === 100) {
        current = (current || 1) * 100;
      } else {
        total += (current || 1) * scale;
        current = 0;
      }
      seen = true;
      lastMeaningful = index;
      continue;
    }
    break;
  }

  if (!seen) return null;
  return { value: total + current, end: lastMeaningful + 1 };
}

function tokenize(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[–—]/g, ' ')
    // "twenty-five" is two number words, but "195,000" and "6.5" are one token.
    .replace(/(?<=[a-z])-(?=[a-z])/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

function digitMatch(text) {
  const re = /(\$)?\s*(\d{1,3}(?:,\d{3})+|\d+(?:\.\d+)?)\s*(%|percent\b|k\b|grand\b|thousand\b|mil\b|million\b|m\b)?/i;
  const match = re.exec(String(text || ''));
  if (!match) return null;
  const [raw, dollar, digits, suffixRaw] = match;
  const suffix = String(suffixRaw || '').toLowerCase().replace(/\s+/g, '');
  const base = Number(digits.replace(/,/g, ''));
  if (!Number.isFinite(base)) return null;

  if (suffix === '%' || suffix === 'percent') {
    return { value: base, kind: 'percent', raw: raw.trim(), index: match.index };
  }
  const multiplier = MONEY_SUFFIX[suffix];
  if (multiplier) {
    return { value: base * multiplier, kind: 'money', raw: raw.trim(), index: match.index };
  }
  return {
    value: base,
    kind: dollar ? 'money' : 'plain',
    raw: raw.trim(),
    index: match.index,
  };
}

function wordMatch(text) {
  const tokens = tokenize(text);
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i].replace(/[^a-z]/g, '');
    if (!WORD_TOKEN.test(token)) continue;
    // "and" / "a" only ever continue a number, they never start one.
    if (token === 'and' || token === 'a' || token === 'an') continue;
    if (!isWordNumberToken(token)) continue;
    const read = readWordNumber(tokens.map((t) => t.replace(/[^a-z]/g, '')), i);
    if (!read || !Number.isFinite(read.value)) continue;
    const raw = tokens.slice(i, read.end).join(' ');
    const scaled = /\b(thousand|grand|million|mil|k)\b/.test(raw);
    return { value: read.value, kind: scaled ? 'money' : 'plain', raw };
  }
  return null;
}

/**
 * The first number in `text`, or null.
 *
 * @param {string} text
 * @returns {{value:number, kind:'money'|'percent'|'plain', raw:string}|null}
 */
export function parseNumber(text) {
  const source = String(text || '');
  if (!source.trim()) return null;

  const digits = digitMatch(source);
  const words = wordMatch(source);

  // Whichever comes first in the sentence is the one the speaker meant.
  if (digits && words) {
    const wordIndex = source.toLowerCase().indexOf(words.raw.split(' ')[0]);
    if (wordIndex >= 0 && wordIndex < digits.index) {
      return { value: words.value, kind: words.kind, raw: words.raw };
    }
  }
  if (digits) return { value: digits.value, kind: digits.kind, raw: digits.raw };
  if (words) return { value: words.value, kind: words.kind, raw: words.raw };
  return null;
}

const THOUSANDS_FIELDS = new Set(['purchase', 'offer', 'arv', 'value', 'rehab']);
const RATE_FIELDS = new Set(['rate', 'ltv', 'downPayment']);

/**
 * Supply the magnitude the field implies. "Rehab is 60" is sixty thousand;
 * "rate 6.5" is six and a half percent; nobody rehabs a house for $60.
 *
 * @param {string} field
 * @param {number} value
 * @returns {number}
 */
export function scaleForField(field, value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return n;
  const key = String(field || '');

  if (THOUSANDS_FIELDS.has(key)) return n < 5000 ? n * 1000 : n;
  if (key === 'rent') return n < 100 ? n * 1000 : n;
  if (RATE_FIELDS.has(key)) return n > 1 ? n / 100 : n;
  if (key === 'hold') return Math.round(n);
  return n;
}
