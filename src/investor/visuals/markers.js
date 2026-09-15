/**
 * Marker system v2 — screen-space, primitive-backed, never occluded.
 *
 * v1 drew every signal as a ground-clamped Cesium *entity* ellipse. Three
 * things were wrong with that and all three showed up in a headed review:
 *
 *   1. the ellipses were positioned at ~6 m above the WGS84 ellipsoid, and
 *      Decatur's ground is ~310 m up — so every marker was three hundred metres
 *      underground. Nothing was visible at CRUISE because nothing was above
 *      ground, not because of LOD;
 *   2. even above ground, a ground-clamped ellipse is opaque geometry that
 *      Google's 3D tiles happily draw over;
 *   3. an ellipse is sized in METRES, so it shrinks to a sub-pixel speck as the
 *      camera climbs. A marker has to hold its size on screen, not on the map.
 *
 * So: billboards, points, labels and polylines in primitive collections, placed
 * ON the property's anchor — the footprint centroid at the one ground height
 * `visuals/ground.js` holds for that row — with depth testing disabled so tiles
 * can never hide them. Pulsing is a per-frame **scale** write on an existing
 * billboard; the only geometry rebuild after `build()` is the manager calling
 * `build()` again when the ground source reports a height moved.
 *
 * The marker used to sample its own ground and float 14 m above it. Two
 * samples (this layer's from space, the near-field layer's from the near
 * field) put the sprite and the tint on different grounds — see ground.js —
 * and the 14 m rise was a second offset the hero framing then had to tilt for.
 * The sprite now stands exactly where the outline, the tint and the lot line
 * stand, and the smoke check measures that they do.
 *
 * The pure half (tempos, alpha rules, label text) is exported for unit tests;
 * the Cesium half takes `Cesium` as an argument so this module imports nothing
 * from it.
 */
import { SIGNAL_LOOK } from './propertyPulse.js';
import { GOLD } from './goldHalo.js';

export const SPRITE_PX = 48;
export const CORE_PX = 12;
/** Clearance above the roofline so a marker reads as floating, not painted on. */
/** The beacon rises from the anchor; nothing else is lifted off it. */
export const BEACON_HEIGHT_M = 120;
export const BEACON_WIDTH_PX = 3;
export const EMPHASIS_SCALE = 1.5;
export const DIM_ALPHA = 0.35;

export const PULSE_MIN = 0.8;
export const PULSE_MAX = 1.15;

/**
 * One tempo per signal type. The kind is the shape of the envelope; the period
 * is how long one cycle takes. All of them stay inside [PULSE_MIN, PULSE_MAX]
 * so a marker never swamps its neighbours.
 */
export const TEMPOS = Object.freeze({
  FORECLOSURE: Object.freeze({ kind: 'heartbeat', periodS: 2.8 }),
  PREFORECLOSURE: Object.freeze({ kind: 'breath', periodS: 3.2 }),
  TAX_SALE: Object.freeze({ kind: 'tick', periodS: 2.6 }),
  DISTRESS: Object.freeze({ kind: 'shimmer', periodS: 3.6 }),
  LISTED_OPPORTUNITY: Object.freeze({ kind: 'steady', periodS: 4.0 }),
});

function clamp01(value) {
  return Math.min(1, Math.max(0, Number(value) || 0));
}

/** Two quick beats then rest — a notice of sale should feel like a pulse. */
function heartbeat(t) {
  const beat = (phase) => Math.max(0, Math.sin(phase * Math.PI));
  if (t < 0.15) return beat(t / 0.15);
  if (t >= 0.22 && t < 0.37) return 0.75 * beat((t - 0.22) / 0.15);
  return 0;
}

/** Envelope value 0..1 for a tempo at a phase. Exported for the sweep tests. */
export function envelopeFor(kind, t) {
  const phase = clamp01(t);
  if (kind === 'heartbeat') return heartbeat(phase);
  if (kind === 'breath') return (1 - Math.cos(2 * Math.PI * phase)) / 2;
  // Sharp attack, long decay — a deadline ticking down.
  if (kind === 'tick') return phase < 0.12 ? phase / 0.12 : Math.max(0, 1 - (phase - 0.12) / 0.88);
  if (kind === 'shimmer') return (1 - Math.cos(2 * Math.PI * phase * 3)) / 2;
  return 0.5; // steady
}

