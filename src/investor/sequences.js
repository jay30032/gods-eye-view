/**
 * The hero moments, as designed timelines.
 *
 * Every number a moment depends on lives in `TIMING` and nowhere else. A
 * timeline is data — phases of events with a millisecond offset each — and the
 * runner is the only thing that touches a clock, so the ordering, the timing
 * and the cancel rules are all unit-testable without a scene, a card or a
 * speaker. `session.js` supplies handlers that do the actual work (light a
 * marker, fly the camera, speak the line) and never decides *when*.
 *
 * ## The three moments
 *
 *   FIND_MONEY    0.0 s scan wave and its sound → 0.6 s the matches ignite one
 *                 by one, nearest to the camera first, 80 ms apart, each with a
 *                 soft tick → the gold pick with a chime, its beacon rising
 *                 over 500 ms → the REVEAL flight → the brief spoken as the
 *                 flight lands → a dwell → the dive.
 *   LOOK_CLOSER   the HERO dive → the x-ray moment on landing → the card
 *                 assembles line by line in step with the spoken explanation.
 *   SAVE          the bookmark glyph drops onto the house, a confirmation tone
 *                 as it lands, the card follows.
 *
 * ## Phases and gating
 *
 * A phase's events are offsets from the phase's own start. A phase ends when
 * its last event has fired AND every promise a handler returned has settled.
 * That is how a flight of unknown length gates what follows: the REVEAL
 * handler returns the director's promise, and "the brief is spoken as the
 * flight lands" falls out without anyone guessing a duration.
 *
 * ## Cancel and reduced motion
 *
 * `cancel()` clears every pending timer, marks the run cancelled, and resolves
 * `done` — nothing else fires. A handler that discovers its flight was
 * superseded calls `ctx.cancel()` for the same effect. Under
 * `prefers-reduced-motion` every offset collapses to zero: the same events in
 * the same order, all at once, with `ctx.reduced` set so handlers skip the
 * travel and take the framing.
 */

/** Every timing in the choreography, in one place. Milliseconds unless named. */
export const TIMING = Object.freeze({
  FIND_MONEY: Object.freeze({
    /** The scan wave and its sound. */
    scanAt: 0,
    /** First match ignites. */
    igniteStartAt: 600,
    /** Between one ignition and the next. */
    igniteGapMs: 80,
    /** The gold pick lands this long after the last ordinary ignition. */
    goldAfterLastIgniteMs: 80,
    /** The beacon climbs from the roof over this long. */
    beaconRiseMs: 500,
    /** How long REVEAL is held after the brief before the dive. */
    dwellAfterBriefMs: 800,
  }),
  LOOK_CLOSER: Object.freeze({
    /** On landing: the x-ray, the card's first line, the orbit. */
    landAt: 0,
    /** The card's first line leads the first spoken sentence by this much. */
    firstLineLeadMs: 0,
  }),
  SAVE: Object.freeze({
    /** The glyph's fall. */
    dropMs: 450,
    /** The confirmation tone, as the glyph touches the roof. */
    toneAt: 300,
  }),
  /**
   * The typed-mode reading pace the card lines follow. A brisk adult reading
   * speed rather than a speaking one: a five-sentence brief assembles in
   * about fifteen seconds, not twenty-five.
   */
  READING_WPM: 240,
  /** Never let a sentence reveal faster than this, however short. */
  MIN_SENTENCE_MS: 350,
});

export const SEQUENCES = Object.freeze({
  FIND_MONEY: 'FIND_MONEY',
  LOOK_CLOSER: 'LOOK_CLOSER',
  SAVE: 'SAVE',
});

const M_PER_DEG_LAT = 111_320;
const DEG = Math.PI / 180;

/** Ground distance in metres between two {lat,lng} points. */
export function distanceM(a, b) {
  if (!a || !b) return Infinity;
  const mLng = M_PER_DEG_LAT * Math.cos(((a.lat + b.lat) / 2) * DEG);
  return Math.hypot((a.lng - b.lng) * mLng, (a.lat - b.lat) * M_PER_DEG_LAT);
}

