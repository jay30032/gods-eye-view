/**
 * The near-field effects layer: building outline, per-signal motion, columns.
 *
 * Below 1,500 m the sprites stop being the story. A 48-pixel billboard says
 * "there is a signal in this block"; at street level the question is *which
 * roof*, and only geometry drawn on the ground can answer it. So this layer
 * draws the building itself and a column of light standing over it, and hands
 * back to the sprites on the way up.
 *
 * It used to draw a *synthetic parcel* instead — the footprint's oriented
 * bounding box pushed out by guessed setbacks. Reviewed on the tiles that was
 * plainly the wrong object: a crooked gold box lying across the street and
 * around a neighbour's house. The outline now traces the real OSM footprint,
 * and a lot line is drawn only where a county actually surveyed one.
 *
 * Four rules hold the whole design together:
 *
 *   1. **Draped, never drawn over.** Every ground primitive is a
 *      `GroundPolylinePrimitive` with `classificationType` BOTH, so
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
 *      no footprint, so it draws nothing here at all — it keeps the far-field
 *      beacon, which marks a coordinate without claiming to know which roof.
 *      Silence is honest; a confident outline around the neighbour's house is
 *      not, and neither is a box that only looks surveyed.
 *
 * The screen-space markers are untouched by all of this and remain the far
 * field. This layer only adds.
 */
import { geometryFor } from '../../mock/geometry.js';
import { COLUMN_FABRIC, OUTLINE_FABRIC } from './materials.js';
import {
  TINT_EDGE_ALPHA,
  TINT_FILL_ALPHA,
  TINT_HEIGHT_M,
  insetRing,
  tintAppliesTo,
} from './buildingTint.js';
import {
  COLUMN_HEIGHT_M,
  EFFECT_GOLD,
  GOLD_GLOW_WIDTH_PX,
  brightnessFor,
  colorFor,
  columnAlphaFor,
  createEffectClock,
  goldBreathFor,
  motionFor,
  nearFieldActive,
  outlineProfileFor,
  outlineStateFor,
  parcelProfileFor,
} from './signalMotion.js';

/**
 * Ribbon width the outline geometry is baked at; the material narrows it.
 *
 * `GroundPolylineGeometry` bakes its width at construction, so this is built
 * once at the widest the design ever needs — the gold halo — and every profile
 * below it is carved out by the shader in pixels. The material is told the
 * baked half-width as `ribbonHalfPx` so "2 px core" means two actual pixels.
 */
const RIBBON_HALF_PX = Math.max(GOLD_GLOW_WIDTH_PX, 8);
const RIBBON_WIDTH_PX = RIBBON_HALF_PX * 2;

/**
 * Parcel rings we are willing to draw.
 *
 * Deliberately an allow-list of surveyed county sources rather than "anything
 * with a ring". The synthetic parcel — an oriented bounding box pushed out from
 * the footprint by guessed setbacks — is no longer drawn at all: on the tiles it
 * landed across the street and around a neighbour's house, and a confident gold
 * box around the wrong property is worse than no box. `mock/parcel.js` still
 * exists for the footprint geometry helpers it carries; nothing renders its
 * output.
 */
