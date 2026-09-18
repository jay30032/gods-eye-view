/**
 * X-ray: the photo world goes translucent for a moment so the subject reads.
 *
 * ## What it is for
 *
 * Google's photogrammetry is a photograph, and a photograph of an old, canopied
 * block is mostly trees. When the camera lands on a house the eye has to find
 * it in that picture. X-ray takes the picture down to a 35% white ghost for two
 * and a half seconds and then eases it back — long enough to see where the gold
 * tint, the lot line and the outline sit on the ground, short enough that the
 * world is a photograph again before the user has to ask for it.
 *
 * It replaced Clear View, which swapped the whole world for terrain, aerial
 * imagery and untextured OSM boxes. Reviewed headed that looked flat and cheap:
 * grey boxes on a photo. A moment of translucency keeps the photo.
 *
 * ## How the tileset is made translucent
 *
 * Through `tileset.style`, exactly as asked, and nothing else: the tileset is
 * given a `Cesium3DTileStyle` whose colour is a custom evaluator returning
 * white at the current alpha, and the tileset is told the style is dirty
 * whenever that alpha changes. Google's tiles carry no feature table, so Cesium
 * applies the style as `model.color` on every loaded tile — white with alpha
 * below one moves the model into the translucent pass. Crossing alpha 1.0 in
 * either direction resets every tile's draw commands (`Model.applyColorAndShow`
 * checks `Math.floor(alpha)`), so there are exactly two rebuild frames per
 * effect: the first translucent frame and the first opaque one. Inside the
 * effect an alpha change is a uniform write.
 *
 * ## The envelope is pure
 *
 * `xrayEnvelope` is a function of elapsed milliseconds and nothing else, so the
 * shape — a short attack to the floor, the hold, the 600 ms release — is tested
 * without a scene. `xrayReleaseAlpha` is the same for an early end: "solid"
 * eases from wherever the alpha is rather than snapping, over the same 600 ms.
 *
 * The scene half (`createXray`) owns four things: the style object, the
 * per-frame alpha write, the render hold that keeps the governor drawing while
 * nothing else moves, and the arm-on-arrival latch that lets a flight land
 * before the world goes translucent under it.
 */

/** The translucent floor. White at this alpha over whatever is behind. */
export const XRAY_ALPHA = 0.35;
/** From trigger to the start of the release. The world is at the floor for most of it. */
export const XRAY_HOLD_MS = 2500;
/** The ease back to opaque. */
export const XRAY_RELEASE_MS = 600;
/**
 * The drop to the floor. Short, and not zero: a hard cut from a photograph to
 * a ghost reads as the tiles failing. Inside the hold, so a 2.5 s hold is 2.5 s
 * from the word to the release.
 */
export const XRAY_ATTACK_MS = 200;

/** Governor hold id while the effect is running. */
export const XRAY_RENDER_OWNER = 'investor-xray';

/** Smoothstep: eases both ends, no overshoot. */
function smooth(t) {
  const x = Math.min(1, Math.max(0, t));
  return x * x * (3 - 2 * x);
}

/** A number, or null for anything that is not one. Absence is never zero. */
function finiteOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * The tileset alpha at `elapsedMs` since the trigger.
 *
 * Phases: `in` (attack, 1 → floor), `hold` (at the floor), `out` (release,
 * floor → 1), `done` (1, and the effect can be torn down). An absent or
 * non-finite elapsed time is `idle` at alpha 1: a missing start stamp must not
 * read as "the effect just started", which is the `Number(null) === 0` trap.
 *
 * @param {number} elapsedMs
 * @returns {{alpha:number, phase:'idle'|'in'|'hold'|'out'|'done', done:boolean}}
 */
export function xrayEnvelope(elapsedMs, {
  alpha = XRAY_ALPHA,
  attackMs = XRAY_ATTACK_MS,
  holdMs = XRAY_HOLD_MS,
  releaseMs = XRAY_RELEASE_MS,
} = {}) {
  const t = finiteOrNull(elapsedMs);
  if (t === null) return { alpha: 1, phase: 'idle', done: true };
  const floor = Math.min(1, Math.max(0, finiteOrNull(alpha) ?? XRAY_ALPHA));
  const attack = Math.max(0, finiteOrNull(attackMs) ?? XRAY_ATTACK_MS);
  const hold = Math.max(attack, finiteOrNull(holdMs) ?? XRAY_HOLD_MS);
  const release = Math.max(1, finiteOrNull(releaseMs) ?? XRAY_RELEASE_MS);

  if (t < 0) return { alpha: 1, phase: 'idle', done: true };
  if (t < attack) {
    return { alpha: 1 - (1 - floor) * smooth(t / attack), phase: 'in', done: false };
  }
  if (t < hold) return { alpha: floor, phase: 'hold', done: false };
  const out = (t - hold) / release;
  if (out < 1) return { alpha: floor + (1 - floor) * smooth(out), phase: 'out', done: false };
  return { alpha: 1, phase: 'done', done: true };
}

