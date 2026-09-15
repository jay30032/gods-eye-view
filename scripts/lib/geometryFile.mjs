/**
 * Editing one field of one entry in a generated geometry file.
 *
 * Three scripts write `mock/*Geometry.js` and each owns a different field:
 * `fetch-footprints.mjs` writes the whole file, `fetch-parcels.mjs` replaces
 * `parcel`, `fetch-streets.mjs` replaces `street`. The last two are surgical
 * edits on a file they did not generate, which is exactly the kind of thing
 * that goes quietly wrong.
 *
 * It did. `fetch-parcels.mjs` originally located `parcel:` inside an entry,
 * kept everything *before* it, and appended the new block plus the entry's
 * closing brace. That is correct only while `parcel` is the last field — and it
 * was, until `fetch-streets.mjs` started appending `street` after it. The next
 * parcel run then silently deleted every street bearing in both datasets: 29 of
 * them in the Atlanta file, all 6 in the six-house file. Nothing failed. The
 * headed check still passed, because a row with no street bearing simply falls
 * back to the long-wall convention and looks plausible.
 *
 * So the replacement below is bounded at *both* ends and preserves whatever
 * follows, and both scripts use it rather than each rolling its own.
 */

/** The source text of one entry, or null. Anchored on the generator's format. */
export function entryTextOf(source, id) {
  const opener = `  '${id}': Object.freeze({\n`;
  const start = source.indexOf(opener);
  if (start < 0) return null;
  const endMarker = '\n  }),\n';
  const end = source.indexOf(endMarker, start);
  if (end < 0) return null;
  return { start, end: end + endMarker.length, text: source.slice(start, end + endMarker.length) };
}

/**
 * Where a top-level field of an entry begins and ends.
 *
 * Fields sit at four spaces of indentation and their values are either `null`
 * or an `Object.freeze({ ... })` closing on its own `    })` line — at four
 * spaces, which is what distinguishes it from the `      })` and `      ])`
 * of anything nested inside, and from the `  })` that closes the entry.
 *
 * `to` stops just **before** the trailing comma, not after it. That matters
 * more than it looks: with the comma inside the span, lifting a block out with
 * `slice(from, to)` carries the comma along, and writing it back somewhere that
 * adds its own produces `}),,` — a syntax error in a generated file that
 * nothing would notice until the next import.
 *
 * @returns {{from:number, to:number}|null} offsets within `entry`, where `to`
 *   is the index OF the trailing comma
 */
export function fieldSpan(entry, field) {
  const marker = `\n    ${field}: `;
  const from = entry.indexOf(marker);
  if (from < 0) return null;
  const valueAt = from + marker.length;

  if (entry.startsWith('null,', valueAt)) {
    return { from, to: valueAt + 'null'.length };
  }
  const close = entry.indexOf('\n    }),', valueAt);
  if (close < 0) return null;
  return { from, to: close + '\n    })'.length };
}

/**
 * Replace one field of one entry, leaving every other field exactly as it was.
 *
 * @param {string} source whole file
 * @param {string} id property id
 * @param {string} field top-level field name, e.g. 'parcel' or 'street'
 * @param {string} block rendered value, without the trailing comma
 * @param {{insertIfMissing?:boolean}} [options] append the field when the entry
 *   has none — which is how `street` first arrives on a freshly generated file
 * @returns {{source:string, ok:boolean, reason?:string}}
 */
export function replaceFieldBlock(source, id, field, block, { insertIfMissing = false } = {}) {
  const entry = entryTextOf(source, id);
  if (!entry) return { source, ok: false, reason: 'id not found in geometry file' };

  const span = fieldSpan(entry.text, field);
  let rewritten;
  if (span) {
    rewritten = entry.text.slice(0, span.from)
      + `\n    ${field}: ${block},`
      // `span.to` is the index OF the old trailing comma, so +1 steps over it.
      // Everything after — any field written by another fetcher — is kept.
      + entry.text.slice(span.to + 1);
  } else {
    if (!insertIfMissing) {
      return { source, ok: false, reason: `entry carries no ${field} field` };
    }
    const closer = '\n  }),\n';
    const body = entry.text.slice(0, entry.text.length - closer.length);
    rewritten = `${body}\n    ${field}: ${block},${closer}`;
  }

  return {
    source: source.slice(0, entry.start) + rewritten + source.slice(entry.end),
    ok: true,
  };
}

/**
 * Lift one field's rendered value out of an entry, without its trailing comma.
 *
 * The counterpart to {@link replaceFieldBlock}: what this returns can be handed
 * straight back to it.
 *
 * @returns {string|null}
 */
export function fieldBlockOf(source, id, field) {
  const entry = entryTextOf(source, id);
  if (!entry) return null;
  const span = fieldSpan(entry.text, field);
  if (!span) return null;
  return entry.text.slice(span.from + `\n    ${field}: `.length, span.to);
}
