import test from 'node:test';
import assert from 'node:assert/strict';
import { createOrb, orbStateFromVoice, resolveOrbState } from './orb.js';

test('the voice control\'s attributes map to the four lights', () => {
  assert.equal(orbStateFromVoice({ status: 'idle', speaker: 'idle' }), 'idle');
  assert.equal(orbStateFromVoice({ status: 'listening', speaker: 'idle' }), 'listening');
  assert.equal(orbStateFromVoice({ status: 'listening', speaker: 'user' }), 'listening');
  assert.equal(orbStateFromVoice({ status: 'executing', speaker: 'idle' }), 'thinking');
  assert.equal(orbStateFromVoice({ status: 'connecting', speaker: 'idle' }), 'thinking');
  assert.equal(orbStateFromVoice({ status: 'listening', speaker: 'ai' }), 'speaking');
  assert.equal(orbStateFromVoice({ status: 'error' }), 'idle');
});

test('when sources disagree the user talking wins, then speaking, then thinking', () => {
  assert.equal(resolveOrbState({ voice: 'idle', narrator: 'idle', session: 'idle' }), 'idle');
  assert.equal(resolveOrbState({ voice: 'idle', narrator: 'speaking', session: 'thinking' }), 'speaking');
  assert.equal(resolveOrbState({ voice: 'listening', narrator: 'speaking' }), 'listening');
  assert.equal(resolveOrbState({ session: 'thinking' }), 'thinking');
  assert.equal(resolveOrbState({ session: 'nonsense' }), 'idle');
});

test('the orb writes its state onto the slot, and follows the voice control through a mutation observer', () => {
  const slot = { dataset: {} };
  let callback = null;
  const observed = [];
  class FakeObserver {
    constructor(fn) { callback = fn; }
    observe(node, options) { observed.push([node, options]); }
    disconnect() {}
  }
  const listeners = {};
  const target = {
    addEventListener(type, fn) { listeners[type] = fn; },
    removeEventListener(type) { delete listeners[type]; },
  };
  const orb = createOrb({ slot: () => slot, target, MutationObserverCtor: FakeObserver });
  assert.equal(slot.dataset.tsOrb, 'idle');

  orb.set('session', 'thinking');
  assert.equal(slot.dataset.tsOrb, 'thinking');
  orb.set('narrator', 'speaking');
  assert.equal(slot.dataset.tsOrb, 'speaking');
  orb.set('narrator', 'idle');
  orb.set('session', 'idle');
  assert.equal(slot.dataset.tsOrb, 'idle');

  const voice = { dataset: { status: 'idle', speaker: 'idle' } };
  listeners['terrasignal:voice-placed']({ detail: { node: voice } });
  assert.equal(observed.length, 1);
  assert.deepEqual(observed[0][1], { attributes: true, attributeFilter: ['data-status', 'data-speaker', 'data-paused'] });
  voice.dataset.status = 'listening';
  callback();
  assert.equal(slot.dataset.tsOrb, 'listening');
  voice.dataset.status = 'executing';
  callback();
  assert.equal(slot.dataset.tsOrb, 'thinking');
  voice.dataset.speaker = 'ai';
  callback();
  assert.equal(slot.dataset.tsOrb, 'speaking');
  // A second placement of the same node does not double-observe.
  listeners['terrasignal:voice-placed']({ detail: { node: voice } });
  assert.equal(observed.length, 1);
  orb.destroy();
  assert.deepEqual(Object.keys(listeners), []);
});

test('a paused mic reads as idle even while the control says listening; the assistant speaking still shows', () => {
  assert.equal(orbStateFromVoice({ status: 'listening', speaker: 'idle', paused: true }), 'idle');
  assert.equal(orbStateFromVoice({ status: 'listening', speaker: 'ai', paused: true }), 'speaking');
  assert.equal(orbStateFromVoice({ status: 'listening', speaker: 'idle', paused: false }), 'listening');
});
