import test from 'node:test';
import assert from 'node:assert/strict';
import { createMockPropertyProvider } from './mock/provider.js';
import { buildDriveRoute, isStrongDriveSignal } from './driveDemo.js';

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
