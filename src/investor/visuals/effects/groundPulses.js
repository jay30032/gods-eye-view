/**
 * Two draped pulses: the top pick's ring, and the scan wave.
 *
 * Both are rings of light expanding across the ground, and both are drawn the
 * same way — a **static** draped disc whose material paints a moving annulus
 * inside it. That indirection is the whole design. A ring that literally grew
 * would mean rebuilding an `EllipseGeometry` every frame, which is the
 * per-frame geometry work the near-field layer was written to avoid; here the
 * geometry is created once at its maximum radius and the shader decides where
 * inside it the ring currently is.
 *
 *   - **the ring** loops every 4 s around the top pick's footprint, 0 → 30 m;
 *   - **the scan** fires once, on "find me money", and crosses the whole scene
 *     in 1.6 s before the matches light.
 *
 * Both read the same shared clock the rest of `effects/` runs on, so a flight
 * that freezes the near field freezes these too rather than leaving a ring
 * pulsing over a moving camera.
 *
 * `st` is the disc's own bounding square, so `length(st - 0.5) * 2` is the
 * normalised distance from the centre: 0 in the middle, 1 at the rim. That is
 * the only value either shader needs.
 */

import {
  EFFECT_GOLD,
  RING_MAX_RADIUS_M,
  ringEnvelopeFor,
  scanEnvelopeFor,
} from './signalMotion.js';

/** Thickness of the travelling ring, as a fraction of the disc's radius. */
const RING_THICKNESS = 0.16;
/** The scan band is thinner: it crosses a whole neighbourhood, not a garden. */
const SCAN_THICKNESS = 0.07;
/** Never let a pulse disc get so big it becomes a wash over the whole metro. */
const MAX_SCAN_RADIUS_M = 1_200;
const MIN_SCAN_RADIUS_M = 120;

/**
 * One expanding annulus inside a draped disc.
 *
 * `radiusFrac` is where the ring currently is, 0 at the centre and 1 at the
 * rim; `thickness` is how wide it is in the same units. Everything outside the
 * band is fully transparent, so the disc is invisible except for the ring —
 * which is why a single static disc can stand in for a growing circle.
 */
const PULSE_SOURCE = `
czm_material czm_getMaterial(czm_materialInput materialInput)
{
  czm_material material = czm_getDefaultMaterial(materialInput);

  float d = length(materialInput.st - vec2(0.5)) * 2.0;
  // Outside the disc entirely — the corners of the bounding square.
  if (d > 1.0) {
    material.alpha = 0.0;
    return material;
  }

  float band = abs(d - radiusFrac);
  float edge = 1.0 - smoothstep(0.0, max(thickness, 0.005), band);
  // Square it so the ring has a bright centre line and soft shoulders rather
  // than reading as a wide flat donut.
  float ring = edge * edge;

  material.diffuse = color.rgb;
  material.emission = color.rgb * ring * 0.9;
  material.alpha = ring * alpha;
  return material;
}
`;

export const PULSE_FABRIC = Object.freeze({
  type: 'TerraSignalGroundPulse',
  uniforms: {
    color: [1, 1, 1, 1],
    /** Where the ring is, 0 centre → 1 rim. */
    radiusFrac: 0.0,
    /** Half-width of the band in the same normalised units. */
    thickness: RING_THICKNESS,
    /** Overall strength, computed on the CPU so it can be proven bounded. */
    alpha: 0.0,
  },
  source: PULSE_SOURCE,
});

const M_PER_DEG_LAT = 111_320;
const DEG = Math.PI / 180;

/** Radius that covers a set of points from their own centroid, in metres. */
export function spanRadiusM(points) {
  const rows = (points || []).filter((p) => Number.isFinite(p?.lat) && Number.isFinite(p?.lng));
  if (!rows.length) return null;
  const lat = rows.reduce((sum, p) => sum + p.lat, 0) / rows.length;
  const lng = rows.reduce((sum, p) => sum + p.lng, 0) / rows.length;
  const mPerLng = M_PER_DEG_LAT * Math.cos(lat * DEG);
  let furthest = 0;
  for (const point of rows) {
    const d = Math.hypot((point.lng - lng) * mPerLng, (point.lat - lat) * M_PER_DEG_LAT);
    if (d > furthest) furthest = d;
  }
  // A margin so the wave finishes past the outermost house rather than on it.
  return { centre: { lat, lng }, radiusM: furthest * 1.25 };
}

/**
 * @param {{viewer:object, Cesium:object, market:object, reduced:Function}} deps
 */
