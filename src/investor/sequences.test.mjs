/**
 * The hero moments as timelines: ordering, timing, cancel, reduced motion.
 *
 * Driven on a fake clock, so "80 ms apart" is asserted to the millisecond and
 * a cancel mid-ignition can be proved to fire nothing further.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SEQUENCES,
  TIMING,
  buildFindMoney,
  buildLookCloser,
  buildSave,
  createSequencer,
  flattenTimeline,
  lineScheduleFor,
  orderNearestFirst,
  phaseSpanMs,
  runTimeline,
} from './sequences.js';

/** A deterministic clock with setTimeout/clearTimeout and an `advance`. */
function fakeTimers() {
  let t = 0;
  let seq = 0;
  const queue = [];
  const timers = {
    setTimeout(fn, ms) {
      const id = ++seq;
      queue.push({ id, at: t + Math.max(0, ms), fn, order: seq });
      return id;
    },
    clearTimeout(id) {
      const i = queue.findIndex((row) => row.id === id);
      if (i >= 0) queue.splice(i, 1);
    },
  };
  return {
    timers,
    now: () => t,
    /** Advance, firing due timers in time order, draining microtasks between. */
    async advance(ms) {
      const target = t + ms;
      const drain = async () => { for (let i = 0; i < 20; i += 1) await Promise.resolve(); };
      for (;;) {
        // Let promise chains inside the runner settle: a phase that just
        // ended schedules the next phase's timers from a microtask.
        await drain();
        queue.sort((a, b) => (a.at - b.at) || (a.order - b.order));
        const next = queue[0];
        if (!next || next.at > target) break;
        queue.shift();
        t = next.at;
        next.fn();
      }
      t = target;
      await drain();
    },
    get pending() { return queue.length; },
  };
}

const HOUSES = [
  { id: 'A', lat: 33.760, lng: -84.300 },
  { id: 'B', lat: 33.761, lng: -84.301 },
  { id: 'C', lat: 33.762, lng: -84.302 },
  { id: 'G', lat: 33.763, lng: -84.303 },
];

test('nearest-to-camera ordering is by ground distance, stable, and a no-op without a camera', () => {
  const camera = { lat: 33.7622, lng: -84.3022 };
  assert.deepEqual(orderNearestFirst(HOUSES, camera).map((h) => h.id), ['C', 'G', 'B', 'A']);
  assert.deepEqual(orderNearestFirst(HOUSES, null).map((h) => h.id), ['A', 'B', 'C', 'G']);
  // Ties keep ranking order.
  const tied = [{ id: 'x', lat: 0, lng: 0 }, { id: 'y', lat: 0, lng: 0 }];
  assert.deepEqual(orderNearestFirst(tied, { lat: 0, lng: 0 }).map((h) => h.id), ['x', 'y']);
});

test('FIND_MONEY: scan at 0, ignitions from 600 ms 80 ms apart nearest first, gold last, beacon 500 ms', () => {
  const camera = { lat: 33.7622, lng: -84.3022 };
  const timeline = buildFindMoney({ matches: HOUSES, goldId: 'G', camera, brief: 'Gold pick is G.', focusId: 'G' });
  assert.equal(timeline.name, SEQUENCES.FIND_MONEY);
  assert.deepEqual(timeline.order, ['C', 'B', 'A', 'G']);

  const scan = timeline.phases[0];
  const ignitions = scan.events.filter((e) => e.id === 'ignite');
  assert.deepEqual(ignitions.map((e) => e.propertyId), ['C', 'B', 'A']);
  assert.deepEqual(ignitions.map((e) => e.at), [600, 680, 760]);
  assert.equal(scan.events.find((e) => e.id === 'scan').at, 0);
  assert.equal(scan.events.find((e) => e.sound === 'scanSweep').at, 0);
  for (const ignition of ignitions) {
    const tick = scan.events.find((e) => e.sound === 'houseTick' && e.propertyId === ignition.propertyId);
    assert.equal(tick.at, ignition.at, 'each ignition has its tick on the same beat');
  }
  const gold = scan.events.find((e) => e.id === 'gold');
  assert.equal(gold.propertyId, 'G');
  assert.equal(gold.at, 760 + TIMING.FIND_MONEY.goldAfterLastIgniteMs);
  assert.equal(scan.events.find((e) => e.sound === 'goldChime').at, gold.at);
  const rise = scan.events.find((e) => e.id === 'beaconRise');
  assert.equal(rise.durationMs, 500);
  assert.equal(scan.events.find((e) => e.id === 'beaconUp').at, gold.at + 500);
  assert.equal(phaseSpanMs(scan), gold.at + 500);

  // Then the flight, then the brief, then the dive after the dwell.
  assert.equal(timeline.phases[1].id, 'reveal');
  assert.equal(timeline.phases[1].events.find((e) => e.id === 'flight').shot, 'REVEAL');
  assert.equal(timeline.phases[2].id, 'brief');
  assert.equal(timeline.phases[2].events.find((e) => e.id === 'speak').text, 'Gold pick is G.');
  assert.equal(timeline.phases[2].events.find((e) => e.id === 'dive').at, TIMING.FIND_MONEY.dwellAfterBriefMs);

  // Flattened, the whole thing reads in performance order.
  const ids = flattenTimeline(timeline).map((e) => e.id).filter((id) => id !== 'sound');
  assert.deepEqual(ids, ['scan', 'ignite', 'ignite', 'ignite', 'gold', 'beaconRise', 'beaconUp', 'flight', 'speak', 'dive']);
});

