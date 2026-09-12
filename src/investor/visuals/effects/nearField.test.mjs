import test from 'node:test';
import assert from 'node:assert/strict';
import {
  COLUMN_ALPHA_FAR,
  COLUMN_ALPHA_NEAR,
  COLUMN_FADE_FAR_M,
  COLUMN_FADE_NEAR_M,
  DIM_ALPHA,
  EFFECT_COLORS,
  GLOW_WIDTH_MAX_PX,
  GLOW_WIDTH_MIN_PX,
  GOLD_BREATH_MAX,
  GOLD_BREATH_MIN,
  GOLD_BREATH_PERIOD_S,
  GOLD_GLOW_WIDTH_PX,
  MOTION,
  NEAR_FIELD_HYSTERESIS_M,
  NEAR_FIELD_MAX_HEIGHT_M,
  QUIET_ALPHA,
  brightnessFor,
  columnAlphaFor,
  createEffectClock,
  envelopeFor,
  glowWidthFor,
  goldBreathFor,
  nearFieldActive,
  outlineStateFor,
  phaseOf,
} from './signalMotion.js';
import { colorForSignal } from '../markers.js';
import { SIGNAL_LOOK } from '../propertyPulse.js';

const TYPES = Object.keys(MOTION);

// ---------------------------------------------------------------------------
// tempo envelopes stay within bounds
// ---------------------------------------------------------------------------

test('every envelope stays inside 0..1 across several full cycles', () => {
  for (const type of TYPES) {
    const { kind, periodS } = MOTION[type];
    // 1 ms steps over three cycles — the sweep that caught the ellipse race.
    for (let ms = 0; ms <= periodS * 3000; ms += 1) {
      const value = envelopeFor(kind, phaseOf(ms / 1000, periodS));
      assert.ok(Number.isFinite(value), `${type} @${ms}ms is ${value}`);
      assert.ok(value >= 0 && value <= 1, `${type} @${ms}ms left 0..1 at ${value}`);
    }
  }
});

test('brightness stays inside each signal type its own floor and ceiling', () => {
  for (const type of TYPES) {
    const { periodS, floor, ceil } = MOTION[type];
    let min = Infinity;
    let max = -Infinity;
    for (let ms = 0; ms <= periodS * 3000; ms += 1) {
      const value = brightnessFor(type, ms / 1000);
      assert.ok(value >= floor - 1e-9, `${type} @${ms}ms dipped to ${value} (floor ${floor})`);
      assert.ok(value <= ceil + 1e-9, `${type} @${ms}ms spiked to ${value} (ceil ${ceil})`);
      min = Math.min(min, value);
      max = Math.max(max, value);
    }
    if (MOTION[type].kind === 'steady') {
      assert.equal(min, max, `${type} is steady and must not move`);
    } else {
      assert.ok(max - min > 0.1, `${type} barely moves (${(max - min).toFixed(3)})`);
    }
  }
});

test('no tempo strobes: every period clears the 2.2s floor', () => {
  for (const type of TYPES) {
    assert.ok(MOTION[type].periodS >= 2.2, `${type} at ${MOTION[type].periodS}s would strobe`);
  }
  assert.ok(GOLD_BREATH_PERIOD_S >= 2.2);
});

test('a tempo is periodic, deterministic, and survives a clock that stepped back', () => {
  for (const type of TYPES) {
    const { periodS, floor, ceil } = MOTION[type];
    for (const t of [0, 0.41, 1.7, 2.95]) {
      assert.equal(brightnessFor(type, t), brightnessFor(type, t), `${type} is not deterministic`);
      assert.ok(
        Math.abs(brightnessFor(type, t) - brightnessFor(type, t + periodS)) < 1e-9,
        `${type} is not periodic at ${t}`,
      );
    }
    const back = brightnessFor(type, -3.7);
    assert.ok(back >= floor - 1e-9 && back <= ceil + 1e-9, `${type} broke on a negative clock`);
    const broken = brightnessFor(type, Number.NaN);
    assert.ok(broken >= floor - 1e-9 && broken <= ceil + 1e-9, `${type} broke on NaN`);
  }
});

