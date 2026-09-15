/**
 * The pure rules of the Street View drive.
 *
 * Everything here is a product rule that has a number in it, and the point of
 * the test is the *reason* for the number rather than the number: a cadence
 * that survives a loop wrap and a seek, a fallback measured in metres of road
 * rather than in failed requests, and a POV that turns like a head rather than
 * like a compass needle.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  COVERAGE,
  COVERAGE_GAP_M,
  DOLLY_DRIFT_TO,
  DOLLY_FROM,
  DOLLY_IN_FROM,
  DOLLY_IN_TO,
  DOLLY_OUT_TO,
  DOLLY_STALL_MAX,
  HOP_ACTION,
  HOP_FADE_MS,
  HOP_MAX_MS,
  HOP_MIN_MS,
  HOP_PHASE,
  MARKER_RADIUS_M,
  PANO_RADIUS_M,
  PANO_SPACING_M,
  POV_EASE_RADIUS_M,
  POV_MAX_OFF_TRAVEL_DEG,
  POV_RELEASE_M,
  PRELOAD_FAIL_LIMIT,
  QUEUE_DEPTH,
  STREET_VIEW_SPEED_MPS,
  createPanoQueue,
  dollyFor,
  hopPlanFor,
  hopProgress,
  hopSpacingFor,
  initialCoverage,
  initialHopState,
  initialPreloadHealth,
  nextCoverage,
  nextHopState,
  nextPreloadHealth,
  panoMarkersFor,
  povBlendFor,
  povHeadingFor,
  queueMayReach,
} from './streetViewDrive.js';
import { deltaDeg } from './route.js';

const LOOP_M = 1360.2;

// ---------------------------------------------------------------------------
// Cadence
// ---------------------------------------------------------------------------

test('the search radius and the playback speed are the stated ones', () => {
  assert.equal(PANO_RADIUS_M, 25);
  assert.equal(STREET_VIEW_SPEED_MPS, 7);
  assert.equal(PANO_SPACING_M, 10);
});

// ---------------------------------------------------------------------------
// Hop timing
// ---------------------------------------------------------------------------

test('the hop interval at the default playback speed is 1.43 s', () => {
  // 10 m of nominal spacing at 7 m/s. This is the rhythm a reviewer sees.
  const { intervalMs, clamped } = hopPlanFor(STREET_VIEW_SPEED_MPS);
  assert.equal(clamped, false);
  assert.ok(Math.abs(intervalMs - 1428.6) < 1, `interval was ${intervalMs} ms`);
  assert.ok(intervalMs > HOP_FADE_MS * 2, 'there must be a settled moment between fades');
});

test('a fast drive floors the interval and stretches the spacing instead', () => {
  /**
   * This is the part that keeps the picture on the road.
   *
   * At the probe's 4x the raw interval would be 357 ms, which is shorter than
   * the 300 ms fade — overlapping transitions, a dissolve with no image in it.
   * Flooring the interval alone would make the panorama advance 10 m per 420 ms
   * while the drive covers 28: about 4 m/s of drift, a quarter of a kilometre
   * over a lap. So the SPACING absorbs the clamp.
   */
  const fast = 4 * STREET_VIEW_SPEED_MPS;
  const { intervalMs, clamped } = hopPlanFor(fast);
  assert.equal(clamped, true);
  assert.equal(intervalMs, HOP_MIN_MS);
  const spacingM = hopSpacingFor(fast, intervalMs);
  const panoMetresPerSecond = (spacingM / intervalMs) * 1000;
  assert.ok(Math.abs(panoMetresPerSecond - fast) < 0.01,
    `picture moves at ${panoMetresPerSecond} m/s against a drive at ${fast}`);
});