test('FIND_MONEY with only the gold house still ignites it and still flies', () => {
  const timeline = buildFindMoney({ matches: [HOUSES[3]], goldId: 'G', brief: 'x' });
  assert.deepEqual(timeline.order, ['G']);
  assert.equal(timeline.phases[0].events.find((e) => e.id === 'gold').at, TIMING.FIND_MONEY.igniteStartAt);
  assert.equal(timeline.phases[0].events.filter((e) => e.id === 'ignite').length, 0);
});

test('LOOK_CLOSER: dive, then on landing the x-ray, the card, the orbit and the explanation', () => {
  const timeline = buildLookCloser({
    propertyId: 'G', hop: true, line: 'G.', sentences: ['one.', 'two.', 'three.'], sectionCount: 6,
  });
  assert.equal(timeline.name, SEQUENCES.LOOK_CLOSER);
  const [dive, land, settle] = timeline.phases;
  assert.equal(dive.events.find((e) => e.id === 'flight').shot, 'HOP');
  assert.equal(buildLookCloser({ propertyId: 'G' }).phases[0].events.find((e) => e.id === 'flight').shot, 'HERO');
  assert.deepEqual(land.events.map((e) => e.id).sort(), ['card', 'explain', 'orbit', 'sound', 'xray']);
  assert.ok(land.events.every((e) => e.at === 0), 'everything on landing lands together');
  assert.deepEqual(land.events.find((e) => e.id === 'explain').schedule, [0, 0, 0, 1, 1, 2]);
  assert.equal(settle.events[0].id, 'revealAll');
});

test('line schedule: header immediate, the rest spread over the sentences, last on last', () => {
  assert.deepEqual(lineScheduleFor(0, 3), []);
  assert.deepEqual(lineScheduleFor(1, 3), [0]);
  assert.deepEqual(lineScheduleFor(4, 0), [0, 0, 0, 0]);
  assert.deepEqual(lineScheduleFor(4, 1), [0, 0, 0, 0]);
  assert.deepEqual(lineScheduleFor(5, 4), [0, 0, 1, 2, 3]);
  assert.deepEqual(lineScheduleFor(8, 3), [0, 0, 0, 0, 1, 1, 1, 2]);
  const many = lineScheduleFor(9, 5);
  assert.equal(many[0], 0);
  assert.equal(many.at(-1), 4);
  for (let i = 1; i < many.length; i += 1) assert.ok(many[i] >= many[i - 1], 'monotonic');
});

test('SAVE: the glyph drops, the tone lands at 300 ms, the card follows at 450 ms', () => {
  const timeline = buildSave({ propertyId: 'A' });
  const events = flattenTimeline(timeline);
  assert.deepEqual(events.map((e) => [e.id, e.at]), [
    ['saved', 0], ['drop', 0], ['sound', 300], ['card', 450],
  ]);
  assert.equal(events.find((e) => e.id === 'drop').durationMs, TIMING.SAVE.dropMs);
  assert.equal(events.find((e) => e.id === 'sound').sound, 'saveConfirm');
});

test('the runner fires events at their offsets, in order, and waits on a handler promise before the next phase', async () => {
  const clock = fakeTimers();
  const fired = [];
  let landFlight = null;
  const timeline = buildFindMoney({ matches: HOUSES, goldId: 'G', camera: { lat: 33.7622, lng: -84.3022 }, brief: 'b', focusId: 'G' });
  const run = runTimeline(timeline, {
    scan: () => fired.push(['scan', clock.now()]),
    ignite: (e) => fired.push([`ignite:${e.propertyId}`, clock.now()]),
    gold: (e) => fired.push([`gold:${e.propertyId}`, clock.now()]),
    beaconUp: () => fired.push(['beaconUp', clock.now()]),
    flight: () => new Promise((resolve) => { landFlight = resolve; fired.push(['flight', clock.now()]); }),
    speak: () => fired.push(['speak', clock.now()]),
    dive: () => fired.push(['dive', clock.now()]),
  }, { timers: clock.timers, now: clock.now });

  await clock.advance(0);
  assert.deepEqual(fired, [['scan', 0]]);
  await clock.advance(700);
  assert.deepEqual(fired.slice(1), [['ignite:C', 600], ['ignite:B', 680]]);
  await clock.advance(1000);
  // The scan phase ended at 1340 (gold 840 + 500), so the flight took off then.
  assert.deepEqual(fired.slice(3), [['ignite:A', 760], ['gold:G', 840], ['beaconUp', 1340], ['flight', 1340]]);
  // The brief waits for the flight, however long it takes.
  await clock.advance(5000);
  assert.equal(fired.at(-1)[0], 'flight');
  assert.equal(run.running, true);
  landFlight({ cancelled: false });
  await clock.advance(0);
  assert.deepEqual(fired.at(-1), ['speak', 6700]);
  await clock.advance(TIMING.FIND_MONEY.dwellAfterBriefMs);
  assert.deepEqual(fired.at(-1), ['dive', 7500]);
  const summary = await run.done;
  assert.equal(summary.cancelled, false);
  assert.equal(run.running, false);
  assert.equal(clock.pending, 0);
});

