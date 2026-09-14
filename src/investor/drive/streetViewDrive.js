/**
 * Drive Mode v2 — Street View is the driving view.
 *
 * Drive Mode v1 drove a chase camera 55 m over the road because that was the
 * only camera there was. It reads as a drive, but it is a drive nobody has ever
 * taken: an investor looking at a street looks *along* it from a car, and what
 * they are reading — the roofline, the porch, the fence, whether the grass has
 * been cut — is not legible from above the canopy. So the driving view is now a
 * `StreetViewPanorama`, and the 3D scene stops being the view and becomes the
 * **answer engine**: it is what the product cuts to when a question needs a lot
 * line, a roof, or a block.
 *
 * ## What this module is and is not
 *
 * It is a consumer of the position source, exactly like the chase camera. It
 * takes fixes and moves a panorama; it decides nothing about narration,
 * activation or which house is being discussed. `driveDemo.js` still owns all
 * of that, and still reads the source rather than the spline — which is why a
 * GPS drive and a playback drive resolve the same panoramas in the same order.
 *
 * ## The imagery is Google's and is never touched
 *
 * Nothing here reads a pixel. There is no canvas, no `toDataURL`, no fetch of a
 * tile, no store of a panorama beyond the id currently being displayed, and no
 * derived product of any frame. The panorama element renders itself and carries
 * Google's own attribution and Terms link, and `ensureStreetViewHost` is
 * deliberately written so no drive stylesheet can hide them — see
 * `ATTRIBUTION_GUARD_CSS`. The only thing this module sends to Google is a
 * coordinate and a heading.
 *
 * ## Why the cadence is distance and not time
 *
 * A panorama request per fix would be sixty requests a second, and a request
 * per second would step in metres that depend on playback speed. Panoramas on a
 * residential street sit roughly 10 m apart, so resolving one every 10 m of
 * **route progress** asks for each pano about once, at any speed, forwards or
 * backwards, and asks for none at all while paused.
 */

import {
  deltaDeg,
  normalizeDeg,
  signedAheadM,
  smoothHeading,
  toLocal,
} from './route.js';
import { SIGNAL_LOOK } from '../visuals/propertyPulse.js';
import { GOLD } from '../visuals/goldHalo.js';
import { primarySignal } from '../mock/schema.js';
import { shortAddress } from '../visuals/markers.js';

// ---------------------------------------------------------------------------
// The numbers
// ---------------------------------------------------------------------------

/** Resolve a new panorama every this many metres of route progress. */
export const PANO_STEP_M = 10;
/** How far from the route point a panorama may sit and still be this one. */
export const PANO_RADIUS_M = 25;
/**
 * How much route may pass with no panorama before the drive gives up and falls
 * back to the 3D chase camera. Four consecutive misses at the 10 m cadence.
 */
export const COVERAGE_GAP_M = 40;
/** Signal properties get a pin inside the panorama within this range. */
export const MARKER_RADIUS_M = 120;
/** The POV starts easing towards a discussed house at this range. */
export const POV_EASE_RADIUS_M = 60;
/** And eases back to the direction of travel over this much road past it. */
export const POV_RELEASE_M = 25;
/**
 * The POV never turns further off the direction of travel than this.
 *
 * A panorama looking backwards while the drive moves forwards is disorienting
 * in a way a 3D camera is not: the transition to the next pano then arrives
 * from behind the viewer. 85 degrees is a hard look out of the side window,
 * which is the most a driver actually does.
 */
export const POV_MAX_OFF_TRAVEL_DEG = 85;
/**
 * Time constant of the POV filter.
 *
 * Shorter than the chase camera's 0.9 s because a panorama POV has no
 * inertia to sell — it is a head turning, not a vehicle — and a slow filter
 * reads as the view lagging the road rather than as a smooth pan.
 */
export const POV_TAU_S = 0.55;
/**
 * Playback speed for a Street View drive, in metres per second.
 *
 * Slower than the chase camera's 9 m/s and for a different reason than
 * comfort: each pano transition is Google's own animation, and at 9 m/s a
 * 10 m step arrives before the previous transition has finished, so the drive
 * reads as a stutter of half-played dissolves rather than as travel. It is
 * still a playback rate and still not a claim about a vehicle.
 */
export const STREET_VIEW_SPEED_MPS = 7;