/**
 * The alpha `elapsedMs` into an early release that began at `fromAlpha`.
 *
 * "Solid" mid-hold eases up from the floor; "solid" mid-attack eases up from
 * wherever the attack had got to. Either way the release takes `releaseMs`,
 * so ending early never produces a faster snap than the natural end does.
 */
export function xrayReleaseAlpha(elapsedMs, fromAlpha, { releaseMs = XRAY_RELEASE_MS } = {}) {
  const t = finiteOrNull(elapsedMs);
  const from = finiteOrNull(fromAlpha);
  if (t === null || from === null) return { alpha: 1, done: true };
  const start = Math.min(1, Math.max(0, from));
  const release = Math.max(1, finiteOrNull(releaseMs) ?? XRAY_RELEASE_MS);
  if (t < 0) return { alpha: start, done: false };
  const k = t / release;
  if (k >= 1) return { alpha: 1, done: true };
  return { alpha: start + (1 - start) * smooth(k), done: false };
}

/**
 * The style Cesium is handed, built once per effect.
 *
 * A custom colour evaluator rather than an expression string: an expression is
 * compiled when the style is constructed, so animating alpha through it would
 * mean a new style — and a full re-style of every loaded tile — per frame. The
 * evaluator reads `getAlpha()` each time it is asked, and the tileset is only
 * asked when `makeStyleDirty()` says the answer changed.
 */
export function createXrayStyle(Cesium, getAlpha) {
  const style = new Cesium.Cesium3DTileStyle();
  const white = Cesium.Color.WHITE;
  style.color = {
    evaluateColor(feature, result) {
      return Cesium.Color.fromAlpha(white, getAlpha(), result);
    },
  };
  return style;
}

/**
 * @param {{Cesium:object, scene:object, getTileset:Function,
 *   holdRender?:Function, releaseRender?:Function, requestRender?:Function,
 *   now?:Function, reduced?:Function}} deps
 *   `getTileset` is read at trigger time rather than captured: the photo
 *   tileset can be absent (keyless boot) or hidden (an experiment world), and
 *   both mean there is nothing to see through.
 */