test('a slow drive caps the interval and hops between closer panoramas', () => {
  // Playback drops to 40% near a house being explained. At the nominal spacing
  // that would be a three-and-a-half second hold on one static frame.
  const slow = STREET_VIEW_SPEED_MPS * 0.4;
  const { intervalMs } = hopPlanFor(slow);
  assert.equal(intervalMs, HOP_MAX_MS);
  const spacingM = hopSpacingFor(slow, intervalMs);
  assert.ok(spacingM < PANO_SPACING_M, `spacing ${spacingM} m did not shrink`);
  assert.ok(Math.abs((spacingM / intervalMs) * 1000 - slow) < 0.01);
});

test('the interval never drops below a fade plus a settled moment', () => {
  for (const speed of [7, 20, 50, 200, 1e6]) {
    assert.ok(hopPlanFor(speed).intervalMs >= HOP_FADE_MS + 120,
      `${speed} m/s produced overlapping fades`);
  }
});

test('a stopped or nonsense speed does not produce a zero interval', () => {
  for (const speed of [0, -3, NaN, null, undefined]) {
    assert.equal(hopPlanFor(speed).intervalMs, HOP_MAX_MS, String(speed));
  }
  assert.ok(hopSpacingFor(0, 1000) > 0);
});

// ---------------------------------------------------------------------------
// The swap state machine
// ---------------------------------------------------------------------------

const INTERVAL = 1000;

test('a hop waits out the interval, fades, and swaps', () => {
  let state = initialHopState(0);
  let step = nextHopState(state, { nowMs: 500, intervalMs: INTERVAL, nextReady: true });
  assert.equal(step.action, HOP_ACTION.NONE);
  assert.equal(step.state.phase, HOP_PHASE.HOLDING);

  step = nextHopState(step.state, { nowMs: 1000, intervalMs: INTERVAL, nextReady: true });
  assert.equal(step.action, HOP_ACTION.START_FADE);
  assert.equal(step.state.phase, HOP_PHASE.FADING);

  state = step.state;
  step = nextHopState(state, { nowMs: 1200, intervalMs: INTERVAL, nextReady: true });
  assert.equal(step.action, HOP_ACTION.NONE, 'the fade is not over at 200 ms');

  step = nextHopState(state, { nowMs: 1000 + HOP_FADE_MS, intervalMs: INTERVAL, nextReady: true });
  assert.equal(step.action, HOP_ACTION.END_FADE);
  assert.equal(step.state.phase, HOP_PHASE.HOLDING);
  assert.equal(step.state.hops, 1);
});

test('a preload that has not landed holds the picture instead of blanking it', () => {
  const state = initialHopState(0);
  const step = nextHopState(state, { nowMs: 1200, intervalMs: INTERVAL, nextReady: false });
  assert.equal(step.action, HOP_ACTION.STALL);
  assert.equal(step.state.phase, HOP_PHASE.HOLDING, 'never fade to a panorama that is not there');
  assert.equal(step.state.stalls, 1);
});

test('a stalled fade still lasts exactly one fade, not one cycle', () => {
  // The fade is anchored on its own start, so a hop delayed by a slow preload
  // is a late hop and not a long one.
  let step = nextHopState(initialHopState(0), { nowMs: 5_000, intervalMs: INTERVAL, nextReady: false });
  step = nextHopState(step.state, { nowMs: 5_000, intervalMs: INTERVAL, nextReady: true });
  assert.equal(step.action, HOP_ACTION.START_FADE);
  assert.equal(step.state.fadeSince, 5_000);
  const early = nextHopState(step.state, { nowMs: 5_000 + HOP_FADE_MS - 1, intervalMs: INTERVAL, nextReady: true });
  assert.equal(early.action, HOP_ACTION.NONE);
  const done = nextHopState(step.state, { nowMs: 5_000 + HOP_FADE_MS, intervalMs: INTERVAL, nextReady: true });
  assert.equal(done.action, HOP_ACTION.END_FADE);
});

