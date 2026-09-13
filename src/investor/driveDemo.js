/**
 * Drive Mode v1 — the six-house scene, driven along real roads.
 *
 * What this replaces: a "route" that was a list of eight houses sorted by
 * score, a camera that cut from one to the next every seven seconds, and a
 * narration that read a line at each stop. Nothing about it was a drive. There
 * were no roads, no travel, no sense of anything arriving.
 *
 * What it is now: a committed, road-following loop (`mock/sixRoute.js`, fetched
 * once and checked vertex by vertex against OSM's own highways), a chase camera
 * that follows a spline through it, and a board whose emphasis is a function of
 * **how far ahead each house is** rather than of which stop index we are on.
 *
 * ## The one architectural rule
 *
 * Everything reads the **position source**, never the spline.
 *
 *     { position, bearingDeg, speedMps, timestamp, accuracyM }
 *
 * `PlaybackSource` generates those from the spline; `GpsSource` gets them from
 * a phone. This module projects whatever arrives back onto the route and drives
 * activation, sides and narration off the projection. Reading the spline
 * directly would be shorter by a dozen lines and would mean the GPS path
 * exercised none of the same code — which is exactly the bug that ships.
 *
 * ## Playback speed is not a vehicle's speed
 *
 * 9 m/s is how fast the drive plays, not how fast anyone is driving. "Slower"
 * and "faster" scale playback; approaching a house the assistant is explaining
 * slows it to 40% so the house is still on screen when the sentence ends. None
 * of that is a claim about a car.
 */
import { holdContinuousRender, releaseContinuousRender } from '../renderGovernor.js';
import { compositeScore, primarySignal } from './mock/schema.js';
import { countdownWords } from './georgia.js';
import { whyThisMatters } from './focus.js';
import { SIX_ROUTE, SIX_ROUTE_LENGTH_M } from './mock/sixRoute.js';
import {
  buildRoute,
  projectOnto,
  sideFromBearing,
  signedAheadM,
  smoothHeading,
  wrapDistance,
} from './drive/route.js';
import { activationsFor, speedScaleFor, SLOW_RADIUS_M } from './drive/activation.js';
import {
  CALLOUT_AHEAD_M,
  ambiguityQuestion,
  bestAlongRoute,
  calloutFor,
  createDiscussionTracker,
  goldWhy,
  groupByProximity,
  resolveDiscussed,
  shouldAnnounce,
} from './drive/narration.js';
import { createGpsSource, createPlaybackSource } from './drive/positionSource.js';

const HOLD_ID = 'investor-drive';
const URGENT_SIGNALS = new Set(['FORECLOSURE', 'TAX_SALE']);
const DRIVE_MIN_COMPOSITE = 86;
const DRIVE_MIN_CONFIDENCE = 0.78;

/** How far off the route a property may sit and still belong to this drive. */
const ON_ROUTE_MAX_OFFSET_M = 90;

export const MODES = Object.freeze({ DRIVE: 'drive', PROPERTY: 'property' });

/** Worth a detour: a high composite, or a clock already running on the house. */
export function isStrongDriveSignal(property) {
  const signal = primarySignal(property);
  return Boolean(
    compositeScore(property) >= DRIVE_MIN_COMPOSITE
    || (signal && URGENT_SIGNALS.has(signal.type) && signal.confidence >= DRIVE_MIN_CONFIDENCE),
  );
}

/**
 * A house with a sale on the calendar gets announced by its deadline; anything
 * else gets announced by its signal.
 */
export function announceLine(property) {
  const where = String(property?.address || 'this property').split(',')[0];
  const signal = primarySignal(property);
  const auction = property?.auction;
  if (auction && Number.isFinite(auction.daysUntil)) {
    const lead = signal?.type === 'TAX_SALE' ? 'Tax sale' : 'Notice of sale';
    const days = auction.daysUntil;
    if (days > 1) return `${lead} at ${where} — auction in ${days} days.`;
    return `${lead} at ${where} — auction ${countdownWords(days)}.`;
  }
  return `Strong ${String(signal?.type || 'signal').replaceAll('_', ' ').toLowerCase()} at ${where}.`;
}

/**
 * The old stop list. Kept because the shortlist it produces is still the right
 * answer to "which of these is worth stopping for", and `conversation.js` and
 * the demo rail both still ask that question.
 */
export function buildDriveRoute(properties) {
  return properties
    .filter(isStrongDriveSignal)
    .sort((a, b) => compositeScore(b) - compositeScore(a))
    .slice(0, 8);
}