export const COVERAGE = Object.freeze({ STREET_VIEW: 'streetview', CHASE: 'chase' });

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

/** Smoothstep on 0..1. */
function smoothstep(t) {
  const x = clamp(Number(t) || 0, 0, 1);
  return x * x * (3 - 2 * x);
}

// ---------------------------------------------------------------------------
// Cadence
// ---------------------------------------------------------------------------

/**
 * Is another panorama due?
 *
 * The comparison is a **signed** distance along the loop rather than a raw
 * subtraction, for two reasons that both bite in practice: the route wraps, so
 * 5 m past the start is 5 m after 1,355 m and not 1,350 m before it; and a GPS
 * fix can land slightly behind the last one, which a wrapped-forward-only
 * reading would score as almost a full lap and treat as instantly due.
 *
 * Either direction counts. A drive that has been seeked backwards — "keep
 * going" after a detour — should resolve the panorama where it now is.
 *
 * @param {number|null} lastResolvedAtM route position of the last resolve
 * @param {number} alongM where the drive is now
 * @returns {boolean}
 */
export function panoDue(lastResolvedAtM, alongM, { stepM = PANO_STEP_M, lengthM = 0 } = {}) {
  if (!Number.isFinite(alongM)) return false;
  if (!Number.isFinite(lastResolvedAtM)) return true;
  const delta = lengthM > 0
    ? signedAheadM({ lengthM }, lastResolvedAtM, alongM)
    : alongM - lastResolvedAtM;
  return Math.abs(delta) >= stepM;
}

// ---------------------------------------------------------------------------
// Coverage and the fallback rule
// ---------------------------------------------------------------------------

/** Starting coverage state: assume Street View until told otherwise. */
export function initialCoverage() {
  return { mode: COVERAGE.STREET_VIEW, missedM: 0, lastAtM: null };
}

/**
 * One resolve attempt, folded into the coverage state.
 *
 * The rule the product states is "no panorama within 25 m for 40 m of route",
 * so what accumulates is **route distance across consecutive misses**, not a
 * count of failed requests. Counting requests would make the fallback depend on
 * the cadence, and a drive that fell back after four misses at 10 m and after
 * four misses at 2 m would be two different products.
 *
 * A single hit clears the debt and restores Street View, which is the other
 * half of "until coverage returns".
 *
 * @param {{mode:string, missedM:number, lastAtM:number|null}} state
 * @param {{alongM:number, found:boolean, lengthM?:number, gapM?:number}} attempt
 */
export function nextCoverage(state, { alongM, found, lengthM = 0, gapM = COVERAGE_GAP_M } = {}) {
  const previous = state || initialCoverage();
  if (!Number.isFinite(alongM)) return previous;
  if (found) return { mode: COVERAGE.STREET_VIEW, missedM: 0, lastAtM: alongM };
  const travelled = previous.lastAtM === null
    ? 0
    : Math.abs(lengthM > 0
      ? signedAheadM({ lengthM }, previous.lastAtM, alongM)
      : alongM - previous.lastAtM);
  const missedM = previous.missedM + travelled;
  return {
    mode: missedM >= gapM ? COVERAGE.CHASE : previous.mode,
    missedM,
    lastAtM: alongM,
  };
}

// ---------------------------------------------------------------------------
// POV
// ---------------------------------------------------------------------------

/**
 * How much of the look belongs to the house rather than to the road, 0..1.
 *
 * Rises from nothing at 60 m to full as the drive draws level, then releases
 * over the next 25 m of road. The release is a ramp rather than a switch
 * because the *target* has to be continuous: the POV filter below would smooth
 * a step, but it would smooth it into a swing back through the windscreen that
 * takes a second and a half, and the house is gone by then.
 *
 * @param {number} aheadM positive ahead, negative once passed
 */
export function povBlendFor(aheadM) {
  const d = Number(aheadM);
  if (!Number.isFinite(d)) return 0;
  if (d >= POV_EASE_RADIUS_M) return 0;
  if (d >= 0) return smoothstep(1 - d / POV_EASE_RADIUS_M);
  const past = -d;
  if (past >= POV_RELEASE_M) return 0;
  return smoothstep(1 - past / POV_RELEASE_M);
}

