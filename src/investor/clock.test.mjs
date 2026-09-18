import test from 'node:test';
import assert from 'node:assert/strict';
import { DEMO_CLOCK_DEFAULT, demoNow, parseClockDate } from './clock.js';

const iso = (date) => (date ? date.toISOString().slice(0, 10) : null);

test('the query clock wins over everything else', () => {
  assert.equal(iso(demoNow({
    search: '?clock=2027-03-02&demo=1',
    envClock: '2026-01-01',
    demoMode: true,
  })), '2027-03-02');
});

test('the env clock wins when no query clock is given', () => {
  assert.equal(iso(demoNow({
    search: '?demo=1',
    envClock: '2026-01-01',
    demoMode: true,
  })), '2026-01-01');
});

test('demo mode falls back to the pinned demo date', () => {
  assert.equal(DEMO_CLOCK_DEFAULT, '2026-09-10');
  assert.equal(iso(demoNow({ search: '?demo=1', envClock: '', demoMode: true })), DEMO_CLOCK_DEFAULT);
  // ?demo=1 is enough on its own, without the env flag.
  assert.equal(iso(demoNow({ search: '?demo=1', envClock: '' })), DEMO_CLOCK_DEFAULT);
});

test('outside demo mode the real clock runs', () => {
  const realNow = Date.UTC(2031, 4, 17, 13, 30);
  const now = demoNow({ search: '', envClock: '', demoMode: false, realNow });
  assert.equal(now.getTime(), realNow);
});

test('?demo=0 turns the pin off even when the env flag is on', () => {
  const realNow = Date.UTC(2031, 4, 17);
  assert.equal(demoNow({ search: '?demo=0', envClock: '', realNow }).getTime(), realNow);
  assert.equal(demoNow({ search: '?demo=false', envClock: '', realNow }).getTime(), realNow);
});

test('a malformed clock is ignored rather than trusted', () => {
  const realNow = Date.UTC(2031, 4, 17);
  assert.equal(iso(demoNow({ search: '?clock=nope', envClock: '', demoMode: true })), DEMO_CLOCK_DEFAULT);
  assert.equal(iso(demoNow({ search: '?clock=03/02/2027', envClock: '', demoMode: true })), DEMO_CLOCK_DEFAULT);
  assert.equal(demoNow({ search: '?clock=nope', envClock: 'nope', demoMode: false, realNow }).getTime(), realNow);
});

test('the clock is UTC midnight, so day arithmetic never drifts by zone', () => {
  const now = demoNow({ search: '?clock=2026-09-10', envClock: '' });
  assert.equal(now.toISOString(), '2026-09-10T00:00:00.000Z');
  assert.equal(parseClockDate('2026-09-10').toISOString(), '2026-09-10T00:00:00.000Z');
  assert.equal(parseClockDate(''), null);
  assert.equal(parseClockDate(null), null);
});
