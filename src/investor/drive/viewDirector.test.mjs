/**
 * Which view answers which question, and the 300 ms between them.
 *
 * The mapping is the product decision Drive Mode v2 is built on — Street View
 * drives, the 3D scene answers — so the cases pinned here are the ones where
 * getting it wrong is invisible until a demo: a resume read as a request for a
 * rear wall, a volume change that cuts away from the road, a card that stops
 * the drive it was meant to run underneath.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { parseCommand } from '../nlp/parse.js';
import {
  CROSS_FADE_MS,
  VIEWS,
  announceFor,
  createViewDirector,
  crossFadeState,
  isThreeD,
  leavesTheRoad,
  viewForQuestion,
} from './viewDirector.js';

/** The way the session asks: the words, and the parser's reading of them. */
function route(text) {
  const parsed = parseCommand(text);
  return viewForQuestion(text, { intent: parsed?.intent, slots: parsed?.slots });
}

// ---------------------------------------------------------------------------
// The mapping
// ---------------------------------------------------------------------------

test('why / flagged / how recent are a card over the current view', () => {
  assert.deepEqual(route('why'), { view: VIEWS.CARD, reason: 'why' });
  assert.deepEqual(route('why did you flag it'), { view: VIEWS.CARD, reason: 'why' });
  assert.deepEqual(route('how recent is that'), { view: VIEWS.CARD, reason: 'recency' });
  assert.deepEqual(route('when was it filed'), { view: VIEWS.CARD, reason: 'recency' });
  // A card does not leave the road: the drive keeps rolling under it, which is
  // the whole reason these three are cards.
  assert.equal(leavesTheRoad(VIEWS.CARD), false);
});

test('lot / parcel / how big / boundaries are the 3D aerial', () => {
  for (const phrase of [
    'how big is the lot',
    'show me the parcel',
    'where are the property lines',
    'what are the boundaries',
    'how much land is there',
  ]) {
    assert.deepEqual(route(phrase), { view: VIEWS.AERIAL, reason: 'lot' }, phrase);
  }
});

test('roof / overhead / from above are the top-down', () => {
  for (const phrase of ['show me the roof', 'from above', 'top down', "bird's eye"]) {
    assert.deepEqual(route(phrase), { view: VIEWS.TOPDOWN, reason: 'overhead' }, phrase);
  }
  // "overhead" during a drive parses as a look, not a camera command, and is
  // still the same answer — the view is decided by the question, not by which
  // branch of the parser happened to claim it.
  assert.deepEqual(
    viewForQuestion('overhead', { intent: 'drive_look', slots: { look: 'overhead' } }),
    { view: VIEWS.TOPDOWN, reason: 'overhead' },
  );
});

test('sides and compass points are the existing any-angle shots', () => {
  for (const phrase of ['show me the back', 'show me the front', 'from the north', 'look at the left side']) {
    assert.deepEqual(route(phrase), { view: VIEWS.ANGLE, reason: 'angle' }, phrase);
  }
});

test('neighborhood / around it / comps cruise over the route', () => {
  for (const phrase of ['show me the neighborhood', "what's around it", 'show me comps', 'what else is on the block']) {
    assert.deepEqual(route(phrase), { view: VIEWS.CRUISE, reason: 'neighborhood' }, phrase);
  }
});

test('numbers / deal / run it are the analysis card', () => {
  for (const phrase of ['run the numbers', 'show me the deal', 'run it', 'what are the numbers']) {
    assert.deepEqual(route(phrase), { view: VIEWS.ANALYSIS, reason: 'numbers' }, phrase);
  }
  assert.equal(leavesTheRoad(VIEWS.ANALYSIS), false);
});

test('keep going / resume return to Street View', () => {
  for (const phrase of ['keep going', 'resume', 'carry on', 'back on the road', 'drive on']) {
    assert.deepEqual(route(phrase), { view: VIEWS.STREET_VIEW, reason: 'resume' }, phrase);
  }
});

test('"back on the road" is a resume and "show me the back" is a wall', () => {
  // The two rules share the word, and only the ordering of the table keeps both
  // readings alive. This is the assertion that fails if anyone reorders it.
  assert.equal(route('back on the road').view, VIEWS.STREET_VIEW);
  assert.equal(route('show me the back').view, VIEWS.ANGLE);
  assert.equal(route('back to the drive').view, VIEWS.STREET_VIEW);
});

test('a question about the lot from above is still about the lot', () => {
  // Both rules match. The aerial answers it either way and the parcel outline
  // is the point, so the land rule runs first — stated here so the ordering is
  // a decision rather than an accident of regex order.
  assert.equal(route('how big is the lot from above').view, VIEWS.AERIAL);
});