/**
 * The panorama heading for one fix.
 *
 * Travel bearing by default; blended towards the house being discussed as it
 * comes into range; filtered, so the pan is a head turning rather than a cut.
 *
 * The blend is applied to the **signed shortest turn** off the travel bearing,
 * not to the two absolute headings — averaging 359 and 1 the naive way points
 * the camera south.
 *
 * @returns {{headingDeg:number, targetDeg:number, blend:number}}
 */
export function povHeadingFor({
  previousHeadingDeg = null,
  travelBearingDeg = 0,
  houseBearingDeg = null,
  aheadM = Infinity,
  dtSeconds = 0.25,
  tauS = POV_TAU_S,
} = {}) {
  const travel = normalizeDeg(travelBearingDeg);
  const blend = Number.isFinite(houseBearingDeg) ? povBlendFor(aheadM) : 0;
  let targetDeg = travel;
  if (blend > 0) {
    const off = clamp(
      deltaDeg(travel, houseBearingDeg),
      -POV_MAX_OFF_TRAVEL_DEG,
      POV_MAX_OFF_TRAVEL_DEG,
    );
    targetDeg = normalizeDeg(travel + off * blend);
  }
  return {
    headingDeg: smoothHeading(previousHeadingDeg, targetDeg, dtSeconds, { tauS }),
    targetDeg,
    blend,
  };
}

// ---------------------------------------------------------------------------
// Markers inside the panorama
// ---------------------------------------------------------------------------

function hexOf([r, g, b]) {
  const byte = (v) => Math.round(clamp(Number(v) || 0, 0, 1) * 255).toString(16).padStart(2, '0');
  return `#${byte(r)}${byte(g)}${byte(b)}`;
}

/** The gold accent, as the hex a Google marker icon wants. */
export const GOLD_HEX = hexOf([GOLD.r, GOLD.g, GOLD.b]);

/**
 * Which signal properties get a pin in the panorama right now.
 *
 * 120 m rather than the whole route because a `StreetViewPanorama` will happily
 * place a marker a kilometre away and render it as a speck on the horizon over
 * a house that is not the house. The label is the top pick's alone: a street of
 * five labelled pins is a map legend, and the one thing worth reading at speed
 * is which of them is the answer.
 *
 * @param {Array} rows drive rows (`{id, property}`) or plain properties
 * @param {{position:{lat:number,lng:number}, radiusM?:number, topPickId?:string}} options
 */
export function panoMarkersFor(rows, { position, radiusM = MARKER_RADIUS_M, topPickId = null } = {}) {
  if (!Number.isFinite(position?.lat) || !Number.isFinite(position?.lng)) return [];
  const origin = { lat: position.lat, lng: position.lng };
  const out = [];
  for (const row of rows || []) {
    const property = row?.property || row;
    if (!Number.isFinite(property?.lat) || !Number.isFinite(property?.lng)) continue;
    const [east, north] = toLocal([property.lng, property.lat], origin);
    const distanceM = Math.hypot(east, north);
    if (distanceM > radiusM) continue;
    const gold = Boolean(topPickId) && property.id === topPickId;
    const signalType = primarySignal(property)?.type || 'DISTRESS';
    out.push({
      id: property.id,
      lat: property.lat,
      lng: property.lng,
      distanceM,
      gold,
      signalType,
      color: gold ? GOLD_HEX : hexOf((SIGNAL_LOOK[signalType] || SIGNAL_LOOK.DISTRESS).color),
      // An empty string is not a label: a row with no address must not produce
      // a gold pin with a blank white box floating next to it.
      label: gold ? (shortAddress(property) || null) : null,
    });
  }
  // Nearest last, so the closest pin is appended over the ones behind it.
  return out.sort((a, b) => b.distanceM - a.distanceM);
}

// ---------------------------------------------------------------------------
// The Maps JavaScript API
// ---------------------------------------------------------------------------

const MAPS_SCRIPT_ID = 'ts-google-maps-js';
const MAPS_CALLBACK = '__terraSignalMapsReady';

/**
 * Load the Maps JavaScript API once, and be honest about a key that refuses.
 *
 * Google does not reject the bootstrap request for a bad key — the script loads
 * and then fails at the point of use, which is how a broken key presents as a
 * blank grey box rather than as an error. Two things catch it: `gm_authFailure`,
 * which Google calls for `InvalidKeyMapError` and `RefererNotAllowedMapError`,
 * and a timeout, for the case where the script host is blocked outright.
 *
 * @returns {Promise<{ok:boolean, maps?:object, reason?:string}>}
 */
