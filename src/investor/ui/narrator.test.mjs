import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createNarrator,
  readingSchedule,
  sentenceIndexAtChar,
  splitSentences,
  wordCount,
} from './narrator.js';
import { TIMING } from '../sequences.js';

function fakeTimers() {
  let t = 0;
  let seq = 0;
  const queue = [];
  return {
    timers: {
      setTimeout(fn, ms) { const id = ++seq; queue.push({ id, at: t + ms, fn }); return id; },
      clearTimeout(id) { const i = queue.findIndex((r) => r.id === id); if (i >= 0) queue.splice(i, 1); },
    },
    now: () => t,
    async advance(ms) {
      const target = t + ms;
      for (;;) {
        queue.sort((a, b) => a.at - b.at || a.id - b.id);
        const next = queue[0];
        if (!next || next.at > target) break;
        queue.shift();
        t = next.at;
        next.fn();
        await Promise.resolve();
      }
      t = target;
      await Promise.resolve();
    },
    get pending() { return queue.length; },
  };
}

const BRIEF = 'Notice of sale — The Champion, filed Aug 12 (29 days ago), 92% confidence. '
  + 'Auction Tuesday Oct 7 at the DeKalb County Courthouse — in 26 days. '
  + 'Owner equity 41%; entry at $185,000 is 38% under the $298,000 estimate. '
  + 'Best path: FLIP — $61k profit.';

test('sentences split on terminal punctuation and keep it; decimals and abbreviations survive', () => {
  const parts = splitSentences(BRIEF);
  assert.equal(parts.length, 4);
  assert.equal(parts[0].at(-1), '.');
  assert.equal(parts[3], 'Best path: FLIP — $61k profit.');
  assert.deepEqual(splitSentences(''), []);
  assert.deepEqual(splitSentences('No punctuation at all'), ['No punctuation at all']);
  assert.deepEqual(splitSentences('Really? Yes! Fine.'), ['Really?', 'Yes!', 'Fine.']);
});

test('the reading schedule runs at 240 wpm with a floor per sentence', () => {
  assert.equal(TIMING.READING_WPM, 240);
  const parts = splitSentences(BRIEF);
  const schedule = readingSchedule(parts);
  assert.equal(schedule.length, 4);
  assert.equal(schedule[0].startMs, 0);
  for (let i = 1; i < schedule.length; i += 1) {
    assert.equal(schedule[i].startMs, schedule[i - 1].endMs, 'sentences abut');
  }
  const perWord = 60_000 / 240;
  assert.equal(schedule[0].endMs, Math.round(wordCount(parts[0]) * perWord));
  const tiny = readingSchedule(['Go.']);
  assert.equal(tiny[0].endMs, TIMING.MIN_SENTENCE_MS, 'a one-word sentence still gets the floor');
});

test('a character offset into the joined text maps to its sentence', () => {
  const parts = ['One two.', 'Three.', 'Four five six.'];
  assert.equal(sentenceIndexAtChar(parts, 0), 0);
  assert.equal(sentenceIndexAtChar(parts, 7), 0);
  assert.equal(sentenceIndexAtChar(parts, 9), 1);
  assert.equal(sentenceIndexAtChar(parts, 16), 2);
  assert.equal(sentenceIndexAtChar(parts, 999), 2);
});

test('reading mode: the strip gets the whole line at once and sentences fire at reading pace', async () => {
  const clock = fakeTimers();
  const strip = { textContent: '' };
  const states = [];
  const narrator = createNarrator({
    strip: () => strip, timers: clock.timers, now: clock.now, synth: null, Utterance: null,
    storage: null, onState: (s) => states.push(s),
  });
  const seen = [];
  const speech = narrator.say(BRIEF, { onSentence: (i) => seen.push([i, clock.now()]) });
  assert.equal(strip.textContent, BRIEF);
  assert.equal(narrator.speaking, true);
  assert.deepEqual(states, ['speaking']);
  const schedule = readingSchedule(speech.sentences);
  await clock.advance(0);
  assert.deepEqual(seen, [[0, 0]]);
  await clock.advance(schedule[1].startMs);
  assert.deepEqual(seen.at(-1), [1, schedule[1].startMs]);
  await clock.advance(schedule.at(-1).endMs);
  assert.equal(seen.length, 4);
  const result = await speech.done;
  assert.equal(result.cancelled, false);
  assert.equal(narrator.speaking, false);
  assert.equal(states.at(-1), 'idle');
});

test('a new line cancels the one being said, and cancel fires nothing further', async () => {
  const clock = fakeTimers();
  const narrator = createNarrator({
    strip: () => ({ textContent: '' }), timers: clock.timers, now: clock.now, synth: null, Utterance: null, storage: null,
  });
  const first = [];
  const speech = narrator.say('One two three. Four five six. Seven eight.', { onSentence: (i) => first.push(i) });
  await clock.advance(100);
  const second = [];
  narrator.say('Other.', { onSentence: (i) => second.push(i) });
  assert.equal((await speech.done).cancelled, true);
  await clock.advance(10_000);
  assert.deepEqual(first, [0], 'the first line stopped after its first sentence');
  assert.deepEqual(second, [0]);
  assert.equal(clock.pending, 0);
});

test('synth mode: sentence reveals follow the speech engine\'s word boundaries, and end reveals all', async () => {
  const clock = fakeTimers();
  const spoken = [];
  let live = null;
  const synth = { speak(u) { live = u; spoken.push(u.text); }, cancel() {} };
  class Utterance { constructor(text) { this.text = text; } }
  const storage = { getItem: () => '1', setItem() {} };
  const narrator = createNarrator({
    strip: () => ({ textContent: '' }), timers: clock.timers, now: clock.now, synth, Utterance, storage,
  });
  assert.equal(narrator.voice, true);
  const seen = [];
  const speech = narrator.say('One two. Three four. Five.', { onSentence: (i) => seen.push(i) });
  assert.equal(spoken.length, 1);
  live.onstart();
  assert.deepEqual(seen, [0]);
  live.onboundary({ charIndex: 9 });
  assert.deepEqual(seen, [0, 1]);
  live.onend();
  assert.deepEqual(seen, [0, 1, 2], 'the end reveals whatever was left');
  assert.equal((await speech.done).cancelled, false);
  assert.equal(clock.pending, 0, 'the fallback guard was cleared');
});

test('synth mode falls back to the reading pace when the engine never starts', async () => {
  const clock = fakeTimers();
  const synth = { speak() {}, cancel() {} };
  class Utterance { constructor(text) { this.text = text; } }
  const narrator = createNarrator({
    strip: () => ({ textContent: '' }), timers: clock.timers, now: clock.now, synth, Utterance,
    storage: { getItem: () => '1', setItem() {} },
  });
  const seen = [];
  const speech = narrator.say('One two. Three four.', { onSentence: (i) => seen.push([i, clock.now()]) });
  await clock.advance(999);
  assert.deepEqual(seen, []);
  await clock.advance(1);
  assert.deepEqual(seen, [[0, 1000]], 'after a silent second, reading mode took over');
  await clock.advance(5000);
  assert.equal(seen.length, 2);
  assert.equal((await speech.done).cancelled, false);
});