test('everything that is not a view question leaves the view alone', () => {
  // Null is a real answer and the common one. A director that insisted on a
  // view for every utterance would cut away from the road to acknowledge a
  // narration change.
  for (const phrase of [
    'pause here', 'slower', 'faster', 'save that one', 'narration off',
    'closer', 'back up', 'stop drive', 'find me money',
  ]) {
    assert.equal(route(phrase), null, phrase);
  }
});

test('"closer" is a re-framing, not a cut to a 3D angle', () => {
  assert.equal(
    viewForQuestion('closer', { intent: 'camera_angle', slots: { range: 'closer' } }),
    null,
  );
  assert.deepEqual(
    viewForQuestion('swing round', { intent: 'camera_angle', slots: { side: 'back' } }),
    { view: VIEWS.ANGLE, reason: 'angle' },
  );
});

test('the 3D views are exactly the ones that leave the road', () => {
  assert.deepEqual(
    [VIEWS.AERIAL, VIEWS.TOPDOWN, VIEWS.ANGLE, VIEWS.CRUISE].map(isThreeD),
    [true, true, true, true],
  );
  assert.deepEqual(
    [VIEWS.STREET_VIEW, VIEWS.CARD, VIEWS.ANALYSIS].map(isThreeD),
    [false, false, false],
  );
  for (const view of Object.values(VIEWS)) {
    assert.equal(leavesTheRoad(view), isThreeD(view), view);
  }
});

test('every view switch has a short spoken clause', () => {
  const clauses = Object.values(VIEWS).map((view) => announceFor(view));
  for (const clause of clauses) {
    assert.ok(clause.length > 0, 'a view switch with nothing said is a cut');
    // One clause. It lands while the cross-fade is still running, and anything
    // longer is still being spoken once the answer is already on screen.
    assert.ok(clause.split(' ').length <= 5, `"${clause}" is not one short clause`);
    assert.ok(/[.!]$/.test(clause));
  }
  assert.equal(announceFor(VIEWS.AERIAL), "Here's the lot.");
  assert.equal(announceFor(VIEWS.CARD, 'recency'), "Here's the filing.");
  assert.equal(announceFor(VIEWS.CARD, 'why'), "Here's why.");
});

// ---------------------------------------------------------------------------
// The cross-fade
// ---------------------------------------------------------------------------

test('the cross-fade is 300 ms and the two opacities always sum to one', () => {
  assert.equal(CROSS_FADE_MS, 300);
  for (const to of [VIEWS.STREET_VIEW, VIEWS.AERIAL]) {
    for (let ms = 0; ms <= 300; ms += 25) {
      const state = crossFadeState(ms, { to });
      assert.ok(Math.abs(state.streetView + state.cesium - 1) < 1e-9,
        `${to} at ${ms} ms summed to ${state.streetView + state.cesium}`);
    }
  }
});

test('into Street View the panorama arrives; out of it, it leaves', () => {
  const inStart = crossFadeState(0, { to: VIEWS.STREET_VIEW });
  const inEnd = crossFadeState(CROSS_FADE_MS, { to: VIEWS.STREET_VIEW });
  assert.equal(inStart.streetView, 0);
  assert.equal(inEnd.streetView, 1);
  assert.equal(inEnd.done, true);

  const outStart = crossFadeState(0, { to: VIEWS.AERIAL });
  const outEnd = crossFadeState(CROSS_FADE_MS, { to: VIEWS.AERIAL });
  assert.equal(outStart.streetView, 1);
  assert.equal(outStart.cesium, 0);
  assert.equal(outEnd.streetView, 0);
  assert.equal(outEnd.cesium, 1);
});

test('the panorama stays in the tree until it is fully transparent', () => {
  // Removing it at t=0.99 is a one-frame flash of the 3D scene at the end of
  // every transition.
  assert.equal(crossFadeState(299, { to: VIEWS.AERIAL }).showStreetView, true);
  assert.equal(crossFadeState(300, { to: VIEWS.AERIAL }).showStreetView, false);
});

test('the fade is eased, and monotonic either way', () => {
  let previous = -1;
  for (let ms = 0; ms <= 400; ms += 5) {
    const value = crossFadeState(ms, { to: VIEWS.STREET_VIEW }).streetView;
    assert.ok(value >= previous - 1e-9, `dipped at ${ms} ms`);
    previous = value;
  }
  // Smoothstep rather than linear: a linear alpha ramp between two photographs
  // reads as a wipe with a hard start and stop.
  assert.ok(crossFadeState(CROSS_FADE_MS * 0.1, { to: VIEWS.STREET_VIEW }).streetView < 0.1);
  assert.ok(Math.abs(crossFadeState(CROSS_FADE_MS / 2, { to: VIEWS.STREET_VIEW }).streetView - 0.5) < 1e-9);
});

