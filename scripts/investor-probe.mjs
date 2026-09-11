#!/usr/bin/env node
/**
 * Headed diagnostic probe for the TerraSignal investor globe.
 *
 * Launches REAL Chrome (channel: 'chrome', headless: false) so the page gets a
 * real GPU — the keyless/black-globe symptoms do not reproduce under SwiftShader.
 * For 30 seconds it records tile traffic, whether Earth ever paints, main-thread
 * long tasks, and the render-governor holds, then prints a summary table.
 *
 * Read-only: it calls the diagnostics already exposed on window.__godsEyeView
 * and imports nothing into the page. No src/ file is modified.
 *
 *   node scripts/investor-probe.mjs <url> <logPath> <label>
 *
 * Design note — a pegged renderer cannot answer page.evaluate(). Every in-page
 * sample is raced against a short timer and recorded as BLOCKED on timeout;
 * that blocked/answered pattern is itself the signal we are hunting. Network
 * events arrive over CDP from the browser process, so they keep flowing even
 * while the main thread is wedged.
 */
import { chromium } from 'playwright';
import { writeFileSync } from 'node:fs';

const URL_ARG = process.argv[2] || 'http://localhost:4173/?demo=1&welcome=1';
const LOG_PATH = process.argv[3] || '/tmp/investor-probe.log';
const LABEL = process.argv[4] || 'investor';

const DURATION_MS = 30_000;
const PIXEL_EVERY_MS = 2_000;
const STATE_EVERY_MS = 5_000;
const EVAL_TIMEOUT_MS = 1_500;
const WINDOW_MS = 5_000;

const TILE_HOSTS = ['tile.googleapis.com', 'assets.ion.cesium.com', 'server.arcgisonline.com'];

const log = [];
function record(line) {
  const stamped = `[${String(Date.now() - started).padStart(6)}ms] ${line}`;
  log.push(stamped);
}
let started = Date.now();

/** page.evaluate, but a wedged main thread resolves as BLOCKED instead of hanging. */
async function safeEval(page, fn, timeoutMs = EVAL_TIMEOUT_MS) {
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ __blocked: true }), timeoutMs);
  });
  try {
    return await Promise.race([page.evaluate(fn), timeout]);
  } catch (error) {
    return { __error: String(error?.message || error).slice(0, 160) };
  } finally {
    clearTimeout(timer);
  }
}

function host(url) {
  try { return new global.URL(url).host; } catch { return '?'; }
}

