import test from 'node:test';
import assert from 'node:assert/strict';
import { createCameraDirector } from './director.js';
import { DURATIONS, HERO, heroShot } from './shots.js';
import { resolveMarket } from '../markets.js';
import { ATLANTA_DECATUR_PROPERTIES } from '../mock/atlantaDecatur.js';
import { _resetRenderGovernorForTest, getRenderGovernorDiagnostics } from '../../renderGovernor.js';

const market = resolveMarket('atlanta');
const houses = ATLANTA_DECATUR_PROPERTIES;

/** Enough Cesium to exercise the director without a browser. */
function makeCesium() {
  const handlers = [];
  return {
    Cartesian3: { fromDegrees: (lng, lat, h) => ({ lng, lat, h }) },
    Cartographic: { fromCartesian: (p) => ({ height: p?.h ?? 0 }) },
    Math: { toRadians: (deg) => (deg * Math.PI) / 180 },
    EasingFunction: { CUBIC_IN_OUT: 'CUBIC_IN_OUT', LINEAR_NONE: 'LINEAR_NONE' },
    HeadingPitchRange: class { constructor(h, p, r) { Object.assign(this, { h, p, r }); } },
    Matrix4: { IDENTITY: 'IDENTITY' },
    ScreenSpaceEventType: {
      LEFT_DOWN: 1, RIGHT_DOWN: 2, MIDDLE_DOWN: 3, WHEEL: 4, PINCH_START: 5,
    },
    ScreenSpaceEventHandler: class {
      constructor() {
        this.actions = new Map();
        this.destroyed = false;
        handlers.push(this);
      }

      setInputAction(fn, type) { this.actions.set(type, fn); }

      destroy() { this.destroyed = true; }
    },
    /** Every handler the director built, so tests can fire real input. */
    handlers,
  };
}

function makeViewer() {
  const flights = [];
  const postRenderListeners = [];
  const viewer = {
    flights,
    setViews: [],
    lookAts: [],
    lookAtTransforms: [],
    camera: {
      positionWC: { h: 1200 },
      flyTo(options) {
        flights.push({ options, settled: false });
      },
      cancelFlight() {
        const pending = flights.filter((f) => !f.settled);
        for (const flight of pending) {
          flight.settled = true;
          flight.options.cancel?.();
        }
      },
      setView(options) { viewer.setViews.push(options); },
      lookAt(centre, hpr) { viewer.lookAts.push({ centre, hpr }); },
      lookAtTransform(matrix) { viewer.lookAtTransforms.push(matrix); },
    },
    scene: {
      canvas: {},
      postRender: {
        addEventListener(fn) {
          postRenderListeners.push(fn);
          return () => {
            const i = postRenderListeners.indexOf(fn);
            if (i >= 0) postRenderListeners.splice(i, 1);
          };
        },
      },
    },
    tick() { for (const fn of [...postRenderListeners]) fn(); },
    get postRenderCount() { return postRenderListeners.length; },
    /** Land the newest in-flight move. */
    complete() {
      const flight = flights.find((f) => !f.settled);
      if (!flight) return false;
      flight.settled = true;
      flight.options.complete?.();
      return true;
    },
    get inFlight() { return flights.filter((f) => !f.settled).length; },
  };
  return viewer;
}

function makeDirector({ reduced = false } = {}) {
  _resetRenderGovernorForTest();
  const viewer = makeViewer();
  const Cesium = makeCesium();
  // A controlled clock: real frames are ~16ms apart, but two synchronous ticks
  // in a test land in the same millisecond and would show zero rotation.
  const clock = { ms: 0, advance(by) { clock.ms += by; } };
  const director = createCameraDirector({
    viewer, Cesium, market, reducedMotion: () => reduced, now: () => clock.ms,
  });
  return { viewer, Cesium, director, clock };
}

const holds = () => getRenderGovernorDiagnostics().holds;

test('a flight resolves when it lands, and holds the governor while airborne', async () => {
  const { viewer, director } = makeDirector();
  const flight = director.fly('CRUISE');
  assert.equal(viewer.inFlight, 1);
  assert.ok(holds().includes('investor-camera-flight'), 'a flight must keep frames rendering');

  viewer.complete();
  const result = await flight;
  assert.equal(result.cancelled, false);
  assert.equal(result.shot, 'CRUISE');
  assert.equal(holds().includes('investor-camera-flight'), false, 'the hold is released on landing');
  _resetRenderGovernorForTest();
});

