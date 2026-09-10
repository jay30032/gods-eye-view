import test from 'node:test';
import assert from 'node:assert/strict';
import { shouldShowFirstHunt } from './firstHunt.js';

function memoryStore(start = {}) {
  const data = { ...start };
  return {
    getItem: (key) => (Object.hasOwn(data, key) ? data[key] : null),
    setItem: (key, value) => { data[key] = String(value); },
    removeItem: (key) => { delete data[key]; },
  };
}

test('first hunt shows on a fresh session and yields to a share link', () => {
  assert.equal(shouldShowFirstHunt({ location: { search: '' } }), true);
  assert.equal(shouldShowFirstHunt({ hasShareState: true, location: { search: '' } }), false);
});

test('welcome query outranks stored suppress, and durable suppress hides it', () => {
  const storage = memoryStore({ 'terrasignal:first-hunt:v1': 'suppressed' });
  const session = memoryStore({ 'terrasignal:first-hunt-session:v1': 'dismissed' });
  assert.equal(shouldShowFirstHunt({ storage, sessionStorageRef: session, location: { search: '' } }), false);
  assert.equal(shouldShowFirstHunt({ storage, sessionStorageRef: session, location: { search: '?welcome=1' } }), true);
  assert.equal(shouldShowFirstHunt({ location: { search: '?welcome=0' } }), false);
});