test('a stall leaves the hop overdue, so it fires the instant the preload lands', () => {
  // The alternative — advancing `since` on a stall — makes a 50 ms late preload
  // cost a whole extra interval, and the picture visibly hitches.
  let step = nextHopState(initialHopState(0), { nowMs: 1200, intervalMs: INTERVAL, nextReady: false });
  assert.equal(step.state.since, 0, 'the stall must not restart the interval');
  step = nextHopState(step.state, { nowMs: 1250, intervalMs: INTERVAL, nextReady: true });
  assert.equal(step.action, HOP_ACTION.START_FADE);
});

test('a fade in progress is never interrupted by the next one coming due', () => {
  let step = nextHopState(initialHopState(0), { nowMs: 1000, intervalMs: INTERVAL, nextReady: true });
  // An absurdly short interval: the next hop is due before this fade ends.
  step = nextHopState(step.state, { nowMs: 1100, intervalMs: 1, nextReady: true });
  assert.equal(step.action, HOP_ACTION.NONE);
  assert.equal(step.state.phase, HOP_PHASE.FADING);
});

test('one hop takes one interval — hold plus fade, not hold then fade', () => {
  /**
   * The pacing bug this pins.
   *
   * The spacing between the panoramas asked for is derived from the interval,
   * so if the real cycle is `interval + fade` the picture advances one spacing
   * every 720 ms while the drive covers 420 ms of road. At the probe's 4x that
   * is about 11 m/s of drift — half a kilometre over one lap of the loop, with
   * the pins and the call-outs describing somewhere the picture never reached.
   * Eighty clean hops and every fade inside 300 ms, and still wrong.
   */
  let state = initialHopState(0);
  const hopAt = [];
  for (let ms = 0; ms <= 20 * INTERVAL; ms += 1) {
    const step = nextHopState(state, { nowMs: ms, intervalMs: INTERVAL, nextReady: true });
    state = step.state;
    if (step.action === HOP_ACTION.END_FADE) hopAt.push(ms);
  }
  assert.ok(hopAt.length >= 19, `only ${hopAt.length} hops in twenty intervals`);
  for (let i = 1; i < hopAt.length; i += 1) {
    const period = hopAt[i] - hopAt[i - 1];
    assert.ok(Math.abs(period - INTERVAL) <= 2, `hop ${i} took ${period} ms, not ${INTERVAL}`);
  }
});

test('a hundred hops produce a hundred swaps and no lost frames', () => {
  let state = initialHopState(0);
  let hops = 0;
  let fading = 0;
  let frames = 0;
  for (let ms = 0; ms <= 100 * INTERVAL; ms += 16) {
    const step = nextHopState(state, { nowMs: ms, intervalMs: INTERVAL, nextReady: true });
    state = step.state;
    frames += 1;
    if (step.action === HOP_ACTION.END_FADE) hops += 1;
    if (state.phase === HOP_PHASE.FADING) fading += 1;
  }
  assert.equal(hops, state.hops);
  assert.ok(hops >= 95, `only ${hops} hops in a hundred intervals`);
  // The picture is settled far more often than it is dissolving: 300 ms of
  // fade in every 1000 ms of cycle.
  assert.ok(fading / frames < 0.4, `dissolving ${((fading / frames) * 100).toFixed(0)}% of the time`);
});

// ---------------------------------------------------------------------------
// The dolly
// ---------------------------------------------------------------------------

test('the two layers always sum to one — there is never a blank frame', () => {
  /**
   * The failure a double buffer introduces: both layers transparent at once.
   * Nothing on screen but the 3D scene showing through, for one frame, on every
   * hop. This is the property `smoke:drive` samples for on the real page.
   */
  for (const phase of [HOP_PHASE.HOLDING, HOP_PHASE.FADING]) {
    for (let t = 0; t <= 1.0001; t += 0.02) {
      const d = dollyFor({ phase, holdProgress: t, fadeProgress: t });
      const sum = d.front.opacity + d.back.opacity;
      assert.ok(Math.abs(sum - 1) < 1e-9, `${phase} at ${t} summed to ${sum}`);
      assert.ok(Math.max(d.front.opacity, d.back.opacity) >= 0.5,
        `${phase} at ${t} left both layers faint`);
    }
  }
});