/**
 * Screen-space scale for a marker.
 * @param {string} type signal type
 * @param {number} seconds elapsed on the shared clock
 * @returns {number} always within [PULSE_MIN, PULSE_MAX]
 */
export function pulseScaleFor(type, seconds, { reduced = false } = {}) {
  const tempo = TEMPOS[type] || TEMPOS.DISTRESS;
  if (reduced) return (PULSE_MIN + PULSE_MAX) / 2;
  const elapsed = Number(seconds);
  if (!Number.isFinite(elapsed)) return (PULSE_MIN + PULSE_MAX) / 2;
  const phase = ((elapsed % tempo.periodS) + tempo.periodS) % tempo.periodS / tempo.periodS;
  return PULSE_MIN + (PULSE_MAX - PULSE_MIN) * clamp01(envelopeFor(tempo.kind, phase));
}

/**
 * A shortlist is an answer to a question — everything that did not make it
 * recedes rather than disappearing, so the board still reads as a board.
 */
export function markerAlphaFor(id, { shortlistIds = null, focusedId = null, topPickId = null } = {}) {
  if (!shortlistIds || !shortlistIds.size) return 1;
  if (shortlistIds.has(id) || id === focusedId || id === topPickId) return 1;
  return DIM_ALPHA;
}

export function shortAddress(property) {
  return String(property?.address || '').split(',')[0];
}

/** "3372 Belvedere Ln · AUCTION 26d" — the two facts worth reading at altitude. */
export function beaconLabelFor(property) {
  const where = shortAddress(property);
  const days = property?.auction?.daysUntil;
  if (!Number.isFinite(days) || days < 0) return where;
  return `${where} · AUCTION ${days}d`;
}

export function colorForSignal(type) {
  return (SIGNAL_LOOK[type] || SIGNAL_LOOK.DISTRESS).color;
}

// ---------------------------------------------------------------------------
// Cesium side
// ---------------------------------------------------------------------------

function spriteCanvas(rgba, size = SPRITE_PX) {
  const canvas = globalThis.document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  const [r, g, b] = rgba.map((v) => Math.round(v * 255));
  const half = size / 2;
  const gradient = ctx.createRadialGradient(half, half, 0, half, half, half);
  gradient.addColorStop(0, `rgba(${r},${g},${b},0.95)`);
  gradient.addColorStop(0.42, `rgba(${r},${g},${b},0.42)`);
  gradient.addColorStop(1, `rgba(${r},${g},${b},0)`);
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, size, size);
  return canvas;
}

/**
 * @param {{viewer:object, Cesium:object, ground:object, getProperties:Function,
 *   reduced:Function}} deps
 */
