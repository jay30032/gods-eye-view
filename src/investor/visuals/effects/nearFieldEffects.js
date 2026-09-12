/**
 * The near-field effects layer: parcel glow, per-signal motion, signal columns.
 *
 * Below 1,500 m the sprites stop being the story. A 48-pixel billboard says
 * "there is a signal in this block"; at street level the question is *which
 * roof*, and only geometry drawn on the ground can answer it. So this layer
 * draws the parcel each house sits on and a column of light standing over the
 * footprint, and hands back to the sprites on the way up.
 *
 * Four rules hold the whole design together:
 *
 *   1. **Draped, never drawn over.** Every ground primitive is a
 *      `GroundPolylinePrimitive` with `classificationType` CESIUM_3D_TILE, so
 *      the outline is projected onto Google's photogrammetry. Drawn as ordinary
 *      geometry it would be buried under a street tree or sliced by a porch
 *      roof — the tiles are real surfaces, not a backdrop.
 *   2. **One clock, delivered as uniforms.** `createEffectClock` is read once
 *      per frame and written to every material. No `CallbackProperty` anywhere:
 *      that machinery re-evaluates a property per frame on the main thread, and
 *      the far-field marker rewrite already established that per-frame work in
 *      this product is a scale write and nothing more.
 *   3. **Nothing is rebuilt after `build()`.** Geometry is created once. Motion,
 *      selection, dimming and distance fades are all uniform writes. That is
 *      what keeps the layer inside the 33 ms p95 the six-house smoke check
 *      enforces.
 *   4. **Never colour the wrong house.** A row whose Overpass lookup missed has
 *      no footprint, so it gets no building outline and no column — only a
 *      nominal parcel glow, at a lower alpha, plus the beacon the far-field
 *      layer already draws. An approximate mark is honest; a confident outline
 *      around the neighbour's house is not.
 *
 * The screen-space markers are untouched by all of this and remain the far
 * field. This layer only adds.
 */
import { geometryFor } from '../../mock/geometry.js';
import { nominalParcel } from '../../mock/parcel.js';
import { COLUMN_FABRIC, OUTLINE_FABRIC } from './materials.js';
import {
  COLUMN_HEIGHT_M,
  EFFECT_GOLD,
  GLOW_WIDTH_MAX_PX,
  GOLD_GLOW_WIDTH_PX,
  brightnessFor,
  colorFor,
  columnAlphaFor,
  createEffectClock,
  glowWidthFor,
  goldBreathFor,
  motionFor,
  nearFieldActive,
  outlineStateFor,
} from './signalMotion.js';

/** Ribbon width the outline geometry is baked at; the material narrows it. */
const RIBBON_WIDTH_PX = Math.max(GLOW_WIDTH_MAX_PX, GOLD_GLOW_WIDTH_PX) * 2;
/**
 * Past this the parcel is a couple of pixels and not worth a draw call.
 *
 * It must clear the *slant range* of the shot that shows the whole cluster,
 * not the altitude of it. The six-house CRUISE sits 900 m above the houses at
 * a 38 degree depression, which puts the camera 1,462 m from its own aim
 * point — so a 1,400 m radius culled every parcel in the establishing shot,
 * which is the one frame the layer exists for.
 */
const DRAW_RADIUS_M = 2_500;
/** An approximate parcel must never read as confidently as a surveyed one. */
const APPROXIMATE_ALPHA_SCALE = 0.55;

const RANKED_SIGNALS = ['FORECLOSURE', 'TAX_SALE', 'PREFORECLOSURE', 'DISTRESS', 'LISTED_OPPORTUNITY'];

export function primarySignalType(property) {
  for (const type of RANKED_SIGNALS) {
    if ((property?.signals || []).some((signal) => signal.type === type)) return type;
  }
  return 'DISTRESS';
}

/**
 * @param {{viewer:object, Cesium:object, market:object, getProperties:Function,
 *   reduced:Function, getGeometry:Function}} deps
 */