const REAL_PARCEL_SOURCES = new Set(['dekalb-gis', 'fulton-gis']);
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
  const entries = new Map(); // id -> { property, type, outline, parcel, column, materials }
  /** Rows skipped for want of a footprint — reported, never drawn. */
  const withoutFootprint = [];
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
   * Drive Mode's per-property weights, or null when not driving.
   *
   * When present these REPLACE the shortlist/focus dimming rules rather than
   * combining with them. The two answer different questions — "is this part of
   * the answer you asked for" versus "can you see it from here" — and a house
   * that is both off-shortlist and fifty metres ahead has to read as fifty
   * metres ahead, or the drive shows you a dim house at the moment it is the
   * only thing on screen.
   */
  let driveActivations = null;
  /** Last value read off the shared clock — the ground pulses ride this too. */
  let lastSeconds = 0;

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
      classificationType: Cesium.ClassificationType.BOTH,
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

  /**
   * The lot ring for a record, but only if a county surveyed it.
   *
   * `parcel.source` must be one of the county GIS layers. A `'synthetic'`
   * parcel — the oriented bounding box `mock/parcel.js` pushes out from the
   * footprint — returns null and draws nothing at all.
   */
  function realParcelRing(record) {
    const parcel = record?.parcel;
    if (!parcel || !REAL_PARCEL_SOURCES.has(parcel.source)) return null;
    const ring = parcel.ring;
    return Array.isArray(ring) && ring.length >= 3 ? ring : null;
  }

  /**
   * Whether this scene can classify 3D tiles at all.
   *
   * `ClassificationPrimitive` needs the same vertex-texture support the draped
   * polylines do, plus a stencil buffer. Where it is missing the tint silently
   * does not exist rather than falling back to opaque geometry sitting through
   * the roof.
   */
  const classificationSupported = (() => {
    try {
      return Cesium.ClassificationPrimitive?.isSupported?.(scene) !== false;
    } catch {
      return false;
    }
  })();

  /**
   * One extruded, tile-classifying volume over a ring.
   *
   * The colour is per-instance, not a material: the classification path does
   * not take one. `PerInstanceColorAppearance` with `flat: true` is what makes
   * the tint a wash over the photogrammetry rather than a lit surface that goes
   * dark on whichever side the sun is not on.
   */
  function tintVolume(outerRing, holeRing, groundM, color, pickId) {
    const toHierarchy = (ring) => Cesium.Cartesian3.fromDegreesArray(
      ring.flatMap(([lon, lat]) => [lon, lat]),
    );
    const hierarchy = new Cesium.PolygonHierarchy(
      toHierarchy(outerRing),
      holeRing ? [new Cesium.PolygonHierarchy(toHierarchy(holeRing))] : undefined,
    );
    return new Cesium.ClassificationPrimitive({
      geometryInstances: new Cesium.GeometryInstance({
        geometry: new Cesium.PolygonGeometry({
          polygonHierarchy: hierarchy,
          // Start a little UNDER the ground the footprint sits on. A volume
          // whose floor is exactly at the sampled height leaves a hairline of
          // untinted tile where the walls meet the grass.
          height: groundM - 1,
          extrudedHeight: groundM + TINT_HEIGHT_M,
          vertexFormat: Cesium.PerInstanceColorAppearance.VERTEX_FORMAT,
        }),
        attributes: {
          color: Cesium.ColorGeometryInstanceAttribute.fromColor(color),
        },
        id: pickId,
      }),
      appearance: new Cesium.PerInstanceColorAppearance({ flat: true, translucent: true }),
      classificationType: Cesium.ClassificationType.BOTH,
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
      // No footprint, no near-field geometry. This layer used to fall back to a
      // nominal lot box around the row's bare coordinate; that box is what read
      // as "the wrong property", so a row Overpass never resolved now keeps only
      // the far-field beacon, which does not claim to know which roof it is.
      if (!footprint) {
        withoutFootprint.push(property.id);
        continue;
      }

      const type = primarySignalType(property);
      const motion = motionFor(type);
      const [r, g, b] = colorFor(type);
      const pickId = { terrasignalPropertyId: property.id };
      const ground = groundHeightM(property.lat, property.lng);

      // Both colours are built once and assigned by reference every frame.
      // Allocating a Cesium.Color per entry per frame is 60 objects a frame at
      // 60 fps, which is a garbage collector pause the p95 budget would wear.
      const signalColor = new Cesium.Color(r, g, b, 1);

      // The building itself: the ring this layer is actually willing to claim.
      const outlineMaterial = makeMaterial(OUTLINE_FABRIC, {
        color: signalColor,
        travelPerSec: motion.travelPerSec,
        ribbonHalfPx: RIBBON_HALF_PX,
      });
      const outline = outlinePrimitive(footprint, outlineMaterial, pickId);
      collection.add(outline);

      // The surveyed lot, if a county gave us one. Secondary by construction:
      // thinner, dimmer, and it never travels — the moving segment belongs to
      // the house, so a lot line that also crawled would double the motion.
      const parcelRing = realParcelRing(record);
      let parcel = null;
      let parcelMaterial = null;
      if (parcelRing) {
        parcelMaterial = makeMaterial(OUTLINE_FABRIC, {
          color: signalColor,
          travelPerSec: 0,
          ribbonHalfPx: RIBBON_HALF_PX,
        });
        parcel = outlinePrimitive(parcelRing, parcelMaterial, pickId);
        collection.add(parcel);
      }

      const columnMaterial = makeMaterial(COLUMN_FABRIC, {
        color: signalColor,
        wavePerSec: motion.wavePerSec,
      });
      const column = columnPrimitive(footprint, ground, columnMaterial, pickId);
      collection.add(column);

      // The tint that lights the house itself. Built for every row so that
      // nothing is constructed mid-flight when focus moves, but only ever
      // shown for the top pick and the focused house.
      let tintFill = null;
      let tintEdge = null;
      if (classificationSupported) {
        const gold = (alpha) => new Cesium.Color(
          EFFECT_GOLD[0], EFFECT_GOLD[1], EFFECT_GOLD[2], alpha,
        );
        const inner = insetRing(footprint);
        if (inner) {
          // Fill the middle, band the rim. The two volumes share an edge and
          // never overlap, so neither alpha stacks on the other.
          tintFill = tintVolume(inner, null, ground, gold(TINT_FILL_ALPHA), pickId);
          tintEdge = tintVolume(footprint, inner, ground, gold(TINT_EDGE_ALPHA), pickId);
        } else {
          // Too small to carry a 1.6 m band: one flat wash over the whole roof.
          tintFill = tintVolume(footprint, null, ground, gold(TINT_FILL_ALPHA), pickId);
        }
        collection.add(tintFill);
        if (tintEdge) collection.add(tintEdge);
      }

      entries.set(property.id, {
        property,
        type,
        footprint,
        signalColor,
        outline,
        outlineMaterial,
        parcel,
        parcelMaterial,
        parcelSource: parcelRing ? record.parcel.source : null,
        column,
        columnMaterial,
        tintFill,
        tintEdge,
        position: Cesium.Cartesian3.fromDegrees(property.lng, property.lat, ground),
      });
    }
    built = true;
  }

  function clear() {
    collection.removeAll();
    entries.clear();
    withoutFootprint.length = 0;
    built = false;
  }

  /**
   * One frame. Per entry this writes at most seven uniform floats and two
   * `show` booleans — no allocation, no geometry, no property evaluation.
   */
  function tick() {
    if (destroyed || !supported) return;
    // Read the one clock FIRST, before any early return. The ground pulses run
    // off this same value, and a clock that only advanced while the near-field
    // layer happened to be active would stall the top pick's ring the moment
    // the camera climbed.
    lastSeconds = clock.read(globalThis.performance?.now?.() ?? Date.now());
    const height = cameraHeight();
    const wasActive = active;
    active = enabled && nearFieldActive(height, wasActive);
    if (!active) {
      if (wasActive) {
        for (const entry of entries.values()) {
          entry.outline.show = false;
          if (entry.parcel) entry.parcel.show = false;
          if (entry.column) entry.column.show = false;
          if (entry.tintFill) entry.tintFill.show = false;
          if (entry.tintEdge) entry.tintEdge.show = false;
        }
      }
      return;
    }
    if (!built) build();

    const still = reduced();
    const seconds = lastSeconds;
    const goldBrightness = goldBreathFor(seconds, { reduced: still });

    for (const [id, entry] of entries) {
      // Declared first because the visibility block below reads it. It used to
      // sit lower, which is a temporal dead zone rather than a subtle bug: the
      // render loop threw on the first frame of every drive and Cesium stopped
      // rendering. `smoke:drive` caught it; nothing in the unit suite could.
      const drive = driveActivations ? driveActivations.get(id) : null;

      const range = rangeTo(entry.position);
      const visible = range <= DRAW_RADIUS_M;
      entry.outline.show = visible;
      if (entry.parcel) entry.parcel.show = visible;
      if (entry.column) entry.column.show = visible;
      // Only the two houses the product is pointing at are lit. The tint is a
      // wash over real photogrammetry, so applying it broadly would recolour
      // the street rather than single out a house.
      // In a drive the tint is the "useful viewing" highlight, so it arrives on
      // whatever is close enough to look at — not only on the focused house.
      const tinted = visible && (drive
        ? drive.highlight > 0.02 || tintAppliesTo(id, { focusedId, topPickId })
        : tintAppliesTo(id, { focusedId, topPickId }));
      if (entry.tintFill) entry.tintFill.show = tinted;
      if (entry.tintEdge) entry.tintEdge.show = tinted;
      if (!visible) continue;

      if (drive?.suspended) {
        // Behind the camera and out of the rear-view: drawn not at all. This is
        // the cheap half of a drive's frame budget, where most of the route is
        // behind you most of the time.
        entry.outline.show = false;
        if (entry.parcel) entry.parcel.show = false;
        if (entry.column) entry.column.show = false;
        if (entry.tintFill) entry.tintFill.show = false;
        if (entry.tintEdge) entry.tintEdge.show = false;
        continue;
      }

      const state = outlineStateFor(id, { shortlistIds, focusedId, topPickId, savedId });
      const moving = state.moving && !still;
      const brightness = state.gold
        ? goldBrightness
        : brightnessFor(entry.type, moving ? seconds : 0, { reduced: !moving });
      const clockSeconds = moving ? seconds : 0;
      const profile = outlineProfileFor(entry.type, clockSeconds, {
        reduced: !moving,
        gold: state.gold,
      });
      // In a drive the alpha is distance-based; standing still it is selection.
      const alpha = drive ? drive.alpha : state.alpha;

      const uniforms = entry.outlineMaterial.uniforms;
      uniforms.color = state.gold ? goldColor : entry.signalColor;
      // Status motion only inside the useful window — a house 300 m up the road
      // pulsing at full rate is noise competing with the one you can see.
      uniforms.brightness = drive ? brightness * (0.45 + 0.55 * drive.motion) : brightness;
      // A 2 px core that does not breathe, with a halo around it that does. The
      // drive fades the outline IN across the approach by shrinking it towards
      // the core rather than by alpha alone, so it reads as resolving.
      uniforms.coreHalfPx = profile.coreHalfPx;
      uniforms.glowHalfPx = drive
        ? profile.coreHalfPx + (profile.glowHalfPx - profile.coreHalfPx) * drive.outline
        : profile.glowHalfPx;
      uniforms.alpha = alpha;
      uniforms.time = seconds;
      // prefers-reduced-motion: a static glow, and the segment stops existing.
      uniforms.travelPerSec = moving ? motionFor(entry.type).travelPerSec : 0;

      if (entry.parcel) {
        // The lot line rides the same envelope as the house so the two read as
        // one object, but at 40% of its glow and never gold — gold is the
        // product's word for "this house", and a lot is not a house.
        const lot = parcelProfileFor(entry.type, clockSeconds, { reduced: !moving });
        const parcelUniforms = entry.parcelMaterial.uniforms;
        parcelUniforms.color = entry.signalColor;
        parcelUniforms.brightness = brightness;
        parcelUniforms.coreHalfPx = lot.coreHalfPx;
        parcelUniforms.glowHalfPx = lot.glowHalfPx;
        parcelUniforms.alpha = alpha * lot.alphaScale;
        parcelUniforms.time = seconds;
        parcelUniforms.travelPerSec = 0;
      }

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
    /** The shared effect clock, in seconds. One clock for every effect. */
    get seconds() { return lastSeconds; },
    get count() { return entries.size; },
    /**
     * Ids drawing a real OSM building footprint. Every entry now qualifies —
     * a row without one is not built at all — so this equals `count`, and the
     * gap between them is `approximateIds`, which is how the smoke check
     * notices a dataset that quietly stopped resolving.
     */
    get surveyedIds() {
      return [...entries.keys()];
    },
    /** Rows that wanted a footprint and did not get one. Never drawn. */
    get approximateIds() {
      return [...withoutFootprint];
    },
    /**
     * Where a house's footprint centroid lands on screen, in pixels.
     *
     * The headed check frames on this rather than on the marker: the marker
     * floats 14 m above the roof, so a shot that put the *marker* in the middle
     * of the frame would be sitting the house itself low — which is the bug the
     * framing tilts exist to correct, and not something a test should be
     * blind to.
     */
    screenPositionFor(id) {
      const entry = entries.get(id);
      if (!entry) return null;
      try {
        const point = Cesium.SceneTransforms.worldToWindowCoordinates?.(scene, entry.position)
          || Cesium.SceneTransforms.wgs84ToWindowCoordinates?.(scene, entry.position);
        return point ? { x: point.x, y: point.y } : null;
      } catch {
        return null;
      }
    },

    /** Did this scene support classifying the 3D tiles at all? */
    get classificationSupported() { return classificationSupported; },
    /** Ids currently wearing the building tint. */
    get tintedIds() {
      return [...entries.entries()]
        .filter(([, e]) => Boolean(e.tintFill?.show))
        .map(([id]) => id);
    },
    /** Ids that actually built a rim band rather than a flat wash. */
    get tintEdgeIds() {
      return [...entries.entries()].filter(([, e]) => Boolean(e.tintEdge)).map(([id]) => id);
    },
    /** Ids carrying a surveyed county lot line under the building. */
    get parcelIds() {
      return [...entries.entries()].filter(([, e]) => Boolean(e.parcel)).map(([id]) => id);
    },
    /** Which county layer each drawn lot came from. */
    get parcelSources() {
      const out = {};
      for (const [id, entry] of entries) if (entry.parcelSource) out[id] = entry.parcelSource;
      return out;
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
    /** Drive Mode weights, or null to go back to the standing rules. */
    setDriveActivations(map) {
      driveActivations = map instanceof Map && map.size ? map : null;
    },
    get driving() { return driveActivations !== null; },
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