/**
 * Which properties this route actually passes.
 *
 * A house 300 m off the loop is not on this drive however good its numbers are,
 * and projecting it anyway would have the narration announce something that
 * never comes into view.
 */
export function propertiesOnRoute(route, properties, { maxOffsetM = ON_ROUTE_MAX_OFFSET_M } = {}) {
  const out = [];
  for (const property of properties || []) {
    const projected = projectOnto(route, property);
    if (!projected || projected.offsetM > maxOffsetM) continue;
    out.push({
      id: property.id,
      property,
      alongM: projected.alongM,
      offsetM: projected.offsetM,
    });
  }
  return out.sort((a, b) => a.alongM - b.alongM);
}

/**
 * The card shown before the drive starts: where, how far, what is on it.
 *
 * Deliberately small and deliberately before. A drive that simply begins is
 * disorienting; one sentence of "here is what you are about to see" is the
 * difference between a demo and a surprise.
 */
export function drivePlan(route, onRoute) {
  const types = new Set();
  for (const row of onRoute) {
    const type = primarySignal(row.property)?.type;
    if (type) types.add(type);
  }
  const first = onRoute[0]?.property;
  return {
    area: first?.neighborhood || 'this neighborhood',
    city: first?.city || '',
    lengthM: Math.round(route?.lengthM || SIX_ROUTE_LENGTH_M),
    properties: onRoute.length,
    signalTypes: [...types].sort(),
    ids: onRoute.map((row) => row.id),
  };
}

/**
 * @param {{viewer:object, Cesium:object, camera:object, visuals:object,
 *   getProperties:Function, onAnnounce:Function, onStop:Function,
 *   onState:Function, routeCoordinates?:Array, makeSource?:Function}} deps
 */