/**
 * The matches, nearest to the camera first.
 *
 * Stable for ties and for a missing camera: with nothing to measure from, the
 * order the ranking produced is kept, so the gold pick still ignites where the
 * shortlist put it rather than wherever a sort of `Infinity`s landed it.
 */
export function orderNearestFirst(points, camera) {
  const rows = (points || []).filter(Boolean);
  if (!camera || !Number.isFinite(camera.lat) || !Number.isFinite(camera.lng)) return rows.slice();
  return rows
    .map((point, index) => ({ point, index, d: distanceM(point, camera) }))
    .sort((a, b) => (a.d - b.d) || (a.index - b.index))
    .map((row) => row.point);
}

function event(at, id, data = {}) {
  return { at: Math.max(0, Number(at) || 0), id, ...data };
}

/**
 * FIND_MONEY.
 *
 * @param {{matches:Array<{id:string,lat:number,lng:number}>, goldId:string,
 *   camera?:{lat:number,lng:number}, brief:string, focusId?:string}} args
 *   `matches` is the shortlist in ranking order; the ignition order is by
 *   distance from `camera`, with the gold pick always last because it is the
 *   answer and an answer comes at the end.
 */
export function buildFindMoney({ matches, goldId, camera = null, brief = '', focusId = null }) {
  const T = TIMING.FIND_MONEY;
  const rows = (matches || []).filter((row) => row && row.id);
  const ordinary = orderNearestFirst(rows.filter((row) => row.id !== goldId), camera);
  const gold = rows.find((row) => row.id === goldId) || null;

  const scan = [
    event(T.scanAt, 'scan'),
    event(T.scanAt, 'sound', { sound: 'scanSweep' }),
  ];
  ordinary.forEach((row, index) => {
    const at = T.igniteStartAt + index * T.igniteGapMs;
    scan.push(event(at, 'ignite', { propertyId: row.id, index }));
    scan.push(event(at, 'sound', { sound: 'houseTick', propertyId: row.id }));
  });
  const goldAt = ordinary.length
    ? T.igniteStartAt + (ordinary.length - 1) * T.igniteGapMs + T.goldAfterLastIgniteMs
    : T.igniteStartAt;
  if (gold) {
    scan.push(event(goldAt, 'gold', { propertyId: gold.id }));
    scan.push(event(goldAt, 'sound', { sound: 'goldChime', propertyId: gold.id }));
    scan.push(event(goldAt, 'beaconRise', { propertyId: gold.id, durationMs: T.beaconRiseMs }));
    // The phase does not end until the beacon is up.
    scan.push(event(goldAt + T.beaconRiseMs, 'beaconUp', { propertyId: gold.id }));
  }

  return {
    name: SEQUENCES.FIND_MONEY,
    order: [...ordinary.map((row) => row.id), ...(gold ? [gold.id] : [])],
    phases: [
      { id: 'scan', events: scan },
      {
        id: 'reveal',
        events: [
          event(0, 'sound', { sound: 'flightWhoosh' }),
          event(0, 'flight', { shot: 'REVEAL' }),
        ],
      },
      {
        id: 'brief',
        events: [
          event(0, 'speak', { text: brief }),
          ...(focusId ? [event(T.dwellAfterBriefMs, 'dive', { propertyId: focusId })] : []),
        ],
      },
    ],
  };
}

/**
 * LOOK_CLOSER.
 *
 * @param {{propertyId:string, hop?:boolean, line?:string, sentences:string[],
 *   sectionCount:number}} args `line` is what is said as the camera takes
 *   off; `sentences` is the explanation the card assembles to on landing.
 */