export function loadGoogleMaps({
  apiKey,
  win = globalThis,
  doc = globalThis.document,
  timeoutMs = 12_000,
} = {}) {
  if (!apiKey) {
    return Promise.resolve({ ok: false, reason: 'no GOOGLE_MAPS_API_KEY in this build' });
  }
  if (win.google?.maps?.StreetViewPanorama) {
    return Promise.resolve({ ok: true, maps: win.google.maps });
  }
  if (win[MAPS_CALLBACK]?.promise) return win[MAPS_CALLBACK].promise;
  if (!doc?.createElement) return Promise.resolve({ ok: false, reason: 'no document' });

  const promise = new Promise((resolve) => {
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    // Google calls this by name on an auth failure, and only then.
    win.gm_authFailure = () => finish({
      ok: false,
      reason: 'the Google Maps key refused this origin (check the key\'s API '
        + 'restrictions include Maps JavaScript API, and its HTTP referrer list)',
    });
    const timer = win.setTimeout(
      () => finish({ ok: false, reason: `maps.googleapis.com did not load in ${timeoutMs} ms` }),
      timeoutMs,
    );
    win[MAPS_CALLBACK] = Object.assign(() => {
      win.clearTimeout(timer);
      finish(win.google?.maps?.StreetViewPanorama
        ? { ok: true, maps: win.google.maps }
        : { ok: false, reason: 'Maps JS loaded without StreetViewPanorama' });
    }, { promise: null });

    const script = doc.createElement('script');
    script.id = MAPS_SCRIPT_ID;
    script.async = true;
    script.src = 'https://maps.googleapis.com/maps/api/js'
      + `?key=${encodeURIComponent(apiKey)}&v=weekly&loading=async&callback=${MAPS_CALLBACK}`;
    script.addEventListener('error', () => {
      win.clearTimeout(timer);
      finish({ ok: false, reason: 'the Maps JavaScript API script failed to load' });
    });
    doc.head.appendChild(script);
  });
  win[MAPS_CALLBACK] = win[MAPS_CALLBACK] || (() => {});
  win[MAPS_CALLBACK].promise = promise;
  return promise;
}

/** Read the key the way the rest of the app does, without importing main.js. */
export function readMapsApiKey(win = globalThis) {
  try {
    return win.__GOOGLE_MAPS_API_KEY__ || import.meta.env?.GOOGLE_MAPS_API_KEY || '';
  } catch {
    return win.__GOOGLE_MAPS_API_KEY__ || '';
  }
}

// ---------------------------------------------------------------------------
// The host element
// ---------------------------------------------------------------------------

export const STREET_VIEW_HOST_ID = 'ts-streetview';
/**
 * The panorama gets its own element inside the host, and this is not tidiness.
 *
 * The Maps JavaScript API **writes `position: relative` inline onto whatever
 * container it is given**, and an inline style beats a stylesheet: the host's
 * `position: fixed` became `relative`, `top: 0; bottom: 0` stopped stretching
 * anything, and the box collapsed to its content — which is zero, because
 * everything Google puts inside it is absolutely positioned. The result was a
 * full-width, **zero-height** element that was present, opaque, correct in
 * every property the probe could read, and drew nothing at all: 125 panoramas
 * resolved, five images loaded, and the screen showed the 3D scene straight
 * through it.
 *
 * So the host owns the layout and this inner element is what Google is handed
 * to rewrite.
 */
export const STREET_VIEW_PANO_ID = 'ts-streetview-pano';
const HOST_STYLE_ID = 'ts-streetview-style';

/**
 * Google's attribution is not ours to restyle.
 *
 * Drive Mode hides the standing HUD with one class on `<body>`, and the easiest
 * possible mistake is a selector broad enough to catch the logo and Terms link
 * the panorama renders for itself. These rules are `!important` and they exist
 * to make that mistake impossible rather than unlikely.
 */
const ATTRIBUTION_GUARD_CSS = `
#${STREET_VIEW_HOST_ID} .gm-style-cc,
#${STREET_VIEW_HOST_ID} .gmnoprint,
#${STREET_VIEW_HOST_ID} a[href*="maps.google.com"],
#${STREET_VIEW_HOST_ID} a[href*="google.com/maps"],
#${STREET_VIEW_HOST_ID} img[src*="google"] {
  display: revert !important;
  visibility: visible !important;
  opacity: 1 !important;
}
`;