export function createDriveDemo({
  viewer,
  Cesium,
  camera = null,
  visuals = null,
  getProperties,
  onAnnounce,
  onStop,
  onState = null,
  routeCoordinates = SIX_ROUTE,
  now = () => Date.now(),
  geolocation = globalThis.navigator?.geolocation,
} = {}) {
  const route = buildRoute(routeCoordinates);

  let source = null;
  let running = false;
  let mode = MODES.DRIVE;
  let onRoute = [];
  let groups = [];
  let narrationLevel = 'full';
  let goldId = null;
  let goldRequested = false;
  let goldAnnounced = false;
  let selectedId = null;
  let smoothedHeading = null;
  let lastFix = null;
  let lastAlongM = 0;
  let lookActive = false;
  /** Where the drive was when it left the road for a closer look. */
  let resumePoint = null;
  const announced = new Set();
  const discussion = createDiscussionTracker();
  const callouts = [];

  function emitState(extra = {}) {
    onState?.({
      running,
      mode,
      paused: Boolean(source?.paused),
      level: narrationLevel,
      goldId,
      goldRequested,
      alongM: lastAlongM,
      lengthM: route.lengthM,
      selectedId,
      ...extra,
    });
  }

  function speak(text, payload = {}) {
    if (!text) return null;
    const line = { spoken: text, ...payload };
    onAnnounce?.(line);
    return line;
  }

  // ---- per-fix ------------------------------------------------------------

  /**
   * One position fix, from whichever source is running.
   *
   * This is the whole feature in one function, and the order matters: project,
   * then activate, then narrate, then steer. Narration reads the projection
   * rather than the spline so that a GPS drive narrates identically.
   */
  function onFix(fix, dtSeconds) {
    if (!running || !fix?.position) return;
    // An untrusted GPS fix is reported to the HUD but never moves the drive.
    if (fix.trusted === false) {
      emitState({ weakSignal: true });
      return;
    }
    lastFix = fix;

    const projected = projectOnto(route, fix.position);
    if (!projected) return;
    lastAlongM = projected.alongM;

    // Heading: the fix's own bearing, smoothed. A GPS course and a spline
    // tangent are the same kind of number and get the same filter.
    smoothedHeading = smoothHeading(
      smoothedHeading,
      fix.bearingDeg,
      Number.isFinite(dtSeconds) && dtSeconds > 0 ? dtSeconds : 0.25,
    );

    // (3) Activation by position along the route.
    const activations = activationsFor(onRoute, {
      alongM: projected.alongM,
      selectedId,
      savedIds: visuals?.savedIds || null,
      signedAhead: (from, to) => signedAheadM(route, from, to),
    });
    visuals?.setDriveActivations?.(activations);

    // (4) Narration, and (5) the gold call-out if one was asked for.
    narrate(fix, projected);

    // Slow for the house being explained — playback, not brakes.
    const discussedId = discussion.current?.primaryId || null;
    if (discussedId) {
      const row = onRoute.find((r) => r.id === discussedId);
      const ahead = row ? signedAheadM(route, projected.alongM, row.alongM) : Infinity;
      source?.setExternalScale?.(speedScaleFor(ahead, { discussing: true }));
    } else {
      source?.setExternalScale?.(1);
    }

    // (2) Steer.
    if (mode === MODES.DRIVE) {
      if (lookActive) {
        const look = camera?.relaxDriveLook?.(dtSeconds);
        if (look?.settled) lookActive = false;
      }
      camera?.updateDrive?.(fix.position, smoothedHeading);
    }
    emitState();
  }

  function narrate(fix, projected) {
    // (5) Gold first: if the user asked for the best match, it owns its arrival
    // and the ordinary call-out for that house is skipped.
    if (goldRequested && goldId && !goldAnnounced) {
      const row = onRoute.find((r) => r.id === goldId);
      if (row) {
        const ahead = signedAheadM(route, projected.alongM, row.alongM);
        if (ahead <= CALLOUT_AHEAD_M && ahead > 0) {
          const side = sideFromBearing(fix.position, fix.bearingDeg, row.property);
          const callout = calloutFor({ ids: [row.id], members: [row], alongM: row.alongM }, side, { gold: true });
          goldAnnounced = true;
          announced.add(row.id);
          discussion.announce([row.id], row.id);
          callouts.push({ ...callout, side, atM: projected.alongM });
          visuals?.setTopPick?.(row.id);
          speak(callout.text, { id: row.id, gold: true, why: goldWhy(row.property), property: row.property });
          speak(goldWhy(row.property), { id: row.id, gold: true, detail: true, property: row.property });
          return;
        }
      }
    }

    for (const group of groups) {
      const ahead = signedAheadM(route, projected.alongM, group.alongM);
      if (!shouldAnnounce({ group, aheadM: ahead, level: narrationLevel, announced })) continue;
      // The gold house announces itself; do not announce it twice.
      if (goldRequested && group.ids.length === 1 && group.ids[0] === goldId) continue;

      const side = sideFromBearing(fix.position, fix.bearingDeg, group.members[0].property);
      const callout = calloutFor(group, side);
      for (const id of group.ids) announced.add(id);
      discussion.announce(group.ids, callout.primaryId);
      callouts.push({ ...callout, side, atM: projected.alongM });
      // Level `off` still tracks what is being passed, so "save that one"
      // works in silence — it simply does not speak.
      if (narrationLevel !== 'off') {
        speak(callout.text, {
          id: callout.primaryId,
          ids: callout.ids,
          side,
          property: group.members[0].property,
        });
      }
      return; // one call-out per fix; the next group waits its turn
    }
  }

  // ---- lifecycle ----------------------------------------------------------

  function plan() {
    const properties = typeof getProperties === 'function' ? getProperties() : [];
    return drivePlan(route, propertiesOnRoute(route, properties));
  }

  function start({ live = false, gold = false, level = narrationLevel } = {}) {
    const properties = typeof getProperties === 'function' ? getProperties() : [];
    onRoute = propertiesOnRoute(route, properties);
    if (!onRoute.length) {
      return { ok: false, action: 'start_drive', spoken: 'Nothing on this route to show you.' };
    }
    groups = groupByProximity(onRoute);
    announced.clear();
    callouts.length = 0;
    discussion.reset();
    narrationLevel = level;
    goldRequested = Boolean(gold);
    goldAnnounced = false;
    goldId = goldRequested ? bestAlongRoute(onRoute)?.id || null : null;
    selectedId = null;
    smoothedHeading = null;
    lookActive = false;
    resumePoint = null;
    mode = MODES.DRIVE;

    source?.destroy?.();
    source = live
      ? createGpsSource({ route, geolocation, now })
      : createPlaybackSource({ route, now });
    source.subscribe((fix) => onFix(fix, fixDelta(fix)));

    running = true;
    holdContinuousRender(HOLD_ID);
    camera?.engageDrive?.();
    visuals?.setDriveRoute?.(routeCoordinates);
    visuals?.setDriveMode?.(true);

    const started = source.start((error) => {
      speak(`Could not start a live drive: ${error?.message || 'no position'}.`);
    });
    if (live && !started) {
      stop();
      return { ok: false, action: 'start_drive', spoken: 'Live drive needs location permission.' };
    }

    const summary = plan();
    return {
      ok: true,
      action: 'start_drive',
      live,
      gold: goldRequested,
      plan: summary,
      spoken: `Driving ${summary.area} — ${(summary.lengthM / 1000).toFixed(1)} km, `
        + `${summary.properties} flagged properties. Say pause here, or look closer.`,
    };
  }

  let previousFixAt = null;
  function fixDelta(fix) {
    const stamp = Number(fix?.timestamp);
    if (!Number.isFinite(stamp)) return 0.25;
    const dt = previousFixAt === null ? 0 : (stamp - previousFixAt) / 1000;
    previousFixAt = stamp;
    return dt > 0 ? Math.min(1, dt) : 0.25;
  }

  function stop() {
    running = false;
    mode = MODES.DRIVE;
    source?.stop?.();
    releaseContinuousRender(HOLD_ID);
    camera?.releaseDrive?.();
    visuals?.setDriveMode?.(false);
    visuals?.setDriveActivations?.(null);
    previousFixAt = null;
    onStop?.();
    emitState();
    return { ok: true, action: 'stop_drive', spoken: 'Drive stopped.' };
  }

  /** The render loop's tick. Playback needs it; GPS ignores it. */
  function tick(dtSeconds) {
    if (!running || mode !== MODES.DRIVE) return;
    source?.advance?.(dtSeconds);
  }

  // ---- commands -----------------------------------------------------------

  function pause() {
    source?.pause?.();
    emitState();
    return { ok: true, action: 'drive_pause', spoken: 'Paused here.' };
  }

  function resume() {
    source?.resume?.();
    emitState();
    return { ok: true, action: 'drive_resume', spoken: 'Keeping going.' };
  }

  function look(direction) {
    const applied = camera?.setDriveLook?.(direction);
    lookActive = direction !== 'ahead';
    emitState();
    const words = {
      left: 'Looking left.', right: 'Looking right.', overhead: 'Overhead.', ahead: 'Back on the road.',
    };
    return { ok: true, action: 'drive_look', look: direction, applied, spoken: words[direction] || '' };
  }

  /**
   * (6) Look closer: leave the road for this house.
   *
   * The route position is saved, not lost — `keepGoing` puts the drive back
   * exactly where it left off and facing the same way, which is what makes a
   * detour feel like a detour rather than a restart.
   */
  function lookCloser(id = null) {
    const targetId = id || discussion.current?.primaryId || null;
    const row = onRoute.find((r) => r.id === targetId);
    if (!row) return { ok: false, action: 'look_closer', spoken: 'Nothing to look at yet.' };

    resumePoint = { alongM: lastAlongM, headingDeg: smoothedHeading };
    mode = MODES.PROPERTY;
    selectedId = row.id;
    source?.pause?.();
    camera?.releaseDrive?.();
    visuals?.setDriveMode?.(false);
    visuals?.setFocused?.(row.id);
    camera?.fly?.('HERO', row.property);
    discussion.settle(row.id);
    emitState();
    return {
      ok: true,
      action: 'look_closer',
      id: row.id,
      property: row.property,
      spoken: `${String(row.property.address).split(',')[0]}. Say keep going when you're ready.`,
    };
  }

  /** (6) Back to the road, where and how we left it. */
  function keepGoing() {
    if (mode !== MODES.PROPERTY) {
      return resume();
    }
    mode = MODES.DRIVE;
    selectedId = null;
    visuals?.setFocused?.(null);
    visuals?.setDriveMode?.(true);
    camera?.engageDrive?.();
    if (resumePoint) {
      source?.seek?.(resumePoint.alongM);
      smoothedHeading = resumePoint.headingDeg;
      resumePoint = null;
    }
    source?.resume?.();
    emitState();
    return { ok: true, action: 'keep_going', spoken: 'Back on the route.' };
  }

  /** (5) "Show me the best match along this route." */
  function requestBestMatch() {
    const best = bestAlongRoute(onRoute);
    if (!best) return { ok: false, action: 'drive_best', spoken: 'Nothing ranked on this route yet.' };
    goldRequested = true;
    goldId = best.id;
    const row = onRoute.find((r) => r.id === best.id);
    visuals?.setTopPick?.(best.id);

    /**
     * "Behind us" is about whether we have PASSED it, not about the sign of a
     * signed distance.
     *
     * This route is a loop, and `signedAheadM` deliberately reports anything
     * more than half a lap ahead as behind — which is right for activation and
     * wrong here. The best match sits at 1,382 m on a 1,382 m loop, so asked at
     * 20 m in, the signed distance is −20: technically behind, actually 1,362 m
     * of driving away and certain to come round. Trusting that sign announced
     * it as already missed, suppressed the approach call-out, and left the one
     * house the user asked about as the only one never mentioned.
     *
     * Whether it has been passed is a fact the drive already knows: it is
     * whether the house has been announced this lap.
     */
    if (row && announced.has(best.id) && !goldAnnounced) {
      goldAnnounced = true;
      discussion.announce([best.id], best.id);
      const line = goldWhy(row.property);
      const callout = calloutFor(
        { ids: [row.id], members: [row], alongM: row.alongM }, 'ahead', { gold: true },
      );
      callouts.push({ ...callout, side: 'behind', atM: lastAlongM });
      speak(`Best match on this route is behind us — ${line}`, { id: best.id, gold: true });
      return { ok: true, action: 'drive_best', id: best.id, behind: true, spoken: line };
    }

    emitState();
    const forwardM = row
      ? wrapDistance(row.alongM - lastAlongM, route.lengthM)
      : null;
    return {
      ok: true,
      action: 'drive_best',
      id: best.id,
      forwardM,
      spoken: 'Watching for the best match — I\'ll call it as we come up on it.',
    };
  }

  function setNarrationLevel(level) {
    if (!['full', 'quiet', 'off'].includes(level)) {
      return { ok: false, spoken: 'Narration can be full, quiet, or off.' };
    }
    narrationLevel = level;
    emitState();
    return { ok: true, action: 'drive_narration', level, spoken: `Narration ${level}.` };
  }

  /** Resolve "that one" and hand back the property, or the question to ask. */
  function resolve(intent) {
    const outcome = resolveDiscussed(discussion, intent);
    if (outcome.ok) {
      return {
        ok: true,
        id: outcome.id,
        previousId: outcome.previousId || null,
        property: onRoute.find((r) => r.id === outcome.id)?.property || null,
      };
    }
    if (outcome.ambiguous) {
      const question = ambiguityQuestion(
        outcome.ambiguous,
        (id) => onRoute.find((r) => r.id === id)?.property || null,
      );
      return { ok: false, ambiguous: outcome.ambiguous, spoken: question };
    }
    return { ok: false, spoken: 'I haven\'t flagged anything yet.' };
  }

  return {
    get running() { return running; },
    get mode() { return mode; },
    get paused() { return Boolean(source?.paused); },
    get level() { return narrationLevel; },
    get goldId() { return goldId; },
    get alongM() { return lastAlongM; },
    get lengthM() { return route.lengthM; },
    get callouts() { return callouts.slice(); },
    get discussed() { return discussion.current; },
    get source() { return source; },
    get onRoute() { return onRoute.slice(); },
    get current() {
      const id = discussion.current?.primaryId;
      return id ? onRoute.find((r) => r.id === id)?.property || null : null;
    },

    route,
    plan,
    start,
    stop,
    tick,
    pause,
    resume,
    look,
    lookCloser,
    keepGoing,
    requestBestMatch,
    setNarrationLevel,
    resolve,

    slower() {
      const scale = source?.slower?.() ?? 1;
      return { ok: true, action: 'drive_speed', scale, spoken: 'Slowing down.' };
    },
    faster() {
      const scale = source?.faster?.() ?? 1;
      return { ok: true, action: 'drive_speed', scale, spoken: 'Speeding up.' };
    },

    /** The old stop-list commands, kept so existing intents keep working. */
    next() {
      const list = onRoute;
      if (!list.length) return start();
      const currentId = discussion.current?.primaryId;
      const index = list.findIndex((r) => r.id === currentId);
      const nextRow = list[(index + 1 + list.length) % list.length];
      discussion.settle(nextRow.id);
      return lookCloser(nextRow.id);
    },
    skip() {
      const id = discussion.current?.primaryId;
      if (id) announced.add(id);
      return keepGoing();
    },
    why() {
      const row = this.current;
      if (!row) return { ok: false, spoken: 'No property being discussed.' };
      return { ok: true, action: 'explain_property', id: row.id, spoken: whyThisMatters(row), property: row };
    },

    destroy() {
      stop();
      source?.destroy?.();
    },
  };
}
