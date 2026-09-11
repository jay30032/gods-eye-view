import { holdContinuousRender, releaseContinuousRender } from '../renderGovernor.js';
import { compositeScore, primarySignal } from './mock/schema.js';
import { whyThisMatters } from './focus.js';

const HOLD_ID = 'investor-drive';
const URGENT_SIGNALS = new Set(['FORECLOSURE', 'TAX_SALE']);
const DRIVE_MIN_COMPOSITE = 86;
const DRIVE_MIN_CONFIDENCE = 0.78;

/** Worth a detour: a high composite, or a clock already running on the house. */
export function isStrongDriveSignal(property) {
  const signal = primarySignal(property);
  return Boolean(
    compositeScore(property) >= DRIVE_MIN_COMPOSITE
    || (signal && URGENT_SIGNALS.has(signal.type) && signal.confidence >= DRIVE_MIN_CONFIDENCE),
  );
}

export function buildDriveRoute(properties) {
  return properties
    .filter(isStrongDriveSignal)
    .sort((a, b) => compositeScore(b) - compositeScore(a))
    .slice(0, 8);
}

/**
 * Simulated drive — not GPS. Camera steps along a mock route and announces
 * strong signals only. why / save / skip / next are session commands.
 */
export function createDriveDemo({
  viewer,
  Cesium,
  getProperties,
  onAnnounce,
  onStop,
}) {
  let stops = [];
  let index = -1;
  let timer = null;
  let running = false;
  let skipped = new Set();

  function clearTimer() {
    if (timer) {
      globalThis.clearTimeout(timer);
      timer = null;
    }
  }

  function current() {
    return stops[index] || null;
  }

  function goTo(property, { announce = true } = {}) {
    if (!property || !viewer) return;
    viewer.camera.cancelFlight();
    viewer.camera.flyTo({
      destination: Cesium.Cartesian3.fromDegrees(property.lng, property.lat, 380),
      orientation: {
        heading: Cesium.Math.toRadians(40),
        pitch: Cesium.Math.toRadians(-28),
        roll: 0,
      },
      duration: 2.1,
    });
    if (announce) {
      const signal = primarySignal(property);
      onAnnounce?.({
        id: property.id,
        address: property.address,
        spoken: `Strong ${String(signal?.type || 'signal').replaceAll('_', ' ').toLowerCase()} at ${property.address.split(',')[0]}.`,
        why: whyThisMatters(property),
        property,
      });
    }
  }

  function advance(fromUser = false) {
    if (!running) return { ok: false, running: false };
    index += 1;
    while (index < stops.length && skipped.has(stops[index].id)) index += 1;
    if (index >= stops.length) {
      stop();
      return { ok: true, action: 'stop_drive_demo', done: true, spoken: 'Drive demo finished. That was the last strong signal.' };
    }
    goTo(stops[index], { announce: true });
    clearTimer();
    if (!fromUser) {
      timer = globalThis.setTimeout(() => advance(false), 7000);
    }
    return { ok: true, action: 'start_drive_demo', id: stops[index].id, index, total: stops.length };
  }

  function start() {
    stops = buildDriveRoute(typeof getProperties === 'function' ? getProperties() : []);
    skipped = new Set();
    index = -1;
    if (!stops.length) {
      return { ok: false, action: 'start_drive_demo', spoken: 'No strong mock signals to drive.' };
    }
    running = true;
    holdContinuousRender(HOLD_ID);
    const first = advance(false);
    return {
      ...first,
      spoken: `Drive demo on. ${stops.length} strong signals only. Say why, save, skip, or next.`,
      stops: stops.map((row) => row.id),
    };
  }

  function stop() {
    running = false;
    clearTimer();
    releaseContinuousRender(HOLD_ID);
    onStop?.();
    return { ok: true, action: 'stop_drive_demo', spoken: 'Drive demo stopped.' };
  }

  function next() {
    if (!running) return start();
    clearTimer();
    return { ...advance(true), spoken: current() ? `Next: ${current().address.split(',')[0]}.` : 'Drive demo finished.' };
  }

  function skip() {
    const row = current();
    if (row) skipped.add(row.id);
    return next();
  }

  function why() {
    const row = current();
    if (!row) return { ok: false, spoken: 'No current drive stop.' };
    return { ok: true, action: 'explain_property', id: row.id, spoken: whyThisMatters(row), property: row };
  }

  return {
    get running() { return running; },
    get current() { return current(); },
    start,
    stop,
    next,
    skip,
    why,
  };
}
