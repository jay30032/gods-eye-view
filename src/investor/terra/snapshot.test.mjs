import test from 'node:test';
import assert from 'node:assert/strict';
import { createMockPropertyProvider } from '../mock/provider.js';
import { analyzePropertyDeal } from '../deal/index.js';
import { EXCHANGE_LIMIT, boardSummary, buildSnapshot, focusedSummary, snapshotText } from './snapshot.js';
import { ASSISTANT_NAME } from './identity.js';

const provider = createMockPropertyProvider({ dataset: 'six' });
const rows = provider.list();

test('the board summary counts houses, signals and auctions soonest first', () => {
  const board = boardSummary(rows);
  assert.equal(board.houses, 6);
  assert.equal(board.notices, 7);
  assert.equal(board.byType['Notice of Sale Under Power'], 2);
  assert.equal(board.byType['Tax sale (fi. fa.)'], 1);
  assert.equal(board.auctions.length, 3);
  assert.ok(board.auctions.every((a, i, all) => i === 0 || a.daysUntil >= all[i - 1].daysUntil));
  assert.equal(board.auctions[0].daysUntil, 26);
  assert.equal(board.auctions[0].courthouse, 'DeKalb County Courthouse');
});

test('the focused house carries exact numbers, the analysis and the why', () => {
  const house = rows.find((r) => r.id === 'DEMO-SIX-001');
  const analysis = analyzePropertyDeal(house, 'flip');
  const focused = focusedSummary(house, analysis, { saved: true, strategy: 'flip' });
  assert.equal(focused.address, '621 Third Ave');
  assert.equal(focused.value, 432000);
  assert.equal(focused.equityPct, 52);
  assert.equal(focused.purchase, 238000);
  assert.equal(focused.analysis.play, 'flip');
  assert.equal(focused.analysis.works, 'strong');
  assert.equal(focused.underValuePct, 45);
  assert.equal(focused.play, 'flip');
  assert.equal(focused.headline, '$100k profit on $56k cash in');
  assert.equal(focused.analysis.profit, Math.round(analysis.profit));
  assert.equal(focused.analysis.marginPct, 23.3);
  assert.equal(focused.auction.daysUntil, 26);
  assert.ok(focused.why.includes('Notice of Sale Under Power'));
  assert.equal(focused.saved, true);
  assert.equal(focusedSummary(null), null);
  // A different strategy's shape.
  const rental = focusedSummary(house, analyzePropertyDeal(house, 'rental'));
  assert.equal(rental.analysis.play, 'rental');
  assert.ok('dscr' in rental.analysis);
});

test('the snapshot is compact JSON with the shortlist, the camera, the drive and the last three exchanges', () => {
  const exchanges = [1, 2, 3, 4, 5].map((n) => ({ user: `q${n}`, [ASSISTANT_NAME.toLowerCase()]: `a${n}` }));
  const snapshot = buildSnapshot({
    market: { id: 'atlanta', name: 'Atlanta / Decatur', lat: 1 },
    clock: '2026-09-10',
    camera: { shot: 'CRUISE', flying: false, heightM: 900.4 },
    drive: { running: true, alongM: 120.6, lengthM: 1360, current: rows[1], goldId: null, panoStopped: false },
    properties: rows,
    shortlistIds: ['DEMO-SIX-001', 'DEMO-SIX-003', 'missing'],
    topPickId: 'DEMO-SIX-001',
    focused: rows[0],
    analysis: null,
    screen: { card: true, dealVision: 'flip', opportunityVision: true, strip: 'Try: Find me money' },
    exchanges,
    level: 'quiet',
    event: 'descent_settled',
  });
  assert.equal(snapshot.assistant, ASSISTANT_NAME);
  assert.equal(snapshot.event, 'descent_settled');
  assert.deepEqual(snapshot.market, { id: 'atlanta', name: 'Atlanta / Decatur' });
  assert.equal(snapshot.camera.heightM, 900);
  assert.equal(snapshot.camera.view, 'over the market');
  assert.equal('shot' in snapshot.camera, false);
  assert.equal(snapshot.drive.alongM, 121);
  assert.equal(snapshot.drive.current.address, '1344 Oakview Rd');
  assert.equal(snapshot.shortlist.length, 2);
  assert.deepEqual(snapshot.shortlist.map((row) => row.rank), [1, 2]);
  assert.equal(snapshot.gold.id, 'DEMO-SIX-001');
  assert.equal(snapshot.gold.play, 'flip');
  // Nothing in the snapshot invites the app's vocabulary into the reply.
  const keys = new Set();
  JSON.stringify(snapshot, (key, value) => { keys.add(key); return value; });
  for (const banned of ['composite', 'scores', 'bestPath', 'signalCount', 'topPick', 'verdict', 'strategy']) {
    assert.ok(!keys.has(banned), banned);
  }
  assert.equal(snapshot.focused.analysis, null);
  assert.equal(snapshot.narration, 'quiet');
  assert.equal(snapshot.exchanges.length, EXCHANGE_LIMIT);
  assert.equal(snapshot.exchanges[0].user, 'q3');
  const text = snapshotText(snapshot);
  assert.ok(text.length < 4000, `snapshot is ${text.length} chars`);
  assert.deepEqual(JSON.parse(text), snapshot);
});

test('an empty session still snapshots', () => {
  const snapshot = buildSnapshot({});
  assert.equal(snapshot.focused, null);
  assert.equal(snapshot.board.houses, 0);
  assert.equal(snapshot.drive.running, false);
  assert.deepEqual(snapshot.exchanges, []);
});
