/**
 * Clear View — the same neighbourhood with the trees taken out.
 *
 * ## The problem the photo world cannot solve
 *
 * Oakhurst is old and heavily canopied. Google's photogrammetry is a
 * photograph, so the oaks are in it: the drive camera sits at 55 m because
 * anything lower spends a residential block looking *through* them, the
 * best-angle sweep casts forty rays per house to find one that is not behind a
 * tree, and some houses simply cannot be seen from any angle in July. Every one
 * of those is a workaround for foliage, and none of them removes it.
 *
 * Clear View removes it. Cesium World Terrain for the ground, Bing aerial for
 * what it looks like, and Cesium OSM Buildings for the houses — three ion
 * assets that between them contain no vegetation at all. The same signal
 * effects, markers, parcels and camera shots run over it unchanged.
 *
 * ## Why this is not a different product
 *
 * It is the same board. The properties, the scores, the drive, the narration
 * and every camera shot are identical; what changes is what the ground and the
 * roofs are made of. So this module owns exactly two things — which world is
 * on screen, and how the buildings are painted — and nothing else in the
 * investor tree learns which world it got.
 *
 * ## Why it drives MapStackController rather than building its own world
 *
 * Terrain and imagery are already solved: `MapStackController` owns the ion
 * Bing layer, the world-terrain provider, the Google tileset's visibility and
 * the generation guards that keep a slow provider from stomping a fast one.
 * Reimplementing that here would be a second, worse copy of a component whose
 * hard cases — a switch superseded mid-fetch, a terrain fetch that hangs on a
 * filtered network — are already handled. This calls `setStack` and adds the
 * one thing that controller does not have: buildings.
 *
 * ## The buildings are deliberately dull
 *
 * A warm light grey, darkened where a surface turns away from the eye. No
 * per-building colour, no height ramp, no age or type styling — every one of
 * those is a colour on the screen competing with the signal colours, and the
 * signals are the product. The only building that is ever coloured is the one
 * the user is being shown, and it is gold because that already means "this is
 * the answer" everywhere else.
 */

import { footprintCentroid } from '../mock/parcel.js';
import { geometryFor } from '../mock/geometry.js';

/** Cesium OSM Buildings on ion. */
export const OSM_BUILDINGS_ASSET_ID = 96188;

/** The stack each world runs on, in `MapStackController`'s own vocabulary. */
export const WORLD_STACKS = Object.freeze({
  photo: 'photoreal',
  clear: 'bing-aerial',
});

export const WORLDS = Object.freeze({ PHOTO: 'photo', CLEAR: 'clear' });

/** How the two worlds trade places. */
export const WORLD_FADE_MS = 600;

export const CLEAR_VIEW_STORAGE_KEY = 'terrasignal:clear-view:v1';

/**
 * How close a building's own position must be to our footprint centroid.
 *
 * Six metres, and the number is doing real work. OSM Buildings carries one
 * representative coordinate per building rather than a footprint, and it is not
 * always the polygon's centroid — so the tolerance has to absorb that offset
 * while staying tight enough to reject the neighbour. On a street of detached
 * houses the gap between one building's centroid and the next is 15-25 m, so
 * six metres is comfortably inside half that and no match is ever ambiguous.
 * Wider and a gold tint lands on the house next door, which is a silent error
 * of exactly the kind the fictional-address rule exists to prevent.
 */
export const BUILDING_MATCH_RADIUS_M = 6;

const M_PER_DEG_LAT = 111_320;

/** Warm light grey. Not white: white roofs at noon are a glare, not a surface. */
export const BUILDING_BASE_CSS = '#d8d2c7';
/** The answer, in the gold that means the answer everywhere else. */
export const BUILDING_GOLD_CSS = '#edbd38';
/** The focused house when it is not the top pick — the same gold, quieter. */
export const BUILDING_FOCUS_CSS = '#e2c98a';

/**
 * Metres between two coordinates, in the local plane.
 *
 * Plane geometry rather than great-circle: at neighbourhood scale the
 * difference is under a millimetre, and this runs once per building feature
 * per tile load.
 */
