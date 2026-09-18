/**
 * The X-ray envelope and the controller around it.
 *
 * The envelope is pure and is what the headed check's "below 0.5 mid-effect,
 * back to 1.0 after" assertions rest on. The controller is exercised with a
 * fake tileset and a fake clock so the style hand-off, the dirty-marking and
 * the governor hold can be pinned without a scene.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  XRAY_ALPHA,
  XRAY_ATTACK_MS,
  XRAY_HOLD_MS,
  XRAY_RELEASE_MS,
  XRAY_RENDER_OWNER,
  createXray,
  createXrayStyle,
  xrayEnvelope,
  xrayReleaseAlpha,
} from './xray.js';

// ---------------------------------------------------------------------------
// The envelope
// ---------------------------------------------------------------------------

test('the brief, in numbers: 35% for 2.5 s, back over 600 ms', () => {
  assert.equal(XRAY_ALPHA, 0.35);
  assert.equal(XRAY_HOLD_MS, 2500);
  assert.equal(XRAY_RELEASE_MS, 600);
  assert.ok(XRAY_ATTACK_MS < XRAY_HOLD_MS);
});

test('an absent elapsed time is idle at alpha 1, never "just started"', () => {
  // Number(null) is 0, and 0 ms into the effect is the start of the attack.
  // A missing start stamp must not fire an x-ray nobody asked for.
  for (const value of [null, undefined, '', NaN, Infinity, -Infinity, 'soon']) {
    const state = xrayEnvelope(value);
    assert.equal(state.alpha, 1, `alpha for ${String(value)}`);
    assert.equal(state.phase, 'idle');
    assert.equal(state.done, true);
  }
  assert.equal(xrayEnvelope(-1).phase, 'idle');
});

test('the shape: attack, hold at the floor, release, done', () => {
  assert.equal(xrayEnvelope(0).alpha, 1);
  assert.equal(xrayEnvelope(0).phase, 'in');
  const mid = xrayEnvelope(XRAY_ATTACK_MS / 2);
  assert.ok(mid.alpha < 1 && mid.alpha > XRAY_ALPHA, `attacking at ${mid.alpha}`);

  for (const ms of [XRAY_ATTACK_MS, 500, 1000, 1250, 2000, XRAY_HOLD_MS - 1]) {
    const state = xrayEnvelope(ms);
    assert.equal(state.alpha, XRAY_ALPHA, `at the floor at ${ms} ms`);
    assert.equal(state.phase, 'hold');
    assert.equal(state.done, false);
  }

  const out = xrayEnvelope(XRAY_HOLD_MS + XRAY_RELEASE_MS / 2);
  assert.equal(out.phase, 'out');
  assert.ok(out.alpha > XRAY_ALPHA && out.alpha < 1, `releasing at ${out.alpha}`);

  const end = xrayEnvelope(XRAY_HOLD_MS + XRAY_RELEASE_MS);
  assert.equal(end.alpha, 1);
  assert.equal(end.phase, 'done');
  assert.equal(end.done, true);
  assert.equal(xrayEnvelope(60_000).alpha, 1);
});

test('mid-effect is below 0.5 and after is exactly 1.0 — the headed assertions', () => {
  assert.ok(xrayEnvelope(1000).alpha < 0.5);
  assert.ok(xrayEnvelope(2000).alpha < 0.5);
  assert.equal(xrayEnvelope(XRAY_HOLD_MS + XRAY_RELEASE_MS + 1).alpha, 1.0);
});

test('alpha never leaves [floor, 1] and the release is monotonic', () => {
  let previous = XRAY_ALPHA;
  for (let ms = 0; ms <= XRAY_HOLD_MS + XRAY_RELEASE_MS + 100; ms += 5) {
    const { alpha } = xrayEnvelope(ms);
    assert.ok(alpha >= XRAY_ALPHA - 1e-9 && alpha <= 1 + 1e-9, `alpha ${alpha} at ${ms} ms`);
    if (ms > XRAY_HOLD_MS) {
      assert.ok(alpha >= previous - 1e-9, `release went backwards at ${ms} ms`);
      previous = alpha;
    }
  }
});

test('the parameters are overridable and bad ones fall back rather than explode', () => {
  const quick = xrayEnvelope(50, { attackMs: 0, holdMs: 100, releaseMs: 100, alpha: 0.5 });
  assert.equal(quick.alpha, 0.5);
  assert.equal(quick.phase, 'hold');
  // A hold shorter than the attack is clamped to it; a zero release is one ms.
  assert.equal(xrayEnvelope(10, { attackMs: 20, holdMs: 5 }).phase, 'in');
  assert.equal(xrayEnvelope(21, { attackMs: 20, holdMs: 5, releaseMs: 0 }).phase, 'done');
  assert.equal(xrayEnvelope(1000, { alpha: null }).alpha, XRAY_ALPHA);
  assert.equal(xrayEnvelope(1000, { alpha: 'x' }).alpha, XRAY_ALPHA);
});

test('an early release eases from wherever the alpha is, over the same 600 ms', () => {
  assert.equal(xrayReleaseAlpha(0, XRAY_ALPHA).alpha, XRAY_ALPHA);
  const half = xrayReleaseAlpha(XRAY_RELEASE_MS / 2, XRAY_ALPHA);
  assert.ok(half.alpha > XRAY_ALPHA && half.alpha < 1);
  assert.equal(half.done, false);
  assert.deepEqual(xrayReleaseAlpha(XRAY_RELEASE_MS, XRAY_ALPHA), { alpha: 1, done: true });
  // From mid-attack: starts where the attack was, not at the floor.
  assert.equal(xrayReleaseAlpha(0, 0.8).alpha, 0.8);
  // Absent inputs are the opaque, finished state.
  for (const value of [null, undefined, NaN, Infinity]) {
    assert.deepEqual(xrayReleaseAlpha(value, 0.35), { alpha: 1, done: true });
    assert.deepEqual(xrayReleaseAlpha(100, value), { alpha: 1, done: true });
  }
});

// ---------------------------------------------------------------------------
// The controller
// ---------------------------------------------------------------------------

function fakeCesium() {
  class Color {
    constructor(r = 1, g = 1, b = 1, a = 1) { Object.assign(this, { red: r, green: g, blue: b, alpha: a }); }
    static fromAlpha(color, alpha, result) {
      const out = result || new Color();
      Object.assign(out, { red: color.red, green: color.green, blue: color.blue, alpha });
      return out;
    }
  }
  Color.WHITE = Object.freeze(new Color(1, 1, 1, 1));
  class Cesium3DTileStyle { constructor() { this.color = undefined; } }
  return { Color, Cesium3DTileStyle };
}

function fakeTileset() {
  return {
    show: true,
    style: undefined,
    dirty: 0,
    makeStyleDirty() { this.dirty += 1; },
    isDestroyed() { return false; },
  };
}

function harness({ tileset = fakeTileset(), reduced = () => false } = {}) {
  const Cesium = fakeCesium();
  let clock = 1000;
  const listeners = [];
  const scene = { preRender: { addEventListener(fn) { listeners.push(fn); return () => {}; } } };
  const holds = [];
  const releases = [];
  let renders = 0;
  const xray = createXray({
    Cesium,
    scene,
    getTileset: () => tileset,
    holdRender: (id) => holds.push(id),
    releaseRender: (id) => releases.push(id),
    requestRender: () => { renders += 1; },
    now: () => clock,
    reduced,
  });
  const frame = (advanceMs) => {
    clock += advanceMs;
    for (const fn of listeners) fn();
  };
  return {
    xray, tileset, Cesium, holds, releases, frame, get renders() { return renders; }, set clock(v) { clock = v; },
  };
}

test('the style is a white evaluator at the live alpha, on the tileset only while running', () => {
  const h = harness();
  assert.equal(h.tileset.style, undefined);
  const started = h.xray.trigger();
  assert.deepEqual(started, { ok: true, restarted: false });
  assert.deepEqual(h.holds, [XRAY_RENDER_OWNER]);

  h.frame(16); // attack: alpha just under 1
  assert.ok(h.tileset.style, 'style handed to the tileset on the first frame');
  assert.ok(h.xray.alpha < 1 && h.xray.alpha > XRAY_ALPHA);
  assert.equal(h.xray.styleAlpha, h.xray.alpha, 'the style evaluates to the applied alpha');

  h.frame(1000); // deep in the hold
  assert.equal(h.xray.alpha, XRAY_ALPHA);
  assert.equal(h.xray.styleAlpha, XRAY_ALPHA);
  const dirtyAtHold = h.tileset.dirty;
  h.frame(16);
  h.frame(16);
  assert.equal(h.tileset.dirty, dirtyAtHold, 'a constant alpha does not re-dirty the style');

  h.frame(XRAY_HOLD_MS + XRAY_RELEASE_MS); // past the end
  assert.equal(h.xray.running, false);
  assert.equal(h.tileset.style, undefined, 'the style is taken back off');
  assert.equal(h.xray.alpha, 1);
  assert.equal(h.xray.styleAlpha, 1);
  assert.deepEqual(h.releases, [XRAY_RENDER_OWNER]);
  assert.ok(h.xray.last.minAlpha <= XRAY_ALPHA + 1e-9);
  assert.ok(h.xray.last.frames >= 4);
});

test('"solid" eases back early and releases the render hold when it lands', () => {
  const h = harness();
  h.xray.trigger();
  h.frame(1000);
  assert.equal(h.xray.alpha, XRAY_ALPHA);
  assert.deepEqual(h.xray.end(), { ok: true, wasRunning: true });
  h.frame(XRAY_RELEASE_MS / 2);
  assert.ok(h.xray.alpha > XRAY_ALPHA && h.xray.alpha < 1, `easing at ${h.xray.alpha}`);
  assert.equal(h.xray.phase, 'out');
  h.frame(XRAY_RELEASE_MS / 2 + 1);
  assert.equal(h.xray.running, false);
  assert.equal(h.tileset.style, undefined);
  assert.deepEqual(h.releases, [XRAY_RENDER_OWNER]);
  assert.equal(h.xray.last.earlyEnd, true);
  // Ending an idle effect is a no-op, not an error.
  assert.deepEqual(h.xray.end(), { ok: true, wasRunning: false });
});

test('a second x-ray restarts the clock rather than queueing', () => {
  const h = harness();
  h.xray.trigger();
  h.frame(2000);
  assert.deepEqual(h.xray.trigger(), { ok: true, restarted: true });
  h.frame(1000); // would be past the hold on the first clock; not on the restarted one
  assert.equal(h.xray.alpha, XRAY_ALPHA);
  assert.equal(h.xray.runs, 2);
  assert.equal(h.holds.length, 1, 'one hold for one continuous effect');
});

test('no tileset, or a hidden one, is a refusal rather than a style on nothing', () => {
  const none = harness({ tileset: null });
  assert.deepEqual(none.xray.trigger(), { ok: false, reason: 'no tileset' });
  assert.deepEqual(none.holds, []);
  const hidden = harness({ tileset: { ...fakeTileset(), show: false } });
  assert.deepEqual(hidden.xray.trigger(), { ok: false, reason: 'tileset hidden' });
  assert.equal(hidden.xray.running, false);
});

test('arming fires on the next flight settle, or now when nothing is flying', () => {
  const h = harness();
  assert.equal(h.xray.arm({ flying: true }), true);
  assert.equal(h.xray.running, false);
  h.xray.onFlight({ flying: true });
  assert.equal(h.xray.running, false, 'still in the air');
  h.xray.onFlight({ flying: false });
  assert.equal(h.xray.running, true);
  assert.equal(h.xray.armed, false, 'the latch is consumed');
  // A settle with nothing armed does nothing.
  h.frame(XRAY_HOLD_MS + XRAY_RELEASE_MS + 10);
  h.xray.onFlight({ flying: false });
  assert.equal(h.xray.running, false);
  // Not flying: immediate.
  assert.equal(h.xray.arm({ flying: false }), false);
  assert.equal(h.xray.running, true);
});

test('a flight taking off ends a running x-ray early but keeps the latch', () => {
  const h = harness();
  h.xray.trigger();
  h.frame(1000);
  assert.equal(h.xray.alpha, XRAY_ALPHA);
  // The next house: a hop begins, armed for its landing.
  h.xray.arm({ flying: true });
  h.xray.onFlight({ flying: true });
  assert.equal(h.xray.phase, 'out', 'releasing as the camera leaves');
  assert.equal(h.xray.armed, true, 'still armed for the landing');
  h.frame(XRAY_RELEASE_MS + 1);
  assert.equal(h.xray.running, false);
  h.xray.onFlight({ flying: false });
  assert.equal(h.xray.running, true, 'fires again on arrival');
  assert.equal(h.xray.runs, 2);
});

test('reduced motion skips the automatic x-ray and keeps the spoken one', () => {
  const h = harness({ reduced: () => true });
  assert.equal(h.xray.arm({ flying: true }), false);
  assert.equal(h.xray.armed, false);
  h.xray.onFlight({ flying: false });
  assert.equal(h.xray.running, false);
  assert.equal(h.xray.trigger().ok, true);
});

test('createXrayStyle evaluates white at whatever the getter says now', () => {
  const Cesium = fakeCesium();
  let alpha = 0.35;
  const style = createXrayStyle(Cesium, () => alpha);
  const a = style.color.evaluateColor(undefined, new Cesium.Color());
  assert.deepEqual([a.red, a.green, a.blue, a.alpha], [1, 1, 1, 0.35]);
  alpha = 0.9;
  assert.equal(style.color.evaluateColor(undefined, new Cesium.Color()).alpha, 0.9);
});

test('destroy mid-effect takes the style back and releases the hold', () => {
  const h = harness();
  h.xray.trigger();
  h.frame(500);
  assert.ok(h.tileset.style);
  h.xray.destroy();
  assert.equal(h.tileset.style, undefined);
  assert.deepEqual(h.releases, [XRAY_RENDER_OWNER]);
  assert.equal(h.xray.trigger().ok, false);
});