export function createXray({
  Cesium,
  scene,
  getTileset = () => null,
  holdRender = () => {},
  releaseRender = () => {},
  requestRender = () => {},
  now = () => (globalThis.performance?.now?.() ?? Date.now()),
  reduced = () => false,
  /** Called with `{restarted}` each time the effect actually starts. */
  onFire = null,
} = {}) {
  let tileset = null;
  let style = null;
  let startedAt = null;
  /** Set by `end()`: the release runs from here rather than from the envelope. */
  let releaseStartedAt = null;
  let releaseFrom = 1;
  let appliedAlpha = 1;
  let armed = false;
  let destroyed = false;
  let runs = 0;
  /** What the last effect did, for the headed check to read back. */
  const last = { minAlpha: 1, frames: 0, startedAt: null, endedAt: null, earlyEnd: false };

  const running = () => startedAt !== null;

  function usable(candidate) {
    if (!candidate || candidate.isDestroyed?.()) return false;
    if (candidate.show === false) return false;
    return true;
  }

  function apply(alpha) {
    if (!tileset || alpha === appliedAlpha) return;
    appliedAlpha = alpha;
    last.minAlpha = Math.min(last.minAlpha, alpha);
    try {
      if (tileset.style !== style) tileset.style = style;
      tileset.makeStyleDirty?.();
    } catch (error) {
      console.warn('[TerraSignal] x-ray style:', error?.message || error);
    }
    requestRender();
  }

  function finish() {
    if (!running()) return;
    if (tileset) {
      try { if (tileset.style === style) tileset.style = undefined; } catch { /* torn down */ }
    }
    appliedAlpha = 1;
    startedAt = null;
    releaseStartedAt = null;
    releaseFrom = 1;
    style = null;
    tileset = null;
    last.endedAt = now();
    releaseRender(XRAY_RENDER_OWNER);
    requestRender();
  }

  function current() {
    if (!running()) return { alpha: 1, phase: 'idle', done: true };
    const t = now();
    if (releaseStartedAt !== null) {
      const state = xrayReleaseAlpha(t - releaseStartedAt, releaseFrom);
      return { alpha: state.alpha, phase: state.done ? 'done' : 'out', done: state.done };
    }
    return xrayEnvelope(t - startedAt);
  }

  function tick() {
    if (destroyed || !running()) return;
    last.frames += 1;
    const state = current();
    if (state.done) {
      apply(1);
      finish();
      return;
    }
    apply(state.alpha);
  }

  /**
   * Start, or restart, the effect now.
   *
   * A second "x-ray" while one is running restarts the clock rather than
   * queueing: the user asked to see through the world, and the answer is to be
   * seeing through it, not to be told to wait.
   */
  function trigger() {
    if (destroyed) return { ok: false, reason: 'destroyed' };
    const candidate = getTileset();
    if (!usable(candidate)) {
      armed = false;
      return { ok: false, reason: candidate ? 'tileset hidden' : 'no tileset' };
    }
    armed = false;
    if (running() && candidate === tileset) {
      // Same world, restart the clock. The style already on it stays.
      startedAt = now();
      releaseStartedAt = null;
      releaseFrom = 1;
      last.earlyEnd = false;
      runs += 1;
      try { onFire?.({ restarted: true }); } catch { /* listener */ }
      return { ok: true, restarted: true };
    }
    if (running()) finish();
    tileset = candidate;
    style = createXrayStyle(Cesium, () => appliedAlpha);
    startedAt = now();
    releaseStartedAt = null;
    releaseFrom = 1;
    appliedAlpha = 1;
    Object.assign(last, { minAlpha: 1, frames: 0, startedAt, endedAt: null, earlyEnd: false });
    runs += 1;
    holdRender(XRAY_RENDER_OWNER);
    requestRender();
    try { onFire?.({ restarted: false }); } catch { /* listener */ }
    return { ok: true, restarted: false };
  }

  /** "Solid": ease back to opaque from wherever the alpha is, now. */
  function end({ keepArmed = false } = {}) {
    if (!keepArmed) armed = false;
    if (!running()) return { ok: true, wasRunning: false };
    if (releaseStartedAt !== null) return { ok: true, wasRunning: true, alreadyReleasing: true };
    releaseStartedAt = now();
    releaseFrom = appliedAlpha;
    last.earlyEnd = true;
    return { ok: true, wasRunning: true };
  }

  /**
   * Fire on the next flight settle, or now if nothing is flying.
   *
   * The automatic triggers — focus, the lot — all arrive with a flight in the
   * air, and a world that goes translucent while tiles are still streaming in
   * under a moving camera is a mess rather than a moment. Reduced motion skips
   * the automatic version entirely; the spoken "x-ray" still works.
   */
  function arm({ flying = false } = {}) {
    if (destroyed) return false;
    if (reduced()) return false;
    if (!flying) {
      trigger();
      return false;
    }
    armed = true;
    return true;
  }

  /**
   * The camera director's flight listener.
   *
   * A flight taking off ends a running x-ray early — the world going
   * translucent is a moment at a house, not a way to travel — and leaves the
   * latch alone, so an x-ray armed for that flight still fires when it lands.
   */
  function onFlight({ flying } = {}) {
    if (flying) {
      if (running() && releaseStartedAt === null) end({ keepArmed: true });
      return;
    }
    if (!armed) return;
    armed = false;
    trigger();
  }

  const removeTick = scene?.preRender?.addEventListener?.(() => tick()) || null;

  return {
    get running() { return running(); },
    get armed() { return armed; },
    get alpha() { return appliedAlpha; },
    get phase() { return current().phase; },
    get runs() { return runs; },
    /** Read-back for the headed check: what the tileset's style says right now. */
    get styleAlpha() {
      const t = tileset || getTileset();
      const s = t?.style;
      if (!s?.color?.evaluateColor) return 1;
      try { return s.color.evaluateColor(undefined, new Cesium.Color()).alpha; } catch { return null; }
    },
    get last() { return { ...last }; },
    trigger,
    end,
    arm,
    onFlight,
    tick,
    destroy() {
      destroyed = true;
      try { removeTick?.(); } catch { /* already gone */ }
      if (running()) finish();
    },
  };
}
