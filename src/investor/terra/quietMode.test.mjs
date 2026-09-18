import test from 'node:test';
import assert from 'node:assert/strict';
import {
  QUIET_STORAGE_KEY,
  classifyReplyEvent,
  readQuietPref,
  replyRoute,
  sessionUpdateFor,
  stripLineFor,
  writeQuietPref,
} from './quietMode.js';

function memoryStorage() {
  const map = new Map();
  return { getItem: (k) => (map.has(k) ? map.get(k) : null), setItem: (k, v) => map.set(k, String(v)), map };
}

test('quiet persists per browser and defaults to off', () => {
  const storage = memoryStorage();
  assert.equal(readQuietPref(storage), false);
  assert.equal(writeQuietPref(true, storage), true);
  assert.equal(storage.map.get(QUIET_STORAGE_KEY), '1');
  assert.equal(readQuietPref(storage), true);
  writeQuietPref(false, storage);
  assert.equal(readQuietPref(storage), false);
  // A storage that throws (private mode) reads as off and never throws.
  const broken = { getItem() { throw new Error('nope'); }, setItem() { throw new Error('nope'); } };
  assert.equal(readQuietPref(broken), false);
  assert.equal(writeQuietPref(true, broken), true);
});

test('typed and spoken messages route through the assistant; quiet only changes the reply modality', () => {
  assert.deepEqual(replyRoute({ available: true, quiet: false }), { via: 'assistant', modality: 'audio', audio: true });
  assert.deepEqual(replyRoute({ available: true, quiet: true }), { via: 'assistant', modality: 'text', audio: false });
  assert.deepEqual(replyRoute({ available: false, quiet: true }), { via: 'parser', modality: 'text', audio: false });
  assert.deepEqual(replyRoute({}), { via: 'parser', modality: 'text', audio: false });
});

test('the session is switched between speaking and writing with one update', () => {
  assert.deepEqual(sessionUpdateFor(true), { type: 'session.update', session: { type: 'realtime', output_modalities: ['text'] } });
  assert.deepEqual(sessionUpdateFor(false).session.output_modalities, ['audio']);
});

test('reply events classify by modality, and the strip shows the tail of a long reply', () => {
  assert.deepEqual(classifyReplyEvent('response.output_audio_transcript.delta'), { kind: 'delta', modality: 'audio' });
  assert.deepEqual(classifyReplyEvent('response.output_text.done'), { kind: 'done', modality: 'text' });
  assert.deepEqual(classifyReplyEvent('response.text.delta'), { kind: 'delta', modality: 'text' });
  assert.equal(classifyReplyEvent('response.done'), null);
  assert.equal(stripLineFor('  six   houses '), 'six houses');
  const long = 'x'.repeat(200);
  assert.equal(stripLineFor(long).length, 160);
  assert.ok(stripLineFor(long).startsWith('…'));
});
