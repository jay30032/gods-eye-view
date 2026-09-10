import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeFlip } from './flip.js';

const DEAL = Object.freeze({ purchase: 200000, rehab: 40000, arv: 320000 });

test('flip profit, ROI, and margin are deterministic', () => {
  const result = analyzeFlip(DEAL);
  assert.equal(result.strategy, 'flip');
  assert.equal(result.buyClosing, 4000);
  assert.equal(result.sellClosing, 19200);
  assert.equal(result.holding, 8000);
  assert.equal(result.cashIn, 240000);
  assert.equal(result.allIn, 271200);
  assert.equal(result.profit, 48800);
  assert.equal(result.roi, 0.203333);
  assert.equal(result.margin, 0.1525);
});

test('flip rehab override changes all-in and profit only through the formula', () => {
  const base = analyzeFlip(DEAL);
  const higher = analyzeFlip({ ...DEAL, rehab: 60000 });
  assert.equal(higher.cashIn, 260000);
  assert.equal(higher.profit, base.profit - 20000);
  assert.equal(higher.allIn, base.allIn + 20000);
});

test('flip rejects non-finite inputs', () => {
  assert.throws(() => analyzeFlip({ purchase: 'x', rehab: 1, arv: 1 }), /purchase/);
});