export function createMarkerLayer({ viewer, Cesium, ground, getProperties, reduced = () => false }) {
  if (!ground?.positionFor) throw new TypeError('createMarkerLayer needs the shared ground source');
  const scene = viewer.scene;
  const billboards = scene.primitives.add(new Cesium.BillboardCollection({ scene }));
  const points = scene.primitives.add(new Cesium.PointPrimitiveCollection());
  const labels = scene.primitives.add(new Cesium.LabelCollection({ scene }));
  const polylines = scene.primitives.add(new Cesium.PolylineCollection());

  const sprites = new Map();
  const markers = new Map(); // id -> { property, billboard, point, beacon, label }
  let epoch = null;
  let frozenSeconds = null;
  let destroyed = false;

  let focusedId = null;
  let topPickId = null;
  let savedId = null;
  let shortlistIds = null;
  let hoveredId = null;
  let enabled = false;
  /** Drive Mode weights per id, or null. See nearFieldEffects for the rule. */
  let driveActivations = null;

  const NO_DEPTH = Number.POSITIVE_INFINITY;

  function spriteFor(type) {
    if (!sprites.has(type)) sprites.set(type, spriteCanvas(colorForSignal(type)));
    return sprites.get(type);
  }

  function goldSprite() {
    if (!sprites.has('__gold')) sprites.set('__gold', spriteCanvas([GOLD.r, GOLD.g, GOLD.b, 1]));
    return sprites.get('__gold');
  }

  function primarySignalType(property) {
    const ranked = ['FORECLOSURE', 'TAX_SALE', 'PREFORECLOSURE', 'DISTRESS', 'LISTED_OPPORTUNITY'];
    for (const type of ranked) {
      if ((property.signals || []).some((signal) => signal.type === type)) return type;
    }
    return 'DISTRESS';
  }

  function build() {
    clear();
    if (destroyed) return;
    for (const property of getProperties() || []) {
      // The one anchor every layer shares: footprint centroid, one ground.
      const base = ground.positionFor(property);
      const top = ground.positionFor(property, BEACON_HEIGHT_M);
      if (!base || !top) continue;
      const type = primarySignalType(property);
      const [r, g, b] = colorForSignal(type);
      const pickId = { terrasignalPropertyId: property.id };

      const billboard = billboards.add({
        position: base,
        image: spriteFor(type),
        scale: 1,
        color: Cesium.Color.WHITE,
        // Google 3D tiles must never be able to hide a signal.
        disableDepthTestDistance: NO_DEPTH,
        id: pickId,
      });
      const point = points.add({
        position: base,
        pixelSize: CORE_PX,
        color: new Cesium.Color(r, g, b, 1),
        outlineColor: Cesium.Color.BLACK.withAlpha(0.55),
        outlineWidth: 1,
        disableDepthTestDistance: NO_DEPTH,
        id: pickId,
      });
      const beacon = polylines.add({
        positions: [base, top],
        width: BEACON_WIDTH_PX,
        show: false,
        material: Cesium.Material.fromType('Color', {
          color: new Cesium.Color(GOLD.r, GOLD.g, GOLD.b, 0.55),
        }),
        id: pickId,
      });
      const label = labels.add({
        // Pinned to the MARKER, not the top of the beacon. The beacon is 120 m
        // tall, which is off the top of the frame at hero range — a label up
        // there is unreadable exactly when it matters most.
        position: base,
        text: beaconLabelFor(property),
        font: '13px Inter, sans-serif',
        fillColor: Cesium.Color.WHITE,
        outlineColor: Cesium.Color.BLACK,
        outlineWidth: 3,
        style: Cesium.LabelStyle.FILL_AND_OUTLINE,
        verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
        pixelOffset: new Cesium.Cartesian2(0, -30),
        disableDepthTestDistance: NO_DEPTH,
        show: false,
        id: pickId,
      });
      const bookmark = labels.add({
        position: base,
        text: '⚑',
        font: '16px Inter, sans-serif',
        fillColor: new Cesium.Color(GOLD.r, GOLD.g, GOLD.b, 1),
        outlineColor: Cesium.Color.BLACK,
        outlineWidth: 2,
        style: Cesium.LabelStyle.FILL_AND_OUTLINE,
        verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
        pixelOffset: new Cesium.Cartesian2(0, -26),
        disableDepthTestDistance: NO_DEPTH,
        show: false,
        id: pickId,
      });

      markers.set(property.id, { property, type, billboard, point, beacon, label, bookmark });
    }
    applyState();
  }

  function clear() {
    billboards.removeAll();
    points.removeAll();
    labels.removeAll();
    polylines.removeAll();
    markers.clear();
  }

  /** Colour, emphasis and which extras show. No geometry is touched. */
  function applyState() {
    for (const [id, marker] of markers) {
      const drive = driveActivations ? driveActivations.get(id) : null;
      // A drive replaces the shortlist dimming: what matters is how far ahead
      // the house is, not whether it answered an earlier question.
      const alpha = drive
        ? Math.max(0, Math.min(1, drive.beacon))
        : markerAlphaFor(id, { shortlistIds, focusedId, topPickId });
      const isTop = id === topPickId;
      const isFocused = id === focusedId;
      const show = enabled && !(drive?.suspended);

      marker.billboard.show = show;
      marker.point.show = show;
      marker.billboard.image = isTop || isFocused ? goldSprite() : spriteFor(marker.type);
      marker.billboard.color = Cesium.Color.WHITE.withAlpha(alpha);
      marker.point.color = marker.point.color.withAlpha(alpha);

      const beaconOn = show && (isTop || isFocused);
      marker.beacon.show = beaconOn;
      marker.label.show = beaconOn;
      marker.label.text = hoveredId === id && !beaconOn
        ? shortAddress(marker.property)
        : beaconLabelFor(marker.property);
      marker.bookmark.show = show && id === savedId;
    }
    if (hoveredId && markers.has(hoveredId)) {
      const marker = markers.get(hoveredId);
      if (!marker.label.show) {
        marker.label.show = enabled;
        marker.label.text = shortAddress(marker.property);
      }
    }
  }

  /** Per-frame: one scale write per marker, nothing else. */
  function tick(time) {
    if (destroyed || !enabled) return;
    if (epoch === null) epoch = Cesium.JulianDate.clone(time);
    const seconds = frozenSeconds !== null
      ? frozenSeconds
      : Cesium.JulianDate.secondsDifference(time, epoch);
    const still = reduced();
    for (const [id, marker] of markers) {
      const emphasis = id === topPickId || id === focusedId ? EMPHASIS_SCALE : 1;
      marker.billboard.scale = pulseScaleFor(marker.type, seconds, { reduced: still }) * emphasis;
    }
  }

  const removeTick = scene.preRender.addEventListener((_scene, time) => tick(time));

  return {
    get count() { return markers.size; },
    get ids() { return [...markers.keys()]; },
    /** The primitive collections, so the ground sample can skip them. */
    get collections() { return [billboards, points, labels, polylines]; },
    build,
    setEnabled(next) {
      enabled = Boolean(next);
      applyState();
      return enabled;
    },
    setFocused(id) { focusedId = id || null; applyState(); },
    setTopPick(id) { topPickId = id || null; applyState(); },
    setSaved(id) { savedId = id || null; applyState(); },
    setShortlist(ids) {
      const list = Array.isArray(ids) ? ids.filter(Boolean) : [];
      shortlistIds = list.length ? new Set(list) : null;
      applyState();
    },
    /** Drive Mode weights, or null to go back to the standing rules. */
    setDriveActivations(map) {
      driveActivations = map instanceof Map && map.size ? map : null;
      applyState();
    },
    setHovered(id) {
      if (hoveredId === id) return;
      hoveredId = id || null;
      applyState();
    },
    /** Freeze the pulse clock (used while the camera is flying). */
    freeze(frozen) {
      if (!frozen) { frozenSeconds = null; return; }
      if (epoch === null) { frozenSeconds = 0; return; }
      try {
        frozenSeconds = Cesium.JulianDate.secondsDifference(viewer.clock.currentTime, epoch);
      } catch {
        frozenSeconds = 0;
      }
    },
    /** @returns {string|null} property id under a pick result */
    idFrom(picked) {
      const raw = picked?.id;
      if (raw && typeof raw === 'object' && raw.terrasignalPropertyId) return raw.terrasignalPropertyId;
      return null;
    },
    /** Screen positions of every shown marker — used by the headed smoke check. */
    screenPositions() {
      const out = [];
      for (const [id, marker] of markers) {
        if (!marker.billboard.show) continue;
        const screen = Cesium.SceneTransforms.worldToWindowCoordinates?.(scene, marker.billboard.position)
          || Cesium.SceneTransforms.wgs84ToWindowCoordinates?.(scene, marker.billboard.position);
        if (screen) out.push({ id, x: screen.x, y: screen.y });
      }
      return out;
    },
    destroy() {
      destroyed = true;
      try { removeTick?.(); } catch { /* already gone */ }
      clear();
      for (const collection of [billboards, points, labels, polylines]) {
        try { scene.primitives.remove(collection); } catch { /* torn down */ }
      }
    },
  };
}