test('a new flight cancels the one in progress — never two at once', async () => {
  const { viewer, director } = makeDirector();
  const first = director.fly('CRUISE');
  const second = director.fly('HERO', houses[0]);

  // The old flight is cancelled, not left running alongside the new one.
  assert.equal(viewer.inFlight, 1, 'exactly one flight in the air');
  const firstResult = await first;
  assert.equal(firstResult.cancelled, true, 'a superseded flight resolves, it does not hang');

  viewer.complete();
  assert.equal((await second).cancelled, false);
  assert.equal(holds().includes('investor-camera-flight'), false);
  _resetRenderGovernorForTest();
});

test('a superseded flight never releases the new flight\'s hold', async () => {
  const { viewer, director } = makeDirector();
  const first = director.fly('CRUISE');
  const second = director.fly('REVEAL', houses.slice(0, 4));
  await first;
  assert.ok(holds().includes('investor-camera-flight'), 'the live flight still holds');
  viewer.complete();
  await second;
  assert.equal(holds().includes('investor-camera-flight'), false);
  _resetRenderGovernorForTest();
});

test('every flight eases cubic in-out — nothing is linear', async () => {
  const { viewer, director } = makeDirector();
  for (const [name, target] of [
    ['WORLD', null], ['STAGING', null], ['CRUISE', null],
    ['REVEAL', houses.slice(0, 3)], ['HERO', houses[0]], ['DRIVE', houses[1]],
  ]) {
    const flight = director.fly(name, target);
    const options = viewer.flights.at(-1).options;
    assert.equal(options.easingFunction, 'CUBIC_IN_OUT', `${name} is not eased`);
    assert.ok(options.duration > 0, `${name} has no duration`);
    viewer.complete();
    await flight;
  }
  _resetRenderGovernorForTest();
});

test('durations come from the shot table, not the call site', async () => {
  const { viewer, director } = makeDirector();
  const staging = director.fly('STAGING');
  assert.equal(viewer.flights.at(-1).options.duration, DURATIONS.worldToStaging);
  viewer.complete(); await staging;

  const cruise = director.fly('CRUISE');
  assert.equal(viewer.flights.at(-1).options.duration, DURATIONS.stagingToCruise);
  viewer.complete(); await cruise;

  const reveal = director.fly('REVEAL', houses.slice(0, 4));
  assert.equal(viewer.flights.at(-1).options.duration, DURATIONS.cruiseToReveal);
  viewer.complete(); await reveal;

  const hero = director.fly('HERO', houses[0]);
  assert.equal(viewer.flights.at(-1).options.duration, DURATIONS.toHero);
  viewer.complete(); await hero;

  const back = director.fly('CRUISE');
  assert.equal(viewer.flights.at(-1).options.duration, DURATIONS.heroToCruise);
  viewer.complete(); await back;
  _resetRenderGovernorForTest();
});

test('reduced motion takes the framing and skips the travel', async () => {
  const { viewer, director } = makeDirector({ reduced: true });
  const result = await director.fly('HERO', houses[0]);
  assert.equal(result.reduced, true);
  assert.equal(viewer.flights.length, 0, 'no flight is started');
  assert.equal(viewer.setViews.length, 1, 'the pose is applied instantly');
  assert.equal(holds().includes('investor-camera-flight'), false, 'nothing to hold');
  _resetRenderGovernorForTest();
});

test('a hop rises over the midpoint, then drops into HERO', async () => {
  const { viewer, director } = makeDirector();
  const hop = director.hop(houses[0], houses[1]);

  // First leg: the apex.
  assert.equal(viewer.flights.length, 1);
  assert.equal(viewer.flights[0].options.duration, DURATIONS.hop / 2);
  viewer.complete();
  await Promise.resolve();
  await Promise.resolve();

  // Second leg: down into the hero shot.
  assert.equal(viewer.flights.length, 2, 'the hop is two legs, not a slide');
  viewer.complete();
  const result = await hop;
  assert.equal(result.shot, 'HERO');
  _resetRenderGovernorForTest();
});

test('a hop that is cancelled mid-rise does not continue into the descent', async () => {
  const { viewer, director } = makeDirector();
  const hop = director.hop(houses[0], houses[1]);
  director.cancel();
  const result = await hop;
  assert.equal(result.cancelled, true);
  assert.equal(viewer.flights.length, 1, 'the second leg never starts');
  _resetRenderGovernorForTest();
});

