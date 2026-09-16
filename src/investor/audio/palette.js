/**
 * The sound palette, as data.
 *
 * Seven small synthesized sounds and no assets. Each is a *program*: one or
 * more voices, each an oscillator (or a noise source) through an optional
 * filter and a gain envelope. The engine (`engine.js`) interprets programs; it
 * never decides what anything sounds like. Keeping the palette pure is what
 * lets the tests prove every voice stays quiet — the loudest thing here peaks
 * at 0.22 before the 0.25 master, and the whoosh at 0.05.
 *
 * Envelope points are `[seconds, value]`, linear between points, and every
 * envelope starts and ends at silence so nothing clicks.
 */

/** Default master volume. Quiet enough to sit under a spoken line. */
export const MASTER_VOLUME = 0.25;
/** No voice may be asked for more than this; the palette test enforces it. */
export const MAX_VOICE_GAIN = 0.3;
/** The whoosh is the one sound that must be nearly subliminal. */
export const WHOOSH_MAX_GAIN = 0.06;

export const SOUNDS = Object.freeze([
  'scanSweep', 'houseTick', 'goldChime', 'flightWhoosh', 'saveConfirm', 'xrayHum', 'errorTone',
]);

function voice({
  type = 'sine', freq, gain, filter = null, detune = 0,
}) {
  return Object.freeze({
    type, freq: Object.freeze(freq), gain: Object.freeze(gain), filter, detune,
  });
}

/** A pure note: attack, short sustain, exponential-ish decay to silence. */
function note(hz, { at = 0, attack = 0.008, hold = 0.03, decay = 0.35, peak = 0.16, type = 'sine' } = {}) {
  return voice({
    type,
    freq: [[at, hz], [at + attack + hold + decay, hz]],
    gain: [
      [at, 0],
      [at + attack, peak],
      [at + attack + hold, peak * 0.8],
      [at + attack + hold + decay * 0.35, peak * 0.25],
      [at + attack + hold + decay, 0],
    ],
  });
}

export const PALETTE = Object.freeze({
  /** A rising sweep across the board — the wave leaving the camera. */
  scanSweep: Object.freeze({
    durationS: 1.0,
    voices: [
      voice({
        type: 'sine',
        freq: [[0, 320], [0.9, 1250]],
        gain: [[0, 0], [0.06, 0.14], [0.55, 0.11], [0.95, 0]],
      }),
      voice({
        type: 'noise',
        filter: { type: 'bandpass', freq: [[0, 500], [0.9, 2400]], q: 6 },
        gain: [[0, 0], [0.1, 0.06], [0.7, 0.04], [0.95, 0]],
      }),
    ],
  }),

  /** One match lighting: a soft, short tick. */
  houseTick: Object.freeze({
    durationS: 0.09,
    voices: [
      note(1480, { attack: 0.003, hold: 0.008, decay: 0.06, peak: 0.12, type: 'triangle' }),
    ],
  }),

  /** The gold pick: three notes up, ringing. */
  goldChime: Object.freeze({
    durationS: 1.1,
    voices: [
      note(659.25, { at: 0, decay: 0.55, peak: 0.16 }),
      note(987.77, { at: 0.09, decay: 0.6, peak: 0.14 }),
      note(1318.5, { at: 0.18, decay: 0.85, peak: 0.13 }),
      // A quiet triangle an octave down gives it a body without a thud.
      note(329.63, { at: 0.18, decay: 0.8, peak: 0.05, type: 'triangle' }),
    ],
  }),

  /** The camera leaving: a breath of filtered noise, nearly inaudible. */
  flightWhoosh: Object.freeze({
    durationS: 1.4,
    voices: [
      voice({
        type: 'noise',
        filter: { type: 'lowpass', freq: [[0, 300], [0.5, 1400], [1.3, 250]], q: 0.8 },
        gain: [[0, 0], [0.45, 0.05], [1.3, 0]],
      }),
    ],
  }),

  /** Saved: two quick notes up, a nod. */
  saveConfirm: Object.freeze({
    durationS: 0.42,
    voices: [
      note(523.25, { at: 0, hold: 0.02, decay: 0.16, peak: 0.13 }),
      note(783.99, { at: 0.11, hold: 0.03, decay: 0.26, peak: 0.13 }),
    ],
  }),

  /** The world going translucent: a low hum with a slow beat, in and out. */
  xrayHum: Object.freeze({
    durationS: 2.9,
    voices: [
      voice({
        type: 'sine',
        freq: [[0, 110], [2.9, 110]],
        gain: [[0, 0], [0.35, 0.08], [2.3, 0.07], [2.9, 0]],
      }),
      voice({
        type: 'sine',
        freq: [[0, 110], [2.9, 110]],
        detune: 7,
        gain: [[0, 0], [0.35, 0.06], [2.3, 0.05], [2.9, 0]],
      }),
      voice({
        type: 'triangle',
        freq: [[0, 220], [2.9, 220]],
        gain: [[0, 0], [0.5, 0.025], [2.3, 0.02], [2.9, 0]],
      }),
    ],
  }),

  /** Not understood: a soft falling minor second. Never harsh. */
  errorTone: Object.freeze({
    durationS: 0.36,
    voices: [
      voice({
        type: 'sine',
        freq: [[0, 440], [0.12, 440], [0.2, 415.3], [0.36, 415.3]],
        gain: [[0, 0], [0.02, 0.1], [0.14, 0.09], [0.34, 0]],
      }),
    ],
  }),
});

/** The loudest value any envelope in a program asks for. */
export function peakGainOf(program) {
  let peak = 0;
  for (const row of program?.voices || []) {
    for (const [, g] of row.gain || []) peak = Math.max(peak, Number(g) || 0);
  }
  return peak;
}

/** The last time any envelope in a program is still non-silent. */
export function lastSoundAt(program) {
  let last = 0;
  for (const row of program?.voices || []) {
    for (const [t] of row.gain || []) last = Math.max(last, Number(t) || 0);
  }
  return last;
}