test('between hops the image drifts rather than sitting still', () => {
  const start = dollyFor({ phase: HOP_PHASE.HOLDING, holdProgress: 0 });
  const end = dollyFor({ phase: HOP_PHASE.HOLDING, holdProgress: 1 });
  assert.equal(start.front.scale, DOLLY_FROM);
  assert.ok(Math.abs(end.front.scale - DOLLY_DRIFT_TO) < 1e-9);
  // Monotonic: a drift that dipped would read as a wobble.
  let previous = -Infinity;
  for (let t = 0; t <= 1.0001; t += 0.01) {
    const scale = dollyFor({ phase: HOP_PHASE.HOLDING, holdProgress: t }).front.scale;
    assert.ok(scale >= previous - 1e-9, `drift dipped at ${t}`);
    previous = scale;
  }
});

test('the outgoing layer accelerates away and the incoming one settles', () => {
  const mid = dollyFor({ phase: HOP_PHASE.FADING, fadeProgress: 0.5 });
  const end = dollyFor({ phase: HOP_PHASE.FADING, fadeProgress: 1 });
  assert.ok(Math.abs(end.front.scale - DOLLY_OUT_TO) < 1e-9);
  assert.ok(Math.abs(end.back.scale - DOLLY_IN_TO) < 1e-9);
  assert.ok(mid.front.scale > DOLLY_DRIFT_TO && mid.front.scale < DOLLY_OUT_TO);
  assert.ok(mid.back.scale < DOLLY_IN_FROM && mid.back.scale > DOLLY_IN_TO);
});

test('the outgoing layer has no step in it across the whole of its life', () => {
  // Drift 1.00 -> 1.05 over the hold, then 1.05 -> 1.12 over the fade. A layer
  // that snapped back to 1.0 at the start of its fade would read as a flinch.
  const lastHold = dollyFor({ phase: HOP_PHASE.HOLDING, holdProgress: 1 }).front.scale;
  const firstFade = dollyFor({ phase: HOP_PHASE.FADING, fadeProgress: 0 }).front.scale;
  assert.ok(Math.abs(lastHold - firstFade) < 1e-9, `${lastHold} then ${firstFade}`);
  // And the layer arriving hands over at 1.0, where a fresh drift begins.
  const lastFadeIn = dollyFor({ phase: HOP_PHASE.FADING, fadeProgress: 1 }).back.scale;
  const firstDrift = dollyFor({ phase: HOP_PHASE.HOLDING, holdProgress: 0 }).front.scale;
  assert.ok(Math.abs(lastFadeIn - firstDrift) < 1e-9);
});

test('a stalled preload keeps drifting, but not far and not forever', () => {
  const held = dollyFor({ phase: HOP_PHASE.HOLDING, stalled: true, stallProgress: 0 });
  const long = dollyFor({ phase: HOP_PHASE.HOLDING, stalled: true, stallProgress: 1 });
  assert.ok(Math.abs(held.front.scale - DOLLY_DRIFT_TO) < 1e-9, 'the stall picks up where the drift stopped');
  assert.ok(Math.abs(long.front.scale - DOLLY_STALL_MAX) < 1e-9);
  assert.ok(DOLLY_STALL_MAX < DOLLY_OUT_TO, 'a stall must not out-zoom a real hop');
  assert.equal(long.front.opacity, 1, 'a stall never dims the only picture there is');
});

test('hopProgress reports the stall as an overrun of the hold', () => {
  const state = initialHopState(0);
  // The hold is the interval less the fade — 700 ms of a 1,000 ms cycle.
  const onTime = hopProgress(state, { nowMs: 630, intervalMs: INTERVAL });
  assert.equal(onTime.stalled, false);
  assert.ok(Math.abs(onTime.holdProgress - 0.9) < 1e-9);
  const late = hopProgress(state, { nowMs: 3000, intervalMs: INTERVAL });
  assert.equal(late.stalled, true);
  assert.equal(late.holdProgress, 1);
  assert.ok(late.stallProgress > 0 && late.stallProgress <= 1);
});