export function buildLookCloser({
  propertyId, hop = false, line = '', sentences = [], sectionCount = 0,
}) {
  const T = TIMING.LOOK_CLOSER;
  const schedule = lineScheduleFor(sectionCount, sentences.length);
  return {
    name: SEQUENCES.LOOK_CLOSER,
    propertyId,
    phases: [
      {
        id: 'dive',
        events: [
          event(0, 'speak', { text: line }),
          event(0, 'sound', { sound: 'flightWhoosh' }),
          event(0, 'flight', { shot: hop ? 'HOP' : 'HERO', propertyId }),
        ],
      },
      {
        id: 'land',
        events: [
          event(T.landAt, 'xray', { propertyId }),
          event(T.landAt, 'sound', { sound: 'xrayHum' }),
          event(T.landAt, 'card', { propertyId, assemble: true }),
          event(T.landAt, 'orbit', { propertyId }),
          event(T.landAt + T.firstLineLeadMs, 'explain', { propertyId, sentences, schedule }),
        ],
      },
      { id: 'settle', events: [event(0, 'revealAll', { propertyId })] },
    ],
  };
}

/** SAVE. */
export function buildSave({ propertyId }) {
  const T = TIMING.SAVE;
  return {
    name: SEQUENCES.SAVE,
    propertyId,
    phases: [
      {
        id: 'drop',
        events: [
          event(0, 'saved', { propertyId }),
          event(0, 'drop', { propertyId, durationMs: T.dropMs }),
          event(T.toneAt, 'sound', { sound: 'saveConfirm' }),
          event(T.dropMs, 'card', { propertyId }),
        ],
      },
    ],
  };
}

/**
 * Which spoken sentence reveals which card section.
 *
 * Section 0 (the header) is always immediate. The rest are spread evenly over
 * the sentences so the card finishes assembling as the explanation finishes
 * — never before, never trailing. With no sentences at all everything is
 * immediate.
 *
 * @returns {number[]} for section k, the sentence index that reveals it
 */
export function lineScheduleFor(sectionCount, sentenceCount) {
  const sections = Math.max(0, Number(sectionCount) || 0);
  const sentences = Math.max(0, Number(sentenceCount) || 0);
  const out = [];
  for (let k = 0; k < sections; k += 1) {
    if (k === 0 || sentences === 0) { out.push(0); continue; }
    // Sections 1..n-1 map onto sentences 0..m-1, monotonic, last on last.
    const t = sections > 1 ? (k - 1) / Math.max(1, sections - 2) : 0;
    out.push(Math.min(sentences - 1, Math.floor(t * (sentences - 1) + 1e-9)));
  }
  return out;
}

/** Every event of a timeline, in the order it will fire, with absolute-in-phase offsets. */
export function flattenTimeline(timeline) {
  const rows = [];
  for (const phase of timeline?.phases || []) {
    const sorted = [...(phase.events || [])].sort((a, b) => a.at - b.at);
    for (const item of sorted) rows.push({ phase: phase.id, ...item });
  }
  return rows;
}

/** How long a phase's own events run, ignoring what handlers wait on. */
export function phaseSpanMs(phase) {
  return (phase?.events || []).reduce((max, item) => Math.max(max, item.at), 0);
}

/**
 * Run a timeline.
 *
 * @param {object} timeline from one of the builders
 * @param {Record<string, Function>} handlers keyed by event id; each receives
 *   `(event, ctx)` and may return a promise the phase waits on
 * @param {{timers?:object, now?:Function, reduced?:boolean, onEvent?:Function,
 *   onDone?:Function}} [options]
 * @returns {{done:Promise<{name:string,cancelled:boolean}>, cancel:Function,
 *   running:boolean, name:string}}
 */
