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
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';

const PAINT_DEADLINE_MS = 8_000;
const RESPOND_AT_MS = 15_000;
const RESPOND_BUDGET_MS = 1_000;
const RUN_MS = 18_000;
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
const URL_ARG = arg('url', SPAWN_KEYLESS
  ? `http://localhost:${KEYLESS_PORT}/?demo=1&welcome=1`
  : 'http://localhost:4173/?demo=1&welcome=1');
const LABEL = arg('label', SPAWN_KEYLESS ? 'investor-keyless' : 'investor');
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

  // Responsiveness is measured at a fixed mark, not opportunistically: the
  // question is whether the thread is answering once the page should be idle.
  await new Promise((r) => setTimeout(r, Math.max(0, RESPOND_AT_MS - (Date.now() - started))));
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
  record(`RESPOND at ${RESPOND_AT_MS}ms: ${state.blocked ? 'BLOCKED' : `${respondMs}ms ${JSON.stringify(state)}`}`);

  await new Promise((r) => setTimeout(r, Math.max(0, RUN_MS - (Date.now() - started))));
  clearInterval(pixelTimer);

  await browser.close();
  if (keyless) { keyless.kill('SIGTERM'); await new Promise((r) => setTimeout(r, 500)); }

  // ---- verdict ----
  const paintOk = firstPaintMs != null && firstPaintMs <= PAINT_DEADLINE_MS;
  const respondOk = !state.blocked && !state.error;
  const errorsOk = errors.length === 0;
  const pass = paintOk && respondOk && errorsOk;

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
    `  ${errorsOk ? 'PASS' : 'FAIL'}  console errors     ${errors.length}`,
    `        tiles              ${tileSummary}`,
    `        governor           mode=${state.mode ?? '?'} holds=[${(state.holds || []).join(', ')}]`,
    '='.repeat(74),
  ];
  for (const e of errors.slice(0, 8)) out.push(`  [${e.kind}] @${e.t}ms ${e.text}`);
  console.log(out.join('\n'));

  if (LOG_PATH) writeFileSync(LOG_PATH, log.join('\n') + '\n');
  process.exit(pass ? 0 : 1);
}

main().catch((error) => {
  console.error(`SMOKE FAIL :: ${LABEL} :: ${error.message}`);
  process.exit(1);
});