export function createNearFieldEffects({
  viewer,
  Cesium,
  market,
  getProperties,
  reduced = () => false,
  getGeometry = geometryFor,
}) {
  const scene = viewer.scene;
  const clock = createEffectClock();
  const goldColor = new Cesium.Color(EFFECT_GOLD[0], EFFECT_GOLD[1], EFFECT_GOLD[2], 1);
  const entries = new Map(); // id -> { property, type, outline, column, materials }
  const collection = scene.primitives.add(new Cesium.PrimitiveCollection());

  let built = false;
  let destroyed = false;
  let active = false;
  let enabled = false;
  let focusedId = null;
  let topPickId = null;
  let savedId = null;
  let shortlistIds = null;

  /**
   * GroundPolylinePrimitive needs vertex texture fetch. Cesium reports that per
   * scene, and if it is missing there is no draped outline to be had — the
   * layer stays dark rather than falling back to geometry that floats through
   * the roof it is supposed to be drawn on.
   */
  const supported = (() => {
    try {
      return Cesium.GroundPolylinePrimitive?.isSupported?.(scene) !== false;
    } catch {
      return false;
    }
  })();

  function groundHeightM(lat, lng) {
    try {
      const carto = Cesium.Cartographic.fromDegrees(lng, lat);
      if (scene.sampleHeightSupported) {
        const sampled = scene.sampleHeight(carto);
        if (Number.isFinite(sampled)) return sampled;
      }
      const terrain = scene.globe?.getHeight?.(carto);
      if (Number.isFinite(terrain)) return terrain;
    } catch {
      // Nothing loaded under that point yet.
    }
    return Number(market?.groundElevationM) || 0;
  }

  /**
   * Camera height **above ground**, which is the only reading the 1,500 m
   * ceiling can sensibly mean.
   *
   * `positionCartographic.height` is above the WGS84 ellipsoid, and Decatur's
   * ground is ~310 m up — so the six-house establishing shot, which is 900 m
   * above the houses, reports 1,177 m. Comparing that raw number against the
   * ceiling quietly turns a 1,500 m rule into an 1,190 m one, and every other
   * market would get a different rule again depending on its elevation.
   *
   * The market constant is used rather than sampling the surface under the
   * camera: `scene.sampleHeight` is a render-thread query and this runs every
   * frame. A few metres of error on a 1,500 m threshold is not worth it.
   */
  function cameraHeight() {
    try {
      const height = viewer.camera.positionCartographic?.height;
      if (!Number.isFinite(height)) return null;
      return height - (Number(market?.groundElevationM) || 0);
    } catch {
      return null;
    }
  }

  /**
   * Slant range from the camera to a property, in metres. The position is
   * anchored at the house's *ground*, not on the ellipsoid 310 m below it —
   * measuring to a point underground inflates every range and makes the column
   * fade behave as though the camera were further away than it is.
   */
  function rangeTo(position) {
    try {
      return Cesium.Cartesian3.distance(viewer.camera.positionWC, position);
    } catch {
      return Number.POSITIVE_INFINITY;
    }
  }

  function makeMaterial(fabric, uniforms) {
    return new Cesium.Material({
      fabric: { type: fabric.type, uniforms: { ...fabric.uniforms, ...uniforms }, source: fabric.source },
      translucent: true,
    });
  }

  function outlinePrimitive(ring, material, pickId) {
    const positions = Cesium.Cartesian3.fromDegreesArray(ring.flatMap(([lon, lat]) => [lon, lat]));
    return new Cesium.GroundPolylinePrimitive({
      geometryInstances: new Cesium.GeometryInstance({
        geometry: new Cesium.GroundPolylineGeometry({
          positions,
          width: RIBBON_WIDTH_PX,
          loop: true,
        }),
        id: pickId,
      }),
      appearance: new Cesium.PolylineMaterialAppearance({ material }),
      // The whole reason this layer exists: the outline belongs ON the tiles.
      classificationType: Cesium.ClassificationType.CESIUM_3D_TILE,
      asynchronous: true,
      show: false,
    });
  }

  function columnPrimitive(ring, groundM, material, pickId) {
    const flat = ring.flatMap(([lon, lat]) => [lon, lat]);
    // Close the loop explicitly — a wall is a strip, not a ring.
    flat.push(ring[0][0], ring[0][1]);
    const count = flat.length / 2;
    const geometry = new Cesium.WallGeometry({
      positions: Cesium.Cartesian3.fromDegreesArray(flat),
      minimumHeights: new Array(count).fill(groundM),
      maximumHeights: new Array(count).fill(groundM + COLUMN_HEIGHT_M),
      vertexFormat: Cesium.MaterialAppearance.MaterialSupport.TEXTURED.vertexFormat,
    });
    return new Cesium.Primitive({
      geometryInstances: new Cesium.GeometryInstance({ geometry, id: pickId }),
      appearance: new Cesium.MaterialAppearance({
        material,
        // Unlit: a light column has no surface to shade, and a lit one goes
        // black on whichever face the sun is not on.
        flat: true,
        faceForward: false,
        closed: false,
        translucent: true,
        materialSupport: Cesium.MaterialAppearance.MaterialSupport.TEXTURED,
      }),
      asynchronous: true,
      show: false,
    });
  }

  function build() {
    if (destroyed || !supported) return;
    clear();
    for (const property of getProperties() || []) {
      const record = getGeometry(property.id);
      const footprint = record?.building?.footprint?.[0] || null;
      const parcelRing = record?.parcel?.ring
        || nominalParcel(property.lat, property.lng)?.ring
        || null;
      if (!parcelRing) continue;

      const type = primarySignalType(property);
      const motion = motionFor(type);
      const [r, g, b] = colorFor(type);
      const pickId = { terrasignalPropertyId: property.id };
      const approximate = !footprint;
      const ground = groundHeightM(property.lat, property.lng);

      // Both colours are built once and assigned by reference every frame.
      // Allocating a Cesium.Color per entry per frame is 60 objects a frame at
      // 60 fps, which is a garbage collector pause the p95 budget would wear.
      const signalColor = new Cesium.Color(r, g, b, 1);
      const outlineMaterial = makeMaterial(OUTLINE_FABRIC, {
        color: signalColor,
        travelPerSec: motion.travelPerSec,
      });
      const outline = outlinePrimitive(parcelRing, outlineMaterial, pickId);
      collection.add(outline);

      // No footprint, no column. A shaft of light standing over a guess would
      // point at a specific roof with no reason to believe it is the right one.
      let column = null;
      let columnMaterial = null;
      if (footprint) {
        columnMaterial = makeMaterial(COLUMN_FABRIC, {
          color: signalColor,
          wavePerSec: motion.wavePerSec,
        });
        column = columnPrimitive(footprint, ground, columnMaterial, pickId);
        collection.add(column);
      }

      entries.set(property.id, {
        property,
        type,
        approximate,
        signalColor,
        outline,
        outlineMaterial,
        column,
        columnMaterial,
        position: Cesium.Cartesian3.fromDegrees(property.lng, property.lat, ground),
      });
    }
    built = true;
  }

  function clear() {
    collection.removeAll();
    entries.clear();
    built = false;
  }

  /**
   * One frame. Per entry this writes at most seven uniform floats and two
   * `show` booleans — no allocation, no geometry, no property evaluation.
   */
  function tick() {
    if (destroyed || !supported) return;
    const height = cameraHeight();
    const wasActive = active;
    active = enabled && nearFieldActive(height, wasActive);
    if (!active) {
      if (wasActive) {
        for (const entry of entries.values()) {
          entry.outline.show = false;
          if (entry.column) entry.column.show = false;
        }
      }
      return;
    }
    if (!built) build();

    const still = reduced();
    const seconds = clock.read(globalThis.performance?.now?.() ?? Date.now());
    const goldBrightness = goldBreathFor(seconds, { reduced: still });

    for (const [id, entry] of entries) {
      const range = rangeTo(entry.position);
      const visible = range <= DRAW_RADIUS_M;
      entry.outline.show = visible;
      if (entry.column) entry.column.show = visible;
      if (!visible) continue;

      const state = outlineStateFor(id, { shortlistIds, focusedId, topPickId, savedId });
      const moving = state.moving && !still;
      const brightness = state.gold
        ? goldBrightness
        : brightnessFor(entry.type, moving ? seconds : 0, { reduced: !moving });
      const width = glowWidthFor(entry.type, moving ? seconds : 0, {
        reduced: !moving,
        gold: state.gold,
      });
      const alpha = state.alpha * (entry.approximate ? APPROXIMATE_ALPHA_SCALE : 1);

      const uniforms = entry.outlineMaterial.uniforms;
      uniforms.color = state.gold ? goldColor : entry.signalColor;
      uniforms.brightness = brightness;
      // `width` is a half-width in pixels; the ribbon's own half-width is what
      // maps to the shader's `across == 1`.
      uniforms.widthFrac = Math.min(1, Math.max(0.02, (width * 2) / RIBBON_WIDTH_PX));
      uniforms.alpha = alpha;
      // The gold outline's halo is wider and softer than a signal's — but both
      // fall off fast enough that the ribbon does not glow edge to edge.
      uniforms.softness = state.gold ? 2.6 : 3.6;
      uniforms.time = seconds;
      // prefers-reduced-motion: a static glow, and the segment stops existing.
      uniforms.travelPerSec = moving ? motionFor(entry.type).travelPerSec : 0;

      if (entry.column) {
        const columnUniforms = entry.columnMaterial.uniforms;
        columnUniforms.color = state.gold ? goldColor : entry.signalColor;
        columnUniforms.brightness = state.gold ? goldBrightness : brightness;
        columnUniforms.alpha = columnAlphaFor(range) * state.alpha;
        columnUniforms.time = seconds;
        columnUniforms.wavePerSec = moving ? motionFor(entry.type).wavePerSec : 0;
      }
    }
  }

  const removeTick = scene.preRender.addEventListener(() => tick());

  return {
    get supported() { return supported; },
    get active() { return active; },
    get count() { return entries.size; },
    /** Ids drawing a real OSM footprint rather than a nominal parcel. */
    get surveyedIds() {
      return [...entries.entries()].filter(([, e]) => !e.approximate).map(([id]) => id);
    },
    get approximateIds() {
      return [...entries.entries()].filter(([, e]) => e.approximate).map(([id]) => id);
    },

    setEnabled(next) {
      enabled = Boolean(next);
      if (!enabled) {
        for (const entry of entries.values()) {
          entry.outline.show = false;
          if (entry.column) entry.column.show = false;
        }
        active = false;
      }
      return enabled;
    },
    setFocused(id) { focusedId = id || null; },
    setTopPick(id) { topPickId = id || null; },
    setSaved(id) { savedId = id || null; },
    setShortlist(ids) {
      const list = Array.isArray(ids) ? ids.filter(Boolean) : [];
      shortlistIds = list.length ? new Set(list) : null;
    },
    /** Freeze every animation at once while the camera flies. */
    freeze(frozen) {
      const now = globalThis.performance?.now?.() ?? Date.now();
      if (frozen) clock.freeze(now);
      else clock.thaw(now);
    },
    rebuild() { clear(); build(); },
    idFrom(picked) {
      const raw = picked?.id;
      return raw && typeof raw === 'object' && raw.terrasignalPropertyId
        ? raw.terrasignalPropertyId
        : null;
    },
    destroy() {
      destroyed = true;
      try { removeTick?.(); } catch { /* already gone */ }
      clear();
      try { scene.primitives.remove(collection); } catch { /* torn down */ }
    },
  };
}
