import test from 'node:test';
import assert from 'node:assert/strict';
import { REPEAT_WINDOW_MS, SPEAK_EVENTS, createSpeakPolicy, normalizeLevel } from './speakPolicy.js';

function clock(start = 0) {
  let t = start;
  return { now: () => t, advance: (ms) => { t += ms; } };
}

test('a fresh event about a property speaks; the same property inside 60 s does not', () => {
  const c = clock();
  const policy = createSpeakPolicy({ now: c.now });
  assert.equal(policy.decide({ type: 'find_money_complete', propertyId: 'A' }).speak, true);
  const again = policy.decide({ type: 'house_focused', propertyId: 'A' });
  assert.equal(again.speak, false);
  assert.match(again.reason, /same property within 60s/);
  // A different house is a different brief.
  assert.equal(policy.decide({ type: 'house_focused', propertyId: 'B' }).speak, true);
  c.advance(REPEAT_WINDOW_MS - 1);
  assert.equal(policy.decide({ type: 'xray', propertyId: 'A' }).speak, false);
  c.advance(2);
  assert.equal(policy.decide({ type: 'xray', propertyId: 'A' }).speak, true);
});

test('never during a flight', () => {
  const policy = createSpeakPolicy({ now: () => 0 });
  const grounded = policy.decide({ type: 'descent_settled' }, { flying: false });
  assert.equal(grounded.speak, true);
  const airborne = policy.decide({ type: 'drive_approach', propertyId: 'C' }, { flying: true });
  assert.equal(airborne.speak, false);
  assert.equal(airborne.reason, 'in flight');
  // A refused brief does not burn the property's window.
  assert.equal(policy.decide({ type: 'drive_approach', propertyId: 'C' }, { flying: false }).speak, true);
});

test('quiet speaks only direct answers; off speaks nothing at all', () => {
  const policy = createSpeakPolicy({ now: () => 0 });
  assert.equal(policy.decide({ type: 'descent_settled' }, { level: 'quiet' }).speak, false);
  assert.equal(policy.decide({ type: 'descent_settled' }, { level: 'quiet' }).reason, 'narration quiet');
  assert.equal(policy.decide({ direct: true, propertyId: 'A' }, { level: 'quiet' }).speak, true);
  assert.equal(policy.decide({ direct: true }, { level: 'off' }).speak, false);
  assert.equal(policy.decide({ type: 'save_done', propertyId: 'A' }, { level: 'off' }).reason, 'narration off');
  assert.equal(policy.decide({ type: 'save_done', propertyId: 'Z' }, { level: 'full' }).speak, true);
});

test('a direct answer is exempt from the repeat window and the flight rule, and counts as a brief', () => {
  const policy = createSpeakPolicy({ now: () => 0 });
  assert.equal(policy.decide({ type: 'house_focused', propertyId: 'A' }).speak, true);
  assert.equal(policy.decide({ direct: true, propertyId: 'A' }, { flying: true }).speak, true);
  policy.noteSpoken('B');
  assert.equal(policy.decide({ type: 'house_focused', propertyId: 'B' }).speak, false);
  assert.deepEqual(policy.recent.sort(), ['A', 'B']);
});

test('events without a property only obey level and flight', () => {
  const policy = createSpeakPolicy({ now: () => 0 });
  assert.equal(policy.decide({ type: 'descent_settled' }).speak, true);
  assert.equal(policy.decide({ type: 'descent_settled' }).speak, true);
  assert.equal(policy.decide({}).speak, false);
  assert.equal(policy.decide({}).reason, 'no event');
});

test('levels normalise and every event is declared', () => {
  assert.equal(normalizeLevel('QUIET'), 'quiet');
  assert.equal(normalizeLevel(undefined), 'full');
  assert.equal(normalizeLevel('loud'), 'full');
  for (const type of ['descent_settled', 'find_money_complete', 'house_focused', 'drive_approach', 'xray', 'save_done']) {
    assert.ok(type in SPEAK_EVENTS, type);
  }
});
