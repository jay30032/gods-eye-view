import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  applyInvestorFrameBudget,
  INVESTOR_DEMO_FPS,
  INVESTOR_PLUGGED_FPS,
  resolveInvestorTargetFrameRate,
} from './frameBudget.js';

const here = dirname(fileURLToPath(import.meta.url));

test('investor demo defaults to 30 fps when power state is unknown', () => {
  assert.equal(resolveInvestorTargetFrameRate({}), INVESTOR_DEMO_FPS);
  assert.equal(resolveInvestorTargetFrameRate({ charging: false }), INVESTOR_DEMO_FPS);
  assert.equal(resolveInvestorTargetFrameRate({ saveData: true, charging: true }), INVESTOR_DEMO_FPS);
  assert.equal(resolveInvestorTargetFrameRate({ reducedMotion: true }), INVESTOR_DEMO_FPS);
  assert.equal(resolveInvestorTargetFrameRate({ charging: true }), INVESTOR_PLUGGED_FPS);
});

test('applyInvestorFrameBudget writes targetFrameRate', () => {
  const viewer = { targetFrameRate: 60 };
  assert.equal(applyInvestorFrameBudget(viewer, { charging: false }), 30);
  assert.equal(viewer.targetFrameRate, 30);
});

test('classic GEV keeps a 60 fps cap; investor starts at 30', () => {
  const main = readFileSync(join(here, '../main.js'), 'utf8');
  assert.match(main, /viewer\.targetFrameRate = investorMode \? 30 : 60/);
  assert.match(main, /applyInvestorFrameBudgetFromNavigator/);
  assert.match(main, /msaaSamples: investorMode \? 1 : 4/);
});