test('each motion has the shape its name promises', () => {
  const sample = (kind) => {
    const out = [];
    for (let t = 0; t < 1; t += 0.002) out.push(envelopeFor(kind, t));
    return out;
  };
  // Heartbeat: a strong beat, a weaker one, then a rest longer than both.
  const beats = sample('heartbeat');
  assert.ok(Math.max(...beats) > 0.95, 'heartbeat never reaches full');
  assert.ok(beats.filter((v) => v === 0).length > beats.length / 2, 'heartbeat never rests');

  // Two pulses then a pause: exactly two runs above half, then quiet.
  const two = sample('twoPulse');
  let runs = 0;
  let inRun = false;
  for (const v of two) {
    if (v > 0.5 && !inRun) { runs += 1; inRun = true; }
    if (v <= 0.5) inRun = false;
  }
  assert.equal(runs, 2, `twoPulse produced ${runs} pulses`);
  assert.ok(two.filter((v) => v === 0).length > two.length / 2, 'twoPulse never pauses');

  // Rise: climbs most of the cycle, then releases.
  const rise = sample('rise');
  assert.ok(rise[0] < 0.05 && Math.max(...rise) > 0.98);
  assert.ok(rise.indexOf(Math.max(...rise)) > rise.length * 0.7, 'rise peaks too early');

  // Shimmer: restrained and uneven — it must never reach either rail.
  const shimmer = sample('shimmer');
  assert.ok(Math.max(...shimmer) < 1, 'shimmer saturates');
  assert.ok(Math.min(...shimmer) > 0, 'shimmer blacks out');
  const half = shimmer.slice(0, shimmer.length / 2);
  const rest = shimmer.slice(shimmer.length / 2);
  assert.notDeepEqual(half, rest, 'shimmer repeats inside one cycle — that is a pulse');

  // Steady: the travelling segment carries LISTED, the envelope must not.
  assert.equal(envelopeFor('steady', 0.1), envelopeFor('steady', 0.9));
});

test('the gold breath never goes dark and never overshoots', () => {
  let min = Infinity;
  let max = -Infinity;
  for (let ms = 0; ms <= GOLD_BREATH_PERIOD_S * 3000; ms += 1) {
    const value = goldBreathFor(ms / 1000);
    assert.ok(value >= GOLD_BREATH_MIN - 1e-9, `gold dipped to ${value}`);
    assert.ok(value <= GOLD_BREATH_MAX + 1e-9, `gold spiked to ${value}`);
    min = Math.min(min, value);
    max = Math.max(max, value);
  }
  // It has to actually reach both ends or the range is a lie.
  assert.ok(Math.abs(min - GOLD_BREATH_MIN) < 1e-3, `gold floor is ${min}`);
  assert.ok(Math.abs(max - GOLD_BREATH_MAX) < 1e-3, `gold ceiling is ${max}`);
});

test('glow width tracks the tempo and stays in the pixel band', () => {
  for (const type of TYPES) {
    const { periodS } = MOTION[type];
    let min = Infinity;
    let max = -Infinity;
    for (let ms = 0; ms <= periodS * 2000; ms += 1) {
      const width = glowWidthFor(type, ms / 1000);
      assert.ok(width >= GLOW_WIDTH_MIN_PX - 1e-9 && width <= GLOW_WIDTH_MAX_PX + 1e-9,
        `${type} width ${width}px is outside the band`);
      min = Math.min(min, width);
      max = Math.max(max, width);
    }
    if (MOTION[type].kind !== 'steady') {
      assert.ok(max - min > 1, `${type} width does not follow its tempo`);
    }
  }
  assert.equal(glowWidthFor('FORECLOSURE', 1.2, { gold: true }), GOLD_GLOW_WIDTH_PX);
});

test('prefers-reduced-motion freezes brightness and width at a mid value', () => {
  for (const type of TYPES) {
    const { floor, ceil } = MOTION[type];
    const mid = (floor + ceil) / 2;
    for (const t of [0, 0.8, 2.4, 7.1]) {
      assert.equal(brightnessFor(type, t, { reduced: true }), mid, `${type} moved at ${t}`);
      assert.equal(
        glowWidthFor(type, t, { reduced: true }),
        glowWidthFor(type, 0, { reduced: true }),
        `${type} width moved at ${t}`,
      );
    }
  }
  // Gold holds at full rather than at a midpoint — a top pick is never dimmer
  // for a user who asked for less motion.
  assert.equal(goldBreathFor(3.3, { reduced: true }), GOLD_BREATH_MAX);
});

test('only LISTED travels and only TAX_SALE waves', () => {
  for (const type of TYPES) {
    const { travelPerSec, wavePerSec } = MOTION[type];
    assert.equal(travelPerSec > 0, type === 'LISTED_OPPORTUNITY', `${type} travel`);
    assert.equal(wavePerSec > 0, type === 'TAX_SALE', `${type} wave`);
  }
});