export function metresBetween(a, b) {
  if (!Number.isFinite(a?.lat) || !Number.isFinite(b?.lat)) return Infinity;
  const mLng = M_PER_DEG_LAT * Math.cos((a.lat * Math.PI) / 180);
  return Math.hypot((b.lng - a.lng) * mLng, (b.lat - a.lat) * M_PER_DEG_LAT);
}

/**
 * Where each property's building actually is, for matching purposes.
 *
 * The **footprint centroid**, not the stored coordinate. Phase 1 already moved
 * the marker and the parcel onto the footprint for the same reason: an authored
 * coordinate can sit in the street or in next door's garden, and matching from
 * one would hand the gold tint to whichever building happened to be nearer it.
 * A row with no footprint has no centroid and is simply never matched — the
 * draped fill stands in, which is the documented fallback.
 */
export function buildingAnchorsFor(properties, { getGeometry = geometryFor } = {}) {
  const anchors = [];
  for (const property of properties || []) {
    const ring = getGeometry(property?.id)?.building?.footprint?.[0] || null;
    const centroid = ring ? footprintCentroid(ring) : null;
    if (!centroid || !Number.isFinite(centroid.lat)) continue;
    anchors.push({ id: property.id, lat: centroid.lat, lng: centroid.lng });
  }
  return anchors;
}

/**
 * Which of our properties this building feature is, or null.
 *
 * Nearest wins, and only inside the radius. Nearest rather than first because
 * two anchors can both be in range on a dense block, and taking the first match
 * would make the answer depend on the order of the inventory.
 *
 * @param {{lat:number, lng:number}} feature the building's own position
 * @param {Array<{id:string, lat:number, lng:number}>} anchors
 */
export function matchBuilding(feature, anchors, { radiusM = BUILDING_MATCH_RADIUS_M } = {}) {
  let best = null;
  let bestM = Infinity;
  for (const anchor of anchors || []) {
    const distanceM = metresBetween(anchor, feature);
    if (distanceM <= radiusM && distanceM < bestM) {
      best = anchor;
      bestM = distanceM;
    }
  }
  return best ? { id: best.id, distanceM: bestM } : null;
}

/**
 * Which colour a building should be.
 *
 * Pure so the rule is inspectable: exactly one building is ever gold, and
 * everything else is the same grey. A board where three houses are lit is a
 * board that has not answered the question.
 */
export function buildingColorFor(id, { topPickId = null, focusedId = null } = {}) {
  if (id && id === topPickId) return BUILDING_GOLD_CSS;
  if (id && id === focusedId) return BUILDING_FOCUS_CSS;
  return BUILDING_BASE_CSS;
}

/** `?world=clear` / `?trees=off`, for a link that opens straight into it. */
export function readWorldFromLocation(location = globalThis.location) {
  try {
    const params = new URLSearchParams(location?.search || '');
    const world = String(params.get('world') || '').trim().toLowerCase();
    if (world === 'clear' || world === 'clearview') return WORLDS.CLEAR;
    if (world === 'photo' || world === 'google') return WORLDS.PHOTO;
    const trees = String(params.get('trees') || '').trim().toLowerCase();
    if (trees === 'off' || trees === '0' || trees === 'false') return WORLDS.CLEAR;
    if (trees === 'on' || trees === '1' || trees === 'true') return WORLDS.PHOTO;
  } catch {
    // no window
  }
  return null;
}

/** The remembered choice, or the default. A URL always wins over storage. */
export function readWorldPreference(defaultWorld = WORLDS.PHOTO, storage = globalThis.localStorage) {
  const fromUrl = readWorldFromLocation();
  if (fromUrl) return fromUrl;
  try {
    const raw = storage?.getItem?.(CLEAR_VIEW_STORAGE_KEY);
    if (raw === WORLDS.CLEAR || raw === WORLDS.PHOTO) return raw;
  } catch {
    // private mode, blocked storage
  }
  return defaultWorld;
}

export function writeWorldPreference(world, storage = globalThis.localStorage) {
  try { storage?.setItem?.(CLEAR_VIEW_STORAGE_KEY, world); } catch { /* ignore */ }
  return world;
}