test('the orbit turns the camera and holds the governor', () => {
  const { viewer, director, clock } = makeDirector();
  assert.equal(director.orbit(houses[0]), true);
  assert.equal(director.orbiting, true);
  assert.ok(holds().includes('investor-camera-orbit'));

  clock.advance(16);
  viewer.tick();
  clock.advance(16);
  viewer.tick();
  assert.ok(viewer.setViews.length >= 2, 'each frame re-poses the camera');

  // The orbit re-flies the HERO shot, so the framing it inherits is the framing
  // the flight landed on — same pitch, same range, only the heading moves.
  const framed = heroShot(houses[0]);
  for (const view of viewer.setViews) {
    assert.equal(view.orientation.pitch, (framed.pitchDeg * Math.PI) / 180,
      'the orbit must not snap back to the geometric pitch');
  }
  const first = viewer.setViews[0].orientation.heading;
  const last = viewer.setViews.at(-1).orientation.heading;
  assert.ok(last > first, 'heading advances around the house');
  assert.equal(viewer.lookAts.length, 0, 'lookAt would centre the house and lose the framing');

  director.stopOrbit();
  assert.equal(director.orbiting, false);
  assert.equal(holds().includes('investor-camera-orbit'), false);
  _resetRenderGovernorForTest();
});

test('a drag, a wheel or a pinch hands the camera back to the user', () => {
  for (const input of ['LEFT_DOWN', 'RIGHT_DOWN', 'MIDDLE_DOWN', 'WHEEL', 'PINCH_START']) {
    const { viewer, Cesium, director } = makeDirector();
    director.orbit(houses[0]);
    assert.equal(director.orbiting, true);
    const framesBefore = viewer.postRenderCount;

    const handler = Cesium.handlers.at(-1);
    const fire = handler.actions.get(Cesium.ScreenSpaceEventType[input]);
    assert.ok(fire, `${input} is not wired`);
    fire();

    assert.equal(director.orbiting, false, `${input} should stop the orbit`);
    assert.equal(holds().includes('investor-camera-orbit'), false, `${input} left a hold behind`);
    assert.equal(handler.destroyed, true, `${input} left the handler attached`);
    assert.ok(viewer.postRenderCount < framesBefore, `${input} left the per-frame listener running`);
    _resetRenderGovernorForTest();
  }
});

test('the next command also takes the camera back from an orbit', () => {
  const { director } = makeDirector();
  director.orbit(houses[0]);
  director.fly('CRUISE');
  assert.equal(director.orbiting, false);
  assert.equal(holds().includes('investor-camera-orbit'), false);
  _resetRenderGovernorForTest();
});

test('reduced motion never starts an orbit', () => {
  const { director } = makeDirector({ reduced: true });
  assert.equal(director.orbit(houses[0]), false);
  assert.equal(director.orbiting, false);
  _resetRenderGovernorForTest();
});

test('the director reports the shot it is on', async () => {
  const { viewer, director } = makeDirector();
  assert.equal(director.shot, 'WORLD');
  const flight = director.fly('CRUISE');
  assert.equal(director.shot, 'CRUISE');
  viewer.complete();
  await flight;
  _resetRenderGovernorForTest();
});

test('destroy cancels everything and stops answering', async () => {
  const { viewer, director } = makeDirector();
  director.orbit(houses[0]);
  const flight = director.fly('HERO', houses[0]);
  director.destroy();
  assert.equal((await flight).cancelled, true);
  assert.equal(director.orbiting, false);
  assert.deepEqual(holds(), []);

  const after = await director.fly('CRUISE');
  assert.equal(after.cancelled, true, 'a destroyed director does not fly');
  assert.equal(viewer.inFlight, 0);
  _resetRenderGovernorForTest();
});

test('an unknown shot name is a no-op, not a crash', async () => {
  const { director } = makeDirector();
  const result = await director.fly('NOPE');
  assert.equal(result.cancelled, true);
  _resetRenderGovernorForTest();
});

test('route heading falls back to the hero heading without a leg', () => {
  const { director } = makeDirector();
  assert.equal(director.routeHeading(null, houses[0]), HERO.headingDeg);
  const heading = director.routeHeading(houses[0], houses[1]);
  assert.ok(heading >= 0 && heading < 360);
  _resetRenderGovernorForTest();
});

test('flight listeners see start and settle, so visuals can pause and resume', async () => {
  const { viewer, director } = makeDirector();
  const seen = [];
  const off = director.onFlight((state) => seen.push(state));

  const flight = director.fly('CRUISE');
  assert.deepEqual(seen.map((s) => s.flying), [true], 'takeoff is announced');
  assert.equal(director.flying, true);

  viewer.complete();
  await flight;
  assert.deepEqual(seen.map((s) => s.flying), [true, false], 'settle is announced');
  assert.equal(seen.at(-1).cancelled, false);
  assert.equal(director.flying, false);

  off();
  const second = director.fly('WORLD');
  viewer.complete();
  await second;
  assert.equal(seen.length, 2, 'unsubscribe actually unsubscribes');
  _resetRenderGovernorForTest();
});

