import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DIM_ALPHA,
  PULSE_MAX,
  PULSE_MIN,
  TEMPOS,
  beaconLabelFor,
  colorForSignal,
  envelopeFor,
  markerAlphaFor,
  pulseScaleFor,
  shortAddress,
} from './markers.js';

const SIGNALS = Object.keys(TEMPOS);

test('every tempo stays inside the pulse band across several full cycles', () => {
  for (const type of SIGNALS) {
    const period = TEMPOS[type].periodS;
    let min = Infinity;
    let max = -Infinity;
    // 1 ms steps over three cycles — the same sweep that caught the ellipse race.
    for (let ms = 0; ms <= period * 3000; ms += 1) {
      const scale = pulseScaleFor(type, ms / 1000);
      assert.ok(Number.isFinite(scale), `${type} @${ms}ms is ${scale}`);
      assert.ok(scale >= PULSE_MIN - 1e-9, `${type} @${ms}ms dipped to ${scale}`);
      assert.ok(scale <= PULSE_MAX + 1e-9, `${type} @${ms}ms spiked to ${scale}`);
      min = Math.min(min, scale);
      max = Math.max(max, scale);
    }
    if (TEMPOS[type].kind === 'steady') {
      assert.equal(min, max, 'steady should not move at all');
    } else {
      assert.ok(max - min > 0.15, `${type} barely moves (${(max - min).toFixed(3)})`);
    }
  }
});

test('a pulse is periodic and deterministic', () => {
  for (const type of SIGNALS) {
    const period = TEMPOS[type].periodS;
    for (const t of [0, 0.37, 1.1, 2.05]) {
      assert.equal(pulseScaleFor(type, t), pulseScaleFor(type, t), 'not deterministic');
      assert.ok(Math.abs(pulseScaleFor(type, t) - pulseScaleFor(type, t + period)) < 1e-9,
        `${type} is not periodic at ${t}`);
    }
    // Negative elapsed time (a clock that stepped back) must not break the band.
    const back = pulseScaleFor(type, -1.3);
    assert.ok(back >= PULSE_MIN - 1e-9 && back <= PULSE_MAX + 1e-9);
  }
});

test('each tempo has the shape its name promises', () => {
  // Heartbeat: two beats then rest — it must return to zero inside a cycle.
  const beats = [];
  for (let t = 0; t < 1; t += 0.005) beats.push(envelopeFor('heartbeat', t));
  assert.ok(Math.max(...beats) > 0.95, 'heartbeat should reach full');
  assert.ok(beats.filter((v) => v === 0).length > beats.length / 2, 'heartbeat should rest');

  // Tick: sharp attack, long decay — the peak is early in the cycle.
  let peakAt = 0;
  let peak = -1;
  for (let t = 0; t < 1; t += 0.005) {
    const v = envelopeFor('tick', t);
    if (v > peak) { peak = v; peakAt = t; }
  }
  assert.ok(peakAt < 0.2, `tick peaks at ${peakAt}, should be an attack`);

  // Shimmer cycles faster than breath over the same phase.
  const zeroCrossings = (kind) => {
    let n = 0;
    let previous = envelopeFor(kind, 0);
    for (let t = 0.005; t < 1; t += 0.005) {
      const v = envelopeFor(kind, t);
      if ((previous - 0.5) * (v - 0.5) < 0) n += 1;
      previous = v;
    }
    return n;
  };
  assert.ok(zeroCrossings('shimmer') > zeroCrossings('breath'), 'shimmer should be faster');
  assert.equal(envelopeFor('steady', 0.3), envelopeFor('steady', 0.8));
  assert.equal(envelopeFor('nonsense', 0.4), 0.5, 'unknown falls back to steady');
});

test('reduced motion parks every marker at a steady mid-scale', () => {
  for (const type of SIGNALS) {
    const parked = pulseScaleFor(type, 1.7, { reduced: true });
    assert.equal(parked, (PULSE_MIN + PULSE_MAX) / 2);
    assert.equal(parked, pulseScaleFor(type, 99, { reduced: true }), 'must not move');
  }
});