/**
 * The 600 ms cross-fade between worlds, as a pure function of elapsed time.
 *
 * A scrim over the scene rather than an opacity on either world: the two are
 * the same Cesium scene with different providers in it, so there is no second
 * element to fade against. What the viewer sees is the picture dimming to about
 * a third, the swap happening under the dip, and it coming back — which reads
 * as a transition rather than as a load.
 *
 * The swap point is the darkest moment, not the start, because that is the one
 * instant where a provider changing over is invisible.
 */
export function worldFadeState(elapsedMs, { durationMs = WORLD_FADE_MS, dipTo = 0.68 } = {}) {
  const duration = Math.max(1, Number(durationMs) || WORLD_FADE_MS);
  const t = Math.min(1, Math.max(0, (Number(elapsedMs) || 0) / duration));
  // One symmetric dip: 0 at the ends, 1 at the middle.
  const dip = Math.sin(Math.PI * t);
  const eased = dip * dip * (3 - 2 * dip);
  return {
    t,
    /** Opacity of the scrim over the scene, 0..dipTo. */
    scrim: eased * dipTo,
    /** True once, at the bottom of the dip: the moment to swap worlds. */
    atSwap: t >= 0.5,
    done: t >= 1,
  };
}

// ---------------------------------------------------------------------------
// The buildings
// ---------------------------------------------------------------------------

/**
 * OSM Buildings, painted the one way this product paints buildings.
 *
 * `UNLIT` with the darkening done in the shader rather than PBR lighting. The
 * scene has no sun position the product controls, and lit buildings under a
 * default sun put a hard bright face and a black face on every house — which is
 * a second set of colours competing with the signals, and the wrong ones. The
 * grazing-angle darkening below gives the edges instead: enough to read one
 * roof from the next, flat enough that nothing on a building draws the eye.
 */
function buildingShader(Cesium) {
  return new Cesium.CustomShader({
    lightingModel: Cesium.LightingModel.UNLIT,
    fragmentShaderText: `
      void fragmentMain(FragmentInput fsInput, inout czm_modelMaterial material) {
        vec3 normalEC = normalize(fsInput.attributes.normalEC);
        vec3 viewDirEC = normalize(-fsInput.attributes.positionEC);
        // 1 looking straight at a face, 0 edge-on. Walls seen at a glance get
        // darker, which is what separates a building from its neighbour
        // without giving either of them a colour of its own.
        float facing = abs(dot(normalEC, viewDirEC));
        material.diffuse *= mix(0.62, 1.0, smoothstep(0.0, 0.62, facing));
      }
    `,
  });
}

/**
 * @param {{viewer:object, Cesium:object, mapStackController:object,
 *   getProperties:Function, getTopPickId:Function, getFocusedId:Function,
 *   ionToken?:string, onWorld?:Function, now?:Function}} deps
 */
