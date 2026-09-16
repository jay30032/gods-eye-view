#!/usr/bin/env node
/**
 * Headed check for the choreographed moments.
 *
 * Runs FIND_MONEY, LOOK_CLOSER and SAVE at the six-house scene and asks three
 * things of each:
 *
 *   1. it ran to its end — the sequencer's history shows it uncancelled, and
 *      its event log fires in the designed order at the designed offsets
 *      (ignitions 80 ms apart, the beacon up 500 ms after the gold pick);
 *   2. the sounds it asked for were scheduled (the engine is unlocked by hand
 *      because a synthetic submit is not a user gesture);
 *   3. the frame time held through it — the same one-dropped-vsync budget the
 *      six-house check uses.
 *
 * And it captures a frame every 200 ms of each moment into `/tmp/shots/seq-*`
 * plus a contact strip per moment. The capture is a CDP screencast — frames
 * come off the compositor rather than through `page.screenshot`, which stalls
 * the renderer for hundreds of milliseconds per shot. It still costs something,
 * so `--no-capture` runs the same check with the screencast off for a clean
 * frame-time number; report both.
 *
 *   node scripts/investor-sequences.mjs [--url u] [--shots dir] [--no-capture]
 */
import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--')
    ? process.argv[i + 1]
    : fallback;
}
const HAS = (name) => process.argv.includes(`--${name}`);

const URL_ARG = arg('url', 'http://localhost:4173/?scene=six');
const SHOT_DIR = arg('shots', '/tmp/shots');
const CAPTURE = !HAS('no-capture');
const LABEL = arg('label', CAPTURE ? 'sequences' : 'sequences-clean');
const FRAME_EVERY_MS = 200;
const SIX_FRAME_P95_BUDGET_MS = 33;
const FRAME_CAP_TOLERANCE = 1.12;
/** How far an offset may drift from its design on a busy render thread. */
const TIMING_TOLERANCE_MS = 45;
/** The designed FIND_MONEY offsets, mirrored here so a drift is a failure. */
const DESIGN = { igniteStartAt: 600, igniteGapMs: 80, goldAfterLastIgniteMs: 80, beaconRiseMs: 500 };

function frameBudgetFor(targetFrameRate) {
  const interval = Number.isFinite(targetFrameRate) && targetFrameRate > 0 ? 1000 / targetFrameRate : 1000 / 30;
  return Math.max(SIX_FRAME_P95_BUDGET_MS, interval * 2) * FRAME_CAP_TOLERANCE;
}

function frameStats(frames, window) {
  if (!window || !frames.length) return null;
  const [start, end] = window;
  const rows = frames.filter(([stamp]) => stamp >= start && stamp <= end);
  const gaps = rows.map(([, gap]) => gap).sort((a, b) => a - b);
  if (gaps.length < 5) return null;
  const at = (q) => gaps[Math.min(gaps.length - 1, Math.floor(q * gaps.length))];
  return { n: gaps.length, p50: at(0.5), p95: at(0.95), worst: gaps.at(-1), seconds: Math.round((end - start) / 100) / 10 };
}

const log = [];
const started = Date.now();
const record = (line) => log.push(`[${String(Date.now() - started).padStart(6)}ms] ${line}`);