async function main() {
  const browser = await chromium.launch({ channel: 'chrome', headless: false });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();

  // Installed before any page script so long tasks are counted from the very
  // first frame, and survive in-page even while we cannot read them out.
  await page.addInitScript(() => {
    window.__probe = { longtasks: [], drained: 0 };
    try {
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          window.__probe.longtasks.push({ start: Math.round(entry.startTime), dur: Math.round(entry.duration) });
        }
      }).observe({ entryTypes: ['longtask'] });
    } catch {
      window.__probe.unsupported = true;
    }
  });

  const requests = [];
  const consoleMsgs = [];

  page.on('response', async (response) => {
    const h = host(response.url());
    if (!TILE_HOSTS.includes(h)) return;
    let bytes = Number(response.headers()['content-length'] || 0);
    if (!bytes) {
      try { bytes = (await response.body()).length; } catch { bytes = -1; }
    }
    const row = { t: Date.now() - started, host: h, status: response.status(), bytes, url: response.url() };
    requests.push(row);
    record(`NET ${h} ${row.status} ${row.bytes}B ${response.url().slice(0, 120)}`);
  });

  page.on('requestfailed', (request) => {
    const h = host(request.url());
    if (!TILE_HOSTS.includes(h)) return;
    const row = { t: Date.now() - started, host: h, status: 'FAILED', bytes: 0, failure: request.failure()?.errorText };
    requests.push(row);
    record(`NET ${h} FAILED ${row.failure} ${request.url().slice(0, 120)}`);
  });

  page.on('console', (msg) => {
    const type = msg.type();
    if (type !== 'error' && type !== 'warning') return;
    const row = { t: Date.now() - started, type, text: msg.text().slice(0, 400) };
    consoleMsgs.push(row);
    record(`CONSOLE ${type.toUpperCase()} ${row.text}`);
  });

  page.on('pageerror', (error) => {
    const row = { t: Date.now() - started, type: 'pageerror', text: String(error?.message || error).slice(0, 400) };
    consoleMsgs.push(row);
    record(`PAGEERROR ${row.text}`);
  });

  record(`=== ${LABEL} :: ${URL_ARG} ===`);
  started = Date.now();
  try {
    await page.goto(URL_ARG, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    record('navigation: domcontentloaded');
  } catch (error) {
    record(`navigation FAILED: ${error.message}`);
  }

  const pixels = [];
  const states = [];

  const pixelTimer = setInterval(async () => {
    const sample = await safeEval(page, () => {
      const viewer = window.__godsEyeView?.viewer;
      const canvas = viewer?.scene?.canvas || document.querySelector('#cesiumContainer canvas');
      if (!canvas) return { ready: false };
      const gl = viewer?.scene?.context?._gl
        || canvas.getContext('webgl2') || canvas.getContext('webgl');
      if (!gl) return { ready: false };
      const w = canvas.width; const h = canvas.height;
      if (w < 2 || h < 2) return { ready: false, w, h };
      const px = new Uint8Array(4);
      try {
        gl.readPixels(Math.floor(w / 2), Math.floor(h / 2), 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
      } catch (e) {
        return { ready: false, err: String(e).slice(0, 80) };
      }
      return { ready: true, rgba: [px[0], px[1], px[2], px[3]], w, h };
    });
    const t = Date.now() - started;
    const row = { t, ...sample };
    // Same predicate the product uses to decide "the globe painted".
    row.nonBlack = Boolean(sample.rgba && sample.rgba[3] >= 8
      && (sample.rgba[0] + sample.rgba[1] + sample.rgba[2]) > 24);
    pixels.push(row);
    record(`PIXEL ${sample.__blocked ? 'BLOCKED (main thread busy)'
      : sample.rgba ? `rgba(${sample.rgba.join(',')}) nonBlack=${row.nonBlack}`
        : JSON.stringify(sample)}`);
  }, PIXEL_EVERY_MS);

  const stateTimer = setInterval(async () => {
    const sample = await safeEval(page, () => {
      const gev = window.__godsEyeView;
      const viewer = gev?.viewer;
      const scene = viewer?.scene;
      const drained = window.__probe ? window.__probe.longtasks.splice(0) : [];
      let diagnostics = null;
      try { diagnostics = gev?.getRenderGovernorDiagnostics?.() || null; } catch { /* not installed */ }
      const errEl = document.getElementById('ts-globe-error');
      return {
        hasGev: Boolean(gev),
        hasInvestor: Boolean(window.__terraSignal),
        requestRenderMode: scene?.requestRenderMode ?? null,
        globeShow: scene?.globe?.show ?? null,
        tilesLoaded: scene?.globe?.tilesLoaded ?? null,
        imageryLayers: viewer?.imageryLayers?.length ?? null,
        primitives: scene?.primitives?.length ?? null,
        hasTileset: Boolean(gev?.tileset),
        targetFrameRate: viewer?.targetFrameRate ?? null,
        governor: diagnostics,
        globeError: errEl ? !errEl.hidden : null,
        longtasks: drained,
      };
    });
    const t = Date.now() - started;
    states.push({ t, ...sample });
    if (sample.__blocked) {
      record('STATE BLOCKED (main thread busy)');
    } else {
      record(`STATE rrm=${sample.requestRenderMode} globeShow=${sample.globeShow} `
        + `tilesLoaded=${sample.tilesLoaded} layers=${sample.imageryLayers} `
        + `primitives=${sample.primitives} tileset=${sample.hasTileset} `
        + `fps=${sample.targetFrameRate} mode=${sample.governor?.mode} `
        + `holds=[${(sample.governor?.holds || []).join(',')}] globeError=${sample.globeError} `
        + `longtasks=${sample.longtasks?.length ?? 0}`);
    }
  }, STATE_EVERY_MS);

  await new Promise((resolve) => setTimeout(resolve, DURATION_MS));
  clearInterval(pixelTimer);
  clearInterval(stateTimer);

  // One last drain — anything the observer buffered while we could not read it.
  const tail = await safeEval(page, () => ({
    longtasks: window.__probe ? window.__probe.longtasks.splice(0) : [],
    responsive: true,
  }), 4000);
  if (!tail.__blocked && tail.longtasks?.length) {
    states.push({ t: DURATION_MS, longtasks: tail.longtasks, tail: true });
  }
  record(`FINAL responsive=${!tail.__blocked}`);

  await browser.close();
  writeFileSync(LOG_PATH, log.join('\n') + '\n');

  summarize({ requests, pixels, states, consoleMsgs, tail });
}

function summarize({ requests, pixels, states, consoleMsgs, tail }) {
  const out = [];
  const p = (s) => { out.push(s); };

  p(`\n${'='.repeat(78)}`);
  p(`SUMMARY :: ${LABEL} :: ${URL_ARG}`);
  p('='.repeat(78));

  p('\n-- TILE REQUESTS ------------------------------------------------------');
  if (!requests.length) {
    p('  (none — no request to any tile host in 30s)');
  } else {
    for (const h of TILE_HOSTS) {
      const rows = requests.filter((r) => r.host === h);
      if (!rows.length) { p(`  ${h.padEnd(26)} 0 requests`); continue; }
      const byStatus = {};
      let bytes = 0;
      for (const r of rows) {
        byStatus[r.status] = (byStatus[r.status] || 0) + 1;
        if (r.bytes > 0) bytes += r.bytes;
      }
      const statuses = Object.entries(byStatus).map(([s, n]) => `${s}×${n}`).join(' ');
      p(`  ${h.padEnd(26)} ${String(rows.length).padStart(4)} req  ${statuses.padEnd(22)} ${(bytes / 1024).toFixed(0)} KB  first@${rows[0].t}ms`);
    }
  }

  p('\n-- CENTER PIXEL (did Earth paint?) ------------------------------------');
  const firstPaint = pixels.find((r) => r.nonBlack);
  const blockedPixels = pixels.filter((r) => r.__blocked).length;
  p(`  samples=${pixels.length}  blocked=${blockedPixels}  `
    + `firstNonBlack=${firstPaint ? `${firstPaint.t}ms rgba(${firstPaint.rgba.join(',')})` : 'NEVER'}`);
  for (const row of pixels) {
    p(`    ${String(row.t).padStart(6)}ms  ${row.__blocked ? 'BLOCKED'
      : row.rgba ? `rgba(${row.rgba.join(',').padEnd(15)}) ${row.nonBlack ? 'PAINTED' : 'black'}`
        : JSON.stringify(row).slice(0, 60)}`);
  }

  p('\n-- LONG TASKS (main-thread blocking, per 5s window) --------------------');
  const all = states.flatMap((s) => s.longtasks || []);
  const windows = new Map();
  for (const task of all) {
    const w = Math.floor(task.start / WINDOW_MS) * WINDOW_MS;
    const cur = windows.get(w) || { count: 0, ms: 0, max: 0 };
    cur.count += 1; cur.ms += task.dur; cur.max = Math.max(cur.max, task.dur);
    windows.set(w, cur);
  }
  if (!windows.size) {
    p('  (no long tasks recorded — or the observer could never be drained)');
  } else {
    p('  window        count   total ms   longest   % of window');
    for (const [w, v] of [...windows.entries()].sort((a, b) => a[0] - b[0])) {
      p(`  ${String(w / 1000).padStart(2)}-${String(w / 1000 + 5).padStart(2)}s     `
        + `${String(v.count).padStart(5)}   ${String(v.ms).padStart(8)}   ${String(v.max).padStart(7)}   `
        + `${((v.ms / WINDOW_MS) * 100).toFixed(0)}%`);
    }
  }

  p('\n-- SCENE / GOVERNOR STATE ---------------------------------------------');
  p('  t(ms)  rrm    globe  tiles  layers prim  tileset fps  mode        holds');
  for (const s of states) {
    if (s.tail) continue;
    if (s.__blocked) { p(`  ${String(s.t).padStart(5)}  BLOCKED (main thread busy)`); continue; }
    p(`  ${String(s.t).padStart(5)}  ${String(s.requestRenderMode).padEnd(6)} `
      + `${String(s.globeShow).padEnd(6)} ${String(s.tilesLoaded).padEnd(6)} `
      + `${String(s.imageryLayers).padEnd(6)} ${String(s.primitives).padEnd(5)} `
      + `${String(s.hasTileset).padEnd(7)} ${String(s.targetFrameRate).padEnd(4)} `
      + `${String(s.governor?.mode).padEnd(11)} [${(s.governor?.holds || []).join(', ')}]`);
  }

  p('\n-- CONSOLE ERRORS / WARNINGS ------------------------------------------');
  if (!consoleMsgs.length) p('  (none)');
  const seen = new Map();
  for (const m of consoleMsgs) {
    const key = m.text.slice(0, 120);
    if (!seen.has(key)) seen.set(key, { ...m, n: 0 });
    seen.get(key).n += 1;
  }
  for (const m of [...seen.values()].slice(0, 25)) {
    p(`  [${m.type}] ×${m.n} @${m.t}ms  ${m.text.slice(0, 150)}`);
  }

  p(`\n  page responsive at 30s: ${!tail.__blocked}`);
  p(`  full log: ${LOG_PATH}`);
  p('='.repeat(78));

  console.log(out.join('\n'));
}

main().catch((error) => {
  console.error('probe failed:', error);
  process.exit(1);
});
