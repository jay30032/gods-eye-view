#!/usr/bin/env node
/**
 * Headed smoke check for the TerraSignal globe.
 *
 * `npm test` is Node-only: it drives no WebGL, no render loop, and no DOM
 * lifecycle. It stayed fully green while the investor page hard-locked on load
 * and never painted Earth. This is the check that would have caught that.
 *
 * Launches REAL Chrome (channel: 'chrome', headless: false) — the symptoms do
 * not reproduce under SwiftShader — and asserts three things:
 *
 *   1. the canvas centre pixel goes non-black within PAINT_DEADLINE_MS;
 *   2. the page answers a page.evaluate() within RESPOND_BUDGET_MS at the
 *      RESPOND_AT_MS mark (a microtask loop starves evaluate, which is exactly
 *      how the hard-lock presented);
 *   3. no console errors or page errors.
 *
 * Exit code 0 = pass, 1 = fail. Usage:
 *
 *   node scripts/investor-probe.mjs --url <url> [--label x] [--log path]
 *   node scripts/investor-probe.mjs --spawn-keyless   # own server, no Google key
 *   node scripts/investor-probe.mjs --play            # drive the whole demo
 *
 * --play additionally clicks into the market and sends the six acceptance
 * phrases through the typed bar, failing on any scene.renderError, any Cesium
 * error dialog in the DOM, any DeveloperError in the console, or the page going
 * unresponsive. That is the path that surfaced the ellipse-axis race: a bug
 * that only appears once pulses, a gold halo and a saved ring are all animating
 * at once, minutes into a session.
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';

const PAINT_DEADLINE_MS = 8_000;
const RESPOND_AT_MS = 15_000;
const RESPOND_BUDGET_MS = 1_000;
const RUN_MS = 18_000;
// Descent, then six phrases at 4s each, then a tail to let animations run.
const PLAY_RUN_MS = 60_000;
const PIXEL_EVERY_MS = 500;
const KEYLESS_PORT = 4174;

const TILE_HOSTS = ['tile.googleapis.com', 'assets.ion.cesium.com', 'server.arcgisonline.com'];

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--')
    ? process.argv[i + 1]
    : fallback;
}
const HAS = (name) => process.argv.includes(`--${name}`);

const SPAWN_KEYLESS = HAS('spawn-keyless');
const PLAY = HAS('play');
const PLAY_PHRASES = [
  'Find me money',
  'Why?',
  'Show me the deal',
  'Assume rehab is twenty thousand higher',
  'Save it',
  'Compare',
];
const PLAY_GAP_MS = 4_000;
const URL_ARG = arg('url', SPAWN_KEYLESS
  ? `http://localhost:${KEYLESS_PORT}/?demo=1&welcome=1`
  : 'http://localhost:4173/?demo=1&welcome=1');
const LABEL = arg('label', SPAWN_KEYLESS ? 'investor-keyless' : (PLAY ? 'demo' : 'investor'));
const LOG_PATH = arg('log', null);

const log = [];
let started = Date.now();
const record = (line) => log.push(`[${String(Date.now() - started).padStart(6)}ms] ${line}`);

async function waitForServer(url, timeoutMs = 40_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(2000) });
      if (res.ok) return true;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 400));
  }
  return false;
}

/**
 * A second dev server with the Google key blanked in the environment only.
 * Vite's config prefers process.env over .env (vite.config.js:8057), so this
 * never reads, writes, or needs .env changed.
 */
async function startKeylessServer() {
  const child = spawn('npm', ['run', 'dev'], {
    cwd: process.cwd(),
    env: { ...process.env, GOOGLE_MAPS_API_KEY: '', PORT: String(KEYLESS_PORT) },
    stdio: 'ignore',
    detached: false,
  });
  const up = await waitForServer(`http://localhost:${KEYLESS_PORT}/`);
  if (!up) {
    child.kill('SIGTERM');
    throw new Error(`keyless dev server never came up on :${KEYLESS_PORT}`);
  }
  return child;
}

