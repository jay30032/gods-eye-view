import test from 'node:test';
import assert from 'node:assert/strict';
import {
  COUNT_UP_MS,
  SPRING,
  SPRING_OUT,
  countUp,
  countUpValueAt,
  installSpringEasing,
  springAt,
  springLinearEasing,
} from './motion.js';
import {
  ANCHOR_GAP_PX,
  ANCHOR_MARGIN_PX,
  BOTTOM_RESERVE_PX,
  SHEET_MAX_WIDTH_PX,
  anchorCard,
  enterOffset,
  leaderLine,
} from './cardAnchor.js';

test('the spring starts at rest, overshoots a little, and settles at 1', () => {
  assert.equal(springAt(0), 0);
  let peak = 0;
  for (let ms = 0; ms <= SPRING.durationMs; ms += 5) peak = Math.max(peak, springAt(ms / 1000));
  assert.ok(peak > 1.0 && peak < 1.12, `overshoot ${peak.toFixed(3)} should be small but present`);
  assert.ok(Math.abs(springAt(SPRING.durationMs / 1000) - 1) < 0.01, 'settled by the end of the transition');
  // The exit spring is over-damped: no overshoot, gets there faster.
  let outPeak = 0;
  for (let ms = 0; ms <= SPRING_OUT.durationMs; ms += 5) outPeak = Math.max(outPeak, springAt(ms / 1000, SPRING_OUT));
  assert.ok(outPeak <= 1.0 + 1e-6, 'the leave spring must not bounce');
  assert.ok(springAt(SPRING_OUT.durationMs / 1000, SPRING_OUT) > 0.95);
});

