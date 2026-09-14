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
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

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
/**
 * The six-house scene check. Narrower than --play on purpose: it does not drive
 * the conversation, it measures the two shots the near-field effects actually
 * have to hold — a settled CRUISE over the cluster with six parcels glowing,
 * and HERO on the gold house with its outline breathing.
 *
 * The frame budget is 33 ms rather than --play's 120 ms because that is the
 * whole question being asked. Draped ground polylines and translucent columns
 * are real GPU work, and the point of building them once and animating them
 * through uniforms is that the result holds 30 fps. A layer that cannot is not
 * worth having.
 */
const SIX = HAS('six');
/**
 * Drive Mode v1. Starts the drive by typed command, runs the whole loop at 4x
 * playback, and measures the things a drive can break that nothing else can:
 * the frame budget while the camera is in continuous motion, whether every
 * signal type actually got announced, and whether asking for the best match
 * produces exactly one gold call-out rather than none or several.
 */
const DRIVE = HAS('drive');
const DRIVE_SPEED_SCALE = 4;
const DRIVE_RUN_MS = 150_000;
/** How long to let the whole loop play before giving up on it finishing. */
const DRIVE_LAP_TIMEOUT_MS = 110_000;
/**
 * 33 ms is 30 fps, and `frameBudget.js` deliberately caps the investor viewer
 * at exactly 30 fps whenever the machine is on battery. So a flat 33 ms budget
 * is unachievable by construction on an unplugged laptop — which is the demo
 * machine — and the first run on battery failed at 33.4 ms while rendering
 * perfectly: p50 33.3, worst 34.3, the cap held to a tenth of a millisecond.
 *
 * The question worth asking is "is the layer holding the frame rate the product
 * asked for", so the budget is the larger of 33 ms and the viewer's own frame
 * interval plus 12% of headroom. At 60 fps that leaves 33 ms binding with two
 * frames of slack; at 30 fps it becomes 37 ms, which a held cap clears and a
 * real stall does not.
 */
const SIX_FRAME_P95_BUDGET_MS = 33;
const FRAME_CAP_TOLERANCE = 1.12;
const SIX_RUN_MS = 70_000;
/**
 * The any-angle moves the six-house check drives, in order.
 *
 * These are the two that have to hold framing: "show me the back" swings the
 * camera through roughly 180 degrees, and "from the street" derives its heading
 * from real OSM street data rather than from a constant. If either can drop the
 * house out of the middle of the frame, the framing maths is wrong.
 */
const SIX_ANGLES = Object.freeze([
  { phrase: 'show me the back', shot: 'hero-six-back' },
  { phrase: 'from the street', shot: 'hero-six-street' },
]);
/** The house must stay in the middle 30% of the frame through every angle. */
const ANGLE_CENTRE_FRACTION = 0.30;
/** A 2 s re-framing plus a moment for tiles to catch up. */
const ANGLE_SETTLE_MS = 3_200;
const PLAY_PHRASES = [
  'Find me money',
  'Why?',
  'Show me the deal',
  'Assume rehab is twenty thousand higher',
  'Save it',
  'Compare',
];
const PLAY_GAP_MS = 4_000;
const SHOT_DIR = arg('shots', '/tmp/shots');
/** The board has to actually read at market altitude, not just exist. */
const MIN_MARKERS_IN_VIEW = 20;
/** The focused house must land near the middle of the frame, not under chrome. */
const HERO_CENTRE_FRACTION = 0.30;
/** A dropped frame is anything the eye reads as a stutter on this hardware. */
const FRAME_P95_BUDGET_MS = 120;
const URL_ARG = arg('url', SPAWN_KEYLESS
  ? `http://localhost:${KEYLESS_PORT}/?demo=1&welcome=1`
  : ((SIX || DRIVE) ? 'http://localhost:4173/?scene=six' : 'http://localhost:4173/?demo=1&welcome=1'));
const LABEL = arg('label', SPAWN_KEYLESS
  ? 'investor-keyless'
  : (DRIVE ? 'drive' : (SIX ? 'six' : (PLAY ? 'demo' : 'investor'))));
const LOG_PATH = arg('log', null);

const log = [];
let started = Date.now();
const record = (line) => log.push(`[${String(Date.now() - started).padStart(6)}ms] ${line}`);

/**
 * Page-clock intervals the probe itself stalled the renderer, and must not
 * charge to the product.
 *
 * `page.screenshot()` blocks the compositor for hundreds of milliseconds — the
 * drive's worst frame was 2,266 ms and every one of those was a capture. A
 * check that counts its own instrumentation as a dropped frame is measuring
 * itself, and at the 60 fps cap that alone pushed the drive's p95 over budget
 * while a clean window of the same drive measured 31.3 ms.
 */
const frameExclusions = [];