test('every signal type has a near-field colour and LISTED is cyan, not blue', () => {
  for (const type of TYPES) {
    const colour = EFFECT_COLORS[type];
    assert.equal(colour.length, 3, type);
    assert.ok(colour.every((c) => c >= 0 && c <= 1), type);
  }
  const [r, g, b] = EFFECT_COLORS.LISTED_OPPORTUNITY;
  assert.ok(g > 0.6 && b > 0.6 && r < 0.4, `LISTED is not cyan: ${[r, g, b]}`);
});

test('a signal is the same colour in the far field and the near field', () => {
  // The two layers are visible at once through the whole handover around
  // 1,500 m. If a sprite and the parcel outline under it are different
  // colours, they stop reading as the same house — which is exactly what
  // happened when the near field carried its own LISTED override.
  for (const type of TYPES) {
    assert.deepEqual(
      EFFECT_COLORS[type],
      colorForSignal(type).slice(0, 3),
      `${type} is one colour as a sprite and another on the ground`,
    );
  }
  // And the palette is one object, not two that happen to agree today.
  assert.deepEqual(
    Object.keys(EFFECT_COLORS).sort(),
    Object.keys(SIGNAL_LOOK).sort(),
    'the near field has invented or dropped a signal type',
  );
});

// ---------------------------------------------------------------------------
// dim rules
// ---------------------------------------------------------------------------

test('with no shortlist and nothing focused every outline is full strength', () => {
  const state = outlineStateFor('A', {});
  assert.deepEqual(state, { alpha: 1, moving: true, gold: false, focused: false });
});

test('a house the shortlist left out goes quiet and stops moving', () => {
  const shortlistIds = new Set(['A', 'B']);
  const out = outlineStateFor('Z', { shortlistIds });
  assert.equal(out.alpha, QUIET_ALPHA);
  assert.equal(out.moving, false, 'a quiet house must not animate');
  assert.equal(out.gold, false);

  // Being on the shortlist is what buys motion back.
  assert.equal(outlineStateFor('A', { shortlistIds }).alpha, 1);
  assert.equal(outlineStateFor('A', { shortlistIds }).moving, true);
});

test('focus brightens one house and dims every other to 35%', () => {
  const options = { focusedId: 'B' };
  assert.equal(outlineStateFor('B', options).alpha, 1);
  assert.equal(outlineStateFor('B', options).focused, true);
  for (const id of ['A', 'C', 'D']) {
    const other = outlineStateFor(id, options);
    assert.equal(other.alpha, DIM_ALPHA, `${id} should dim to ${DIM_ALPHA}`);
    assert.equal(other.focused, false);
    assert.equal(other.moving, true, 'dimmed is not the same as frozen');
  }
});

test('the focused house and the top pick are never quiet, shortlist or not', () => {
  const shortlistIds = new Set(['A']);
  assert.equal(outlineStateFor('F', { shortlistIds, focusedId: 'F' }).alpha, 1);
  assert.equal(outlineStateFor('T', { shortlistIds, topPickId: 'T' }).gold, true);
  assert.notEqual(outlineStateFor('T', { shortlistIds, topPickId: 'T' }).alpha, QUIET_ALPHA);
});

test('the top pick stays gold but dims when the user focuses something else', () => {
  const state = outlineStateFor('T', { topPickId: 'T', focusedId: 'B' });
  assert.equal(state.gold, true, 'the ranking did not change');
  assert.equal(state.alpha, DIM_ALPHA, 'but it is not what is being looked at');
});

test('a saved house is held above quiet without being promoted to gold', () => {
  const shortlistIds = new Set(['A']);
  assert.equal(outlineStateFor('S', { shortlistIds }).alpha, QUIET_ALPHA);
  const saved = outlineStateFor('S', { shortlistIds, savedId: 'S' });
  assert.equal(saved.alpha, DIM_ALPHA);
  assert.equal(saved.gold, false);
  assert.equal(saved.moving, false, 'saved is legible, not animated');
});

test('an empty shortlist is not a shortlist', () => {
  assert.equal(outlineStateFor('A', { shortlistIds: new Set() }).alpha, 1);
  assert.equal(outlineStateFor('A', { shortlistIds: null }).alpha, 1);
});

// ---------------------------------------------------------------------------
// the 1,500 m layer switch
// ---------------------------------------------------------------------------

test('the near field is on below 1,500 m and off above it', () => {
  assert.equal(nearFieldActive(0), true);
  assert.equal(nearFieldActive(150), true, 'HERO is near field');
  assert.equal(nearFieldActive(900), true, 'the six-house cruise is near field');
  assert.equal(nearFieldActive(NEAR_FIELD_MAX_HEIGHT_M - 1), true);
  assert.equal(nearFieldActive(NEAR_FIELD_MAX_HEIGHT_M), false, 'the ceiling is exclusive');
  assert.equal(nearFieldActive(1_800), false, 'the market cruise is sprite territory');
  assert.equal(nearFieldActive(40_000), false, 'STAGING is sprite territory');
  assert.equal(nearFieldActive(18_000_000), false, 'WORLD is sprite territory');
});