test('the sampled linear() easing is a valid curve from 0 to exactly 1', () => {
  const easing = springLinearEasing();
  assert.match(easing, /^linear\(/);
  const stops = easing.slice(7, -1).split(', ').map(Number);
  assert.equal(stops.length, 41);
  assert.equal(stops[0], 0);
  assert.equal(stops.at(-1), 1);
  assert.ok(stops.every((v) => Number.isFinite(v)));
  assert.ok(Math.max(...stops) > 1, 'the overshoot survives sampling');
});

test('installing the springs writes the custom properties, with a cubic-bezier fallback', () => {
  const written = {};
  const root = { style: { setProperty: (k, v) => { written[k] = v; } } };
  const withLinear = installSpringEasing(root, { supports: () => true });
  assert.equal(withLinear.linear, true);
  assert.match(written['--ts-spring'], /^linear\(/);
  assert.equal(written['--ts-spring-ms'], `${SPRING.durationMs}ms`);
  const without = installSpringEasing(root, { supports: () => false });
  assert.equal(without.linear, false);
  assert.match(written['--ts-spring'], /^cubic-bezier/);
  assert.equal(installSpringEasing(null), null);
});

test('a dollar figure counts up over 400 ms, fast first, landing exactly on the number', () => {
  assert.equal(COUNT_UP_MS, 400);
  assert.equal(countUpValueAt(0, 0, 1000), 0);
  assert.equal(countUpValueAt(400, 0, 1000), 1000);
  assert.equal(countUpValueAt(9999, 0, 1000), 1000);
  const half = countUpValueAt(200, 0, 1000);
  assert.ok(half > 800 && half < 900, `ease-out: ${half} at the halfway mark`);
  assert.ok(countUpValueAt(100, 0, 1000) > countUpValueAt(50, 0, 1000));
  // Down works too — a what-if can lower a figure.
  assert.ok(countUpValueAt(200, 1000, 0) < 200);

  // Through the node, on a fake frame loop.
  let t = 0;
  const frames = [];
  const raf = (fn) => frames.push(fn);
  const node = { textContent: '' };
  const seen = [];
  countUp(node, { from: 0, to: 500, format: (v) => `$${Math.round(v)}`, raf, now: () => t });
  assert.equal(node.textContent, '$0');
  while (frames.length) {
    t += 100;
    const fn = frames.shift();
    fn();
    seen.push(node.textContent);
  }
  assert.equal(seen.at(-1), '$500');
  assert.equal(seen.length, 4, 'three frames of motion then the landing');
  // Reduced motion: straight to the number, nothing scheduled.
  const still = { textContent: '' };
  countUp(still, { from: 0, to: 7, format: String, raf, now: () => t, reduced: true });
  assert.equal(still.textContent, '7');
  assert.equal(frames.length, 0);
});

const VIEW = { w: 1440, h: 900 };
const CARD = { w: 352, h: 420 };

test('the card sits to the right of its house, vertically centred on it', () => {
  const at = anchorCard({ marker: { x: 600, y: 450 }, viewport: VIEW, card: CARD });
  assert.equal(at.mode, 'anchored');
  assert.equal(at.side, 'right');
  assert.equal(at.left, 600 + ANCHOR_GAP_PX);
  assert.equal(at.top, 450 - CARD.h / 2);
  // It slides in from the house's direction: leftwards, towards the marker.
  assert.ok(at.from.dx < 0 && Math.abs(at.from.dy) < 2, JSON.stringify(at.from));
});

test('near the right edge the card flips to the left; near the bottom it is clamped above the strip', () => {
  const left = anchorCard({ marker: { x: 1300, y: 450 }, viewport: VIEW, card: CARD });
  assert.equal(left.side, 'left');
  assert.equal(left.left, 1300 - ANCHOR_GAP_PX - CARD.w);
  assert.ok(left.from.dx > 0, 'slides in from the right, where the house is');

  const low = anchorCard({ marker: { x: 600, y: 880 }, viewport: VIEW, card: CARD });
  assert.equal(low.top, VIEW.h - BOTTOM_RESERVE_PX - CARD.h);
  assert.ok(low.top + CARD.h <= VIEW.h - BOTTOM_RESERVE_PX);
  const high = anchorCard({ marker: { x: 600, y: 10 }, viewport: VIEW, card: CARD });
  assert.ok(high.top >= ANCHOR_MARGIN_PX);
  // Every placement is inside the viewport.
  for (const marker of [{ x: -50, y: -50 }, { x: 2000, y: 2000 }, { x: 720, y: 450 }]) {
    const at = anchorCard({ marker, viewport: VIEW, card: CARD });
    assert.ok(at.left >= ANCHOR_MARGIN_PX && at.left + CARD.w <= VIEW.w - ANCHOR_MARGIN_PX, JSON.stringify(at));
    assert.ok(at.top >= 0 && at.top + CARD.h <= VIEW.h, JSON.stringify(at));
  }
});

test('the card never covers its own house', () => {
  // Wide card, marker in the middle: neither side fits, so it goes below and
  // the clamp would pull it over the marker — it has to be pushed off.
  const wide = { w: 1000, h: 300 };
  for (const y of [100, 450, 800]) {
    const at = anchorCard({ marker: { x: 720, y }, viewport: VIEW, card: wide });
    const covers = 720 >= at.left && 720 <= at.left + wide.w && y >= at.top && y <= at.top + wide.h;
    assert.equal(covers, false, `covers the marker at y=${y}: ${JSON.stringify(at)}`);
  }
});

test('on a narrow screen the card is a bottom sheet; with no marker it parks lower right', () => {
  const sheet = anchorCard({ marker: { x: 200, y: 300 }, viewport: { w: SHEET_MAX_WIDTH_PX - 1, h: 800 }, card: CARD });
  assert.equal(sheet.mode, 'sheet');
  assert.equal(sheet.from.dy > 0, true, 'a sheet rises from the bottom');
  const parked = anchorCard({ marker: null, viewport: VIEW, card: CARD });
  assert.equal(parked.side, 'parked');
  assert.equal(parked.left, VIEW.w - ANCHOR_MARGIN_PX - CARD.w);
});

test('enter offset and leader line point at the house', () => {
  const rect = { left: 400, top: 200, w: 300, h: 200 };
  const from = enterOffset({ x: 100, y: 300 }, rect);
  assert.ok(from.dx < 0 && from.dy === 0);
  const line = leaderLine({ x: 100, y: 300 }, rect);
  assert.deepEqual([line.x1, line.y1, line.x2, line.y2], [100, 300, 400, 300]);
  assert.equal(line.length, 300);
  const inside = leaderLine({ x: 450, y: 250 }, rect);
  assert.equal(inside.length, 0);
});