test('cancel mid-ignition fires nothing further and resolves done as cancelled', async () => {
  const clock = fakeTimers();
  const fired = [];
  const timeline = buildFindMoney({ matches: HOUSES, goldId: 'G', brief: 'b' });
  const run = runTimeline(timeline, {
    ignite: (e) => fired.push(e.propertyId),
    gold: () => fired.push('GOLD'),
    flight: () => fired.push('FLIGHT'),
    speak: () => fired.push('SPEAK'),
  }, { timers: clock.timers, now: clock.now });
  await clock.advance(650);
  assert.deepEqual(fired, ['A']);
  run.cancel();
  assert.equal(run.running, false);
  assert.equal(clock.pending, 0, 'every pending timer was cleared');
  await clock.advance(10_000);
  assert.deepEqual(fired, ['A']);
  const summary = await run.done;
  assert.equal(summary.cancelled, true);
});

test('a handler can cancel from inside — a superseded flight stops the brief', async () => {
  const clock = fakeTimers();
  const fired = [];
  const timeline = buildFindMoney({ matches: HOUSES.slice(3), goldId: 'G', brief: 'b', focusId: 'G' });
  const run = runTimeline(timeline, {
    flight: async (_e, ctx) => { fired.push('flight'); ctx.cancel(); },
    speak: () => fired.push('speak'),
    dive: () => fired.push('dive'),
  }, { timers: clock.timers, now: clock.now });
  await clock.advance(5_000);
  const summary = await run.done;
  assert.deepEqual(fired, ['flight']);
  assert.equal(summary.cancelled, true);
});

test('reduced motion collapses every offset: same events, same order, all at once', async () => {
  const clock = fakeTimers();
  const fired = [];
  const timeline = buildFindMoney({ matches: HOUSES, goldId: 'G', camera: { lat: 33.7622, lng: -84.3022 }, brief: 'b' });
  const run = runTimeline(timeline, {
    scan: () => fired.push('scan'),
    ignite: (e, ctx) => fired.push(`${e.propertyId}${ctx.reduced ? '*' : ''}`),
    gold: () => fired.push('gold'),
    flight: () => fired.push('flight'),
    speak: () => fired.push('speak'),
  }, { timers: clock.timers, now: clock.now, reduced: true });
  await clock.advance(0);
  assert.deepEqual(fired, ['scan', 'C*', 'B*', 'A*', 'gold', 'flight', 'speak']);
  assert.equal(clock.pending, 0, 'no timers were scheduled at all');
  assert.equal((await run.done).cancelled, false);
});

test('the sequencer plays one moment at a time and keeps a history the headed check can read', async () => {
  const clock = fakeTimers();
  const sequencer = createSequencer({ timers: clock.timers, now: clock.now });
  const fired = [];
  const first = sequencer.play(buildSave({ propertyId: 'A' }), {
    sound: () => fired.push('tone-A'),
    card: () => fired.push('card-A'),
  });
  assert.equal(sequencer.current.name, 'SAVE');
  await clock.advance(100);
  const second = sequencer.play(buildSave({ propertyId: 'B' }), {
    sound: () => fired.push('tone-B'),
    card: () => fired.push('card-B'),
  });
  assert.equal(first.running, false, 'starting the next moment cancelled the first');
  await clock.advance(1000);
  assert.deepEqual(fired, ['tone-B', 'card-B']);
  assert.equal(second.running, false);
  assert.equal(sequencer.current, null);
  const history = sequencer.history;
  assert.equal(history.length, 2);
  assert.equal(history[0].cancelled, true);
  assert.equal(history[1].cancelled, false);
  assert.equal(history[1].endedAt - history[1].startedAt, 450);
  assert.deepEqual(history[1].log.map((row) => row.id), ['saved', 'drop', 'sound', 'card']);
});