test('a fade reports its own progress and never exceeds one', () => {
  const state = { phase: HOP_PHASE.FADING, since: 0, fadeSince: 1000, stalls: 0, hops: 0 };
  assert.equal(hopProgress(state, { nowMs: 1000, intervalMs: INTERVAL }).fadeProgress, 0);
  assert.ok(Math.abs(hopProgress(state, { nowMs: 1150, intervalMs: INTERVAL }).fadeProgress - 0.5) < 0.01);
  assert.equal(hopProgress(state, { nowMs: 9999, intervalMs: INTERVAL }).fadeProgress, 1);
});

// ---------------------------------------------------------------------------
// The queue
// ---------------------------------------------------------------------------

test('the queue runs two panoramas ahead and no further', () => {
  assert.equal(QUEUE_DEPTH, 2);
  const queue = createPanoQueue();
  assert.equal(queue.push({ panoId: 'p1', alongM: 10 }), true);
  assert.equal(queue.push({ panoId: 'p2', alongM: 20 }), true);
  assert.equal(queue.full, true);
  assert.equal(queue.push({ panoId: 'p3', alongM: 30 }), false, 'a full queue takes no more');
  assert.equal(queue.length, 2);
  assert.equal(queue.head.panoId, 'p1');
  assert.equal(queue.tail.panoId, 'p2');
});

test('the queue refuses the panorama already on screen', () => {
  /**
   * The probe distance is a guess at where the next panorama is, and guessing
   * short returns the one being looked at. Queued, that is a 300 ms cross-fade
   * between two identical images — a stutter that is indistinguishable from a
   * working hop in every log the drive keeps.
   */
  const queue = createPanoQueue();
  assert.equal(queue.push({ panoId: 'here', alongM: 10 }, 'here'), false);
  assert.equal(queue.length, 0);
});

test('and refuses one it is already holding', () => {
  const queue = createPanoQueue();
  queue.push({ panoId: 'p1', alongM: 10 });
  assert.equal(queue.push({ panoId: 'p1', alongM: 14 }), false);
  assert.equal(queue.length, 1);
});

test('shifting hands them back in the order they were asked for', () => {
  const queue = createPanoQueue();
  queue.push({ panoId: 'p1', alongM: 10 });
  queue.push({ panoId: 'p2', alongM: 20 });
  assert.equal(queue.shift().panoId, 'p1');
  assert.equal(queue.shift().panoId, 'p2');
  assert.equal(queue.shift(), null);
  assert.equal(queue.head, null);
});

test('a queue entry without a panorama id is not an entry', () => {
  const queue = createPanoQueue();
  assert.equal(queue.push({ alongM: 10 }), false);
  assert.equal(queue.push(null), false);
  assert.equal(queue.length, 0);
});

test('clearing is what a seek does — the queue was about road we left', () => {
  const queue = createPanoQueue();
  queue.push({ panoId: 'p1', alongM: 10 });
  queue.push({ panoId: 'p2', alongM: 20 });
  queue.clear();
  assert.equal(queue.length, 0);
  assert.equal(queue.full, false);
});

test('the items it hands out are copies, not its own state', () => {
  const queue = createPanoQueue();
  queue.push({ panoId: 'p1', alongM: 10 });
  queue.head.alongM = 999;
  assert.equal(queue.head.alongM, 10);
});

// ---------------------------------------------------------------------------
// Preload health
// ---------------------------------------------------------------------------

test('two consecutive preload failures give up on the panorama', () => {
  assert.equal(PRELOAD_FAIL_LIMIT, 2);
  let health = initialPreloadHealth();
  health = nextPreloadHealth(health, { ok: false });
  assert.equal(health.exhausted, false, 'one gap in coverage is not a failure of the view');
  health = nextPreloadHealth(health, { ok: false });
  assert.equal(health.exhausted, true);
});

