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
import { brightnessFor, motionFor } from './effects/signalMotion.js';

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
 * The halo's brightness floor. The sprite's alpha rides the same per-signal
 * envelope the near-field rim does — the heartbeat, the double pulse, the
 * shimmer — and never falls below this fraction of full, so a marker at the
 * bottom of a beat is still a marker.
 */
export const HALO_ALPHA_FLOOR = 0.62;
/** The travelling arc: how much of the ring it lights, in turns. */
export const ARC_SPAN_TURNS = 0.22;

/**
 * Alpha multiplier for the halo at a moment on the shared clock, in
 * [HALO_ALPHA_FLOOR, 1]. Reduced motion holds it at the envelope's midpoint.
 */
export function haloAlphaFor(type, seconds, { reduced = false } = {}) {
  const motion = motionFor(type);
  const span = Math.max(1e-6, motion.ceil - motion.floor);
  const value = (brightnessFor(type, seconds, { reduced }) - motion.floor) / span;
  return HALO_ALPHA_FLOOR + (1 - HALO_ALPHA_FLOOR) * Math.min(1, Math.max(0, value));
}

/** Rotation of the travelling arc in radians, or null when the signal does not travel. */
export function arcRotationFor(type, seconds, { reduced = false } = {}) {
  const rate = motionFor(type).travelPerSec;
  if (!(rate > 0) || reduced) return null;
  const t = Number(seconds);
  if (!Number.isFinite(t)) return 0;
  // Clockwise on screen: Cesium rotates billboards counter-clockwise.
  return -2 * Math.PI * (((t * rate) % 1 + 1) % 1);
}

/**
 * Choreography constants, read by the sequences and by these tests.
 *
 * An ignition is a pop: the sprite swells by `IGNITE_POP` and settles over
 * `IGNITE_POP_S`. The beacon climbs from the roof over `BEACON_RISE_S`, and
 * the bookmark falls onto the house from `BOOKMARK_DROP_PX` above over
 * `BOOKMARK_DROP_S` with a small bounce.
 */
export const IGNITE_POP = 0.7;
export const IGNITE_POP_S = 0.35;
export const BEACON_RISE_S = 0.5;
export const BOOKMARK_DROP_PX = 72;
export const BOOKMARK_DROP_S = 0.45;
export const BOOKMARK_REST_PX = -26;

/** How much extra scale an ignition adds `elapsedS` after it fired. 0 once settled. */
export function ignitePopFor(elapsedS) {
  if (elapsedS === null || elapsedS === undefined) return 0;
  const t = Number(elapsedS);
  if (!Number.isFinite(t) || t < 0 || t >= IGNITE_POP_S) return 0;
  const p = t / IGNITE_POP_S;
  return IGNITE_POP * (1 - p) * (1 - p);
}

/** How far up the beacon has climbed, 0..1, `elapsedS` after the rise began. */
export function beaconRiseFor(elapsedS, { reduced = false } = {}) {
  if (reduced) return 1;
  const t = Number(elapsedS);
  if (!Number.isFinite(t) || t < 0) return 0;
  const p = clamp01(t / BEACON_RISE_S);
  // Ease-out cubic: fast off the roof, settling at the top.
  return 1 - (1 - p) ** 3;
}

/**
 * The bookmark's pixel offset above the marker `elapsedS` into its drop.
 *
 * Starts high, falls with a spring-like overshoot past the roof and settles
 * at the rest offset. Negative is up, as Cesium's pixelOffset reads it.
 */
