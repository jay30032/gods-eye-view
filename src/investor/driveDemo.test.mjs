import test from 'node:test';
import assert from 'node:assert/strict';
import { createMockPropertyProvider } from './mock/provider.js';
import {
  DRIVE_VIEWS,
  MODES,
  buildDriveRoute,
  createDriveDemo,
  isStrongDriveSignal,
} from './driveDemo.js';
import { SIX_ROUTE } from './mock/sixRoute.js';
import { DEFAULT_SPEED_MPS } from './drive/positionSource.js';
import { STREET_VIEW_SPEED_MPS } from './drive/streetViewDrive.js';

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

test('"drive" enters the Street View drive by default', async () => {
  const { drive, streetView } = driveFor();
  const result = drive.start();
  assert.equal(result.ok, true);
  assert.equal(drive.view, DRIVE_VIEWS.STREET_VIEW);
  // The mount is async and the drive is not: fixes start arriving immediately,
  // and must not wait on a round trip to maps.googleapis.com.
  assert.equal(drive.panoDriving, false, 'the drive begins before the panorama does');
  await Promise.resolve();
  await Promise.resolve();
  assert.ok(streetView.calls.includes('mount'));
  drive.destroy();
});

test('"drive in 3D" keeps the chase camera and never mounts a panorama', async () => {
  const { drive, streetView } = driveFor();
  drive.start({ view: DRIVE_VIEWS.CHASE });
  assert.equal(drive.view, DRIVE_VIEWS.CHASE);
  await Promise.resolve();
  assert.equal(streetView.calls.includes('mount'), false);
  drive.destroy();
});

test('a live GPS drive is never a panorama', async () => {
  /**
   * The phone is already at the kerb. A panorama of where the driver is
   * standing is a photograph of the view out of their own window, and the
   * overlays are the one thing it cannot show them.
   */
  const { drive, streetView } = driveFor({
    geolocation: { watchPosition: () => 1, clearWatch: () => {} },
  });
  drive.start({ live: true, view: DRIVE_VIEWS.STREET_VIEW });
  assert.equal(drive.view, DRIVE_VIEWS.CHASE, 'live asked for Street View and must not get it');
  await Promise.resolve();
  assert.equal(streetView.calls.includes('mount'), false);
  drive.destroy();
});

test('a Street View drive plays slower than the chase camera', () => {
  // Not a preference: at 9 m/s a 10 m pano step arrives before Google's own
  // transition has finished, and the drive reads as a stutter of half-played
  // dissolves rather than as travel.
  const streetViewDrive = driveFor();
  streetViewDrive.drive.start();
  const svSpeed = streetViewDrive.drive.source.speedMps;
  streetViewDrive.drive.destroy();

  const chaseDrive = driveFor();
  chaseDrive.drive.start({ view: DRIVE_VIEWS.CHASE });
  const chaseSpeed = chaseDrive.drive.source.speedMps;
  chaseDrive.drive.destroy();

  assert.equal(svSpeed, STREET_VIEW_SPEED_MPS);
  assert.equal(chaseSpeed, DEFAULT_SPEED_MPS);
  assert.ok(svSpeed < chaseSpeed);
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