test('consecutive, not cumulative', () => {
  // One panorama that will not load over a 1.4 km loop is a gap; the drive
  // holds and carries on. Only two in a row means the imagery is not coming.
  let health = initialPreloadHealth();
  // Twenty failures, each followed by a success: never exhausted.
  for (let i = 0; i < 20; i += 1) {
    health = nextPreloadHealth(health, { ok: false });
    assert.equal(health.exhausted, false, `single failure ${i} should not give up`);
    health = nextPreloadHealth(health, { ok: true });
    assert.equal(health.failures, 0);
  }
  // Two in a row, and it does.
  health = nextPreloadHealth(health, { ok: false });
  health = nextPreloadHealth(health, { ok: false });
  assert.equal(health.exhausted, true);
  // And a success brings it straight back.
  assert.equal(nextPreloadHealth(health, { ok: true }).exhausted, false);
});

// ---------------------------------------------------------------------------
// Coverage fallback
// ---------------------------------------------------------------------------

test('40 m of route with no panorama falls back to the chase camera', () => {
  assert.equal(COVERAGE_GAP_M, 40);
  let state = initialCoverage();
  assert.equal(state.mode, COVERAGE.STREET_VIEW);
  // Misses every 10 m. The first miss establishes the origin and contributes
  // no distance; 40 m of road has passed by the fifth.
  for (const [alongM, expected] of [
    [100, COVERAGE.STREET_VIEW],
    [110, COVERAGE.STREET_VIEW],
    [120, COVERAGE.STREET_VIEW],
    [130, COVERAGE.STREET_VIEW],
    [140, COVERAGE.CHASE],
  ]) {
    state = nextCoverage(state, { alongM, found: false, lengthM: LOOP_M });
    assert.equal(state.mode, expected, `at ${alongM} m`);
  }
  assert.equal(state.missedM, 40);
});

test('the gap is metres of road, not a count of failed requests', () => {
  // The same five misses 2 m apart are 8 m of road and must not fall back:
  // otherwise the rule would mean something different at every playback speed.
  let state = initialCoverage();
  for (const alongM of [100, 102, 104, 106, 108]) {
    state = nextCoverage(state, { alongM, found: false, lengthM: LOOP_M });
  }
  assert.equal(state.mode, COVERAGE.STREET_VIEW);
  assert.equal(state.missedM, 8);
});

test('one panorama clears the debt and brings Street View back', () => {
  let state = initialCoverage();
  for (const alongM of [0, 10, 20, 30, 40, 50]) {
    state = nextCoverage(state, { alongM, found: false, lengthM: LOOP_M });
  }
  assert.equal(state.mode, COVERAGE.CHASE);
  state = nextCoverage(state, { alongM: 60, found: true, lengthM: LOOP_M });
  assert.equal(state.mode, COVERAGE.STREET_VIEW);
  assert.equal(state.missedM, 0, 'a hit must not leave the next miss one step from falling back');
});

test('the gap accumulates across the loop join', () => {
  let state = nextCoverage(initialCoverage(), { alongM: 1340, found: false, lengthM: LOOP_M });
  state = nextCoverage(state, { alongM: 1350, found: false, lengthM: LOOP_M });
  state = nextCoverage(state, { alongM: 1360, found: false, lengthM: LOOP_M });
  // 1,360 -> 10 is 10 m forward over the join, not 1,350 m backwards.
  state = nextCoverage(state, { alongM: 10, found: false, lengthM: LOOP_M });
  assert.ok(Math.abs(state.missedM - 30) < 1, `missed ${state.missedM} m across the join`);
  assert.equal(state.mode, COVERAGE.STREET_VIEW);
});

// ---------------------------------------------------------------------------
// POV
// ---------------------------------------------------------------------------

test('the POV is the road until a house is 60 m away', () => {
  assert.equal(POV_EASE_RADIUS_M, 60);
  assert.equal(povBlendFor(200), 0);
  assert.equal(povBlendFor(61), 0);
  assert.ok(povBlendFor(59) > 0);
  assert.ok(povBlendFor(0) > 0.999, 'level with the house is a full look');
});

