import test from 'node:test';
import assert from 'node:assert/strict';
import { DEMO_STEPS, demoForcesHunt, readDemoMode } from './demoSequence.js';
import { ACCEPTANCE_PHRASES } from './conversation.js';
import { shouldShowFirstHunt } from './ui/firstHunt.js';

test('demo steps cover the acceptance phrases in order', () => {
  const phrases = DEMO_STEPS.filter((step) => step.phrase).map((step) => step.phrase);
  assert.deepEqual(phrases, ACCEPTANCE_PHRASES);
  assert.equal(DEMO_STEPS[0].kind, 'hunt');
});

test('?demo=1 enables the scripted rail and forces the hunt ritual', () => {
  assert.deepEqual(readDemoMode({ search: '?demo=1' }), { enabled: true, auto: false, source: 'query' });
  assert.equal(readDemoMode({ search: '?demo=auto' }).auto, true);
  assert.equal(demoForcesHunt({ search: '?demo=1' }), true);
  assert.equal(shouldShowFirstHunt({ location: { search: '?demo=1' } }), true);
  const storage = {
    getItem: () => 'suppressed',
    setItem() {},
    removeItem() {},
  };
  assert.equal(shouldShowFirstHunt({
    storage,
    sessionStorageRef: { getItem: () => 'dismissed', setItem() {} },
    location: { search: '?demo=1' },
  }), true);
});