test('time past the end and nonsense both clamp rather than overshoot', () => {
  const late = crossFadeState(5_000, { to: VIEWS.STREET_VIEW });
  assert.equal(late.streetView, 1);
  assert.equal(late.done, true);
  const nonsense = crossFadeState(NaN, { to: VIEWS.STREET_VIEW });
  assert.equal(nonsense.streetView, 0);
});

// ---------------------------------------------------------------------------
// The director's state
// ---------------------------------------------------------------------------

function harness() {
  const element = {
    hidden: true, dataset: {}, style: {},
  };
  const calls = [];
  let alongM = 420;
  let headingDeg = 271;
  const drive = {
    get alongM() { return alongM; },
    get headingDeg() { return headingDeg; },
    parkForAnswer() { calls.push('park'); },
    resumeFromAnswer(saved) { calls.push(['resume', saved]); alongM = saved?.alongM ?? alongM; },
    routePoints: () => [{ id: 'A' }],
  };
  const director = createViewDirector({
    element,
    drive,
    camera: { fly: (name, target) => { calls.push(['fly', name, target?.id ?? null]); } },
    visuals: { setFocused: (id) => calls.push(['focus', id]) },
    onAnnounce: (clause) => calls.push(['say', clause]),
    timers: { setTimeout: () => 1, clearTimeout: () => {} },
  });
  director.setEnabled(true);
  return {
    director, calls, element, drive, move(to) { alongM = to; },
  };
}

test('a 3D answer parks the drive and a resume puts it back on the same metre', async () => {
  const h = harness();
  await h.director.show(VIEWS.AERIAL, { property: { id: 'SIX-004' }, reason: 'lot' });
  assert.equal(h.director.view, VIEWS.AERIAL);
  assert.deepEqual(h.director.saved, { alongM: 420, headingDeg: 271 });
  assert.ok(h.calls.includes('park'));

  h.move(999); // nothing may move the saved point while the answer is up
  const resumed = await h.director.resume();
  assert.equal(h.director.view, VIEWS.STREET_VIEW);
  assert.deepEqual(resumed.resumed, { alongM: 420, headingDeg: 271 });
  assert.equal(h.director.saved, null);
  assert.deepEqual(h.calls.at(-1), ['resume', { alongM: 420, headingDeg: 271 }]);
});

test('three questions in a row save the position once, not three times', () => {
  const h = harness();
  return (async () => {
    await h.director.show(VIEWS.AERIAL, { property: { id: 'A' } });
    h.move(600);
    await h.director.show(VIEWS.TOPDOWN, { property: { id: 'A' } });
    h.move(800);
    await h.director.show(VIEWS.ANGLE, { property: { id: 'A' }, angle: async () => {} });
    assert.deepEqual(h.director.saved, { alongM: 420, headingDeg: 271 },
      'the road was left once, at 420 m — the later answers were asked standing still');
    assert.equal(h.calls.filter((c) => c === 'park').length, 1);
  })();
});

test('a card does not park the drive and moves no camera', async () => {
  const h = harness();
  await h.director.show(VIEWS.CARD, { reason: 'why' });
  assert.equal(h.director.view, VIEWS.CARD);
  assert.equal(h.director.saved, null);
  assert.equal(h.calls.filter((c) => c === 'park').length, 0);
  assert.equal(h.calls.some((c) => Array.isArray(c) && c[0] === 'fly'), false);
  assert.deepEqual(h.calls[0], ['say', "Here's why."]);
});

test('moveCamera:false takes the fade and leaves the flight to the caller', async () => {
  // "Look closer" has flown its own HERO since v1; a second flight would cancel
  // the first mid-arc.
  const h = harness();
  await h.director.show(VIEWS.AERIAL, { property: { id: 'A' }, moveCamera: false });
  assert.equal(h.calls.some((c) => Array.isArray(c) && c[0] === 'fly'), false);
  assert.ok(h.calls.includes('park'));
});

test('with Street View not driving, the director changes nothing', async () => {
  const h = harness();
  h.director.setEnabled(false);
  const result = await h.director.show(VIEWS.AERIAL, { property: { id: 'A' } });
  assert.equal(result.ok, false);
  assert.equal(h.calls.length, 0, 'no announcement for a view switch that did not happen');
});

test('losing coverage disables the director rather than leaving it half-armed', () => {
  const h = harness();
  h.director.fallbackToChase();
  assert.equal(h.director.enabled, false);
  h.director.restoreStreetView();
  assert.equal(h.director.enabled, true);
  assert.equal(h.director.view, VIEWS.STREET_VIEW);
});