test('the look ramps in monotonically rather than switching on', () => {
  let previous = -1;
  for (let d = POV_EASE_RADIUS_M; d >= 0; d -= 0.5) {
    const value = povBlendFor(d);
    assert.ok(value >= previous - 1e-9, `blend dipped at ${d} m`);
    previous = value;
  }
});

test('and eases back to the road over 25 m past the house', () => {
  assert.equal(POV_RELEASE_M, 25);
  // Continuous through zero: a step in the TARGET would be smoothed into a
  // second-and-a-half swing back through the windscreen, by which time the
  // house is gone.
  assert.ok(Math.abs(povBlendFor(0) - povBlendFor(-0.001)) < 1e-3);
  assert.ok(povBlendFor(-12) > 0 && povBlendFor(-12) < 1);
  assert.equal(povBlendFor(-POV_RELEASE_M), 0);
  assert.equal(povBlendFor(-200), 0, 'well past is forward, not a glance backwards');
});

test('with nothing discussed the POV is exactly the travel bearing', () => {
  const { headingDeg, blend } = povHeadingFor({
    previousHeadingDeg: null,
    travelBearingDeg: 271,
    houseBearingDeg: null,
    aheadM: 10,
  });
  assert.equal(blend, 0);
  assert.equal(headingDeg, 271);
});

test('the POV never turns more than 85 degrees off the direction of travel', () => {
  // A house directly behind: the blend would point the panorama at the road
  // already driven, and the next transition would then arrive from behind the
  // viewer. It is clamped to a hard look out of the side window instead.
  assert.equal(POV_MAX_OFF_TRAVEL_DEG, 85);
  const { targetDeg } = povHeadingFor({
    previousHeadingDeg: null,
    travelBearingDeg: 0,
    houseBearingDeg: 179,
    aheadM: 0,
  });
  assert.ok(Math.abs(deltaDeg(0, targetDeg)) <= POV_MAX_OFF_TRAVEL_DEG + 1e-6,
    `turned ${deltaDeg(0, targetDeg)} degrees off travel`);
});

test('the pan filters on the shortest turn, not through south', () => {
  // Filtering 359 towards 1 the naive way spins the view the long way round.
  const { headingDeg } = povHeadingFor({
    previousHeadingDeg: 359,
    travelBearingDeg: 1,
    dtSeconds: 0.25,
  });
  assert.ok(headingDeg > 359 - 1e-9 || headingDeg < 10,
    `filtered to ${headingDeg}, which is the long way round`);
});

test('a whole approach and pass turns towards the house and comes back', () => {
  // 300 m of road north past a house on the right hand side, 20 m off it.
  let heading = null;
  const samples = [];
  for (let ahead = 150; ahead >= -60; ahead -= 2) {
    // Bearing to a house 20 m east of the road, `ahead` metres up it.
    const houseBearingDeg = (Math.atan2(20, ahead) * 180) / Math.PI;
    const step = povHeadingFor({
      previousHeadingDeg: heading,
      travelBearingDeg: 0,
      houseBearingDeg: ahead > -POV_RELEASE_M ? ((houseBearingDeg % 360) + 360) % 360 : null,
      aheadM: ahead,
      dtSeconds: 2 / 7, // 2 m at the Street View playback speed
    });
    heading = step.headingDeg;
    samples.push({ ahead, off: deltaDeg(0, heading), blend: step.blend });
  }
  const far = samples.find((s) => s.ahead === 150);
  const close = samples.reduce((a, b) => (Math.abs(b.off) > Math.abs(a.off) ? b : a));
  const after = samples[samples.length - 1];
  assert.ok(Math.abs(far.off) < 1, `already looking ${far.off} degrees off at 150 m`);
  assert.ok(Math.abs(close.off) > 30, `never really looked at the house: peak ${close.off}`);
  assert.ok(Math.abs(close.off) <= POV_MAX_OFF_TRAVEL_DEG + 1);
  assert.ok(Math.abs(after.off) < 12, `still looking ${after.off} degrees off 60 m past it`);
});