export function runTimeline(timeline, handlers = {}, {
  timers = globalThis,
  now = () => (globalThis.performance?.now?.() ?? Date.now()),
  reduced = false,
  onEvent = null,
  onDone = null,
} = {}) {
  let cancelled = false;
  let finished = false;
  const pending = new Set();
  let resolveDone = null;
  const done = new Promise((resolve) => { resolveDone = resolve; });
  const startedAt = now();
  const log = [];

  const ctx = {
    get cancelled() { return cancelled; },
    reduced,
    startedAt,
    name: timeline?.name || 'timeline',
    log,
    cancel() { cancel(); },
  };

  function finish() {
    if (finished) return;
    finished = true;
    const summary = { name: ctx.name, cancelled, log, elapsedMs: now() - startedAt };
    try { onDone?.(summary); } catch { /* listener */ }
    resolveDone(summary);
  }

  function cancel() {
    if (finished) return;
    cancelled = true;
    for (const timer of pending) timers.clearTimeout(timer);
    pending.clear();
    finish();
  }

  function fire(phase, item) {
    if (cancelled) return null;
    const stamp = now();
    log.push({ phase: phase.id, id: item.id, at: item.at, firedMs: stamp - startedAt, ...pick(item) });
    try { onEvent?.({ phase: phase.id, ...item, firedMs: stamp - startedAt }); } catch { /* listener */ }
    const handler = handlers[item.id];
    if (typeof handler !== 'function') return null;
    try {
      const result = handler(item, ctx);
      return result && typeof result.then === 'function' ? result : null;
    } catch (error) {
      console.error(`[TerraSignal] sequence ${ctx.name}/${item.id}:`, error);
      return null;
    }
  }

  function runPhase(phase) {
    return new Promise((resolve) => {
      const events = [...(phase.events || [])].sort((a, b) => a.at - b.at);
      const waits = [];
      let remaining = events.length;
      const settleIfDone = () => {
        if (remaining > 0) return;
        Promise.allSettled(waits).then(() => resolve());
      };
      if (!events.length) { resolve(); return; }
      if (reduced) {
        for (const item of events) {
          const promise = fire(phase, item);
          if (promise) waits.push(promise);
          remaining -= 1;
        }
        settleIfDone();
        return;
      }
      for (const item of events) {
        const timer = timers.setTimeout(() => {
          pending.delete(timer);
          const promise = fire(phase, item);
          if (promise) waits.push(promise);
          remaining -= 1;
          settleIfDone();
        }, item.at);
        pending.add(timer);
      }
    });
  }

  (async () => {
    for (const phase of timeline?.phases || []) {
      if (cancelled) break;
      await runPhase(phase);
      if (cancelled) break;
    }
    finish();
  })();

  return {
    done,
    cancel,
    get running() { return !finished; },
    get name() { return ctx.name; },
  };
}

function pick(item) {
  const out = {};
  for (const key of ['propertyId', 'sound', 'shot', 'index']) {
    if (item[key] !== undefined) out[key] = item[key];
  }
  return out;
}

/**
 * One runner at a time.
 *
 * A new moment cancels the one in progress — the user has moved on, and a
 * choreography that keeps firing ignitions under a different answer is
 * exactly the "two things at once" the director was written to stop. The
 * history is what the headed check reads to prove each moment ran to its end.
 */
export function createSequencer({ timers, now, reduced = () => false, onEvent = null } = {}) {
  let current = null;
  const history = [];
  const clock = typeof now === 'function'
    ? now
    : () => (globalThis.performance?.now?.() ?? Date.now());

  return {
    get current() { return current ? { name: current.name, startedAt: current.startedAt } : null; },
    get history() { return history.slice(); },
    /** @returns {ReturnType<typeof runTimeline>} */
    play(timeline, handlers) {
      if (current?.run.running) current.run.cancel();
      const startedAt = clock();
      const entry = { name: timeline.name, startedAt, endedAt: null, cancelled: null, log: null };
      history.push(entry);
      const run = runTimeline(timeline, handlers, {
        timers,
        now: clock,
        reduced: Boolean(reduced()),
        onEvent,
        onDone: (summary) => {
          entry.endedAt = clock();
          entry.cancelled = summary.cancelled;
          entry.log = summary.log;
          if (current?.run === run) current = null;
        },
      });
      current = { name: timeline.name, startedAt, run };
      return run;
    },
    cancel() {
      if (current?.run.running) current.run.cancel();
      current = null;
    },
  };
}
