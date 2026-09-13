/**
 * When the drive speaks, and which house "that one" means.
 *
 * Two product rules with teeth here. The first is that the assistant must not
 * become a podcast: one call-out per house ever, neighbours announced together,
 * and a level the user controls. The second is that a referring command —
 * "save that one" — must never guess. Saving the wrong house is a silent error
 * the user only discovers later, which is worse than being asked.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CALLOUT_AHEAD_M,
  CALLOUT_MIN_AHEAD_M,
  GROUP_RADIUS_M,
  ambiguityQuestion,
  bestAlongRoute,
  calloutFor,
  createDiscussionTracker,
  goldWhy,
  groupByProximity,
  resolveDiscussed,
  shouldAnnounce,
} from './narration.js';

const house = (id, alongM, type, composite = 50) => ({
  id,
  alongM,
  property: {
    id,
    address: `${id} Test St, Decatur, GA`,
    signals: [{ type, confidence: 0.9, ageDays: 12 }],
    composite,
    opportunityScore: { flip: composite },
  },
});

// --- grouping -------------------------------------------------------------

test('houses within the group radius are one call-out', () => {
  const groups = groupByProximity([
    house('A', 100, 'FORECLOSURE'),
    house('B', 130, 'FORECLOSURE'),
    house('C', 400, 'TAX_SALE'),
  ]);
  assert.equal(groups.length, 2);
  assert.deepEqual(groups[0].ids, ['A', 'B']);
  assert.deepEqual(groups[1].ids, ['C']);
});

test('a group is announced at its first member, not at its average', () => {
  // The sentence has to arrive before the first house, or the pair is already
  // going past while it is still being said.
  const [group] = groupByProximity([house('A', 100, 'DISTRESS'), house('B', 135, 'DISTRESS')]);
  assert.equal(group.alongM, 100);
});

test('grouping is by distance ALONG the route, not straight-line', () => {
  // Two houses either side of a block are metres apart and a minute apart on a
  // road that goes round it. Announcing them together would name one that is
  // nowhere in sight.
  const groups = groupByProximity([
    house('A', 100, 'FORECLOSURE'),
    house('B', 100 + GROUP_RADIUS_M + 1, 'FORECLOSURE'),
  ]);
  assert.equal(groups.length, 2, 'just past the radius must be two call-outs');
});

test('grouping chains neighbours rather than only pairing them', () => {
  const groups = groupByProximity([
    house('A', 100, 'DISTRESS'),
    house('B', 130, 'DISTRESS'),
    house('C', 160, 'DISTRESS'),
  ]);
  assert.equal(groups.length, 1);
  assert.deepEqual(groups[0].ids, ['A', 'B', 'C']);
});

test('grouping tolerates an empty or nonsense board', () => {
  assert.deepEqual(groupByProximity([]), []);
  assert.deepEqual(groupByProximity(null), []);
  assert.deepEqual(groupByProximity([{ id: null, alongM: 1 }, { id: 'x', alongM: NaN }]), []);
});

// --- when to speak --------------------------------------------------------

test('a call-out fires in its window and nowhere else', () => {
  const [group] = groupByProximity([house('A', 100, 'FORECLOSURE')]);
  const at = (aheadM) => shouldAnnounce({ group, aheadM, announced: new Set() });
  assert.equal(at(CALLOUT_AHEAD_M + 1), false, 'too early to see it');
  assert.equal(at(CALLOUT_AHEAD_M - 1), true);
  assert.equal(at(CALLOUT_MIN_AHEAD_M + 1), true);
  assert.equal(at(CALLOUT_MIN_AHEAD_M - 1), false, 'too late to be useful');
  assert.equal(at(-50), false, 'never behind');
});

test('a house is announced once, ever — including on a second lap', () => {
  const [group] = groupByProximity([house('A', 100, 'FORECLOSURE')]);
  const announced = new Set();
  assert.equal(shouldAnnounce({ group, aheadM: 80, announced }), true);
  announced.add('A');
  assert.equal(shouldAnnounce({ group, aheadM: 80, announced }), false);
});

test('a group re-announces only while some member is still unannounced', () => {
  const [group] = groupByProximity([house('A', 100, 'DISTRESS'), house('B', 120, 'DISTRESS')]);
  const announced = new Set(['A']);
  assert.equal(shouldAnnounce({ group, aheadM: 80, announced }), true, 'B has not been named');
  announced.add('B');
  assert.equal(shouldAnnounce({ group, aheadM: 80, announced }), false);
});

test('the narration level is the user\'s', () => {
  const [urgent] = groupByProximity([house('A', 100, 'FORECLOSURE')]);
  const [minor] = groupByProximity([house('B', 100, 'LISTED_OPPORTUNITY')]);
  const args = { aheadM: 80, announced: new Set() };

  assert.equal(shouldAnnounce({ ...args, group: urgent, level: 'full' }), true);
  assert.equal(shouldAnnounce({ ...args, group: minor, level: 'full' }), true);
  // Quiet speaks only for a clock that is already running.
  assert.equal(shouldAnnounce({ ...args, group: urgent, level: 'quiet' }), true);
  assert.equal(shouldAnnounce({ ...args, group: minor, level: 'quiet' }), false);
  assert.equal(shouldAnnounce({ ...args, group: urgent, level: 'off' }), false);
});

// --- what it says ---------------------------------------------------------

test('one house names its signal and offers a look', () => {
  const [group] = groupByProximity([house('A', 100, 'FORECLOSURE')]);
  const callout = calloutFor(group, 'right');
  assert.match(callout.text, /notice-of-sale property/);
  assert.match(callout.text, /on the right/);
  assert.match(callout.text, /closer look/);
  assert.equal(callout.primaryId, 'A');
});

test('several houses are counted, not listed', () => {
  const [group] = groupByProximity([
    house('A', 100, 'FORECLOSURE'),
    house('B', 120, 'FORECLOSURE'),
  ]);
  const callout = calloutFor(group, 'left');
  assert.match(callout.text, /^2 /);
  assert.match(callout.text, /on the left/);
  assert.deepEqual(callout.ids, ['A', 'B']);
});

test('a mixed group does not claim a shared signal', () => {
  const [group] = groupByProximity([
    house('A', 100, 'FORECLOSURE'),
    house('B', 120, 'TAX_SALE'),
  ]);
  assert.match(calloutFor(group, 'right').text, /flagged properties/);
});

test('"ahead" is used when there is no side', () => {
  const [group] = groupByProximity([house('A', 100, 'DISTRESS')]);
  assert.match(calloutFor(group, 'ahead').text, /ahead/);
});

test('the gold call-out names the house and offers to pause', () => {
  const [group] = groupByProximity([house('A', 100, 'FORECLOSURE', 96)]);
  const callout = calloutFor(group, 'right', { gold: true });
  assert.equal(callout.gold, true);
  assert.match(callout.text, /Best match/);
  assert.match(callout.text, /pause/i);
});

test('the best match is the composite ranking, and ties break deterministically', () => {
  const rows = [house('A', 10, 'DISTRESS', 40), house('B', 20, 'FORECLOSURE', 91), house('C', 30, 'TAX_SALE', 70)];
  assert.equal(bestAlongRoute(rows).id, 'B');
  const tied = [house('Z', 10, 'DISTRESS', 80), house('A', 20, 'DISTRESS', 80)];
  assert.equal(bestAlongRoute(tied).id, 'A', 'a tie must not be a coin toss');
  assert.equal(bestAlongRoute([]), null);
});

test('the gold Why is one sentence with the score in it', () => {
  const line = goldWhy(house('A', 10, 'FORECLOSURE', 96).property);
  assert.match(line, /96/);
  assert.equal(line.split('.').filter(Boolean).length, 1, 'one sentence, not a paragraph');
});

// --- which house is "that one" -------------------------------------------

test('the tracker remembers the current house and the one before it', () => {
  const tracker = createDiscussionTracker();
  assert.equal(tracker.current, null);
  tracker.announce(['A'], 'A');
  assert.equal(tracker.current.primaryId, 'A');
  assert.equal(tracker.previous, null);
  tracker.announce(['B'], 'B');
  assert.equal(tracker.current.primaryId, 'B');
  assert.equal(tracker.previous.primaryId, 'A');
});

test('re-announcing the same house does not make it its own predecessor', () => {
  // Otherwise "compare it with the last one" compares a house with itself.
  const tracker = createDiscussionTracker();
  tracker.announce(['A'], 'A');
  tracker.announce(['A'], 'A');
  assert.equal(tracker.previous, null);
});

test('a referring command resolves to the house being discussed', () => {
  const tracker = createDiscussionTracker();
  tracker.announce(['A'], 'A');
  const outcome = resolveDiscussed(tracker, 'save_that');
  assert.equal(outcome.ok, true);
  assert.equal(outcome.id, 'A');
});

test('two plausible houses produce a question, never a guess', () => {
  // The rule that matters: saving the wrong house is a silent error the user
  // finds out about later.
  const tracker = createDiscussionTracker();
  tracker.announce(['A', 'B'], 'A');
  const outcome = resolveDiscussed(tracker, 'save_that');
  assert.equal(outcome.ok, false);
  assert.deepEqual(outcome.ambiguous, ['A', 'B']);
  assert.equal(outcome.id, undefined, 'it must not answer anyway');
});

test('naming one settles the ambiguity', () => {
  const tracker = createDiscussionTracker();
  tracker.announce(['A', 'B'], 'A');
  tracker.settle('B');
  const outcome = resolveDiscussed(tracker, 'save_that');
  assert.equal(outcome.ok, true);
  assert.equal(outcome.id, 'B');
});

test('"compare it with the last one" needs a last one', () => {
  const tracker = createDiscussionTracker();
  tracker.announce(['A'], 'A');
  const first = resolveDiscussed(tracker, 'compare_last');
  assert.equal(first.ok, false);
  assert.match(first.reason, /compare with/);

  tracker.announce(['B'], 'B');
  const second = resolveDiscussed(tracker, 'compare_last');
  assert.equal(second.ok, true);
  assert.equal(second.id, 'B');
  assert.equal(second.previousId, 'A');
});

test('nothing discussed yet is a reason, not a crash', () => {
  const tracker = createDiscussionTracker();
  const outcome = resolveDiscussed(tracker, 'save_that');
  assert.equal(outcome.ok, false);
  assert.match(outcome.reason, /nothing being discussed/);
  assert.equal(resolveDiscussed(tracker, 'not_a_command').ok, false);
});

test('the ambiguity question names the houses', () => {
  const lookup = (id) => ({ address: `${id} Third Ave, Decatur, GA` });
  const question = ambiguityQuestion(['A', 'B'], lookup);
  assert.match(question, /A Third Ave/);
  assert.match(question, /B Third Ave/);
  assert.match(question, / or /);
  assert.equal(ambiguityQuestion(['A'], lookup), 'Which one?');
});