async function main() {
  mkdirSync(SHOT_DIR, { recursive: true });
  const browser = await chromium.launch({ channel: 'chrome', headless: false });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  const errors = [];
  page.on('console', (msg) => {
    if (msg.type() !== 'error') return;
    errors.push(msg.text().slice(0, 300));
    record(`CONSOLE ERROR ${msg.text().slice(0, 300)}`);
  });
  page.on('pageerror', (error) => {
    errors.push(String(error?.message || error).slice(0, 300));
    record(`PAGEERROR ${String(error?.message || error).slice(0, 300)}`);
  });

  await page.addInitScript(() => {
    window.__probeFrames = [];
    let previous = performance.now();
    const tick = (stamp) => {
      window.__probeFrames.push([Math.round(stamp), Math.round((stamp - previous) * 100) / 100]);
      previous = stamp;
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });

  // ---- screencast --------------------------------------------------------
  const cdp = await context.newCDPSession(page);
  const captured = [];
  let capturing = false;
  cdp.on('Page.screencastFrame', async (event) => {
    if (capturing) captured.push({ epochMs: event.metadata.timestamp * 1000, data: event.data });
    try { await cdp.send('Page.screencastFrameAck', { sessionId: event.sessionId }); } catch { /* stopped */ }
  });
  const startCapture = async () => {
    if (!CAPTURE) return;
    capturing = true;
    await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 72, maxWidth: 720, maxHeight: 450, everyNthFrame: 1 });
  };
  const stopCapture = async () => {
    if (!CAPTURE) return;
    capturing = false;
    try { await cdp.send('Page.stopScreencast'); } catch { /* fine */ }
  };

  record(`=== ${LABEL} :: ${URL_ARG} :: capture ${CAPTURE} ===`);
  await page.goto(URL_ARG, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  const timeOrigin = await page.evaluate(() => performance.timeOrigin);
  const pageNow = () => page.evaluate(() => performance.now()).catch(() => null);
  const cameraState = () => page.evaluate(() => ({
    shot: window.__terraSignal?.camera?.shot ?? null,
    flying: window.__terraSignal?.camera?.flying ?? false,
  })).catch(() => ({ shot: null, flying: false }));
  const waitForShot = async (name, timeoutMs) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const state = await cameraState();
      if (state.shot === name && !state.flying) return true;
      await new Promise((r) => setTimeout(r, 120));
    }
    return false;
  };
  const history = () => page.evaluate(() => window.__terraSignal?.sequences?.history ?? []).catch(() => []);
  const waitForSequence = async (name, { after = 0, timeoutMs = 30_000 } = {}) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const rows = await history();
      const hit = rows.find((row) => row.name === name && row.startedAt >= after && row.endedAt != null);
      if (hit) return hit;
      await new Promise((r) => setTimeout(r, 100));
    }
    return null;
  };
  const sendPhrase = (text) => page.evaluate((phrase) => {
    const input = document.getElementById('ts-demo-input');
    const form = document.getElementById('ts-demo-form');
    if (input && form) {
      input.value = phrase;
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      return 'typed-bar';
    }
    window.__terraSignal?.handleIntent?.(phrase);
    return 'handleIntent';
  }, text).catch((e) => `ERROR ${String(e.message).slice(0, 60)}`);
  const audioState = () => page.evaluate(() => {
    const audio = window.__terraSignal?.audio;
    return audio ? { enabled: audio.enabled, unlocked: audio.unlocked, plays: audio.plays, played: audio.played.map((p) => p.name) } : null;
  }).catch(() => null);
  const uiState = () => page.evaluate(() => {
    const session = window.__terraSignal;
    const strip = document.getElementById('ts-ai-prompt');
    const slot = document.getElementById('ts-ai-slot');
    return {
      card: session?.card ?? null,
      strip: (strip?.textContent || '').trim(),
      orb: slot?.dataset?.tsOrb ?? null,
      focusedId: session?.focused?.id ?? null,
      topPickId: session?.conversation?.topPickId ?? null,
      typedBarVisible: document.body.classList.contains('ts-typing'),
      navButtonsShown: [...document.querySelectorAll('#ts-bottom-nav > button[data-ts-nav]')]
        .filter((b) => getComputedStyle(b).display !== 'none').length,
      demoRailShown: (() => { const rail = document.getElementById('ts-demo-script'); return Boolean(rail && !rail.hidden && getComputedStyle(rail).display !== 'none'); })(),
      brandFlyoutHidden: (() => { const f = document.querySelector('.ts-brand-flyout'); return f ? Number(getComputedStyle(f).opacity) === 0 : null; })(),
      product: document.body.classList.contains('ts-product'),
    };
  }).catch(() => null);

  const cruised = await waitForShot('CRUISE', 45_000);
  record(`CRUISE settled ${cruised}`);
  await new Promise((r) => setTimeout(r, 2_000));
  // A synthetic submit is not a gesture; unlock the engine so plays are logged.
  await page.evaluate(() => window.__terraSignal?.audio?.unlock?.()).catch(() => {});
  const furniture = await uiState();
  record(`FURNITURE ${JSON.stringify(furniture)}`);

  const windows = {};
  const logs = {};
  const checks = {};

  // ---- FIND_MONEY, then the chained LOOK_CLOSER ---------------------------
  await startCapture();
  const t0 = await pageNow();
  const sent = await sendPhrase('find me money');
  record(`FIND_MONEY sent via ${sent}`);
  const findMoney = await waitForSequence('FIND_MONEY', { after: t0 - 50, timeoutMs: 30_000 });
  record(`FIND_MONEY ${JSON.stringify({ ...findMoney, log: undefined })}`);
  if (findMoney) {
    windows.findMoney = [findMoney.startedAt, findMoney.endedAt];
    logs.findMoney = findMoney.log || [];
  }
  const lookCloser = await waitForSequence('LOOK_CLOSER', { after: t0, timeoutMs: 40_000 });
  record(`LOOK_CLOSER ${JSON.stringify({ ...lookCloser, log: undefined })}`);
  if (lookCloser) {
    windows.lookCloser = [lookCloser.startedAt, lookCloser.endedAt];
    logs.lookCloser = lookCloser.log || [];
  }
  checks.afterLookCloser = await uiState();
  record(`UI after LOOK_CLOSER ${JSON.stringify(checks.afterLookCloser)}`);

  // ---- SAVE ----------------------------------------------------------------
  const t1 = await pageNow();
  await sendPhrase('save it');
  const save = await waitForSequence('SAVE', { after: t1 - 50, timeoutMs: 15_000 });
  record(`SAVE ${JSON.stringify({ ...save, log: undefined })}`);
  if (save) {
    windows.save = [save.startedAt, save.endedAt];
    logs.save = save.log || [];
  }
  await new Promise((r) => setTimeout(r, 800));
  checks.afterSave = await uiState();
  checks.audio = await audioState();
  record(`UI after SAVE ${JSON.stringify(checks.afterSave)}`);
  record(`AUDIO ${JSON.stringify(checks.audio)}`);
  await stopCapture();

  const frames = await page.evaluate(() => window.__probeFrames || []).catch(() => []);
  const targetFrameRate = await page.evaluate(() => window.__godsEyeView?.viewer?.targetFrameRate ?? null).catch(() => null);
  await browser.close();

  // ---- frames to disk ------------------------------------------------------
  const strips = {};
  if (CAPTURE) {
    for (const [key, window] of Object.entries(windows)) {
      const name = { findMoney: 'find-money', lookCloser: 'look-closer', save: 'save' }[key];
      const [start, end] = window;
      const inWindow = captured
        .map((row) => ({ ...row, pageMs: row.epochMs - timeOrigin }))
        .filter((row) => row.pageMs >= start - 30 && row.pageMs <= end + 250)
        .sort((a, b) => a.pageMs - b.pageMs);
      const picked = [];
      let last = -Infinity;
      for (const row of inWindow) {
        if (row.pageMs - last >= FRAME_EVERY_MS - 8) { picked.push(row); last = row.pageMs; }
      }
      const files = [];
      const tiles = [];
      for (let i = 0; i < picked.length; i += 1) {
        const file = join(SHOT_DIR, `seq-${name}-${String(i).padStart(3, '0')}.png`);
        const buffer = Buffer.from(picked[i].data, 'base64');
        const png = await sharp(buffer).png().toBuffer();
        writeFileSync(file, png);
        files.push(file);
        tiles.push(png);
      }
      // A contact strip: up to 8 per row, labelled by time into the moment.
      if (tiles.length) {
        const meta = await sharp(tiles[0]).metadata();
        const w = meta.width; const h = meta.height;
        const cols = Math.min(8, tiles.length);
        const rows = Math.ceil(tiles.length / cols);
        const composites = [];
        for (let i = 0; i < tiles.length; i += 1) {
          const ms = Math.round(picked[i].pageMs - start);
          const label = Buffer.from(`<svg width="${w}" height="${h}"><rect x="4" y="4" width="74" height="20" rx="4" fill="rgba(0,0,0,0.6)"/><text x="10" y="19" font-family="Helvetica" font-size="13" fill="#e0b84a">+${ms} ms</text></svg>`);
          const tile = await sharp(tiles[i]).composite([{ input: label, top: 0, left: 0 }]).png().toBuffer();
          composites.push({ input: tile, left: (i % cols) * w, top: Math.floor(i / cols) * h });
        }
        const stripFile = join(SHOT_DIR, `seq-${name}-strip.png`);
        await sharp({ create: { width: cols * w, height: rows * h, channels: 3, background: '#000' } })
          .composite(composites).png().toFile(stripFile);
        strips[key] = { file: stripFile, frames: files.length, spanMs: Math.round(end - start) };
      } else {
        strips[key] = { file: null, frames: 0, spanMs: Math.round(end - start) };
      }
    }
  }

  // ---- verdict -------------------------------------------------------------
  const budget = frameBudgetFor(targetFrameRate);
  const stats = Object.fromEntries(Object.entries(windows).map(([k, w]) => [k, frameStats(frames, w)]));
  const ranOk = Boolean(findMoney && !findMoney.cancelled && lookCloser && !lookCloser.cancelled && save && !save.cancelled);

  const ids = (rows) => rows.filter((row) => row.id !== 'sound').map((row) => row.id);
  const fmIds = ids(logs.findMoney || []);
  const expectedFm = ['scan', ...fmIds.filter((id) => id === 'ignite'), 'gold', 'beaconRise', 'beaconUp', 'flight', 'speak', 'dive'];
  const fmOrderOk = JSON.stringify(fmIds) === JSON.stringify(expectedFm) && fmIds.filter((id) => id === 'ignite').length >= 1;
  const ignitions = (logs.findMoney || []).filter((row) => row.id === 'ignite');
  const gold = (logs.findMoney || []).find((row) => row.id === 'gold');
  const beaconUp = (logs.findMoney || []).find((row) => row.id === 'beaconUp');
  const gaps = ignitions.slice(1).map((row, i) => row.firedMs - ignitions[i].firedMs);
  const firstDrift = ignitions[0] ? Math.abs(ignitions[0].firedMs - DESIGN.igniteStartAt) : null;
  const gapDrift = gaps.length ? Math.max(...gaps.map((g) => Math.abs(g - DESIGN.igniteGapMs))) : 0;
  const goldDrift = gold && ignitions.length
    ? Math.abs((gold.firedMs - ignitions.at(-1).firedMs) - DESIGN.goldAfterLastIgniteMs) : null;
  const beaconDrift = gold && beaconUp ? Math.abs((beaconUp.firedMs - gold.firedMs) - DESIGN.beaconRiseMs) : null;
  const fmTimingOk = [firstDrift, gapDrift, goldDrift, beaconDrift]
    .every((d) => d != null && d <= TIMING_TOLERANCE_MS);
  // The brief is spoken after the flight, never before.
  const flightRow = (logs.findMoney || []).find((row) => row.id === 'flight');
  const speakRow = (logs.findMoney || []).find((row) => row.id === 'speak');
  const briefAfterFlightOk = Boolean(flightRow && speakRow && speakRow.firedMs > flightRow.firedMs + 500);

  const lcIds = ids(logs.lookCloser || []);
  const lcOrderOk = JSON.stringify(lcIds) === JSON.stringify(['speak', 'flight', 'xray', 'card', 'orbit', 'explain', 'revealAll']);
  const card = checks.afterLookCloser?.card;
  const cardOk = Boolean(card && card.visible && card.lines > 0 && card.revealed.length === card.lines
    && !card.sheet && ['right', 'left', 'above', 'below'].includes(card.side));

  const saveIds = ids(logs.save || []);
  const saveOrderOk = JSON.stringify(saveIds) === JSON.stringify(['saved', 'drop', 'card']);
  const saveTone = (logs.save || []).find((row) => row.sound === 'saveConfirm');
  const saveTimingOk = Boolean(saveTone && Math.abs(saveTone.firedMs - 300) <= TIMING_TOLERANCE_MS);

  const played = new Set(checks.audio?.played || []);
  const soundsOk = ['scanSweep', 'houseTick', 'goldChime', 'flightWhoosh', 'xrayHum', 'saveConfirm']
    .every((name) => played.has(name));
  const framesOk = Object.values(stats).every((stat) => stat && stat.p95 <= budget) && Object.keys(stats).length === 3;
  const furnitureOk = Boolean(furniture && furniture.product && furniture.navButtonsShown === 0
    && !furniture.demoRailShown && !furniture.typedBarVisible && furniture.brandFlyoutHidden === true);
  const errorsOk = errors.length === 0;
  const pass = ranOk && fmOrderOk && fmTimingOk && briefAfterFlightOk && lcOrderOk && cardOk
    && saveOrderOk && saveTimingOk && soundsOk && framesOk && furnitureOk && errorsOk;

  const line = (ok, label, detail) => `  ${ok ? 'PASS' : 'FAIL'}  ${label.padEnd(18)} ${detail}`;
  const out = [
    '',
    '='.repeat(74),
    `SEQUENCES ${pass ? 'PASS' : 'FAIL'} :: ${LABEL} :: ${URL_ARG}${CAPTURE ? '' : ' (no capture)'}`,
    '='.repeat(74),
    line(ranOk, 'three moments', `FIND_MONEY ${findMoney ? (findMoney.cancelled ? 'CANCELLED' : `${Math.round(findMoney.endedAt - findMoney.startedAt)} ms`) : 'MISSING'}`
      + ` · LOOK_CLOSER ${lookCloser ? (lookCloser.cancelled ? 'CANCELLED' : `${Math.round(lookCloser.endedAt - lookCloser.startedAt)} ms`) : 'MISSING'}`
      + ` · SAVE ${save ? (save.cancelled ? 'CANCELLED' : `${Math.round(save.endedAt - save.startedAt)} ms`) : 'MISSING'}`),
    line(fmOrderOk, 'FIND_MONEY order', fmIds.join(' → ') || 'no log'),
    line(fmTimingOk, 'FIND_MONEY timing', `first ignition ${ignitions[0] ? Math.round(ignitions[0].firedMs) : '?'} ms (design ${DESIGN.igniteStartAt})`
      + ` · gaps ${gaps.map((g) => Math.round(g)).join('/') || '-'} ms (design ${DESIGN.igniteGapMs})`
      + ` · gold +${goldDrift == null ? '?' : Math.round(gold.firedMs - ignitions.at(-1).firedMs)} ms · beacon up +${beaconUp && gold ? Math.round(beaconUp.firedMs - gold.firedMs) : '?'} ms (design ${DESIGN.beaconRiseMs}) · tolerance ${TIMING_TOLERANCE_MS} ms`),
    line(briefAfterFlightOk, 'brief on landing', `flight at ${flightRow ? Math.round(flightRow.firedMs) : '?'} ms, brief at ${speakRow ? Math.round(speakRow.firedMs) : '?'} ms`),
    line(lcOrderOk, 'LOOK_CLOSER order', lcIds.join(' → ') || 'no log'),
    line(cardOk, 'card assembled', card ? `${card.revealed.length}/${card.lines} lines · side ${card.side} · sheet ${card.sheet} · at ${card.left},${card.top}` : 'no card'),
    line(saveOrderOk && saveTimingOk, 'SAVE', `${saveIds.join(' → ') || 'no log'} · tone at ${saveTone ? Math.round(saveTone.firedMs) : '?'} ms (design 300)`),
    line(soundsOk, 'sound palette', `${checks.audio?.plays ?? 0} plays: ${[...played].join(', ') || 'none'}`),
    line(furnitureOk, 'furniture', furniture ? `product ${furniture.product} · nav buttons ${furniture.navButtonsShown} · rail ${furniture.demoRailShown} · typed bar ${furniture.typedBarVisible} · legend hidden ${furniture.brandFlyoutHidden}` : 'no data'),
    line(framesOk, 'frame time p95', Object.entries(stats).map(([k, s]) => `${k} ${s ? `${s.p95}ms` : 'no data'}`).join(' · ')
      + ` (budget ${budget.toFixed(1)}ms — viewer capped at ${targetFrameRate} fps${CAPTURE ? ', screencast on' : ''})`),
    line(errorsOk, 'console errors', String(errors.length)),
    '='.repeat(74),
  ];
  for (const [key, stat] of Object.entries(stats)) {
    out.push(stat
      ? `  frames ${key}: n=${stat.n} over ${stat.seconds}s  p50 ${stat.p50}ms  p95 ${stat.p95}ms  worst ${stat.worst}ms`
      : `  frames ${key}: no data`);
  }
  for (const [key, strip] of Object.entries(strips)) {
    out.push(`  strip ${key}: ${strip.frames} frames every ${FRAME_EVERY_MS} ms over ${strip.spanMs} ms → ${strip.file}`);
  }
  out.push(`  strip after LOOK_CLOSER: "${checks.afterLookCloser?.strip ?? ''}"`);
  out.push(`  orb after SAVE: ${checks.afterSave?.orb ?? '?'} · saved card lines ${checks.afterSave?.card?.revealed?.length ?? '?'}/${checks.afterSave?.card?.lines ?? '?'}`);
  for (const e of errors.slice(0, 6)) out.push(`  [error] ${e}`);
  console.log(out.join('\n'));
  writeFileSync(join(SHOT_DIR, `${LABEL}.log`), log.join('\n') + '\n');
  process.exit(pass ? 0 : 1);
}

main().catch((error) => {
  console.error(`SEQUENCES FAIL :: ${LABEL} :: ${error.stack || error.message}`);
  process.exit(1);
});
