/**
 * When the assistant speaks during a drive, and what it says.
 *
 * The default failure of a narrated drive is that it never stops talking. Six
 * houses over 1.4 km is one call-out every fifteen seconds at playback speed,
 * and if each of them also gets a follow-up the drive becomes a podcast you
 * cannot interrupt. So three rules, all enforced here rather than left to the
 * caller's discretion:
 *
 *   1. **One call-out per property, ever.** Passing the same house on the
 *      second lap of a loop does not re-announce it.
 *   2. **Neighbours are announced together.** Two houses within 40 m of each
 *      other are one sentence — "two foreclosures coming up on the right" —
 *      because they arrive in the same two seconds and cannot be told apart at
 *      speed anyway.
 *   3. **The level is the user's.** `full` narrates; `quiet` speaks only for
 *      the strongest signals; `off` says nothing and still tracks what is being
 *      passed, so "save that one" keeps working in silence.
 *
 * The other half of this file is **what "that one" means**. A drive is the one
 * place in the product where the user refers to a house without naming it, and
 * getting that wrong is worse than not supporting it: "save that one" saving
 * the wrong house is a silent error the user only finds later. So the resolver
 * returns an ambiguity rather than guessing whenever two houses are equally
 * plausible.
 *
 * Pure: no timers, no speech, no Cesium.
 */

import { compositeScore, primarySignal } from '../mock/schema.js';

/** Houses this close together are one call-out. */
export const GROUP_RADIUS_M = 40;
/** How far ahead a group is announced. Far enough to look up, close enough to see. */
export const CALLOUT_AHEAD_M = 110;
/** Below this it is too late to be useful — you are already past it. */
export const CALLOUT_MIN_AHEAD_M = 25;

export const LEVELS = Object.freeze(['full', 'quiet', 'off']);
/** In `quiet`, only these speak. */
const QUIET_SIGNALS = new Set(['FORECLOSURE', 'TAX_SALE']);

const SIGNAL_WORDS = Object.freeze({
  FORECLOSURE: 'notice-of-sale',
  TAX_SALE: 'tax-sale',
  PREFORECLOSURE: 'mortgage-delinquency',
  DISTRESS: 'code-enforcement',
  LISTED_OPPORTUNITY: 'listed-under-comps',
});

const SIGNAL_NOUNS = Object.freeze({
  FORECLOSURE: 'notice-of-sale property',
  TAX_SALE: 'tax-sale property',
  PREFORECLOSURE: 'mortgage delinquency',
  DISTRESS: 'code-enforcement file',
  LISTED_OPPORTUNITY: 'listing under comps',
});

export function signalWordFor(property) {
  return SIGNAL_WORDS[primarySignal(property)?.type] || 'signal';
}

function nounFor(property) {
  return SIGNAL_NOUNS[primarySignal(property)?.type] || 'property';
}

function shortAddress(property) {
  return String(property?.address || '').split(',')[0];
}

/**
 * Group properties that arrive together.
 *
 * Grouping is by **distance along the route**, not by straight-line distance:
 * two houses forty metres apart across a block are a minute apart on a road
 * that goes round it, and announcing them together would name one that is
 * nowhere in sight.
 *
 * @param {Array<{id:string, alongM:number, property:object}>} projected
 * @returns {Array<{ids:Array<string>, alongM:number, members:Array}>} in route order
 */
export function groupByProximity(projected, { radiusM = GROUP_RADIUS_M } = {}) {
  const rows = (projected || [])
    .filter((row) => row?.id && Number.isFinite(row.alongM))
    .slice()
    .sort((a, b) => a.alongM - b.alongM);

  const groups = [];
  for (const row of rows) {
    const last = groups[groups.length - 1];
    if (last && row.alongM - last.members[last.members.length - 1].alongM <= radiusM) {
      last.members.push(row);
      continue;
    }
    groups.push({ members: [row] });
  }
  return groups.map((group) => ({
    ids: group.members.map((m) => m.id),
    // The group is announced at its FIRST member: the call-out has to arrive
    // before the first house, not at the average of a pair.
    alongM: group.members[0].alongM,
    members: group.members,
  }));
}

/**
 * Should this group be announced now?
 *
 * @param {{group:object, aheadM:number, level:string, announced:Set}} input
 * @returns {boolean}
 */
export function shouldAnnounce({ group, aheadM, level = 'full', announced = new Set() } = {}) {
  if (!group?.ids?.length) return false;
  if (level === 'off') return false;
  // Rule 1: once each, ever — including on a second lap of the loop.
  if (group.ids.every((id) => announced.has(id))) return false;

  const ahead = Number(aheadM);
  if (!Number.isFinite(ahead)) return false;
  if (ahead > CALLOUT_AHEAD_M || ahead < CALLOUT_MIN_AHEAD_M) return false;

  if (level === 'quiet') {
    return group.members.some((m) => QUIET_SIGNALS.has(primarySignal(m.property)?.type));
  }
  return true;
}

/**
 * The sentence.
 *
 * One house names its signal and offers a look. Several name the count and the
 * common signal if they share one. The side comes from the travel bearing at
 * the moment of speaking, never from a stored value — see `route.js`.
 *
 * @returns {{text:string, ids:Array<string>, primaryId:string}}
 */
