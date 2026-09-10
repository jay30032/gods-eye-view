import test from 'node:test';
import assert from 'node:assert/strict';
import { isPropertySaved, readSavedProperties, saveProperty } from './saved.js';

test('saved properties round-trip through a memory store', () => {
  const memory = new Map();
  const store = {
    getItem: (key) => memory.get(key) ?? null,
    setItem: (key, value) => memory.set(key, value),
  };
  const property = { id: 'DEMO-ATL-001', address: '214 Sycamore St' };
  const first = saveProperty(property, { strategy: 'flip' }, store);
  assert.equal(first.ok, true);
  assert.equal(first.alreadySaved, false);
  assert.equal(isPropertySaved('DEMO-ATL-001', store), true);
  const second = saveProperty(property, { note: 'again' }, store);
  assert.equal(second.alreadySaved, true);
  assert.equal(readSavedProperties(store).length, 1);
  assert.equal(readSavedProperties(store)[0].note, 'again');
});
