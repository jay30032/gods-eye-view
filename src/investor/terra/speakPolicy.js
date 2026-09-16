/**
 * When the assistant speaks without being asked.
 *
 * The app raises events — the descent settled, a hunt finished, a house came
 * into focus, the drive is coming up on a signal, the x-ray fired, a save
 * landed — and this decides whether each one becomes a spoken brief. The rules
 * are the product's, not the model's, so they are enforced here where a unit
 * test can reach them:
 *
 *   1. never twice about the same property inside 60 seconds — a house that
 *      was just briefed is not briefed again because a second event named it;
 *   2. never during a flight — a brief spoken over a camera move describes a
 *      view the user is not looking at yet;
 *   3. under narration level "quiet" nothing but a direct answer is spoken;
 *   4. under "off" nothing at all is spoken, direct answers included — the
 *      user asked for silence and the app still shows every answer in text.
 *
 * A direct answer is a turn the user started. It is exempt from rules 1 and 2
 * — the user asked, so they get told — and from "quiet", which is exactly the
 * level that means "only when I ask".
 *
 * Pure: injected clock, no timers.
 */

/** How long one property stays briefed. */
export const REPEAT_WINDOW_MS = 60_000;

export const NARRATION_LEVELS = Object.freeze(['full', 'quiet', 'off']);

/** Every event the app raises, and whether it is about a property. */
export const SPEAK_EVENTS = Object.freeze({
  descent_settled: { property: false },
  find_money_complete: { property: true },
  house_focused: { property: true },
  drive_approach: { property: true },
  xray: { property: true },
  save_done: { property: true },
});

export function normalizeLevel(level) {
  const key = String(level || 'full').trim().toLowerCase();
  return NARRATION_LEVELS.includes(key) ? key : 'full';
}

/**
 * @param {{now?:Function, repeatWindowMs?:number}} [options]
 */
export function createSpeakPolicy({ now = () => Date.now(), repeatWindowMs = REPEAT_WINDOW_MS } = {}) {
  /** propertyId → when it was last spoken about. */
  const spoken = new Map();
  const decisions = [];

  function prune(at) {
    for (const [id, when] of spoken) {
      if (at - when > repeatWindowMs) spoken.delete(id);
    }
  }

  /**
   * @param {{type:string, propertyId?:string|null, direct?:boolean}} event
   * @param {{flying?:boolean, level?:string}} [state]
   * @returns {{speak:boolean, reason:string, type:string, propertyId:string|null}}
   */
  function decide(event, state = {}) {
    const at = now();
    prune(at);
    const type = String(event?.type || '');
    const propertyId = event?.propertyId ? String(event.propertyId) : null;
    const direct = Boolean(event?.direct);
    const level = normalizeLevel(state.level);
    const flying = Boolean(state.flying);

    let reason = 'ok';
    if (level === 'off') reason = 'narration off';
    else if (!direct && level === 'quiet') reason = 'narration quiet';
    else if (!direct && flying) reason = 'in flight';
    else if (!direct && !type) reason = 'no event';
    else if (!direct && propertyId && spoken.has(propertyId)) {
      reason = `same property within ${Math.round(repeatWindowMs / 1000)}s`;
    }

    const speak = reason === 'ok';
    if (speak && propertyId) spoken.set(propertyId, at);
    const decision = { speak, reason, type, propertyId, direct, at };
    decisions.push(decision);
    if (decisions.length > 50) decisions.shift();
    return decision;
  }

  return {
    decide,
    /** A direct answer about a property counts as having briefed it. */
    noteSpoken(propertyId) {
      if (!propertyId) return;
      spoken.set(String(propertyId), now());
    },
    /** Which properties are still inside the repeat window. */
    get recent() {
      prune(now());
      return [...spoken.keys()];
    },
    get decisions() { return decisions.slice(); },
    reset() { spoken.clear(); decisions.length = 0; },
  };
}