export function createClearView({
  viewer,
  Cesium,
  mapStackController = null,
  getProperties = () => [],
  getTopPickId = () => null,
  getFocusedId = () => null,
  onWorld = null,
  doc = globalThis.document,
  timers = globalThis,
  now = () => Date.now(),
} = {}) {
  let world = WORLDS.PHOTO;
  let buildings = null;
  let buildingsPending = null;
  let destroyed = false;
  let switching = false;
  let anchors = [];
  let paintRevision = 0;
  let removeTileVisible = null;
  let scrim = null;
  let fadeTimer = null;
  let fadeStartedAt = 0;

  /** propertyId → { elementId, distanceM }. The match rate is read off this. */
  const matched = new Map();
  /** How many building features have been looked at, for the same report. */
  let featuresSeen = 0;
  /** Tile contents already painted at the current revision. */
  const painted = new WeakMap();

  function refreshAnchors() {
    anchors = buildingAnchorsFor(getProperties());
    return anchors;
  }

  /**
   * Paint one tile's features, and match them while we are already walking it.
   *
   * Both jobs in one pass because the expensive part is the walk: OSM Buildings
   * hands out features one at a time and a dense tile has hundreds. Doing this
   * on `tileVisible` with a revision guard means each tile's content is walked
   * once, not once a frame — and re-walked only when the answer changes, which
   * is when the top pick or the focused house moves.
   */
  function paintTile(tile) {
    const content = tile?.content;
    if (!content || typeof content.getFeature !== 'function') return;
    if (painted.get(content) === paintRevision) return;
    painted.set(content, paintRevision);

    const topPickId = getTopPickId();
    const focusedId = getFocusedId();
    const total = content.featuresLength || 0;
    for (let i = 0; i < total; i += 1) {
      let feature = null;
      try { feature = content.getFeature(i); } catch { continue; }
      if (!feature) continue;
      featuresSeen += 1;
      let position = null;
      try {
        position = {
          lat: Number(feature.getProperty('cesium#latitude')),
          lng: Number(feature.getProperty('cesium#longitude')),
        };
      } catch { position = null; }

      const hit = position && Number.isFinite(position.lat)
        ? matchBuilding(position, anchors)
        : null;
      if (hit) {
        const elementId = (() => {
          try { return feature.getProperty('elementId') ?? null; } catch { return null; }
        })();
        const previous = matched.get(hit.id);
        if (!previous || hit.distanceM < previous.distanceM) {
          matched.set(hit.id, { elementId, distanceM: hit.distanceM });
        }
      }
      const css = buildingColorFor(hit?.id || null, { topPickId, focusedId });
      try { feature.color = Cesium.Color.fromCssColorString(css); } catch { /* no batch table */ }
    }
  }

  /** Build the tileset once, the first time Clear View is asked for. */
  async function ensureBuildings() {
    if (buildings || destroyed) return buildings;
    if (buildingsPending) return buildingsPending;
    buildingsPending = (async () => {
      try {
        const tileset = await Cesium.Cesium3DTileset.fromIonAssetId(OSM_BUILDINGS_ASSET_ID, {
          // The buildings are context, not the subject. A looser error than the
          // photoreal tileset's default keeps them from competing for bandwidth
          // with the parcels and the effects layer, which are the point.
          maximumScreenSpaceError: 20,
        });
        if (destroyed) return null;
        tileset.customShader = buildingShader(Cesium);
        tileset.show = world === WORLDS.CLEAR;
        viewer.scene.primitives.add(tileset);
        refreshAnchors();
        removeTileVisible = tileset.tileVisible.addEventListener((tile) => paintTile(tile));
        buildings = tileset;
        return tileset;
      } catch (error) {
        console.warn('[TerraSignal] Cesium OSM Buildings unavailable:', error?.message || error);
        return null;
      } finally {
        buildingsPending = null;
      }
    })();
    return buildingsPending;
  }

  // ---- the scrim ---------------------------------------------------------

  const SCRIM_ID = 'ts-world-fade';

  function ensureScrim() {
    if (scrim || !doc?.createElement) return scrim;
    scrim = doc.getElementById(SCRIM_ID);
    if (scrim) return scrim;
    scrim = doc.createElement('div');
    scrim.id = SCRIM_ID;
    // Over the scene and under every piece of HUD, like the Street View host.
    scrim.style.cssText = 'position:fixed;inset:0;z-index:2;background:#05070a;'
      + 'opacity:0;pointer-events:none;';
    doc.body.appendChild(scrim);
    return scrim;
  }

  function runFade(onSwap) {
    const el = ensureScrim();
    fadeStartedAt = now();
    let swapped = false;
    if (fadeTimer) timers.clearInterval?.(fadeTimer);
    const step = () => {
      const state = worldFadeState(now() - fadeStartedAt);
      if (el) el.style.opacity = state.scrim.toFixed(3);
      if (!swapped && state.atSwap) {
        swapped = true;
        // Under the darkest frame: a provider changing over is invisible here
        // and a hard cut anywhere else.
        try { onSwap(); } catch (error) { console.warn('[TerraSignal] world swap:', error); }
      }
      if (state.done) {
        timers.clearInterval?.(fadeTimer);
        fadeTimer = null;
        if (el) el.style.opacity = '0';
        if (!swapped) { try { onSwap(); } catch { /* already reported */ } }
      }
    };
    // 16 ms rather than rAF: this is a DOM scrim and it must keep fading while
    // the render governor is idle, which is exactly when a world swap happens.
    fadeTimer = timers.setInterval?.(step, 16);
    step();
  }

  // ---- the switch --------------------------------------------------------

  /**
   * Put a world on screen, keeping the camera exactly where it is.
   *
   * The camera is read and written around the stack switch rather than left
   * alone: `MapStackController` changes the terrain provider, and installing
   * terrain under a camera that is 55 m above a surface which has just moved
   * leaves it 55 m above the *old* height. Restoring the pose is what makes the
   * toggle read as the trees disappearing rather than as the view jumping.
   */
  async function setWorld(next, { fade = true } = {}) {
    const target = next === WORLDS.CLEAR ? WORLDS.CLEAR : WORLDS.PHOTO;
    if (destroyed || switching || target === world) return { ok: true, world, changed: false };
    switching = true;
    /**
     * The buildings load alongside the fade, not before it.
     *
     * Awaiting the ion asset here made the first press of TREES do nothing at
     * all for as long as the tileset took to arrive, and then swap without a
     * transition — measured, the 600 ms dip never appeared on screen because
     * it had not started yet. A control that looks broken for a second and
     * then jumps is worse than one that dims immediately and fills in.
     *
     * Nothing is lost by not waiting: `ensureBuildings` sets `show` from the
     * world that is current when it resolves, so a tileset arriving after the
     * swap appears, and one arriving after a swap back stays hidden.
     */
    const loading = target === WORLDS.CLEAR ? ensureBuildings() : Promise.resolve(null);
    if (destroyed) return { ok: false, world };

    const pose = (() => {
      try {
        const camera = viewer.scene.camera;
        return {
          destination: camera.positionWC.clone(),
          orientation: {
            heading: camera.heading,
            pitch: camera.pitch,
            roll: camera.roll,
          },
        };
      } catch { return null; }
    })();

    const swap = async () => {
      world = target;
      if (buildings) buildings.show = target === WORLDS.CLEAR;
      writeWorldPreference(target);
      onWorld?.(target);
      try {
        await mapStackController?.setStack?.(WORLD_STACKS[target], { silent: true });
      } catch (error) {
        console.warn('[TerraSignal] world stack:', error?.message || error);
      }
      if (pose) {
        try { viewer.scene.camera.setView(pose); } catch { /* scene gone */ }
      }
      refreshAnchors();
      repaint();
    };

    if (fade) {
      runFade(() => { void swap(); });
    } else {
      await loading;
      await swap();
    }
    switching = false;
    return { ok: true, world: target, changed: true };
  }

  /** Re-walk every loaded building: the answer moved. */
  function repaint() {
    paintRevision += 1;
    try { viewer?.scene?.requestRender?.(); } catch { /* stub */ }
    return paintRevision;
  }

  return {
    get world() { return world; },
    get active() { return world === WORLDS.CLEAR; },
    get buildings() { return buildings; },
    get ready() { return Boolean(buildings); },
    /**
     * How many of our footprint properties found a building, and which.
     *
     * The number the feature is judged on: a gold tint that lands on nothing is
     * the draped fill standing in, which is correct but is not what was asked
     * for.
     */
    get matchReport() {
      const anchored = anchors.length;
      const rows = [...matched.entries()].map(([id, hit]) => ({
        id,
        elementId: hit.elementId,
        distanceM: Math.round(hit.distanceM * 100) / 100,
      })).sort((a, b) => a.id.localeCompare(b.id));
      return {
        matched: rows.length,
        anchored,
        featuresSeen,
        rate: anchored ? Math.round((rows.length / anchored) * 1000) / 10 : 0,
        unmatched: anchors.filter((a) => !matched.has(a.id)).map((a) => a.id),
        rows,
      };
    },

    setWorld,
    toggle() { return setWorld(world === WORLDS.CLEAR ? WORLDS.PHOTO : WORLDS.CLEAR); },
    repaint,
    refreshAnchors,

    destroy() {
      destroyed = true;
      if (fadeTimer) timers.clearInterval?.(fadeTimer);
      try { removeTileVisible?.(); } catch { /* already gone */ }
      if (buildings) {
        try { viewer.scene.primitives.remove(buildings); } catch { /* gone */ }
      }
      buildings = null;
      if (scrim?.remove) scrim.remove();
      scrim = null;
    },
  };
}