/** p95 of the frame gaps recorded inside [start, end] page-clock milliseconds. */
function frameStats(frames, window) {
  if (!window || !frames.length) return null;
  const [start, end] = window;
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  const excluded = (stamp) => frameExclusions.some(([from, to]) => stamp >= from && stamp <= to);
  const gaps = frames
    .filter(([stamp]) => stamp >= start && stamp <= end && !excluded(stamp))
    .map(([, gap]) => gap)
    .sort((a, b) => a - b);
  if (gaps.length < 5) return null;
  const at = (q) => gaps[Math.min(gaps.length - 1, Math.floor(q * gaps.length))];
  return {
    n: gaps.length,
    p50: at(0.50),
    p95: at(0.95),
    worst: gaps.at(-1),
    seconds: Math.round((end - start) / 100) / 10,
  };
}

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
  const shots = [];

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

  // Frame-time sampler. Runs from the first frame so the descent is covered.
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

  const cameraState = () => page.evaluate(() => ({
    shot: window.__terraSignal?.camera?.shot ?? null,
    flying: window.__terraSignal?.camera?.flying ?? false,
    orbiting: window.__terraSignal?.camera?.orbiting ?? false,
  })).catch(() => ({ shot: null, flying: false }));

  /** Wait for a shot to be reached and settled, bounded. */
  const waitForShot = async (name, timeoutMs = 25_000) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const state = await cameraState();
      if (state.shot === name && !state.flying) return true;
      await new Promise((r) => setTimeout(r, 120));
    }
    return false;
  };

  const pageNow = () => page.evaluate(() => performance.now()).catch(() => null);

  const shot = async (label) => {
    try {
      mkdirSync(SHOT_DIR, { recursive: true });
      const file = join(SHOT_DIR, `${label}.png`);
      // Bracket the capture in page time so its stall is not charged to the
      // product's frame budget. A little slack either side covers the frame
      // already in flight when the capture starts.
      const from = await pageNow();
      await page.screenshot({ path: file });
      const to = await pageNow();
      if (Number.isFinite(from) && Number.isFinite(to)) {
        frameExclusions.push([from - 120, to + 120]);
      }
      shots.push(file);
      record(`SHOT ${label} -> ${file} (renderer stalled ${Math.round(to - from)}ms, excluded)`);
      return file;
    } catch (error) {
      record(`SHOT ${label} FAILED ${error.message}`);
      return null;
    }
  };

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
  const windows = {};
  const checks = {
    markersInView: null,
    heroCentred: null,
    scene: null,
    heroScene: null,
    cruiseEffects: null,
    heroEffects: null,
    angleChoice: null,
    angles: [],
    drivePlan: null,
    driveCallouts: [],
    driveState: null,
    drivePropertyMode: null,
  };

  /** Markers whose sprite lands inside the viewport. */
  const markersInView = () => page.evaluate(() => {
    const visuals = window.__terraSignal?.visuals;
    const positions = visuals?.screenPositions?.() || [];
    const w = window.innerWidth;
    const h = window.innerHeight;
    const inside = positions.filter((p) => p.x >= 0 && p.x <= w && p.y >= 0 && p.y <= h);
    return { total: positions.length, inView: inside.length, count: visuals?.markerCount ?? 0 };
  }).catch(() => ({ total: 0, inView: 0, count: 0 }));

  /** Where the focused marker sits in the frame, 0..1 from the top left. */
  const focusedMarkerFrame = () => page.evaluate(() => {
    const session = window.__terraSignal;
    const id = session?.focused?.id;
    const positions = session?.visuals?.screenPositions?.() || [];
    const hit = positions.find((p) => p.id === id);
    if (!hit) return null;
    return { id, fx: hit.x / window.innerWidth, fy: hit.y / window.innerHeight };
  }).catch(() => null);
  /** What the near-field layer reports about itself right now. */
  const effectsState = () => page.evaluate(() => {
    const visuals = window.__terraSignal?.visuals;
    const effects = visuals?.effects || null;
    return {
      supported: effects?.supported ?? null,
      active: effects?.active ?? null,
      count: effects?.count ?? 0,
      surveyed: effects?.surveyed?.length ?? 0,
      approximate: effects?.approximate?.length ?? 0,
      // Real county lot lines, and whether the tile tint is available at all.
      parcels: effects?.parcels?.length ?? 0,
      parcelSources: effects?.parcelSources ?? {},
      classification: effects?.classification ?? null,
      tinted: effects?.tinted ?? [],
      tintEdges: effects?.tintEdges?.length ?? 0,
      // Above ground, the way the layer's own ceiling is defined.
      cameraAglM: (() => {
        const h = window.__godsEyeView?.viewer?.camera?.positionCartographic?.height;
        const ground = window.__terraSignal?.market?.groundElevationM ?? 0;
        return Number.isFinite(h) ? Math.round(h - ground) : null;
      })(),
    };
  }).catch(() => null);

  /**
   * Where the focused house's FOOTPRINT CENTROID sits in frame, 0..1.
   *
   * Deliberately the footprint and not the marker: the marker floats 14 m over
   * the roof, so centring it would sit the house itself low in frame — which is
   * exactly the error the hero framing tilts exist to cancel.
   */
  const footprintFrame = (id) => page.evaluate((propertyId) => {
    const point = window.__terraSignal?.visuals?.footprintScreenPosition?.(propertyId);
    if (!point) return null;
    return {
      fx: point.x / window.innerWidth,
      fy: point.y / window.innerHeight,
    };
  }, id).catch(() => null);

  /** What the camera director thinks it is doing right now. */
  const cameraPose = () => page.evaluate(() => ({
    pose: window.__terraSignal?.camera?.pose ?? null,
    angles: window.__terraSignal?.camera?.angleChoices ?? {},
    pulses: window.__terraSignal?.visuals?.pulses ?? null,
  })).catch(() => ({ pose: null, angles: {}, pulses: null }));

  const sceneState = () => page.evaluate(() => ({
    mode: window.__terraSignal?.sceneMode ?? null,
    rows: window.__terraSignal?.properties?.length ?? 0,
    goldId: window.__terraSignal?.scene?.goldId ?? null,
    spanM: window.__terraSignal?.scene?.spanM ?? null,
    types: window.__terraSignal?.scene?.types ?? [],
    focusedId: window.__terraSignal?.focused?.id ?? null,
  })).catch(() => null);

  if (SIX) {
    // No hunt modal in a scene URL: the session descends on its own, so the
    // only thing to do is wait for the establishing shot to settle.
    const cruised = await waitForShot('CRUISE', 40_000);
    playLog.push(`CRUISE over the cluster settled: ${cruised}`);
    if (!cruised) errors.push({ t: Date.now() - started, kind: 'six', text: 'CRUISE never settled' });

    // Let the tiles under the parcels resolve before measuring anything: a
    // p95 that includes tile upload is measuring the network, not the layer.
    await new Promise((r) => setTimeout(r, 2_000));
    checks.scene = await sceneState();
    checks.cruiseEffects = await effectsState();
    record(`CHECK scene ${JSON.stringify(checks.scene)}`);
    record(`CHECK effects at CRUISE ${JSON.stringify(checks.cruiseEffects)}`);
    playLog.push(`effects at CRUISE: active=${checks.cruiseEffects?.active} `
      + `${checks.cruiseEffects?.surveyed} surveyed / ${checks.cruiseEffects?.count} built`);

    const cruiseStart = await pageNow();
    await new Promise((r) => setTimeout(r, 4_000));
    windows.sixCruise = [cruiseStart, await pageNow()];
    await shot('cruise-six');

    // "show me the best one" — the same words a reviewer says out loud.
    const heroStart = await pageNow();
    const sent = await page.evaluate(() => {
      const input = document.getElementById('ts-demo-input');
      const form = document.getElementById('ts-demo-form');
      if (input && form) {
        input.value = 'show me the best one';
        form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
        return 'typed-bar';
      }
      window.__terraSignal?.handleIntent?.('show me the best one');
      return 'handleIntent';
    }).catch((e) => `ERROR ${String(e.message).slice(0, 60)}`);
    record(`SIX "show me the best one" via ${sent}`);
    playLog.push(`"show me the best one" → ${sent}`);

    const heroed = await waitForShot('HERO', 30_000);
    playLog.push(`HERO on the gold house settled: ${heroed}`);
    if (!heroed) errors.push({ t: Date.now() - started, kind: 'six', text: 'HERO never settled' });
    // Frames are sampled from the moment the phrase was sent: the flight is
    // the expensive part and hiding it would make the number meaningless.
    await new Promise((r) => setTimeout(r, 1_500));
    windows.sixHero = [heroStart, await pageNow()];
    checks.heroScene = await sceneState();
    checks.heroEffects = await effectsState();
    record(`CHECK effects at HERO ${JSON.stringify(checks.heroEffects)}`);
    await shot('hero-six');

    // Four more seconds parked on the house: the orbit runs, the gold outline
    // breathes, and the column fades down. Anything that leaks shows up here.
    await new Promise((r) => setTimeout(r, 4_000));
    await shot('hero-six-plus-4s');
    playLog.push(`gold ${checks.scene?.goldId} · focused ${checks.heroScene?.focusedId}`);

    // Which approach heading the occlusion sweep chose, and why.
    const chosen = await cameraPose();
    checks.angleChoice = chosen;
    record(`CHECK camera pose ${JSON.stringify(chosen.pose)}`);
    record(`CHECK angle choices ${JSON.stringify(chosen.angles)}`);
    for (const [id, choice] of Object.entries(chosen.angles || {})) {
      playLog.push(`angle ${id}: ${Math.round(choice.headingDeg)}° `
        + `score ${Number(choice.score).toFixed(2)} (${choice.reason}`
        + `${choice.frontSource ? `, front from ${choice.frontSource}` : ''})`);
    }

    // The any-angle moves. Each one must leave the house where it found it:
    // in the middle of the frame.
    const goldId = checks.scene?.goldId ?? null;
    const before = await footprintFrame(goldId);
    record(`CHECK footprint frame at HERO ${JSON.stringify(before)}`);

    for (const angle of SIX_ANGLES) {
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
      }, angle.phrase).catch((e) => `ERROR ${String(e.message).slice(0, 60)}`);
      record(`SIX "${angle.phrase}" via ${sent}`);

      await new Promise((r) => setTimeout(r, ANGLE_SETTLE_MS));
      const frame = await footprintFrame(goldId);
      const pose = await cameraPose();
      checks.angles.push({ phrase: angle.phrase, frame, pose: pose.pose, shot: angle.shot });
      record(`CHECK "${angle.phrase}" footprint frame ${JSON.stringify(frame)} `
        + `pose ${JSON.stringify(pose.pose)}`);
      playLog.push(`"${angle.phrase}" → heading ${pose.pose ? Math.round(pose.pose.headingDeg) : '?'}°`
        + `, house at ${frame ? `${(frame.fx * 100).toFixed(0)}%, ${(frame.fy * 100).toFixed(0)}%` : 'OFF SCREEN'}`);
      await shot(angle.shot);
    }
  }

  if (DRIVE) {
    // The scene descends on its own; the drive starts from the settled cruise.
    const cruised = await waitForShot('CRUISE', 40_000);
    playLog.push(`CRUISE over the cluster settled: ${cruised}`);
    if (!cruised) errors.push({ t: Date.now() - started, kind: 'drive', text: 'CRUISE never settled' });
    await new Promise((r) => setTimeout(r, 1_500));

    const send = (text) => page.evaluate((phrase) => {
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

    const driveState = () => page.evaluate(() => {
      const drive = window.__terraSignal?.drive;
      if (!drive) return null;
      return {
        running: drive.running,
        mode: drive.mode,
        paused: drive.paused,
        alongM: drive.alongM,
        lengthM: drive.lengthM,
        goldId: drive.goldId,
        level: drive.level,
        tileBudget: drive.tileBudget,
        onRoute: (drive.onRoute || []).length,
        callouts: (drive.callouts || []).map((c) => ({
          text: c.text, side: c.side, ids: c.ids, gold: Boolean(c.gold), atM: c.atM,
        })),
      };
    }).catch(() => null);

    // Start by typed command, the way a reviewer would.
    const startedBy = await send('drive through this neighborhood and show me foreclosures and rentals');
    record(`DRIVE start via ${startedBy}`);
    playLog.push(`"drive through this neighborhood…" → ${startedBy}`);
    await new Promise((r) => setTimeout(r, 1_200));

    checks.drivePlan = await page.evaluate(
      () => window.__terraSignal?.drive?.plan?.() ?? null,
    ).catch(() => null);
    record(`CHECK drive plan ${JSON.stringify(checks.drivePlan)}`);
    if (checks.drivePlan) {
      playLog.push(`plan: ${checks.drivePlan.area} · ${(checks.drivePlan.lengthM / 1000).toFixed(2)} km`
        + ` · ${checks.drivePlan.properties} properties · ${checks.drivePlan.signalTypes.length} signal types`);
    }

    // Ask for the best match, so exactly one gold call-out should follow.
    await send('show me the best match along this route');
    playLog.push('"show me the best match along this route" → sent');

    // 4x playback: the whole loop in a headed check, without a four-minute run.
    await page.evaluate((scale) => {
      window.__terraSignal?.drive?.source?.setSpeedScale?.(scale);
    }, DRIVE_SPEED_SCALE).catch(() => {});
    record(`DRIVE playback scaled to ${DRIVE_SPEED_SCALE}x`);

    // A frame window over the moving camera — the whole question for a drive.
    const driveStart = await pageNow();
    await new Promise((r) => setTimeout(r, 4_000));
    await shot('drive-approach');

    // Run the lap out, grabbing the gold moment when it lands.
    let goldShotTaken = false;
    const deadline = Date.now() + DRIVE_LAP_TIMEOUT_MS;
    let state = null;
    while (Date.now() < deadline) {
      state = await driveState();
      if (!state?.running) break;
      if (!goldShotTaken && state.callouts.some((c) => c.gold)) {
        goldShotTaken = true;
        await shot('drive-gold');
      }
      // A full lap: the loop wraps, so stop once we are back near the start
      // having covered most of it.
      if (state.callouts.length >= (state.onRoute || 6)) break;
      await new Promise((r) => setTimeout(r, 400));
    }
    windows.drive = [driveStart, await pageNow()];
    checks.driveState = state;
    checks.driveCallouts = state?.callouts || [];
    record(`CHECK drive state ${JSON.stringify({ ...state, callouts: undefined })}`);
    for (const callout of checks.driveCallouts) {
      record(`CALLOUT ${callout.gold ? 'GOLD ' : ''}${callout.atM?.toFixed?.(0)}m ${callout.side} :: ${callout.text}`);
      playLog.push(`${callout.gold ? 'GOLD  ' : 'call  '}${String(Math.round(callout.atM || 0)).padStart(4)}m `
        + `${String(callout.side).padEnd(5)} ${callout.text}`);
    }
    if (!goldShotTaken) await shot('drive-gold');

    // (6) Look closer → Property Mode.
    await send('look closer');
    await new Promise((r) => setTimeout(r, 4_000));
    checks.drivePropertyMode = await driveState();
    record(`CHECK property mode ${JSON.stringify({ mode: checks.drivePropertyMode?.mode })}`);
    playLog.push(`"look closer" → mode ${checks.drivePropertyMode?.mode}`);
    await shot('drive-property-mode');

    // And back onto the road, which must not restart the drive.
    await send('keep going');
    await new Promise((r) => setTimeout(r, 2_000));
    const resumed = await driveState();
    playLog.push(`"keep going" → mode ${resumed?.mode}, running ${resumed?.running}`);
  }

  if (PLAY) {
    // Descend first — pulses only exist once the camera is in the market.
    await new Promise((r) => setTimeout(r, 5_000));
    const descentStart = await pageNow();
    const clicked = await page.evaluate(() => {
      const button = [...document.querySelectorAll('button, [role="button"], a')]
        .find((b) => /atlanta\s*\/?\s*decatur/i.test(b.textContent || ''));
      if (!button) return false;
      button.click();
      return true;
    }).catch(() => false);
    record(`PLAY market button clicked=${clicked}`);
    playLog.push(`market button: ${clicked ? 'clicked' : 'NOT FOUND'}`);

    // The descent is WORLD -> STAGING -> (tiles) -> CRUISE.
    const cruised = await waitForShot('CRUISE');
    windows.descent = [descentStart, await pageNow()];
    playLog.push(`descent settled on CRUISE: ${cruised}`);
    await new Promise((r) => setTimeout(r, 900));
    // A settled CRUISE: markers pulsing, camera still. This is the steady state
    // the demo sits in most, so it gets its own frame window.
    const cruiseStart = await pageNow();
    await new Promise((r) => setTimeout(r, 2_500));
    windows.cruise = [cruiseStart, await pageNow()];
    checks.markersInView = await markersInView();
    record(`CHECK markers in view at CRUISE: ${JSON.stringify(checks.markersInView)}`);
    playLog.push(`markers in view at CRUISE: ${checks.markersInView.inView}/${checks.markersInView.count}`);
    await shot('1-cruise-settled');

    // Find me money: REVEAL settles (halo appears), then HERO.
    const heroStart = await pageNow();
    await page.evaluate(() => {
      const input = document.getElementById('ts-demo-input');
      const form = document.getElementById('ts-demo-form');
      if (input && form) {
        input.value = 'Find me money';
        form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      } else {
        window.__terraSignal?.handleIntent?.('Find me money');
      }
    }).catch(() => {});
    playLog.push('"Find me money" → typed-bar');

    if (await waitForShot('REVEAL')) await shot('2-reveal-settled');
    else record('SHOT 2 skipped — REVEAL never settled');

    const heroed = await waitForShot('HERO');
    windows.hero = [heroStart, await pageNow()];
    playLog.push(`hero settled: ${heroed}`);
    checks.heroCentred = await focusedMarkerFrame();
    record(`CHECK focused marker frame position: ${JSON.stringify(checks.heroCentred)}`);
    await shot('3-hero-settled');

    const orbitStart = await pageNow();
    await new Promise((r) => setTimeout(r, 5_000));
    windows.orbit = [orbitStart, await pageNow()];
    await shot('4-hero-orbit-5s');

    // A hop: move to the next house and catch it at the apex.
    await page.evaluate(() => window.__terraSignal?.handleIntent?.('next')).catch(() => {});
    await new Promise((r) => setTimeout(r, 1_250));
    await shot('5-hop-midpoint');
    await new Promise((r) => setTimeout(r, 2_500));

    await page.evaluate(() => window.__terraSignal?.handleIntent?.('start drive')).catch(() => {});
    await new Promise((r) => setTimeout(r, 3_500));
    await shot('6-drive');
    await page.evaluate(() => window.__terraSignal?.handleIntent?.('stop drive')).catch(() => {});
    await new Promise((r) => setTimeout(r, 1_000));

    for (const phrase of PLAY_PHRASES.filter((p) => p !== 'Find me money')) {
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
  const respondAt = (PLAY || SIX || DRIVE) ? Date.now() - started + 2_000 : RESPOND_AT_MS;
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

  const runMs = PLAY ? PLAY_RUN_MS : (DRIVE ? DRIVE_RUN_MS : (SIX ? SIX_RUN_MS : RUN_MS));
  await new Promise((r) => setTimeout(r, Math.max(0, runMs - (Date.now() - started))));
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
  const frames = await page.evaluate(() => window.__probeFrames || []).catch(() => []);
  const targetFrameRate = await page.evaluate(
    () => window.__godsEyeView?.viewer?.targetFrameRate ?? null,
  ).catch(() => null);
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
  const descentFrames = frameStats(frames, windows.descent);
  const heroFrames = frameStats(frames, windows.hero);
  const cruiseFrames = frameStats(frames, windows.cruise);
  const orbitFrames = frameStats(frames, windows.orbit);
  const measured = [descentFrames, heroFrames].filter(Boolean);
  // Only a --play run measures frames; a plain run must not fail on no data.
  const framesOk = !PLAY || (measured.length === 2
    && measured.every((stat) => stat.p95 <= FRAME_P95_BUDGET_MS));

  // The cap the app chose for this machine, not the one we hoped for.
  const sixBudgetMs = SIX
    ? Math.max(
      SIX_FRAME_P95_BUDGET_MS,
      Number.isFinite(targetFrameRate) && targetFrameRate > 0
        ? (1000 / targetFrameRate) * FRAME_CAP_TOLERANCE
        : 0,
    )
    : SIX_FRAME_P95_BUDGET_MS;
  const sixCruiseFrames = frameStats(frames, windows.sixCruise);
  const sixHeroFrames = frameStats(frames, windows.sixHero);
  const sixMeasured = [sixCruiseFrames, sixHeroFrames].filter(Boolean);
  const sixFramesOk = !SIX || (sixMeasured.length === 2
    && sixMeasured.every((stat) => stat.p95 <= sixBudgetMs));
  // The scene is only proved if all six parcels built, every one of them off a
  // real footprint, and the layer actually switched on at 900 m.
  const sixSceneOk = !SIX || Boolean(
    checks.scene?.mode === 'six'
    && checks.scene.rows === 6
    && checks.scene.types?.length === 5
    && checks.scene.goldId
    && checks.cruiseEffects?.active === true
    && checks.cruiseEffects.count === 6
    && checks.cruiseEffects.surveyed === 6,
  );
  // "show me the best one" has to land on the house the ranking chose.
  const sixGoldOk = !SIX || Boolean(
    checks.heroScene?.focusedId
    && checks.heroScene.focusedId === checks.scene?.goldId,
  );
  /**
   * Every any-angle move keeps the house in the middle of the frame.
   *
   * This is the whole claim of routing the angle commands through the hero
   * framing rather than through raw headings: the camera travels and the
   * subject does not. A move that swings 180 degrees and leaves the house in a
   * corner has not re-framed anything, it has just moved.
   */
  const angleHalf = ANGLE_CENTRE_FRACTION / 2;
  const angleRows = checks.angles || [];
  const sixAnglesOk = !SIX || (angleRows.length === SIX_ANGLES.length && angleRows.every(
    (row) => row.frame
      && Math.abs(row.frame.fx - 0.5) <= angleHalf
      && Math.abs(row.frame.fy - 0.5) <= angleHalf,
  ));
  // The occlusion sweep has to have actually run and chosen something.
  const sixAngleChoiceOk = !SIX || Boolean(
    checks.angleChoice?.angles
    && Object.keys(checks.angleChoice.angles).length > 0,
  );

  // ---- drive verdict ----
  const driveFrames = frameStats(frames, windows.drive);
  const driveBudgetMs = Math.max(
    SIX_FRAME_P95_BUDGET_MS,
    Number.isFinite(targetFrameRate) && targetFrameRate > 0
      ? (1000 / targetFrameRate) * FRAME_CAP_TOLERANCE
      : 0,
  );
  const driveFramesOk = !DRIVE || Boolean(driveFrames && driveFrames.p95 <= driveBudgetMs);
  /**
   * Every signal type on the route has to get announced at least once.
   *
   * A drive that silently skipped a type would look fine — the houses are all
   * drawn — and would mean the narration window is too narrow for the speed,
   * which is the failure this exists to catch.
   */
  const driveTypes = new Set(checks.drivePlan?.signalTypes || []);
  const announcedIds = new Set(checks.driveCallouts.flatMap((c) => c.ids || []));
  const driveCoverageOk = !DRIVE || Boolean(
    driveTypes.size > 0
    && checks.drivePlan
    && announcedIds.size >= checks.drivePlan.properties,
  );
  // Exactly one gold call-out, because exactly one best match was requested.
  const goldCallouts = checks.driveCallouts.filter((c) => c.gold);
  const driveGoldOk = !DRIVE || goldCallouts.length === 1;
  const drivePropertyOk = !DRIVE || checks.drivePropertyMode?.mode === 'property';
  const driveRanOk = !DRIVE || Boolean(checks.drivePlan?.properties > 0);

  const markersOk = !PLAY || (checks.markersInView?.inView ?? 0) >= MIN_MARKERS_IN_VIEW;
  const half = HERO_CENTRE_FRACTION / 2;
  const heroOk = !PLAY || (checks.heroCentred
    && Math.abs(checks.heroCentred.fx - 0.5) <= half
    && Math.abs(checks.heroCentred.fy - 0.5) <= half);

  const pass = paintOk && respondOk && errorsOk && renderOk && loopOk
    && framesOk && markersOk && heroOk
    && sixFramesOk && sixSceneOk && sixGoldOk && sixAnglesOk && sixAngleChoiceOk
    && driveRanOk && driveFramesOk && driveCoverageOk && driveGoldOk && drivePropertyOk;

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
    ...(SIX ? [
      `  ${sixSceneOk ? 'PASS' : 'FAIL'}  six-house scene    `
        + `${checks.scene?.rows ?? 0} rows · ${checks.scene?.types?.length ?? 0}/5 signals · `
        + `span ${checks.scene?.spanM == null ? '?' : Math.round(checks.scene.spanM)} m · `
        + `gold ${checks.scene?.goldId ?? 'NONE'}`,
      `  ${checks.cruiseEffects?.active ? 'PASS' : 'FAIL'}  near-field layer   `
        + `active=${checks.cruiseEffects?.active} · ${checks.cruiseEffects?.surveyed ?? 0} surveyed`
        + ` / ${checks.cruiseEffects?.count ?? 0} built · `
        + `camera ${checks.cruiseEffects?.cameraAglM ?? '?'} m AGL`,
      `  ${sixGoldOk ? 'PASS' : 'FAIL'}  best one → HERO    `
        + `focused ${checks.heroScene?.focusedId ?? 'NONE'}`
        + ` (gold ${checks.scene?.goldId ?? 'NONE'})`,
      `  ${sixFramesOk ? 'PASS' : 'FAIL'}  frame time p95     `
        + `cruise ${sixCruiseFrames ? `${sixCruiseFrames.p95}ms` : 'no data'} · `
        + `hero ${sixHeroFrames ? `${sixHeroFrames.p95}ms` : 'no data'} `
        + `(budget ${sixBudgetMs.toFixed(1)}ms`
        + `${Number.isFinite(targetFrameRate) ? ` — viewer capped at ${targetFrameRate} fps` : ''})`,
      `  ${sixAngleChoiceOk ? 'PASS' : 'FAIL'}  best-angle sweep   `
        + `${Object.keys(checks.angleChoice?.angles || {}).length} house(s) scored`
        + (checks.angleChoice?.pose
          ? ` · now ${Math.round(checks.angleChoice.pose.headingDeg)}°`
            + ` @ ${Math.round(checks.angleChoice.pose.rangeM)} m`
          : ''),
      `  ${sixAnglesOk ? 'PASS' : 'FAIL'}  any-angle framing  `
        + (angleRows.length
          ? angleRows.map((row) => `${row.phrase.replace('show me the ', '')} `
            + (row.frame
              ? `${(row.frame.fx * 100).toFixed(0)}/${(row.frame.fy * 100).toFixed(0)}%`
              : 'OFF SCREEN')).join(' · ')
          : 'no moves driven')
        + ` (centre ${ANGLE_CENTRE_FRACTION * 100}%)`,
      `        ground pulses      `
        + `ring on ${checks.angleChoice?.pulses?.ringId ?? 'NONE'}`
        + ` · supported=${checks.angleChoice?.pulses?.supported ?? '?'}`,
      `        county parcels     `
        + `${checks.cruiseEffects?.parcels ?? 0} surveyed lot lines · `
        + `tint ${checks.heroEffects?.classification ? 'classified' : 'UNAVAILABLE'}`
        + ` on [${(checks.heroEffects?.tinted || []).join(', ') || 'none'}]`,
    ] : []),
    ...(DRIVE ? [
      `  ${driveRanOk ? 'PASS' : 'FAIL'}  route              `
        + `${checks.drivePlan ? `${(checks.drivePlan.lengthM / 1000).toFixed(2)} km · `
          + `${checks.drivePlan.properties} properties · `
          + `${checks.drivePlan.signalTypes.length} signal types` : 'NO PLAN'}`,
      `  ${driveCoverageOk ? 'PASS' : 'FAIL'}  call-outs          `
        + `${checks.driveCallouts.length} call-outs covering ${announcedIds.size}`
        + `/${checks.drivePlan?.properties ?? '?'} properties`,
      `  ${driveGoldOk ? 'PASS' : 'FAIL'}  gold call-out      `
        + `${goldCallouts.length} (expected exactly 1 — best match was requested)`,
      `  ${drivePropertyOk ? 'PASS' : 'FAIL'}  look closer        `
        + `mode ${checks.drivePropertyMode?.mode ?? 'NONE'}`,
      `        motion tiles       `
        + `sse ${checks.driveState?.tileBudget?.current ?? '?'} `
        + `(rest ${checks.driveState?.tileBudget?.baseline ?? '?'}, `
        + `motion ${checks.driveState?.tileBudget?.motionSse ?? '?'})`,
      `  ${driveFramesOk ? 'PASS' : 'FAIL'}  frame time p95     `
        + `drive ${driveFrames ? `${driveFrames.p95}ms` : 'no data'} `
        + `(budget ${driveBudgetMs.toFixed(1)}ms`
        + `${Number.isFinite(targetFrameRate) ? ` — viewer capped at ${targetFrameRate} fps` : ''})`,
    ] : []),
    ...(PLAY ? [
      `  ${markersOk ? 'PASS' : 'FAIL'}  markers at CRUISE  `
        + `${checks.markersInView?.inView ?? 0} of ${checks.markersInView?.count ?? 0} in view `
        + `(min ${MIN_MARKERS_IN_VIEW})`,
      `  ${heroOk ? 'PASS' : 'FAIL'}  hero centred       `
        + (checks.heroCentred
          ? `x ${(checks.heroCentred.fx * 100).toFixed(0)}% y ${(checks.heroCentred.fy * 100).toFixed(0)}%`
          : 'focused marker not on screen')
        + ` (centre ${HERO_CENTRE_FRACTION * 100}%)`,
      `  ${framesOk ? 'PASS' : 'FAIL'}  frame time p95     `
        + `descent ${descentFrames ? `${descentFrames.p95}ms` : 'no data'} · `
        + `hero ${heroFrames ? `${heroFrames.p95}ms` : 'no data'} `
        + `(budget ${FRAME_P95_BUDGET_MS}ms)`,
    ] : []),
    `        tiles              ${tileSummary}`,
    `        governor           mode=${state.mode ?? '?'} holds=[${(state.holds || []).join(', ')}]`,
    '='.repeat(74),
  ];
  if (DRIVE) {
    if (driveFrames) {
      out.push(`  frames driving: n=${driveFrames.n} over ${driveFrames.seconds}s  `
        + `p50 ${driveFrames.p50}ms  p95 ${driveFrames.p95}ms  worst ${driveFrames.worst}ms`);
    }
    if (shots.length) {
      out.push('  screenshots:');
      for (const file of shots) out.push(`    ${file}`);
    }
    out.push('  sequence:');
    for (const line of playLog) out.push(`    ${line}`);
  }
  if (SIX) {
    for (const [label, stat] of [
      ['cruise over cluster', sixCruiseFrames],
      ['fly to gold + hero', sixHeroFrames],
    ]) {
      if (!stat) { out.push(`  frames ${label}: no data`); continue; }
      out.push(`  frames ${label}: n=${stat.n} over ${stat.seconds}s  `
        + `p50 ${stat.p50}ms  p95 ${stat.p95}ms  worst ${stat.worst}ms`);
    }
    if (checks.heroEffects) {
      out.push(`  effects at HERO: active=${checks.heroEffects.active} `
        + `camera ${checks.heroEffects.cameraAglM ?? '?'} m above ground`);
    }
    if (shots.length) {
      out.push('  screenshots:');
      for (const file of shots) out.push(`    ${file}`);
    }
    out.push('  sequence:');
    for (const line of playLog) out.push(`    ${line}`);
  }
  if (PLAY) {
    for (const [label, stat] of [
      ['descent', descentFrames],
      ['cruise settled', cruiseFrames],
      ['hero flight', heroFrames],
      ['hero orbit', orbitFrames],
    ]) {
      if (!stat) { out.push(`  frames ${label}: no data`); continue; }
      out.push(`  frames ${label}: n=${stat.n} over ${stat.seconds}s  `
        + `p50 ${stat.p50}ms  p95 ${stat.p95}ms  worst ${stat.worst}ms`);
    }
    if (shots.length) {
      out.push('  screenshots:');
      for (const file of shots) out.push(`    ${file}`);
    }
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
