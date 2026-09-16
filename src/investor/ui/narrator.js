/**
 * The assistant's voice: what it says, and *when* each sentence is said.
 *
 * Two modes, one contract. In **reading** mode (typed commands, the default)
 * nothing is voiced; the line goes on the status strip at once and a schedule
 * at reading pace says when each sentence "is being read", which is what the
 * card assembles to. In **synth** mode ("voice on") the same line is spoken
 * through the Web Speech API and the sentence boundaries come from the
 * speech engine's own word events, so a card line appears as its words are
 * actually heard.
 *
 * The schedule maths is pure and tested; the DOM and the speech engine are
 * injected.
 */
import { TIMING } from '../sequences.js';

export const VOICE_STORAGE_KEY = 'terrasignal:voice:v1';

/** Split a brief into sentences, keeping their terminal punctuation. */
export function splitSentences(text) {
  const clean = String(text || '').replace(/\s+/g, ' ').trim();
  if (!clean) return [];
  const parts = clean.match(/[^.!?]+(?:[.!?]+(?:["')\]]+)?|$)/g) || [clean];
  return parts.map((s) => s.trim()).filter(Boolean);
}

export function wordCount(text) {
  const words = String(text || '').trim().split(/\s+/).filter(Boolean);
  return words.length;
}

/**
 * When each sentence starts and ends at a reading pace.
 * @returns {Array<{index:number, startMs:number, endMs:number, words:number}>}
 */
export function readingSchedule(sentences, { wpm = TIMING.READING_WPM, minMs = TIMING.MIN_SENTENCE_MS } = {}) {
  const perWord = 60_000 / Math.max(1, Number(wpm) || TIMING.READING_WPM);
  let cursor = 0;
  return (sentences || []).map((sentence, index) => {
    const words = wordCount(sentence);
    const span = Math.max(minMs, Math.round(words * perWord));
    const row = { index, startMs: cursor, endMs: cursor + span, words };
    cursor += span;
    return row;
  });
}

/** Which sentence a character offset into the joined text falls in. */
export function sentenceIndexAtChar(sentences, charIndex) {
  let offset = 0;
  for (let i = 0; i < sentences.length; i += 1) {
    const end = offset + sentences[i].length;
    if (charIndex < end) return i;
    offset = end + 1; // the joining space
  }
  return Math.max(0, sentences.length - 1);
}

export function readVoicePref(storage = globalThis.localStorage) {
  try {
    const raw = storage?.getItem?.(VOICE_STORAGE_KEY);
    if (raw === '1') return true;
    if (raw === '0') return false;
  } catch { /* ignore */ }
  return false;
}

export function writeVoicePref(enabled, storage = globalThis.localStorage) {
  try { storage?.setItem?.(VOICE_STORAGE_KEY, enabled ? '1' : '0'); } catch { /* ignore */ }
}

/**
 * @param {{strip?:Function, onState?:Function, timers?:object, now?:Function,
 *   synth?:object, Utterance?:Function, storage?:object, wpm?:number}} deps
 */
export function createNarrator({
  strip = () => globalThis.document?.getElementById?.('ts-ai-prompt') || null,
  onState = null,
  timers = globalThis,
  now = () => (globalThis.performance?.now?.() ?? Date.now()),
  synth = globalThis.speechSynthesis || null,
  Utterance = globalThis.SpeechSynthesisUtterance || null,
  storage = globalThis.localStorage,
  wpm = TIMING.READING_WPM,
} = {}) {
  let voice = readVoicePref(storage);
  let current = null;
  let seq = 0;

  function state(next) {
    try { onState?.(next); } catch { /* listener */ }
  }

  function write(text) {
    const el = strip();
    if (el && el.textContent !== text) el.textContent = text;
  }

  function stopCurrent() {
    if (!current) return;
    const running = current;
    current = null;
    for (const timer of running.timers) timers.clearTimeout(timer);
    running.timers.clear();
    if (running.utterance) {
      running.utterance.onboundary = null;
      running.utterance.onend = null;
      running.utterance.onerror = null;
      try { synth?.cancel?.(); } catch { /* fine */ }
    }
    if (!running.finished) {
      running.finished = true;
      running.resolve({ cancelled: true });
    }
    state('idle');
  }

  /**
   * Say a line.
   *
   * @param {string} text
   * @param {{onSentence?:Function, sentences?:string[], silent?:boolean,
   *   perSentence?:boolean}} [options]
   *   `onSentence(index)` fires as each sentence starts. `silent` writes the
   *   strip and runs the schedule without voicing, whatever the mode.
   *   `perSentence` puts one sentence at a time on the strip — a four-sentence
   *   brief read on a one-line strip — rather than the whole line at once.
   * @returns {{done:Promise<{cancelled:boolean}>, cancel:Function, sentences:string[]}}
   */
  function say(text, {
    onSentence = null, sentences = null, silent = false, perSentence = false,
  } = {}) {
    stopCurrent();
    const line = String(text || '').trim();
    const parts = Array.isArray(sentences) && sentences.length ? sentences : splitSentences(line);
    write(perSentence && parts.length ? parts[0] : line);
    const token = ++seq;
    let resolve;
    const done = new Promise((r) => { resolve = r; });
    const run = { token, timers: new Set(), utterance: null, finished: false, resolve };
    current = run;
    if (!parts.length) {
      run.finished = true;
      current = null;
      resolve({ cancelled: false });
      return { done, cancel() {}, sentences: parts };
    }

    const fired = new Set();
    const sentence = (index) => {
      if (current !== run || fired.has(index)) return;
      fired.add(index);
      if (perSentence) write(parts[index]);
      try { onSentence?.(index, parts[index]); } catch { /* listener */ }
    };
    const finish = () => {
      if (current !== run) return;
      for (let i = 0; i < parts.length; i += 1) sentence(i);
      for (const timer of run.timers) timers.clearTimeout(timer);
      run.timers.clear();
      run.finished = true;
      current = null;
      state('idle');
      resolve({ cancelled: false });
    };

    state('speaking');

    const schedule = readingSchedule(parts, { wpm });
    const runReading = () => {
      for (const row of schedule) {
        const timer = timers.setTimeout(() => { run.timers.delete(timer); sentence(row.index); }, row.startMs);
        run.timers.add(timer);
      }
      const total = schedule.at(-1).endMs;
      const end = timers.setTimeout(() => { run.timers.delete(end); finish(); }, total);
      run.timers.add(end);
    };

    const useSynth = voice && !silent && synth && Utterance;
    if (!useSynth) {
      runReading();
      return { done, cancel: () => { if (current === run) stopCurrent(); }, sentences: parts };
    }

    const joined = parts.join(' ');
    let started = false;
    try {
      const utterance = new Utterance(joined);
      utterance.rate = 1.02;
      utterance.pitch = 1;
      run.utterance = utterance;
      utterance.onstart = () => { started = true; sentence(0); };
      utterance.onboundary = (event) => {
        if (current !== run) return;
        started = true;
        const index = sentenceIndexAtChar(parts, Number(event?.charIndex) || 0);
        for (let i = 0; i <= index; i += 1) sentence(i);
      };
      utterance.onend = () => finish();
      utterance.onerror = () => {
        // The engine refused: fall back to the reading pace rather than stall.
        if (current !== run) return;
        run.utterance = null;
        if (!started) runReading();
        else finish();
      };
      synth.cancel?.();
      synth.speak(utterance);
      // No voices, blocked autoplay, a silent engine: after a second with no
      // start event, read instead.
      const guard = timers.setTimeout(() => {
        run.timers.delete(guard);
        if (current === run && !started) {
          run.utterance = null;
          try { synth.cancel?.(); } catch { /* fine */ }
          runReading();
        }
      }, 1000);
      run.timers.add(guard);
    } catch {
      run.utterance = null;
      runReading();
    }
    return { done, cancel: () => { if (current === run) stopCurrent(); }, sentences: parts };
  }

  return {
    say,
    /** Cancel whatever is being said; the strip keeps its last line. */
    cancel: stopCurrent,
    get speaking() { return current !== null; },
    get voice() { return voice; },
    get synthAvailable() { return Boolean(synth && Utterance); },
    setVoice(next) {
      voice = Boolean(next);
      writeVoicePref(voice, storage);
      if (!voice) { try { synth?.cancel?.(); } catch { /* fine */ } }
      return voice;
    },
    /** Put a line on the strip with no pacing at all. */
    write,
  };
}