// ---------------------------------------------------------------------------
// Markers
// ---------------------------------------------------------------------------

const HOUSES = [
  { id: 'A', address: '1 Pano Row, Decatur, GA 30030', lat: 33.7582, lng: -84.3074, signals: [{ type: 'FORECLOSURE' }] },
  { id: 'B', address: '2 Pano Row, Decatur, GA 30030', lat: 33.7592, lng: -84.3074, signals: [{ type: 'TAX_SALE' }] },
  // ~700 m south: well outside the 120 m window.
  { id: 'C', address: '3 Pano Row, Decatur, GA 30030', lat: 33.7519, lng: -84.3074, signals: [{ type: 'DISTRESS' }] },
];

test('only signal properties within 120 m get a pin', () => {
  assert.equal(MARKER_RADIUS_M, 120);
  const markers = panoMarkersFor(HOUSES, { position: { lat: 33.7582, lng: -84.3074 } });
  assert.deepEqual(markers.map((m) => m.id).sort(), ['A', 'B']);
  assert.ok(markers.every((m) => m.distanceM <= MARKER_RADIUS_M));
});

test('the top pick is the only gold pin and the only labelled one', () => {
  const markers = panoMarkersFor(HOUSES, {
    position: { lat: 33.7582, lng: -84.3074 },
    topPickId: 'B',
  });
  const gold = markers.filter((m) => m.gold);
  assert.equal(gold.length, 1);
  assert.equal(gold[0].id, 'B');
  assert.equal(markers.filter((m) => m.label).length, 1,
    'a street of labelled pins is a map legend');
  assert.equal(gold[0].label, '2 Pano Row');
  const other = markers.find((m) => m.id === 'A');
  assert.equal(other.gold, false);
  assert.notEqual(other.color, gold[0].color, 'the rest carry their signal colour');
});

test('the nearest pin is drawn last, so it is not behind the ones further off', () => {
  const markers = panoMarkersFor(HOUSES, { position: { lat: 33.7582, lng: -84.3074 } });
  for (let i = 1; i < markers.length; i += 1) {
    assert.ok(markers[i].distanceM <= markers[i - 1].distanceM);
  }
});

test('a fix with no position produces no pins rather than throwing', () => {
  assert.deepEqual(panoMarkersFor(HOUSES, { position: null }), []);
  assert.deepEqual(panoMarkersFor(null, { position: { lat: 33.75, lng: -84.3 } }), []);
});

// ---------------------------------------------------------------------------
// The leash on the picture
// ---------------------------------------------------------------------------

test('the queue stops reaching once the picture has run ahead of the road', () => {
  /**
   * A regular rhythm and a picture on the right street are in genuine conflict
   * whenever the drive slows below what Street View's own spacing supports: the
   * nearest panorama 6 m ahead is the one already on screen, the queue rejects
   * the duplicate and nudges forward, and the picture gains ~4 m on the road
   * every hop regardless. Measured over 33 hops at the default speed before
   * this bound existed: the picture 74 m ahead — three or four houses, with the
   * pins describing a stretch of street already out of frame.
   */
  assert.equal(queueMayReach(10, 6.2), true);
  assert.equal(queueMayReach(25, 6.2), true);
  assert.equal(queueMayReach(26, 6.2), false);
  // In spacings as well as metres: at 4x one hop is legitimately 11.8 m, and a
  // flat 25 m bound would stop the queue after two of them.
  assert.equal(queueMayReach(28, 11.8), true, 'a fast drive may reach further');
  assert.equal(queueMayReach(30, 11.8), false);
  // A picture that is behind the road is never the thing being restrained.
  assert.equal(queueMayReach(-40, 6.2), true);
  assert.equal(queueMayReach(NaN, 6.2), true);
});