export function calloutFor(group, side, { gold = false } = {}) {
  const members = group?.members || [];
  if (!members.length) return null;
  const where = side === 'left' || side === 'right' ? ` on the ${side}` : ' ahead';

  if (gold) {
    const property = members[0].property;
    return {
      ids: group.ids,
      primaryId: members[0].id,
      gold: true,
      text: `Best match on this route${where} — ${shortAddress(property)}. `
        + 'Want me to pause here?',
    };
  }

  if (members.length === 1) {
    const property = members[0].property;
    return {
      ids: group.ids,
      primaryId: members[0].id,
      gold: false,
      text: `A ${nounFor(property)} is coming up${where} — want a closer look?`,
    };
  }

  const types = new Set(members.map((m) => primarySignal(m.property)?.type));
  const shared = types.size === 1 ? nounFor(members[0].property) : 'flagged properties';
  const plural = shared.endsWith('y') ? `${shared.slice(0, -1)}ies` : `${shared}s`;
  return {
    ids: group.ids,
    primaryId: members[0].id,
    gold: false,
    text: `${members.length} ${types.size === 1 ? plural : shared}${where} — want a closer look?`,
  };
}

/**
 * The gold call-out: the highest composite on the route.
 *
 * Only ever one, and only when asked for. Without the request every house keeps
 * its own signal colour — the gold treatment means "this is the answer", and a
 * drive that gilds a house nobody asked about is asserting a ranking the user
 * did not request.
 *
 * @returns {{id:string, composite:number}|null}
 */
export function bestAlongRoute(projected) {
  const ranked = (projected || [])
    .filter((row) => row?.property)
    .map((row) => ({ id: row.id, composite: compositeScore(row.property) }))
    .sort((a, b) => b.composite - a.composite || String(a.id).localeCompare(String(b.id)));
  return ranked[0] || null;
}

/** One sentence on why the gold house won. */
export function goldWhy(property) {
  const signal = primarySignal(property);
  const score = compositeScore(property);
  const days = property?.auction?.daysUntil;
  const clock = Number.isFinite(days) && days >= 0 ? `, auction in ${days} days` : '';
  return `${shortAddress(property)} scores ${Math.round(score)} — `
    + `${String(signal?.type || 'signal').replaceAll('_', ' ').toLowerCase()}${clock}.`;
}

// ---------------------------------------------------------------------------
// Which house is "that one"
// ---------------------------------------------------------------------------

/**
 * Commands that refer to a house without naming it.
 *
 * `scope` says which memory the phrase reaches for: `current` is whatever is
 * being discussed now, `previous` is the one before it. "Compare it with the
 * last one" needs both, which is why it carries `needsPrevious`.
 */
export const REFERRING_INTENTS = Object.freeze({
  save_that: { scope: 'current' },
  why_flagged: { scope: 'current' },
  how_recent: { scope: 'current' },
  compare_last: { scope: 'current', needsPrevious: true },
  skip_this: { scope: 'current' },
  more_like_it: { scope: 'current' },
  look_closer: { scope: 'current' },
});

/**
 * Create the tracker that remembers what is being talked about.
 *
 * Deliberately a tiny state machine rather than a variable: "the house being
 * discussed" changes on a call-out, on a focus, and on the user naming one, and
 * every one of those has to move `previous` as well, or "compare it with the
 * last one" compares a house with itself.
 */
export function createDiscussionTracker() {
  let current = null; // { ids: [...], primaryId }
  let previous = null;

  return {
    get current() { return current; },
    get previous() { return previous; },
    /** A call-out just fired, possibly naming several houses at once. */
    announce(ids, primaryId = null) {
      const list = (Array.isArray(ids) ? ids : [ids]).filter(Boolean);
      if (!list.length) return;
      if (current && current.primaryId !== (primaryId || list[0])) previous = current;
      current = { ids: list, primaryId: primaryId || list[0] };
    },
    /** The user picked one explicitly — that settles any ambiguity. */
    settle(id) {
      if (!id) return;
      if (current && current.primaryId !== id) previous = current;
      current = { ids: [id], primaryId: id };
    },
    reset() {
      current = null;
      previous = null;
    },
  };
}

/**
 * Which house a referring command means.
 *
 * The important branch is the third one. When a call-out named two houses and
 * the user says "save that one", there is no honest answer — so this returns
 * `ambiguous` with the candidates and the caller asks, rather than saving a
 * house at random and being wrong half the time.
 *
 * @returns {{ok:true, id:string, previousId?:string}
 *   |{ok:false, ambiguous:Array<string>}
 *   |{ok:false, reason:string}}
 */
export function resolveDiscussed(tracker, intent) {
  const rule = REFERRING_INTENTS[intent];
  if (!rule) return { ok: false, reason: 'not a referring command' };

  const current = tracker?.current;
  if (!current?.ids?.length) return { ok: false, reason: 'nothing being discussed yet' };

  if (rule.needsPrevious) {
    const previousId = tracker.previous?.primaryId || null;
    if (!previousId) return { ok: false, reason: 'nothing to compare with yet' };
    if (current.ids.length > 1) return { ok: false, ambiguous: current.ids.slice() };
    return { ok: true, id: current.ids[0], previousId };
  }

  if (current.ids.length > 1) return { ok: false, ambiguous: current.ids.slice() };
  return { ok: true, id: current.ids[0] };
}

/** "Which one — 621 Third Ave or 915 Mead Rd?" */
export function ambiguityQuestion(ids, lookup) {
  const names = (ids || [])
    .map((id) => shortAddress(typeof lookup === 'function' ? lookup(id) : null) || id)
    .filter(Boolean);
  if (names.length < 2) return 'Which one?';
  const last = names[names.length - 1];
  return `Which one — ${names.slice(0, -1).join(', ')} or ${last}?`;
}