test('with no shortlist everything reads at full strength', () => {
  for (const state of [{}, { shortlistIds: null }, { shortlistIds: new Set() }]) {
    assert.equal(markerAlphaFor('DEMO-ATL-001', state), 1);
  }
});

test('a shortlist dims what did not make it, and only that', () => {
  const shortlistIds = new Set(['a', 'b', 'c', 'd']);
  for (const id of ['a', 'b', 'c', 'd']) {
    assert.equal(markerAlphaFor(id, { shortlistIds }), 1, `${id} is shortlisted`);
  }
  assert.equal(markerAlphaFor('z', { shortlistIds }), DIM_ALPHA, 'others recede');
  assert.ok(DIM_ALPHA > 0, 'recede, never disappear — the board must still read');

  // Focus and the gold pick survive a shortlist they are not part of.
  assert.equal(markerAlphaFor('z', { shortlistIds, focusedId: 'z' }), 1);
  assert.equal(markerAlphaFor('z', { shortlistIds, topPickId: 'z' }), 1);
});

test('the beacon label carries the address and the deadline', () => {
  const house = { address: '3372 Belvedere Ln, Decatur, GA 30032', auction: { daysUntil: 26 } };
  assert.equal(beaconLabelFor(house), '3372 Belvedere Ln · AUCTION 26d');
  assert.equal(shortAddress(house), '3372 Belvedere Ln');

  // No auction, no deadline clause — a delinquency has no sale date.
  assert.equal(beaconLabelFor({ address: '1187 Oakview Rd, Decatur, GA 30030' }), '1187 Oakview Rd');
  assert.equal(beaconLabelFor({ address: 'x, y', auction: { daysUntil: null } }), 'x');
  // A sale already held is not a countdown.
  assert.equal(beaconLabelFor({ address: 'x, y', auction: { daysUntil: -3 } }), 'x');
  assert.equal(beaconLabelFor({ address: 'x, y', auction: { daysUntil: 0 } }), 'x · AUCTION 0d');
  assert.equal(beaconLabelFor(null), '');
});

test('every signal type has a colour, and unknown falls back rather than crashing', () => {
  for (const type of SIGNALS) {
    const colour = colorForSignal(type);
    assert.equal(colour.length, 4, type);
    for (const channel of colour) assert.ok(channel >= 0 && channel <= 1, type);
  }
  assert.deepEqual(colorForSignal('NOPE'), colorForSignal('DISTRESS'));
});

// ---------------------------------------------------------------------------
// Choreography: staged ignition, the beacon rise, the bookmark drop
// ---------------------------------------------------------------------------
import {
  BEACON_RISE_S,
  BOOKMARK_DROP_PX,
  BOOKMARK_DROP_S,
  BOOKMARK_REST_PX,
  IGNITE_POP,
  IGNITE_POP_S,
  beaconRiseFor,
  bookmarkDropFor,
  ignitePopFor,
} from './markers.js';

test('a shortlist being lit one by one keeps the unlit members dim until their turn', () => {
  const shortlistIds = new Set(['a', 'b', 'c']);
  const litIds = new Set(['a']);
  assert.equal(markerAlphaFor('a', { shortlistIds, litIds }), 1);
  assert.equal(markerAlphaFor('b', { shortlistIds, litIds }), DIM_ALPHA, 'waiting its turn');
  assert.equal(markerAlphaFor('z', { shortlistIds, litIds }), DIM_ALPHA, 'never on the list');
  // The gold pick and the focus are never dimmed, lit or not.
  assert.equal(markerAlphaFor('c', { shortlistIds, litIds, topPickId: 'c' }), 1);
  // Once everything is lit (litIds null) the old rule applies unchanged.
  assert.equal(markerAlphaFor('b', { shortlistIds, litIds: null }), 1);
});