test('hysteresis stops the layer flickering at the boundary', () => {
  const ceiling = NEAR_FIELD_MAX_HEIGHT_M;
  // Climbing through: it stays on until it clears the ceiling plus the margin.
  assert.equal(nearFieldActive(ceiling + 50, true), true, 'already on, still on');
  assert.equal(nearFieldActive(ceiling + NEAR_FIELD_HYSTERESIS_M, true), false);
  // Descending: it does not come on early.
  assert.equal(nearFieldActive(ceiling + 50, false), false);
  // A camera parked exactly on the line cannot oscillate.
  let active = false;
  for (let i = 0; i < 50; i += 1) active = nearFieldActive(ceiling, active);
  assert.equal(active, false, 'settled off at the ceiling');
  active = true;
  for (let i = 0; i < 50; i += 1) active = nearFieldActive(ceiling, active);
  assert.equal(active, true, 'settled on at the ceiling');
});

test('a missing or nonsense camera height never turns the layer on', () => {
  for (const bad of [null, undefined, Number.NaN, 'high', -10]) {
    assert.equal(nearFieldActive(bad), false, String(bad));
    assert.equal(nearFieldActive(bad, true), false, `${bad} while active`);
  }
});

test('the column fades out close up and holds up at range', () => {
  const near = (value, target, what) => assert.ok(
    Math.abs(value - target) < 1e-9,
    `${what}: ${value} is not ${target}`,
  );
  near(columnAlphaFor(0), COLUMN_ALPHA_NEAR, 'on top of the house');
  near(columnAlphaFor(COLUMN_FADE_NEAR_M), COLUMN_ALPHA_NEAR, 'at the near stop');
  near(columnAlphaFor(COLUMN_FADE_FAR_M), COLUMN_ALPHA_FAR, 'at the far stop');
  near(columnAlphaFor(5_000), COLUMN_ALPHA_FAR, 'beyond the far stop');
  // The two facts that matter, stated against the constants rather than
  // against numbers that go stale the first time the look is retuned:
  // at HERO the column is all but gone, and across the cluster it is present.
  assert.ok(
    columnAlphaFor(150) <= COLUMN_ALPHA_NEAR + 1e-9,
    'the column is still in the way at HERO',
  );
  assert.ok(
    columnAlphaFor(900) >= COLUMN_ALPHA_FAR - 1e-9,
    'the column cannot locate a house from across the cluster',
  );
  // And the gap between them is wide enough for the fade to read as a fade.
  assert.ok(
    columnAlphaFor(900) > columnAlphaFor(150) * 5,
    'near and far are too close together to read as a distance fade',
  );
  // A closed wall shows two faces at once, so one face must stay well under
  // opaque or the column becomes a slab in front of the house.
  assert.ok(COLUMN_ALPHA_FAR < 0.25, `a single face at ${COLUMN_ALPHA_FAR} will stack to a slab`);
  // Monotonic, so there is no range at which approaching makes it brighter.
  let previous = -1;
  for (let range = 0; range <= 1_200; range += 5) {
    const alpha = columnAlphaFor(range);
    assert.ok(alpha >= previous - 1e-9, `alpha fell then rose at ${range}m`);
    previous = alpha;
  }
  near(columnAlphaFor(Number.NaN), COLUMN_ALPHA_NEAR, 'with no range at all');
});

// ---------------------------------------------------------------------------
// the shared clock
// ---------------------------------------------------------------------------

test('one clock drives everything and a freeze holds every layer together', () => {
  const clock = createEffectClock();
  assert.equal(clock.read(1_000), 0, 'the first read is the epoch');
  assert.equal(clock.read(3_500), 2.5);

  clock.freeze(3_500);
  assert.equal(clock.frozen, true);
  assert.equal(clock.read(9_999), 2.5, 'a frozen clock does not advance');

  // Thawing resumes where it stopped — it does not jump by the length of the
  // flight, which would make every outline lurch as the camera settles.
  clock.thaw(20_000);
  assert.equal(clock.frozen, false);
  assert.equal(clock.read(20_000), 2.5);
  assert.equal(clock.read(21_000), 3.5);
});

test('the clock survives a missing performance clock', () => {
  const clock = createEffectClock();
  assert.equal(clock.read(Number.NaN), 0);
  clock.read(500);
  clock.freeze(1_500);
  assert.equal(clock.read(Number.NaN), 1);
});
