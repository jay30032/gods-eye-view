import test from 'node:test';
import assert from 'node:assert/strict';
import { createMockPropertyProvider } from './mock/provider.js';
import {
  DRIVE_VIEWS,
  MODES,
  buildDriveRoute,
  createDriveDemo,
  isStrongDriveSignal,
  plural,
} from './driveDemo.js';
import { SIX_ROUTE } from './mock/sixRoute.js';
import { DEFAULT_SPEED_MPS } from './drive/positionSource.js';

const NOW = Date.UTC(2026, 8, 10);
const properties = createMockPropertyProvider({ now: NOW }).list();

function row(overrides) {
  return {
    id: 'MOCK-DRIVE',
    address: '1 Drive Ln, Decatur, GA 30030',
    estimatedValue: 300000,
    estimatedEquityPct: 0.3,
    deal: { purchase: 200000, rehab: 20000, arv: 300000, rent: 2000 },
    ...overrides,
  };
}

test('a strong drive stop is a high composite or a clock already running', () => {
  assert.equal(isStrongDriveSignal(row({
    composite: 86,
    signals: [{ type: 'DISTRESS', confidence: 0.4, effectiveDate: '2026-09-01', source: 'MOCK/x' }],
  })), true);
  assert.equal(isStrongDriveSignal(row({
    composite: 85,
    signals: [{ type: 'DISTRESS', confidence: 0.4, effectiveDate: '2026-09-01', source: 'MOCK/x' }],
  })), false);
  assert.equal(isStrongDriveSignal(row({
    composite: 10,
    signals: [{ type: 'FORECLOSURE', confidence: 0.78, effectiveDate: '2026-09-01', source: 'MOCK/x' }],
  })), true);
  assert.equal(isStrongDriveSignal(row({
    composite: 10,
    signals: [{ type: 'FORECLOSURE', confidence: 0.77, effectiveDate: '2026-09-01', source: 'MOCK/x' }],
  })), false);
  assert.equal(isStrongDriveSignal(row({
    composite: 10,
    signals: [{ type: 'TAX_SALE', confidence: 0.9, effectiveDate: '2026-09-01', source: 'MOCK/x' }],
  })), true);
  // A merely-listed house never earns a detour on confidence alone.
  assert.equal(isStrongDriveSignal(row({
    composite: 10,
    signals: [{ type: 'LISTED_OPPORTUNITY', confidence: 0.99, effectiveDate: '2026-09-01', source: 'MOCK/x' }],
  })), false);
});

test('the mock route is strong stops only, ranked by composite, capped at eight', () => {
  const route = buildDriveRoute(properties);
  assert.ok(route.length > 0);
  assert.ok(route.length <= 8);
  assert.ok(route.every(isStrongDriveSignal));
  for (let i = 1; i < route.length; i += 1) {
    assert.ok(route[i - 1].composite >= route[i].composite);
  }
});

// ---------------------------------------------------------------------------
// Drive Mode v2: which view drives
// ---------------------------------------------------------------------------

/** A Street View drive that never touches a network or a DOM. */
function stubStreetView() {
  const calls = [];
  return {
    calls,
    panoId: null,
    stats: { requests: 0, hits: 0, panoCount: 0, uniquePanos: 0, missedM: 0, mode: 'streetview' },
    failure: null,
    markers: [],
    reset() { calls.push('reset'); },
    mount() { calls.push('mount'); return Promise.resolve({ ok: true }); },
    update() { calls.push('update'); return null; },
    reseat() { calls.push('reseat'); },
    settle() { calls.push('settle'); return true; },
    ready: false,
    showAt() { calls.push('showAt'); return Promise.resolve({ ok: true, panoId: 'p1' }); },
    clearMarkers() { calls.push('clearMarkers'); },
    setVisible() {},
  };
}

function driveFor(options = {}) {
  const rows = createMockPropertyProvider({ now: NOW, dataset: 'six' }).list();
  const streetView = stubStreetView();
  const drive = createDriveDemo({
    getProperties: () => rows,
    onAnnounce: () => {},
    onStop: () => {},
    streetView,
    routeCoordinates: SIX_ROUTE,
    ...options,
  });
  return { drive, streetView };
}