test('a superseded flight never announces a settle — visuals must not un-pause mid-move', () => {
  const { director } = makeDirector();
  const seen = [];
  director.onFlight((state) => seen.push(state.flying));

  director.fly('CRUISE');
  director.fly('HERO', houses[0]);
  // takeoff, takeoff — never a false "we have landed" between the two.
  assert.deepEqual(seen, [true, true]);
  _resetRenderGovernorForTest();
});

test('reduced motion still announces a settle so visuals resume', async () => {
  const { director } = makeDirector({ reduced: true });
  const seen = [];
  director.onFlight((state) => seen.push(state));
  await director.fly('HERO', houses[0]);
  assert.deepEqual(seen.map((s) => s.flying), [false], 'no takeoff, but it does settle');
  assert.equal(seen[0].reduced, true);
  _resetRenderGovernorForTest();
});

test('a listener that throws cannot break the flight', async () => {
  const { viewer, director } = makeDirector();
  director.onFlight(() => { throw new Error('listener blew up'); });
  const reached = [];
  director.onFlight((state) => reached.push(state.flying));
  const flight = director.fly('CRUISE');
  viewer.complete();
  assert.equal((await flight).cancelled, false);
  assert.deepEqual(reached, [true, false], 'later listeners still run');
  _resetRenderGovernorForTest();
});

test('the orbit stops itself after one revolution and hands back the GPU', () => {
  const { viewer, director, clock } = makeDirector();
  director.orbit(houses[0]);
  assert.equal(director.orbiting, true);
  assert.ok(holds().includes('investor-camera-orbit'));

  // 2 deg/s for 180s is exactly one lap. Step in frames the stall-cap allows.
  for (let elapsed = 0; elapsed < 200_000 && director.orbiting; elapsed += 200) {
    clock.advance(200);
    viewer.tick();
  }

  assert.equal(director.orbiting, false, 'a parked demo must not orbit forever');
  assert.equal(holds().includes('investor-camera-orbit'), false, 'the hold is released');
  assert.equal(viewer.postRenderCount, 0, 'the per-frame listener is gone');
  _resetRenderGovernorForTest();
});

test('the orbit is still running well before a full revolution', () => {
  const { viewer, director, clock } = makeDirector();
  director.orbit(houses[0]);
  // 60 seconds is a third of a lap.
  for (let elapsed = 0; elapsed < 60_000; elapsed += 200) {
    clock.advance(200);
    viewer.tick();
  }
  assert.equal(director.orbiting, true, 'it should not stop early');
  director.stopOrbit();
  _resetRenderGovernorForTest();
});

test('the tile gate does not defer a flight when nothing is streaming', () => {
  // The fake scene has no globe and no tileset, so the view is trivially
  // settled. A gate that still deferred by a microtask would make takeoff
  // timing depend on the network even when there is no network work to do.
  const { viewer, director } = makeDirector();
  director.fly('HERO', houses[0]);
  assert.equal(viewer.inFlight, 1, 'the first HERO flight starts in this tick');
  assert.equal(director.gates.heroUsed, true, 'the gate was consumed');
  _resetRenderGovernorForTest();
});

test('only the FIRST hero flight pays the gate', async () => {
  const { viewer, director } = makeDirector();
  const first = director.fly('HERO', houses[0]);
  viewer.complete();
  await first;
  assert.equal(director.gates.heroUsed, true);

  // Later hops are already inside loaded tiles.
  const second = director.fly('HERO', houses[1]);
  assert.equal(viewer.inFlight, 1);
  viewer.complete();
  await second;
  _resetRenderGovernorForTest();
});

test('the gates are capped so a slow network delays rather than stalls', () => {
  const { director } = makeDirector();
  assert.equal(director.gates.stagingMs, 2_500);
  assert.equal(director.gates.heroMs, 1_500);
  // The staging gate is the longer one: it is spent at a stationary nadir
  // camera, where waiting costs the viewer nothing.
  assert.ok(director.gates.stagingMs > director.gates.heroMs);
  _resetRenderGovernorForTest();
});

test('awaitTiles resolves even with nothing to listen to', async () => {
  const { director } = makeDirector();
  assert.equal(await director.awaitTiles(50), true);
  _resetRenderGovernorForTest();
});