const HOST_CSS = `
#${STREET_VIEW_HOST_ID} {
  /* !important because the Maps API writes position inline; see above. */
  position: fixed !important;
  top: 0;
  left: 0;
  /* Explicit extent as well as insets: a container whose position has been
     rewritten under us must still be the size of the screen. */
  width: 100vw;
  height: 100vh;
  /* Above the Cesium canvas (z-index 0) and below every piece of HUD (40+). */
  z-index: 1;
  opacity: 0;
  background: #05070a;
  pointer-events: none;
  transition: none;
  overflow: hidden;
}
#${STREET_VIEW_HOST_ID}[data-ts-sv-active="true"] { pointer-events: auto; }
#${STREET_VIEW_HOST_ID}[hidden] { display: none !important; }
#${STREET_VIEW_PANO_ID} {
  width: 100%;
  height: 100%;
}
${ATTRIBUTION_GUARD_CSS}
`;

/** Create (once) the element the panorama renders into. */
export function ensureStreetViewHost(doc = globalThis.document) {
  if (!doc?.createElement) return null;
  if (!doc.getElementById(HOST_STYLE_ID)) {
    const style = doc.createElement('style');
    style.id = HOST_STYLE_ID;
    style.textContent = HOST_CSS;
    doc.head.appendChild(style);
  }
  let host = doc.getElementById(STREET_VIEW_HOST_ID);
  if (host) return host;
  host = doc.createElement('div');
  host.id = STREET_VIEW_HOST_ID;
  host.hidden = true;
  host.setAttribute('aria-label', 'Street View — imagery © Google');
  const pano = doc.createElement('div');
  pano.id = STREET_VIEW_PANO_ID;
  host.appendChild(pano);
  doc.body.appendChild(host);
  return host;
}

/** The element the panorama itself is built into. */
export function panoElementOf(host) {
  return host?.querySelector?.(`#${STREET_VIEW_PANO_ID}`) || host || null;
}

// ---------------------------------------------------------------------------
// The driver
// ---------------------------------------------------------------------------

/**
 * Follow a position source with a Street View panorama.
 *
 * `getRoute` rather than a route, because the drive builds the spline and the
 * panorama must measure its cadence against **that** object rather than
 * against a second copy — two `buildRoute` calls on the same coordinates give
 * equal lengths today and would not have to, and a pano step measured in
 * different metres from a call-out is a bug with no symptom until it is one.
 *
 * @param {{getRoute:Function, getRows:Function, getTopPickId:Function,
 *   apiKey?:string, host?:Element, loader?:Function, onCoverage?:Function,
 *   onPano?:Function, onError?:Function}} deps
 */