export function bookmarkDropFor(elapsedS, { reduced = false } = {}) {
  if (reduced) return BOOKMARK_REST_PX;
  const t = Number(elapsedS);
  if (!Number.isFinite(t) || t < 0) return BOOKMARK_REST_PX - BOOKMARK_DROP_PX;
  if (t >= BOOKMARK_DROP_S) return BOOKMARK_REST_PX;
  const p = t / BOOKMARK_DROP_S;
  // Ease-out back: overshoots the rest point by a few pixels and returns.
  const c1 = 1.70158;
  const c3 = c1 + 1;
  const eased = 1 + c3 * (p - 1) ** 3 + c1 * (p - 1) ** 2;
  return BOOKMARK_REST_PX - BOOKMARK_DROP_PX * (1 - eased);
}

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
export function markerAlphaFor(id, {
  shortlistIds = null, focusedId = null, topPickId = null, litIds = null,
} = {}) {
  if (!shortlistIds || !shortlistIds.size) return 1;
  if (id === focusedId || id === topPickId) return 1;
  // A shortlist being lit one house at a time: members wait dim for their
  // turn, and the board does not read as answered until the last one lands.
  if (shortlistIds.has(id)) return litIds && !litIds.has(id) ? DIM_ALPHA : 1;
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

/** A thin ring with one bright arc — the travelling segment, as a sprite. */
function arcCanvas(rgba, size = SPRITE_PX) {
  const canvas = globalThis.document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  const [r, g, b] = rgba.map((v) => Math.round(v * 255));
  const half = size / 2;
  const radius = half * 0.72;
  ctx.lineCap = 'round';
  ctx.lineWidth = 2;
  ctx.strokeStyle = `rgba(${r},${g},${b},0.22)`;
  ctx.beginPath();
  ctx.arc(half, half, radius, 0, Math.PI * 2);
  ctx.stroke();
  ctx.lineWidth = 2.5;
  ctx.strokeStyle = `rgba(${r},${g},${b},0.95)`;
  ctx.shadowColor = `rgba(${r},${g},${b},0.9)`;
  ctx.shadowBlur = 4;
  ctx.beginPath();
  ctx.arc(half, half, radius, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * ARC_SPAN_TURNS);
  ctx.stroke();
  return canvas;
}

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
  /** Which shortlist members have ignited so far, or null once all are lit. */
  let litIds = null;
  let hoveredId = null;
  let enabled = false;
  /** Drive Mode weights per id, or null. See nearFieldEffects for the rule. */
  let driveActivations = null;
  /** The marker clock's last reading, so a choreography can stamp itself on it. */
  let lastSeconds = 0;
  /** The house whose card is on screen: the card carries the address, so the label yields. */
  let cardOnId = null;

  const NO_DEPTH = Number.POSITIVE_INFINITY;

  function spriteFor(type) {
    if (!sprites.has(type)) sprites.set(type, spriteCanvas(colorForSignal(type)));
    return sprites.get(type);
  }

  function arcFor(type) {
    const key = `__arc:${type}`;
    if (!sprites.has(key)) sprites.set(key, arcCanvas(colorForSignal(type)));
    return sprites.get(key);
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
      // The travelling segment, for the one signal that travels.
      const arc = motionFor(type).travelPerSec > 0
        ? billboards.add({
          position: base,
          image: arcFor(type),
          scale: 1,
          color: Cesium.Color.WHITE,
          disableDepthTestDistance: NO_DEPTH,
          show: false,
          id: pickId,
        })
        : null;
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

      markers.set(property.id, {
        property, type, billboard, point, beacon, label, bookmark, arc, base, top,
        ignitedAt: null, beaconRiseAt: null, bookmarkDropAt: null,
        alpha: 1,
        tint: new Cesium.Color(1, 1, 1, 1),
      });
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
        : markerAlphaFor(id, { shortlistIds, focusedId, topPickId, litIds });
      const isTop = id === topPickId;
      const isFocused = id === focusedId;
      const show = enabled && !(drive?.suspended);

      marker.billboard.show = show;
      marker.point.show = show;
      marker.billboard.image = isTop || isFocused ? goldSprite() : spriteFor(marker.type);
      // The selection alpha is remembered; the tick multiplies the halo's beat in.
      marker.alpha = alpha;
      marker.tint.alpha = alpha;
      marker.billboard.color = marker.tint;
      marker.point.color = marker.point.color.withAlpha(alpha);
      if (marker.arc) {
        marker.arc.show = show && !(isTop || isFocused);
        marker.arc.color = marker.tint;
      }

      const beaconOn = show && (isTop || isFocused);
      marker.beacon.show = beaconOn;
      marker.label.show = beaconOn && id !== cardOnId;
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
    lastSeconds = seconds;
    for (const [id, marker] of markers) {
      const emphasis = id === topPickId || id === focusedId ? EMPHASIS_SCALE : 1;
      // The halo beats: the per-signal envelope as alpha, on top of the scale pulse.
      const beat = emphasis > 1 ? 1 : haloAlphaFor(marker.type, seconds, { reduced: still });
      const alpha = marker.alpha * beat;
      if (Math.abs(marker.tint.alpha - alpha) > 1 / 255) {
        marker.tint.alpha = alpha;
        marker.billboard.color = marker.tint;
        if (marker.arc) marker.arc.color = marker.tint;
      }
      let pop = 0;
      if (marker.ignitedAt !== null) {
        pop = still ? 0 : ignitePopFor(seconds - marker.ignitedAt);
        if (seconds - marker.ignitedAt >= IGNITE_POP_S) marker.ignitedAt = null;
      }
      marker.billboard.scale = pulseScaleFor(marker.type, seconds, { reduced: still }) * emphasis * (1 + pop);
      if (marker.arc?.show) {
        const rotation = arcRotationFor(marker.type, seconds, { reduced: still });
        marker.arc.rotation = rotation ?? 0;
        marker.arc.scale = marker.billboard.scale;
      }

      if (marker.beaconRiseAt !== null) {
        const rise = beaconRiseFor(seconds - marker.beaconRiseAt, { reduced: still });
        marker.beacon.positions = [marker.base, Cesium.Cartesian3.lerp(marker.base, marker.top, rise, new Cesium.Cartesian3())];
        if (rise >= 1) marker.beaconRiseAt = null;
      }

      if (marker.bookmarkDropAt !== null) {
        const elapsed = seconds - marker.bookmarkDropAt;
        marker.bookmark.pixelOffset = new Cesium.Cartesian2(0, bookmarkDropFor(elapsed, { reduced: still }));
        if (still || elapsed >= BOOKMARK_DROP_S) marker.bookmarkDropAt = null;
      }
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
    /**
     * @param {string[]|null} ids
     * @param {{lit?:boolean}} [options] `lit: false` sets the shortlist with
     *   every member still dim, waiting for `ignite`.
     */
    setShortlist(ids, { lit = true } = {}) {
      const list = Array.isArray(ids) ? ids.filter(Boolean) : [];
      shortlistIds = list.length ? new Set(list) : null;
      litIds = shortlistIds && !lit ? new Set() : null;
      applyState();
    },
    /** Light one shortlist member: full strength, with a pop. */
    ignite(id) {
      const marker = markers.get(id);
      if (!marker) return false;
      if (litIds) litIds.add(id);
      marker.ignitedAt = lastSeconds;
      applyState();
      return true;
    },
    /** Light everything that is still waiting — the end state of a cancelled ignition. */
    igniteAll() {
      litIds = null;
      applyState();
    },
    /** Start the beacon climbing from the roof. It is only drawn for the top pick or the focus. */
    raiseBeacon(id) {
      const marker = markers.get(id);
      if (!marker) return false;
      marker.beaconRiseAt = lastSeconds;
      marker.beacon.positions = [marker.base, marker.base];
      return true;
    },
    /** Drop the bookmark glyph onto the house. `setSaved` decides whether it shows. */
    dropBookmark(id) {
      const marker = markers.get(id);
      if (!marker) return false;
      marker.bookmarkDropAt = lastSeconds;
      marker.bookmark.pixelOffset = new Cesium.Cartesian2(0, bookmarkDropFor(0));
      return true;
    },
    /** Where one marker's anchor lands on screen, or null when it is not built. */
    screenPositionFor(id) {
      const marker = markers.get(id);
      if (!marker) return null;
      const screen = Cesium.SceneTransforms.worldToWindowCoordinates?.(scene, marker.billboard.position)
        || Cesium.SceneTransforms.wgs84ToWindowCoordinates?.(scene, marker.billboard.position);
      return screen ? { id, x: screen.x, y: screen.y } : null;
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
    /** The card is up for this house, or for none. */
    setCardOn(id) {
      const next = id || null;
      if (cardOnId === next) return;
      cardOnId = next;
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
