/**
 * The Web Audio engine behind the palette.
 *
 * Three rules, all of them about not being annoying:
 *
 *   1. **Muted until the first gesture.** Browsers refuse to start an
 *      AudioContext without user activation and, more to the point, a page
 *      that plays a chime before anyone has touched it is a page people close.
 *      The context is created on the first pointer, key or touch and never
 *      before; `play()` before that is a no-op that says so.
 *   2. **0.25 master, off with one word.** "sound off" / "sound on" toggle it
 *      and the choice is remembered per browser.
 *   3. **No assets, no fetches.** Every sound is synthesized from the palette's
 *      program on the spot; a noise source is a one-second buffer made once.
 *
 * `AudioContextCtor` is injectable so the engine can be tested against a fake
 * that records what was scheduled.
 */
import { MASTER_VOLUME, PALETTE } from './palette.js';

export const SOUND_STORAGE_KEY = 'terrasignal:sound:v1';

/** Read the remembered preference; `true` when nothing was ever chosen. */
export function readSoundPref(storage = globalThis.localStorage) {
  try {
    const raw = storage?.getItem?.(SOUND_STORAGE_KEY);
    if (raw === '0') return false;
    if (raw === '1') return true;
  } catch {
    // private mode, or no storage at all
  }
  return true;
}

export function writeSoundPref(enabled, storage = globalThis.localStorage) {
  try { storage?.setItem?.(SOUND_STORAGE_KEY, enabled ? '1' : '0'); } catch { /* ignore */ }
}

/**
 * @param {{AudioContextCtor?:Function, storage?:object, volume?:number,
 *   palette?:object, target?:EventTarget}} [deps]
 */
export function createAudioEngine({
  AudioContextCtor = globalThis.AudioContext || globalThis.webkitAudioContext || null,
  storage = globalThis.localStorage,
  volume = MASTER_VOLUME,
  palette = PALETTE,
  target = globalThis,
} = {}) {
  let context = null;
  let master = null;
  let noiseBuffer = null;
  let enabled = readSoundPref(storage);
  let unlocked = false;
  let destroyed = false;
  let masterVolume = clamp01(volume);
  let plays = 0;
  const played = [];
  const unbinders = [];

  function ensureContext() {
    if (context || !AudioContextCtor) return context;
    try {
      context = new AudioContextCtor();
      master = context.createGain();
      master.gain.value = enabled ? masterVolume : 0;
      master.connect(context.destination);
    } catch {
      context = null;
      master = null;
    }
    return context;
  }

  /**
   * The first gesture. Creates the context (allowed now) and resumes it —
   * Safari and Chrome both hand back a suspended context when it is made
   * outside a gesture, and `resume()` inside one is what starts the clock.
   */
  function unlock() {
    if (destroyed) return false;
    const ctx = ensureContext();
    if (!ctx) return false;
    unlocked = true;
    try { if (ctx.state === 'suspended') ctx.resume?.(); } catch { /* fine */ }
    for (const off of unbinders.splice(0)) off();
    return true;
  }

  function bind() {
    if (!target?.addEventListener) return;
    const once = () => unlock();
    for (const type of ['pointerdown', 'keydown', 'touchend']) {
      target.addEventListener(type, once, { passive: true, capture: true });
      unbinders.push(() => target.removeEventListener(type, once, { capture: true }));
    }
  }

  function noise(ctx) {
    if (noiseBuffer) return noiseBuffer;
    const length = Math.max(1, Math.round(ctx.sampleRate || 44100));
    noiseBuffer = ctx.createBuffer(1, length, ctx.sampleRate || 44100);
    const data = noiseBuffer.getChannelData(0);
    for (let i = 0; i < data.length; i += 1) data[i] = Math.random() * 2 - 1;
    return noiseBuffer;
  }

  function envelope(param, points, t0) {
    if (!param || !points?.length) return;
    const [firstT, firstV] = points[0];
    param.setValueAtTime(firstV, t0 + firstT);
    for (let i = 1; i < points.length; i += 1) {
      const [t, v] = points[i];
      param.linearRampToValueAtTime(v, t0 + t);
    }
  }

  function scheduleVoice(ctx, row, t0, durationS) {
    let source;
    if (row.type === 'noise') {
      source = ctx.createBufferSource();
      source.buffer = noise(ctx);
      source.loop = true;
    } else {
      source = ctx.createOscillator();
      source.type = row.type || 'sine';
      if (row.detune && source.detune) source.detune.value = row.detune;
      envelope(source.frequency, row.freq, t0);
    }
    let head = source;
    if (row.filter) {
      const filter = ctx.createBiquadFilter();
      filter.type = row.filter.type || 'bandpass';
      if (Number.isFinite(row.filter.q) && filter.Q) filter.Q.value = row.filter.q;
      envelope(filter.frequency, row.filter.freq, t0);
      head.connect(filter);
      head = filter;
    }
    const gain = ctx.createGain();
    gain.gain.value = 0;
    envelope(gain.gain, row.gain, t0);
    head.connect(gain);
    gain.connect(master);
    source.start(t0);
    source.stop(t0 + durationS + 0.05);
    source.onended = () => {
      try { source.disconnect(); gain.disconnect(); } catch { /* gone */ }
    };
  }

  const engine = {
    get enabled() { return enabled; },
    get unlocked() { return unlocked; },
    get volume() { return masterVolume; },
    get plays() { return plays; },
    /** The last few sounds played, for the headed check. */
    get played() { return played.slice(-20); },
    get supported() { return Boolean(AudioContextCtor); },
    get context() { return context; },
    bind,
    unlock,

    setEnabled(next) {
      enabled = Boolean(next);
      writeSoundPref(enabled, storage);
      if (master) master.gain.value = enabled ? masterVolume : 0;
      return enabled;
    },
    setVolume(next) {
      masterVolume = clamp01(next);
      if (master && enabled) master.gain.value = masterVolume;
      return masterVolume;
    },

    /**
     * Play one palette sound now.
     * @returns {boolean} whether anything was scheduled
     */
    play(name) {
      if (destroyed || !enabled || !unlocked) return false;
      const program = palette[name];
      const ctx = context;
      if (!program || !ctx || !master) return false;
      try {
        const t0 = Number(ctx.currentTime) || 0;
        for (const row of program.voices || []) scheduleVoice(ctx, row, t0, program.durationS);
        plays += 1;
        played.push({ name, at: t0 });
        return true;
      } catch (error) {
        console.warn('[TerraSignal] sound:', error?.message || error);
        return false;
      }
    },

    destroy() {
      destroyed = true;
      for (const off of unbinders.splice(0)) off();
      try { context?.close?.(); } catch { /* fine */ }
      context = null;
      master = null;
    },
  };
  return engine;
}

function clamp01(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return MASTER_VOLUME;
  return Math.min(1, Math.max(0, n));
}