export function createStreetViewDrive({
  getRoute = () => null,
  getRows = () => [],
  getTopPickId = () => null,
  apiKey = readMapsApiKey(),
  host = null,
  loader = loadGoogleMaps,
  doc = globalThis.document,
  win = globalThis,
  onCoverage = null,
  onPano = null,
  onError = null,
} = {}) {
  let maps = null;
  let panorama = null;
  let service = null;
  let element = host;
  let ready = false;
  let failure = null;
  let destroyed = false;

  let coverage = initialCoverage();
  let lastResolvedAtM = null;
  let inFlight = false;
  let panoId = null;
  let panoCount = 0;
  let requests = 0;
  let hits = 0;
  let headingDeg = null;
  let markers = [];
  let markerRows = [];
  let markerKey = '';
  /**
   * Every panorama id this drive has stood on.
   *
   * A count of transitions is not a measure of coverage: a drive that ping-pongs
   * between two panoramas at a junction advances the count without going
   * anywhere. The set is what says how much of the route actually had imagery.
   */
  const seenPanos = new Set();

  function fail(reason) {
    if (failure) return;
    failure = reason;
    // A refused key is a product fact, not a crash: the drive keeps going on
    // the 3D chase camera and the HUD says why.
    coverage = { ...coverage, mode: COVERAGE.CHASE };
    onError?.(reason);
    onCoverage?.(COVERAGE.CHASE, { reason });
  }

  /** Load the API and build the panorama. Idempotent. */
  async function mount() {
    if (ready || failure || destroyed) return { ok: ready, reason: failure };
    element = element || ensureStreetViewHost(doc);
    if (!element) {
      fail('no DOM to host a panorama');
      return { ok: false, reason: failure };
    }
    const loaded = await loader({ apiKey, win, doc });
    if (destroyed) return { ok: false, reason: 'destroyed' };
    if (!loaded?.ok) {
      fail(loaded?.reason || 'the Maps JavaScript API did not load');
      return { ok: false, reason: failure };
    }
    maps = loaded.maps;
    // The panorama measures its container at construction, and a container
    // inside a `hidden` ancestor measures zero. Give it the layout first; the
    // host is still fully transparent, so nothing appears early.
    element.hidden = false;
    try {
      panorama = new maps.StreetViewPanorama(panoElementOf(element), {
        // No UI of Google's own beyond what carries the attribution: the drive
        // supplies the controls, and a pegman compass over a demo is noise.
        addressControl: false,
        linksControl: false,
        panControl: false,
        zoomControl: false,
        fullscreenControl: false,
        motionTracking: false,
        motionTrackingControl: false,
        showRoadLabels: false,
        clickToGo: false,
        scrollwheel: false,
        disableDoubleClickZoom: true,
        visible: true,
      });
      service = new maps.StreetViewService();
      ready = true;
    } catch (error) {
      fail(`StreetViewPanorama refused to build: ${error?.message || error}`);
      return { ok: false, reason: failure };
    }
    return { ok: true };
  }

  /**
   * Ask for the nearest panorama and move to it.
   *
   * One request in flight at a time. The cadence is distance-based and the
   * network is not, so at 4x playback a second request comes due before the
   * first has answered — letting both run means the panorama hops to whichever
   * resolves last, which on a loop is not necessarily the nearer one.
   */
  function resolvePano(position, alongM) {
    if (!ready || inFlight || !service) return;
    inFlight = true;
    requests += 1;
    service.getPanorama(
      {
        location: { lat: position.lat, lng: position.lng },
        radius: PANO_RADIUS_M,
        source: 'outdoor',
        preference: 'nearest',
      },
      (data, status) => {
        inFlight = false;
        if (destroyed) return;
        const found = status === 'OK' && Boolean(data?.location?.pano);
        const before = coverage.mode;
        coverage = nextCoverage(coverage, {
          alongM,
          found,
          lengthM: getRoute()?.lengthM || 0,
        });
        lastResolvedAtM = alongM;
        if (found) {
          hits += 1;
          const nextId = data.location.pano;
          if (nextId !== panoId) {
            panoId = nextId;
            panoCount += 1;
            seenPanos.add(nextId);
            // setPano is what plays Google's own animated transition between
            // neighbouring panoramas. setPosition would jump.
            try { panorama.setPano(nextId); } catch { /* pano vanished */ }
            onPano?.({ panoId: nextId, alongM, position });
          }
        }
        if (coverage.mode !== before) onCoverage?.(coverage.mode, { missedM: coverage.missedM });
      },
    );
  }

  /** Pins for the signal properties within 120 m, rebuilt only when they change. */
  function syncMarkers(position) {
    if (!ready || !maps) return;
    const wanted = panoMarkersFor(getRows(), {
      position,
      topPickId: getTopPickId(),
    });
    const key = wanted.map((m) => `${m.id}:${m.gold ? 'g' : 's'}`).join('|');
    if (key === markerKey) return;
    markerKey = key;
    for (const marker of markers) {
      try { marker.setMap(null); } catch { /* already gone */ }
    }
    markerRows = wanted;
    markers = wanted.map((row) => new maps.Marker({
      position: { lat: row.lat, lng: row.lng },
      map: panorama,
      title: row.label || undefined,
      icon: {
        path: maps.SymbolPath.CIRCLE,
        scale: row.gold ? 11 : 7,
        fillColor: row.color,
        fillOpacity: row.gold ? 1 : 0.9,
        strokeColor: '#0b0d10',
        strokeWeight: row.gold ? 3 : 2,
      },
      label: row.label
        ? {
          text: row.label,
          color: GOLD_HEX,
          fontFamily: 'Inter, system-ui, sans-serif',
          fontSize: '13px',
          fontWeight: '600',
        }
        : undefined,
      optimized: false,
      clickable: false,
    }));
  }

  return {
    get ready() { return ready; },
    get failure() { return failure; },
    get mode() { return coverage.mode; },
    get coverage() { return { ...coverage }; },
    get panoId() { return panoId; },
    get panoCount() { return panoCount; },
    get headingDeg() { return headingDeg; },
    get element() { return element; },
    get stats() {
      return {
        requests,
        hits,
        panoCount,
        uniquePanos: seenPanos.size,
        missedM: coverage.missedM,
        mode: coverage.mode,
      };
    },
    /** What is pinned in the panorama right now — the headed probe reads this. */
    get markers() {
      return markers.map((marker, index) => ({
        id: markerRows[index]?.id ?? null,
        gold: Boolean(markerRows[index]?.gold),
        label: markerRows[index]?.label ?? null,
      }));
    },
    get panorama() { return panorama; },

    mount,

    /**
     * Show or hide the panorama itself.
     *
     * Two jobs, and both matter. `setVisible(false)` is what stops Google
     * streaming imagery for a view nobody is looking at — an element at
     * opacity 0 is still a panorama fetching tiles. And the **resize trigger**
     * on the way back is what makes a panorama that was measured inside a
     * `display: none` ancestor size itself to the screen again; without it the
     * element comes back present, opaque and empty.
     */
    setVisible(on) {
      if (!ready || !element) return false;
      if (!on) {
        try { panorama?.setVisible?.(false); } catch { /* already gone */ }
        return true;
      }
      element.hidden = false;
      try { panorama?.setVisible?.(true); } catch { /* not built */ }
      const remeasure = () => {
        try { maps?.event?.trigger?.(panorama, 'resize'); } catch { /* gone */ }
      };
      remeasure();
      // Once more after layout: the element was display:none one tick ago and
      // its box is not final until the next style recalculation.
      win.setTimeout?.(remeasure, 0);
      return true;
    },

    /**
     * One fix.
     *
     * @param {{position:object, bearingDeg:number}} fix
     * @param {{alongM:number, house?:object, houseAheadM?:number,
     *   dtSeconds?:number}} context the drive's own projection and whatever
     *   house it is currently talking about
     */
    update(fix, { alongM, house = null, houseAheadM = Infinity, dtSeconds = 0.25 } = {}) {
      if (!ready || destroyed || !fix?.position) return null;
      const position = fix.position;

      let houseBearingDeg = null;
      if (Number.isFinite(house?.lat) && Number.isFinite(house?.lng)) {
        const [east, north] = toLocal([house.lng, house.lat], position);
        houseBearingDeg = normalizeDeg(Math.atan2(east, north) * 180 / Math.PI);
      }
      const pov = povHeadingFor({
        previousHeadingDeg: headingDeg,
        travelBearingDeg: fix.bearingDeg,
        houseBearingDeg,
        aheadM: houseAheadM,
        dtSeconds,
      });
      headingDeg = pov.headingDeg;
      try {
        panorama.setPov({ heading: headingDeg, pitch: 0 });
      } catch { /* panorama between panos */ }

      if (panoDue(lastResolvedAtM, alongM, { lengthM: getRoute()?.lengthM || 0 })) {
        resolvePano(position, alongM);
      }
      syncMarkers(position);
      return { headingDeg, blend: pov.blend, mode: coverage.mode, panoId };
    },

    /** Reset the cadence — after a seek, the pano where we now are is due. */
    reseat() {
      lastResolvedAtM = null;
      headingDeg = null;
    },

    /** Start a fresh drive: no coverage debt carried over from the last one. */
    reset() {
      coverage = initialCoverage();
      lastResolvedAtM = null;
      headingDeg = null;
      panoId = null;
      panoCount = 0;
      requests = 0;
      hits = 0;
      markerKey = '';
      seenPanos.clear();
    },

    clearMarkers() {
      for (const marker of markers) {
        try { marker.setMap(null); } catch { /* already gone */ }
      }
      markers = [];
      markerRows = [];
      markerKey = '';
    },

    destroy() {
      destroyed = true;
      this.clearMarkers();
      try { panorama?.setVisible?.(false); } catch { /* already gone */ }
      if (element) element.hidden = true;
      panorama = null;
      service = null;
      ready = false;
    },
  };
}