export function createGroundPulses({ viewer, Cesium, market, reduced = () => false }) {
  const scene = viewer.scene;
  const collection = scene.primitives.add(new Cesium.PrimitiveCollection());
  const gold = new Cesium.Color(EFFECT_GOLD[0], EFFECT_GOLD[1], EFFECT_GOLD[2], 1);

  let destroyed = false;
  let enabled = false;
  let ring = null;
  let ringMaterial = null;
  let ringId = null;
  let scan = null;
  let scanMaterial = null;
  let scanStartedAt = null;

  const supported = (() => {
    try {
      return Cesium.GroundPrimitive?.isSupported?.(scene) !== false;
    } catch {
      return false;
    }
  })();

  function makeMaterial(uniforms) {
    return new Cesium.Material({
      fabric: { type: PULSE_FABRIC.type, uniforms: { ...PULSE_FABRIC.uniforms, ...uniforms }, source: PULSE_FABRIC.source },
      translucent: true,
    });
  }

  /** A draped disc of a given radius, drawn on the tiles rather than through them. */
  function disc(centre, radiusM, material) {
    return new Cesium.GroundPrimitive({
      geometryInstances: new Cesium.GeometryInstance({
        geometry: new Cesium.EllipseGeometry({
          center: Cesium.Cartesian3.fromDegrees(centre.lng, centre.lat),
          semiMajorAxis: radiusM,
          semiMinorAxis: radiusM,
          vertexFormat: Cesium.MaterialAppearance.MaterialSupport.TEXTURED.vertexFormat,
        }),
      }),
      appearance: new Cesium.MaterialAppearance({
        material,
        flat: true,
        translucent: true,
        materialSupport: Cesium.MaterialAppearance.MaterialSupport.TEXTURED,
      }),
      classificationType: Cesium.ClassificationType.CESIUM_3D_TILE,
      asynchronous: true,
      show: false,
    });
  }

  function clearRing() {
    if (!ring) return;
    try { collection.remove(ring); } catch { /* already gone */ }
    ring = null;
    ringMaterial = null;
    ringId = null;
  }

  function clearScan() {
    if (!scan) return;
    try { collection.remove(scan); } catch { /* already gone */ }
    scan = null;
    scanMaterial = null;
    scanStartedAt = null;
  }

  return {
    get supported() { return supported; },
    get ringId() { return ringId; },
    get scanning() { return scanStartedAt !== null; },

    setEnabled(next) {
      enabled = Boolean(next);
      if (!enabled) {
        if (ring) ring.show = false;
        if (scan) scan.show = false;
      }
      return enabled;
    },

    /**
     * Put the ring around a house, or take it away.
     *
     * Rebuilt only when the top pick actually changes — the ring is one disc,
     * and rebuilding it on every frame or every selection change would be the
     * per-frame geometry work this layer exists to avoid.
     */
    setTopPick(property) {
      if (destroyed || !supported) return;
      const id = property?.id ?? null;
      if (id === ringId) return;
      clearRing();
      if (!property || !Number.isFinite(property.lat) || !Number.isFinite(property.lng)) return;
      ringMaterial = makeMaterial({ color: gold, thickness: RING_THICKNESS });
      ring = disc({ lat: property.lat, lng: property.lng }, RING_MAX_RADIUS_M, ringMaterial);
      collection.add(ring);
      ringId = id;
    },

    /**
     * Fire the scan wave across a set of houses.
     *
     * One shot: the disc is built at the scene's own radius, runs for
     * `SCAN_DURATION_S`, and is removed on the frame it finishes. Firing again
     * while one is running replaces it rather than stacking a second wave.
     */
    startScan(points, nowSeconds) {
      if (destroyed || !supported || reduced()) return false;
      const span = spanRadiusM(points);
      if (!span) return false;
      clearScan();
      const radiusM = Math.min(MAX_SCAN_RADIUS_M, Math.max(MIN_SCAN_RADIUS_M, span.radiusM));
      scanMaterial = makeMaterial({ color: gold, thickness: SCAN_THICKNESS });
      scan = disc(span.centre, radiusM, scanMaterial);
      collection.add(scan);
      scanStartedAt = Number(nowSeconds);
      return true;
    },

    /**
     * One frame: at most six uniform writes and two `show` booleans.
     *
     * @param {number} seconds the shared effect clock
     */
    tick(seconds) {
      if (destroyed || !supported) return;
      const still = reduced();

      if (ring && ringMaterial) {
        const envelope = ringEnvelopeFor(seconds, { reduced: still });
        ring.show = enabled && envelope.alpha > 0.001;
        ringMaterial.uniforms.radiusFrac = envelope.radiusFrac;
        ringMaterial.uniforms.alpha = envelope.alpha;
      }

      if (scan && scanMaterial && scanStartedAt !== null) {
        const envelope = scanEnvelopeFor(seconds - scanStartedAt, { reduced: still });
        if (!envelope.active) {
          // Done: take the disc away rather than leaving a transparent
          // GroundPrimitive classifying tiles for the rest of the session.
          clearScan();
        } else {
          scan.show = enabled;
          scanMaterial.uniforms.radiusFrac = envelope.radiusFrac;
          scanMaterial.uniforms.alpha = envelope.alpha;
        }
      }
    },

    destroy() {
      destroyed = true;
      clearRing();
      clearScan();
      try { scene.primitives.remove(collection); } catch { /* torn down */ }
    },
  };
}
