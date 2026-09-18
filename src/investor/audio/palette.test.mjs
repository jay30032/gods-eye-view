/**
 * The palette stays quiet, short and complete; the engine stays silent until
 * a gesture and obeys the one-word switch.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MASTER_VOLUME,
  MAX_VOICE_GAIN,
  PALETTE,
  SOUNDS,
  WHOOSH_MAX_GAIN,
  lastSoundAt,
  peakGainOf,
} from './palette.js';
import { SOUND_STORAGE_KEY, createAudioEngine, readSoundPref } from './engine.js';

test('every sound in the brief exists, has a voice, and lasts under three seconds', () => {
  for (const name of SOUNDS) {
    const program = PALETTE[name];
    assert.ok(program, `${name} missing`);
    assert.ok(program.voices.length >= 1, `${name} has no voice`);
    assert.ok(program.durationS > 0.02 && program.durationS <= 3, `${name} lasts ${program.durationS}s`);
    assert.ok(lastSoundAt(program) <= program.durationS + 1e-9, `${name} envelope outlives its duration`);
  }
  assert.deepEqual(Object.keys(PALETTE).sort(), [...SOUNDS].sort());
});

test('nothing is loud: every voice under the ceiling, the whoosh nearly silent, master at 0.25', () => {
  assert.equal(MASTER_VOLUME, 0.25);
  for (const name of SOUNDS) {
    assert.ok(peakGainOf(PALETTE[name]) <= MAX_VOICE_GAIN, `${name} peaks at ${peakGainOf(PALETTE[name])}`);
  }
  assert.ok(peakGainOf(PALETTE.flightWhoosh) <= WHOOSH_MAX_GAIN, 'the whoosh must be very quiet');
  assert.ok(peakGainOf(PALETTE.houseTick) < peakGainOf(PALETTE.goldChime), 'a tick is softer than the chime');
});

test('every envelope starts and ends at silence, in time order, with sane frequencies', () => {
  for (const name of SOUNDS) {
    for (const row of PALETTE[name].voices) {
      assert.equal(row.gain[0][1], 0, `${name} starts loud`);
      assert.equal(row.gain.at(-1)[1], 0, `${name} ends loud`);
      for (let i = 1; i < row.gain.length; i += 1) {
        assert.ok(row.gain[i][0] > row.gain[i - 1][0], `${name} gain points out of order`);
      }
      if (row.type !== 'noise') {
        for (const [, hz] of row.freq) assert.ok(hz >= 40 && hz <= 8000, `${name} at ${hz} Hz`);
      } else {
        assert.ok(row.filter, `${name}: noise without a filter is a hiss`);
      }
    }
  }
});

/** A fake AudioContext that records what the engine schedules. */
function fakeAudio() {
  const log = [];
  const param = (name) => ({
    value: 0,
    setValueAtTime(v, t) { log.push([name, 'set', v, t]); },
    linearRampToValueAtTime(v, t) { log.push([name, 'ramp', v, t]); },
  });
  const node = (kind) => ({
    kind,
    gain: param(`${kind}.gain`),
    frequency: param(`${kind}.frequency`),
    detune: param(`${kind}.detune`),
    Q: { value: 1 },
    connect() {},
    disconnect() {},
    start(t) { log.push([kind, 'start', t]); },
    stop(t) { log.push([kind, 'stop', t]); },
  });
  class Ctx {
    constructor() {
      this.state = 'suspended';
      this.currentTime = 10;
      this.sampleRate = 8000;
      this.destination = {};
      this.resumed = 0;
    }
    resume() { this.resumed += 1; this.state = 'running'; }
    createGain() { return node('gain'); }
    createOscillator() { return node('osc'); }
    createBiquadFilter() { return node('filter'); }
    createBufferSource() { return node('noise'); }
    createBuffer(_c, length) { return { getChannelData: () => new Float32Array(length) }; }
    close() {}
  }
  return { Ctx, log };
}

function fakeStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return { getItem: (k) => (map.has(k) ? map.get(k) : null), setItem: (k, v) => map.set(k, v), map };
}

test('the engine is silent until the first gesture, then plays through a 0.25 master', () => {
  const { Ctx, log } = fakeAudio();
  const storage = fakeStorage();
  const listeners = {};
  const target = {
    addEventListener(type, fn) { listeners[type] = fn; },
    removeEventListener(type) { delete listeners[type]; },
  };
  const engine = createAudioEngine({ AudioContextCtor: Ctx, storage, target });
  engine.bind();
  assert.equal(engine.unlocked, false);
  assert.equal(engine.play('goldChime'), false, 'nothing plays before a gesture');
  assert.equal(log.length, 0);
  assert.ok(listeners.pointerdown && listeners.keydown && listeners.touchend);

  listeners.pointerdown();
  assert.equal(engine.unlocked, true);
  assert.equal(engine.context.resumed, 1, 'the suspended context was resumed inside the gesture');
  assert.deepEqual(Object.keys(listeners), [], 'the gesture listeners are gone after the unlock');
  assert.equal(engine.volume, MASTER_VOLUME);

  assert.equal(engine.play('goldChime'), true);
  assert.equal(engine.plays, 1);
  const starts = log.filter((row) => row[1] === 'start');
  assert.equal(starts.length, PALETTE.goldChime.voices.length, 'one source per voice');
  assert.ok(starts.every((row) => row[2] === 10), 'scheduled at the context clock');
  assert.equal(engine.play('nope'), false, 'an unknown name is a no-op');
  assert.equal(engine.played.at(-1).name, 'goldChime');
});

test('"sound off" mutes and is remembered; "sound on" restores it', () => {
  const { Ctx } = fakeAudio();
  const storage = fakeStorage();
  const engine = createAudioEngine({ AudioContextCtor: Ctx, storage, target: null });
  engine.unlock();
  assert.equal(engine.enabled, true);
  assert.equal(engine.setEnabled(false), false);
  assert.equal(storage.map.get(SOUND_STORAGE_KEY), '0');
  assert.equal(engine.play('houseTick'), false);
  assert.equal(readSoundPref(storage), false, 'a fresh engine on this browser would start muted');
  const again = createAudioEngine({ AudioContextCtor: Ctx, storage, target: null });
  assert.equal(again.enabled, false);
  again.setEnabled(true);
  again.unlock();
  assert.equal(again.play('houseTick'), true);
  assert.equal(readSoundPref(storage), true);
});

test('no Web Audio at all is a quiet no-op, never a throw', () => {
  const engine = createAudioEngine({ AudioContextCtor: null, storage: fakeStorage(), target: null });
  assert.equal(engine.supported, false);
  assert.equal(engine.unlock(), false);
  assert.equal(engine.play('goldChime'), false);
});