test('the drive is the 3D chase camera, and mounts no panorama', async () => {
  /**
   * Street View was the driving view for one revision. The double-buffered
   * cross-fade made each join between panoramas continuous and could not make
   * the motion continuous, because there is none between two fixed points.
   */
  const { drive, streetView } = driveFor();
  const result = drive.start();
  assert.equal(result.ok, true);
  assert.equal(drive.view, DRIVE_VIEWS.CHASE);
  assert.equal(drive.panoStopped, false);
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(streetView.calls.includes('mount'), false,
    'a drive nobody asks "from the street" on should not load 300 KB of Maps API');
  drive.destroy();
});

test('"drive in 3D" still parses and means what "drive" already does', async () => {
  const { drive, streetView } = driveFor();
  drive.start({ view: DRIVE_VIEWS.CHASE });
  assert.equal(drive.view, DRIVE_VIEWS.CHASE);
  await Promise.resolve();
  assert.equal(streetView.calls.includes('mount'), false);
  drive.destroy();
});

test('the panorama is mounted the first time something asks for it, once', async () => {
  const { drive, streetView } = driveFor();
  drive.start();
  const first = await drive.mountStreetView();
  assert.equal(first.ok, true);
  assert.equal(streetView.calls.filter((c) => c === 'mount').length, 1);
  streetView.ready = true;
  await drive.mountStreetView();
  assert.equal(streetView.calls.filter((c) => c === 'mount').length, 1, 'mounted once, not per question');
  drive.destroy();
});

test('the drive plays at the chase camera speed', () => {
  const { drive } = driveFor();
  drive.start();
  assert.equal(drive.source.speedMps, DEFAULT_SPEED_MPS);
  drive.destroy();
});

test('leaving the road for an answer saves the position and holds it', () => {
  const { drive } = driveFor();
  drive.start({ view: DRIVE_VIEWS.CHASE });
  drive.tick(1);
  drive.tick(1);
  const before = drive.alongM;
  assert.ok(before > 0, 'the drive should have moved');

  const parked = drive.parkForAnswer();
  assert.equal(parked.alongM, before);
  assert.equal(drive.mode, MODES.PROPERTY);
  // Paused: the whole point of a saved position is that nothing moves past it.
  drive.tick(1);
  drive.tick(1);
  assert.equal(drive.alongM, before, 'the drive moved while an answer was on screen');

  drive.resumeFromAnswer(parked);
  assert.equal(drive.mode, MODES.DRIVE);
  assert.ok(Math.abs(drive.alongM - before) < 1, 'came back to a different metre of road');
  drive.destroy();
});

test('coming back from an answer re-seats the panorama rather than waiting a step', () => {
  // Otherwise the first thing the user sees on returning is the pano they left
  // from, held until the drive has covered another 10 m.
  const { drive, streetView } = driveFor();
  drive.start();
  const parked = drive.parkForAnswer();
  streetView.calls.length = 0;
  drive.resumeFromAnswer(parked);
  assert.ok(streetView.calls.includes('reseat'));
  drive.destroy();
});

test('"1 flagged properties" is not a sentence anyone should hear', () => {
  const rows = createMockPropertyProvider({ now: NOW, dataset: 'six' }).list();
  const drive = createDriveDemo({
    getProperties: () => [rows[0]],
    onAnnounce: () => {},
    onStop: () => {},
    streetView: stubStreetView(),
    routeCoordinates: SIX_ROUTE,
  });
  const single = drive.start({ view: DRIVE_VIEWS.CHASE });
  assert.match(single.spoken, /\b1 flagged property\b/);
  assert.doesNotMatch(single.spoken, /1 flagged properties/);
  drive.destroy();

  const many = driveFor().drive;
  const all = many.start({ view: DRIVE_VIEWS.CHASE });
  assert.match(all.spoken, /\b6 flagged properties\b/);
  many.destroy();
});

test('plural counts by the number, not by whether there is a list', () => {
  assert.equal(plural(0, 'house', 'houses'), '0 houses');
  assert.equal(plural(1, 'house', 'houses'), '1 house');
  assert.equal(plural(2, 'house', 'houses'), '2 houses');
});

test('a pause settles a cross-fade rather than freezing it half way', () => {
  // The hop advances on fixes and a paused source emits none, so a pause
  // landing mid-fade would leave both buffers at half opacity.
  const { drive, streetView } = driveFor();
  drive.start({ view: DRIVE_VIEWS.CHASE });
  streetView.calls.length = 0;
  drive.pause();
  assert.ok(streetView.calls.includes('settle'));
  drive.destroy();
});