async function main() {
  let keyless = null;
  if (SPAWN_KEYLESS) {
    process.stdout.write(`spawning keyless dev server on :${KEYLESS_PORT} (GOOGLE_MAPS_API_KEY blanked in env only)...\n`);
    keyless = await startKeylessServer();
  }

  const browser = await chromium.launch({ channel: 'chrome', headless: false });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();

  const tiles = new Map(TILE_HOSTS.map((h) => [h, { n: 0, bytes: 0, statuses: new Map() }]));
  const errors = [];

  page.on('response', (response) => {
    try {
      const h = new URL(response.url()).host;
      const row = tiles.get(h);
      if (!row) return;
      row.n += 1;
      row.bytes += Number(response.headers()['content-length'] || 0);
      row.statuses.set(response.status(), (row.statuses.get(response.status()) || 0) + 1);
    } catch { /* opaque url */ }
  });

  // Cesium's own failure surfaces, watched from the page.
  await page.addInitScript(() => {
    window.__probeRenderErrors = [];
    const install = () => {
      const scene = window.__godsEyeView?.viewer?.scene;
      if (!scene?.renderError?.addEventListener || scene.__probeArmed) return false;
      scene.__probeArmed = true;
      scene.renderError.addEventListener((_s, error) => {
        window.__probeRenderErrors.push(String(error?.message || error));
      });
      return true;
    };
    const timer = setInterval(() => { if (install()) clearInterval(timer); }, 250);
    setTimeout(() => clearInterval(timer), 60_000);
  });

  page.on('console', (msg) => {
    if (msg.type() !== 'error') return;
    const text = msg.text().slice(0, 300);
    errors.push({ t: Date.now() - started, kind: 'console', text });
    record(`CONSOLE ERROR ${text}`);
  });
  page.on('pageerror', (error) => {
    const text = String(error?.message || error).slice(0, 300);
    errors.push({ t: Date.now() - started, kind: 'pageerror', text });
    record(`PAGEERROR ${text}`);
  });

  const cesiumDialogText = () => page.evaluate(() => {
    const el = document.querySelector('.cesium-widget-errorPanel, .cesium-widget-errorPanel-message');
    return el && el.offsetParent !== null ? (el.textContent || '').trim().slice(0, 300) : null;
  }).catch(() => null);

  record(`=== ${LABEL} :: ${URL_ARG} ===`);
  started = Date.now();
  await page.goto(URL_ARG, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  record('navigation: domcontentloaded');

  const readCentrePixel = () => page.evaluate(() => {
    const viewer = window.__godsEyeView?.viewer;
    const canvas = viewer?.scene?.canvas || document.querySelector('#cesiumContainer canvas');
    const gl = viewer?.scene?.context?._gl
      || canvas?.getContext?.('webgl2') || canvas?.getContext?.('webgl');
    if (!gl || !canvas || canvas.width < 2) return null;
    const px = new Uint8Array(4);
    try {
      gl.readPixels(canvas.width >> 1, canvas.height >> 1, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
    } catch { return null; }
    return [px[0], px[1], px[2], px[3]];
  });

  let firstPaintMs = null;
  const painted = (rgba) => Boolean(rgba && rgba[3] >= 8 && (rgba[0] + rgba[1] + rgba[2]) > 24);

  const pixelTimer = setInterval(async () => {
    if (firstPaintMs != null) return;
    let timer;
    const guard = new Promise((r) => { timer = setTimeout(() => r('blocked'), 900); });
    const rgba = await Promise.race([readCentrePixel().catch(() => null), guard])
      .finally(() => clearTimeout(timer));
    const t = Date.now() - started;
    if (rgba === 'blocked') { record(`PIXEL ${t}ms BLOCKED`); return; }
    if (painted(rgba)) {
      firstPaintMs = t;
      record(`PIXEL ${t}ms PAINTED rgba(${rgba.join(',')})`);
    }
  }, PIXEL_EVERY_MS);

  const playLog = [];
  if (PLAY) {
    // Descend first — pulses only exist once the camera is in the market.
    await new Promise((r) => setTimeout(r, 5_000));
    const clicked = await page.evaluate(() => {
      const button = [...document.querySelectorAll('button, [role="button"], a')]
        .find((b) => /atlanta\s*\/?\s*decatur/i.test(b.textContent || ''));
      if (!button) return false;
      button.click();
      return true;
    }).catch(() => false);
    record(`PLAY market button clicked=${clicked}`);
    playLog.push(`market button: ${clicked ? 'clicked' : 'NOT FOUND'}`);
    await new Promise((r) => setTimeout(r, 9_000));

    for (const phrase of PLAY_PHRASES) {
      // Through the typed bar, the way a reviewer drives it.
      const sent = await page.evaluate((text) => {
        const input = document.getElementById('ts-demo-input');
        const form = document.getElementById('ts-demo-form');
        if (input && form) {
          input.value = text;
          form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
          return 'typed-bar';
        }
        window.__terraSignal?.handleIntent?.(text);
        return 'handleIntent';
      }, phrase).catch((e) => `ERROR ${e.message.slice(0, 60)}`);
      record(`PLAY "${phrase}" via ${sent}`);
      playLog.push(`"${phrase}" → ${sent}`);
      await new Promise((r) => setTimeout(r, PLAY_GAP_MS));

      const dialog = await cesiumDialogText();
      if (dialog) {
        errors.push({ t: Date.now() - started, kind: 'cesium-dialog', text: dialog });
        record(`CESIUM DIALOG ${dialog}`);
        break;
      }
    }
  }

  // Responsiveness is measured at a fixed mark, not opportunistically: the
  // question is whether the thread is answering once the page should be idle.
  const respondAt = PLAY ? Date.now() - started + 2_000 : RESPOND_AT_MS;
  await new Promise((r) => setTimeout(r, Math.max(0, respondAt - (Date.now() - started))));
  const askedAt = Date.now();
  let respondTimer;
  const respondGuard = new Promise((r) => {
    respondTimer = setTimeout(() => r({ blocked: true }), RESPOND_BUDGET_MS);
  });
  const state = await Promise.race([
    page.evaluate(() => ({
      investor: Boolean(window.__terraSignal),
      primitives: window.__godsEyeView?.viewer?.scene?.primitives?.length ?? null,
      holds: window.__godsEyeView?.getRenderGovernorDiagnostics?.()?.holds ?? null,
      mode: window.__godsEyeView?.getRenderGovernorDiagnostics?.()?.mode ?? null,
    })).catch((e) => ({ error: String(e.message).slice(0, 120) })),
    respondGuard,
  ]).finally(() => clearTimeout(respondTimer));
  const respondMs = Date.now() - askedAt;
  record(`RESPOND at ${respondAt}ms: ${state.blocked ? 'BLOCKED' : `${respondMs}ms ${JSON.stringify(state)}`}`);

  await new Promise((r) => setTimeout(r, Math.max(0, (PLAY ? PLAY_RUN_MS : RUN_MS) - (Date.now() - started))));
  clearInterval(pixelTimer);

  // Drain every failure surface. scene.renderError is NOT the one that fires
  // for an illegal entity geometry — Cesium stops the render loop and shows a
  // panel instead — so the loop flag and the dialog are the load-bearing gates.
  const renderErrors = await page.evaluate(() => window.__probeRenderErrors || []).catch(() => []);
  const loopStopped = await page.evaluate(
    () => window.__godsEyeView?.viewer?.useDefaultRenderLoop === false,
  ).catch(() => false);
  const recovered = await page.evaluate(
    () => (window.__terraSignalRenderErrors || []).map((e) => e.message).slice(0, 5),
  ).catch(() => []);
  const finalDialog = await cesiumDialogText();
  if (finalDialog && !errors.some((e) => e.kind === 'cesium-dialog')) {
    errors.push({ t: Date.now() - started, kind: 'cesium-dialog', text: finalDialog });
  }
  for (const message of renderErrors) record(`RENDER ERROR ${message}`);

  await browser.close();
  if (keyless) { keyless.kill('SIGTERM'); await new Promise((r) => setTimeout(r, 500)); }

  // ---- verdict ----
  const paintOk = firstPaintMs != null && firstPaintMs <= PAINT_DEADLINE_MS;
  const respondOk = !state.blocked && !state.error;
  const devErrors = errors.filter((e) => /DeveloperError/i.test(e.text));
  const dialogs = errors.filter((e) => e.kind === 'cesium-dialog');
  const errorsOk = errors.length === 0;
  const renderOk = renderErrors.length === 0 && recovered.length === 0;
  const loopOk = !loopStopped;
  const pass = paintOk && respondOk && errorsOk && renderOk && loopOk;

  const tileSummary = TILE_HOSTS.map((h) => {
    const row = tiles.get(h);
    const statuses = [...row.statuses.entries()].map(([code, n]) => `${code}x${n}`).join(' ');
    return `${h}=${row.n}${row.n ? ` (${statuses})` : ''}`;
  }).join('  ');

  const out = [
    '',
    '='.repeat(74),
    `SMOKE ${pass ? 'PASS' : 'FAIL'} :: ${LABEL} :: ${URL_ARG}`,
    '='.repeat(74),
    `  ${paintOk ? 'PASS' : 'FAIL'}  first paint        ${firstPaintMs == null ? 'NEVER' : `${firstPaintMs}ms`} (deadline ${PAINT_DEADLINE_MS}ms)`,
    `  ${respondOk ? 'PASS' : 'FAIL'}  responds @${RESPOND_AT_MS / 1000}s      ${state.blocked ? `no reply in ${RESPOND_BUDGET_MS}ms` : `${respondMs}ms`} (budget ${RESPOND_BUDGET_MS}ms)`,
    `  ${errorsOk ? 'PASS' : 'FAIL'}  console errors     ${errors.length}`
      + `${devErrors.length ? ` (${devErrors.length} DeveloperError)` : ''}`
      + `${dialogs.length ? ` (${dialogs.length} Cesium dialog)` : ''}`,
    `  ${renderOk ? 'PASS' : 'FAIL'}  render errors      ${renderErrors.length + recovered.length}`,
    `  ${loopOk ? 'PASS' : 'FAIL'}  render loop alive  ${loopStopped ? 'STOPPED' : 'running'}`,
    `        tiles              ${tileSummary}`,
    `        governor           mode=${state.mode ?? '?'} holds=[${(state.holds || []).join(', ')}]`,
    '='.repeat(74),
  ];
  if (PLAY) {
    out.push('  play sequence:');
    for (const line of playLog) out.push(`    ${line}`);
  }
  for (const e of errors.slice(0, 8)) out.push(`  [${e.kind}] @${e.t}ms ${e.text}`);
  for (const message of renderErrors.slice(0, 5)) out.push(`  [renderError] ${message}`);
  for (const message of recovered.slice(0, 5)) out.push(`  [recovered] ${message}`);
  console.log(out.join('\n'));

  if (LOG_PATH) writeFileSync(LOG_PATH, log.join('\n') + '\n');
  process.exit(pass ? 0 : 1);
}

main().catch((error) => {
  console.error(`SMOKE FAIL :: ${LABEL} :: ${error.message}`);
  process.exit(1);
});