test('an ignition pops and settles inside its window; reduced motion has no pop to give', () => {
  assert.equal(ignitePopFor(0), IGNITE_POP);
  assert.ok(ignitePopFor(IGNITE_POP_S / 2) > 0 && ignitePopFor(IGNITE_POP_S / 2) < IGNITE_POP);
  assert.equal(ignitePopFor(IGNITE_POP_S), 0);
  assert.equal(ignitePopFor(-1), 0);
  assert.equal(ignitePopFor(null), 0);
});

test('the beacon climbs from the roof over 500 ms and stays up', () => {
  assert.equal(BEACON_RISE_S, 0.5);
  assert.equal(beaconRiseFor(0), 0);
  assert.ok(beaconRiseFor(0.1) > 0.4, 'fast off the roof');
  assert.ok(beaconRiseFor(0.4) < 1 && beaconRiseFor(0.4) > 0.95);
  assert.equal(beaconRiseFor(0.5), 1);
  assert.equal(beaconRiseFor(9), 1);
  assert.equal(beaconRiseFor(0, { reduced: true }), 1, 'reduced motion: already up');
  for (let t = 0; t <= 0.5; t += 0.01) {
    assert.ok(beaconRiseFor(t + 0.01) >= beaconRiseFor(t) - 1e-9, 'monotonic');
  }
});

test('the bookmark falls onto the house, overshoots a touch, and rests where it always sat', () => {
  assert.equal(BOOKMARK_DROP_S, 0.45);
  assert.ok(Math.abs(bookmarkDropFor(0) - (BOOKMARK_REST_PX - BOOKMARK_DROP_PX)) < 1e-9, 'starts high above the roof');
  assert.equal(bookmarkDropFor(BOOKMARK_DROP_S), BOOKMARK_REST_PX);
  assert.equal(bookmarkDropFor(99), BOOKMARK_REST_PX);
  assert.equal(bookmarkDropFor(0, { reduced: true }), BOOKMARK_REST_PX);
  let lowest = -Infinity;
  for (let t = 0; t <= BOOKMARK_DROP_S; t += 0.005) lowest = Math.max(lowest, bookmarkDropFor(t));
  assert.ok(lowest > BOOKMARK_REST_PX && lowest < BOOKMARK_REST_PX + 12, `bounce of ${lowest - BOOKMARK_REST_PX}px`);
});

// ---------------------------------------------------------------------------
// The halo carries the per-signal envelope and the travelling arc
// ---------------------------------------------------------------------------
import { HALO_ALPHA_FLOOR, arcRotationFor, haloAlphaFor } from './markers.js';
import { MOTION } from './effects/signalMotion.js';

test('the halo beats on the near-field envelope, never below its floor, and only LISTED spins', () => {
  for (const type of Object.keys(MOTION)) {
    const { periodS, kind } = MOTION[type];
    let min = Infinity;
    let max = -Infinity;
    for (let ms = 0; ms <= periodS * 2000; ms += 2) {
      const alpha = haloAlphaFor(type, ms / 1000);
      assert.ok(alpha >= HALO_ALPHA_FLOOR - 1e-9 && alpha <= 1 + 1e-9, `${type} halo alpha ${alpha}`);
      min = Math.min(min, alpha);
      max = Math.max(max, alpha);
    }
    if (kind === 'steady') assert.equal(min, max);
    else assert.ok(max - min > 0.1, `${type} halo lost its motion`);
    assert.equal(haloAlphaFor(type, 0.3, { reduced: true }), haloAlphaFor(type, 2.1, { reduced: true }), 'reduced motion holds');
    const spins = arcRotationFor(type, 1.3);
    assert.equal(spins !== null, type === 'LISTED_OPPORTUNITY', `${type} arc`);
    assert.equal(arcRotationFor(type, 1.3, { reduced: true }), null, 'reduced motion: no spinning arc');
  }
  const a = arcRotationFor('LISTED_OPPORTUNITY', 0);
  const b = arcRotationFor('LISTED_OPPORTUNITY', 0.5 / MOTION.LISTED_OPPORTUNITY.travelPerSec);
  assert.ok(Math.abs((a - b) - Math.PI) < 1e-9, 'half a loop is half a turn');
});
