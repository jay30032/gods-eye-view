/**
 * Drive Mode v2's view director — which view answers which question.
 *
 * Street View is the driving view; the 3D scene is the **answer engine**. That
 * split only works if something owns the decision, because the two views are
 * good at opposite things and the user does not say which one they want. They
 * ask "how big is the lot", and a lot line is invisible from the kerb and
 * obvious from 150 m up; they ask "why did you flag it", and the answer is a
 * card that needs no camera move at all.
 *
 * So this module is two things and nothing else:
 *
 *   1. a **mapping** from a question to a view, pure and table-driven;
 *   2. the **transition** between the Street View element and the Cesium
 *      canvas, which owns the 300 ms cross-fade and the route position that
 *      has to survive it.
 *
 * It performs no underwriting, writes no card, and chooses no house. The
 * session still answers the question; this decides what the answer is shown on.
 *
 * ## Why the mapping is not just the existing parser
 *
 * `nlp/parse.js` already turns an utterance into an intent, and most of the
 * time the intent is enough — `why` is a card, `show_deal` is the numbers. But
 * the parser has no vocabulary for the words that pick a *view*: "lot",
 * "parcel", "boundaries", "roof", "what's around it", "comps" all fall through
 * it to `focus` or `unknown`. Adding them to the parser would mean "how big is
 * the lot" stopped being a question about a property and started being a camera
 * command, which is the wrong shape — the user is asking about the land, and
 * the aerial is how the product answers. So the view vocabulary lives here,
 * runs first, and falls back to the intent map when it recognises nothing.
 *
 * ## The order of the table is load-bearing
 *
 * `back` appears in two of the product's own rules — "show me the back" is an
 * angle and "back on the road" is a resume — and `from above` appears in both
 * the overhead rule and, as a range change, in the parser's camera vocabulary.
 * The table resolves both by ordering rather than by cleverness: **resume
 * first**, because it is the one phrase that must never be misread as a camera
 * move, and the specific view nouns before the generic ones.
 */

import { normalizeUtterance } from '../nlp/parse.js';

/** Every view the drive can be showing. */
export const VIEWS = Object.freeze({
  /** The 3D chase camera: the moving view, and what every answer returns to. */
  DRIVE: 'drive',
  /**
   * The panorama, standing still.
   *
   * Street View was the driving view for one revision and is not any more. A
   * panorama is a still photograph of one point, and a drive assembled out of
   * them is a sequence of cuts however carefully they are cross-faded — the
   * double buffer made each join continuous and could not make the *motion*
   * continuous, because there is none between two fixed points. The 3D scene
   * moves; the panorama is what you look at when you have stopped.
   */
  STREET_VIEW: 'streetview',
  /** A card over whatever is already on screen. No camera move. */
  CARD: 'card',
  /** 3D at HERO with the parcel and the outline glow — "here's the lot". */
  AERIAL: 'aerial',
  /** 3D nadir at 120 m — "here's the roof". */
  TOPDOWN: 'topdown',
  /** The existing any-angle shots — sides and compass points. */
  ANGLE: 'angle',
  /** 3D CRUISE over the route — the block, the neighbours, the comps. */
  CRUISE: 'cruise',
  /** A card with the underwriting. No camera move. */
  ANALYSIS: 'analysis',
});

/** Views drawn by Cesium rather than by the panorama. */
const THREE_D_VIEWS = new Set([VIEWS.AERIAL, VIEWS.TOPDOWN, VIEWS.ANGLE, VIEWS.CRUISE]);

/** Views that park the drive: everything except the moving view and the cards. */
const STOP_VIEWS = new Set([...THREE_D_VIEWS, VIEWS.STREET_VIEW]);

/** Is this view rendered by the 3D scene? */
export function isThreeD(view) {
  return THREE_D_VIEWS.has(view);
}

/**
 * Views that leave the road.
 *
 * Everything drawn by Cesium takes the camera off the route, so the drive is
 * paused and its position saved — otherwise "keep going" would resume half a
 * block from where the question was asked, and the answer to "what's around
 * it" would be a block the user never drove past.
 *
 * A card is not one of these. It is drawn *over* the driving view and the
 * drive keeps rolling underneath it, which is the whole reason why / flagged /
 * how recent are cards: they are answerable without stopping.
 */
export function leavesTheRoad(view) {
  return STOP_VIEWS.has(view);
}

/** The cross-fade, in milliseconds. */
export const CROSS_FADE_MS = 300;

// ---------------------------------------------------------------------------
// The mapping
// ---------------------------------------------------------------------------

/**
 * Phrase → view, in priority order. The comments are the reasons, not notes.
 */
const VIEW_PATTERNS = Object.freeze([
  // 1. Resume. First, and only first, because "back on the road" contains
  //    "back" and rule 7 would otherwise read it as a request for a rear wall.
  //    It returns to the 3D chase camera, which is the drive.
  [/\bkeep going\b|\bresume\b|\bcarry on\b|\bback on (?:the )?(?:road|route)\b|\bdrive on\b|\bback to (?:the )?(?:drive|road)\b/,
    VIEWS.DRIVE, 'resume'],

  // 1b. The panorama, on demand. Ahead of the sides rule because "from the
  //     street" contains neither a side nor a compass point but does read as a
  //     request to look at something, and rule 7 would claim it on `from`.
  //
  //     This is what "from the street" now means. It used to be a 3D camera
  //     placed at the kerb looking at the front wall — a reconstruction of a
  //     view Google has an actual photograph of, taken from the actual street.
  [/\bstreet view\b|\bfrom the street\b|\bstreet[\s-]?side\b|\bfrom the (?:curb|kerb)\b|\bon the street\b/,
    VIEWS.STREET_VIEW, 'streetview'],

  // 2. The land. Ahead of the overhead rule because "how big is the lot from
  //    above" is a question about the lot; the aerial answers it either way,
  //    and the parcel outline is the point rather than the pitch.
  [/\blots?\b|\bparcels?\b|\bhow big\b|\bboundar(?:y|ies)\b|\b(?:lot|property) lines?\b|\bacreage?\b|\bhow much land\b|\bsquare foot(?:age)?\b/,
    VIEWS.AERIAL, 'lot'],

  // 3. Straight down.
  [/\broofs?\b|\boverhead\b|\bfrom above\b|\btop[\s-]?down\b|\bbird'?s eye\b|\baerial\b|\bsatellite\b/,
    VIEWS.TOPDOWN, 'overhead'],

  // 4. The block. "around it" rather than "around", so "go around" stays an
  //    orbit and never becomes a cruise over the neighbourhood.
  [/\bneighbou?rhood\b|\bwhat'?s around (?:it|here|this)\b|\baround (?:it|here)\b|\bcomps?\b|\bcomparables?\b|\bthe block\b|\bnearby\b|\bwhat else is\b/,
    VIEWS.CRUISE, 'neighborhood'],

  // 5. The underwriting.
  [/\bnumbers?\b|\bdeals?\b|\brun it\b|\brun the numbers\b|\bunderwrite\b|\bmodel it\b|\bcash[\s-]?flow\b|\bwhat'?s it worth\b/,
    VIEWS.ANALYSIS, 'numbers'],

  // 6. How fresh the filing is — ahead of `why` so the clause that lands is
  //    "here's the filing" rather than "here's why" for a question about a date.
  [/\bhow recent\b|\bhow old\b|\bwhen was (?:it|that|this)\b|\bhow long ago\b/,
    VIEWS.CARD, 'recency'],

  // 6b. Why.
  [/\bwhy\b|\bflagg?ed\b|\bwhat'?s special\b/, VIEWS.CARD, 'why'],

  // 7. Sides and compass points, last, and only when the sentence reads as a
  //    request to look at something — the same guard `parseCameraCommand` uses,
  //    and for the same reason: "the front of the deal" is not a camera move.
  [/\b(?:show|see|view|look|from|give me|swing|face|facing)\b[^.]*\b(?:back|rear|front|left|right|side)\b|\bfrom the (?:north|south|east|west)/,
    VIEWS.ANGLE, 'angle'],
]);

/**
 * Intent → view, for the utterances the phrase table does not recognise.
 *
 * This is the fallback rather than the primary because an intent is coarser
 * than the question: `camera_angle` covers "closer" and "show me the back",
 * which want the same view, and `focus` covers everything the parser gave up
 * on, which wants none.
 */
const INTENT_VIEWS = Object.freeze({
  why: [VIEWS.CARD, 'why'],
  how_recent: [VIEWS.CARD, 'recency'],
  more_like_it: [VIEWS.CARD, 'why'],
  show_deal: [VIEWS.ANALYSIS, 'numbers'],
  what_if: [VIEWS.ANALYSIS, 'numbers'],
  compare: [VIEWS.ANALYSIS, 'numbers'],
  reset_assumptions: [VIEWS.ANALYSIS, 'numbers'],
  camera_angle: [VIEWS.ANGLE, 'angle'],
  drive_resume: [VIEWS.DRIVE, 'resume'],
  look_closer: [VIEWS.AERIAL, 'lot'],
});

/**
 * Which view answers this question, or null for "leave the view alone".
 *
 * Null is a real answer and the common one: "pause here", "slower", "save that
 * one" and "narration off" are all things a drive does without changing what it
 * is showing, and a view director that insisted on a view for every utterance
 * would cut away from the road to acknowledge a volume change.
 *
 * @param {string} text what the user said
 * @param {{intent?:string, slots?:object}} [parsed] the parser's reading of it
 * @returns {{view:string, reason:string}|null}
 */
export function viewForQuestion(text, { intent = null, slots = null } = {}) {
  const normalized = normalizeUtterance(text);
  if (normalized) {
    for (const [pattern, view, reason] of VIEW_PATTERNS) {
      if (pattern.test(normalized)) return { view, reason };
    }
  }
  // `drive_look` carries its own direction, and "overhead" is the one that is
  // a view rather than a glance out of a side window.
  if (intent === 'drive_look') {
    return slots?.look === 'overhead' ? { view: VIEWS.TOPDOWN, reason: 'overhead' } : null;
  }
  const mapped = INTENT_VIEWS[intent];
  if (!mapped) return null;
  // "closer" and "farther" are re-framings of whatever is in frame, not a
  // request to leave Street View for a 3D angle.
  if (intent === 'camera_angle' && !slots?.side && !slots?.compass) return null;
  return { view: mapped[0], reason: mapped[1] };
}

/**
 * One short spoken clause per view switch.
 *
 * Short is the requirement, not a preference. The line lands while the
 * cross-fade is still running, and anything longer than a clause is still being
 * spoken when the answer is already on screen — which reads as the assistant
 * narrating a view the user is looking at rather than handing it over.
 */
export function announceFor(view, reason = null) {
  switch (view) {
    case VIEWS.DRIVE: return 'Back on the road.';
    case VIEWS.STREET_VIEW: return 'From the street.';
    case VIEWS.AERIAL: return 'Here\'s the lot.';
    case VIEWS.TOPDOWN: return 'From above.';
    case VIEWS.CRUISE: return 'Here\'s the block.';
    case VIEWS.ANGLE: return 'Coming around.';
    case VIEWS.ANALYSIS: return 'Here are the numbers.';
    case VIEWS.CARD: return reason === 'recency' ? 'Here\'s the filing.' : 'Here\'s why.';
    default: return '';
  }
}

// ---------------------------------------------------------------------------
// The cross-fade
// ---------------------------------------------------------------------------

function clamp01(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.min(1, Math.max(0, n));
}

/**
 * Where the cross-fade is, as a pure function of elapsed time.
 *
 * The two opacities are complementary because the panorama element is stacked
 * **over** the Cesium canvas: what "the Cesium canvas's opacity" means here is
 * how much of the frame is the 3D scene, which is exactly one minus the
 * panorama's alpha. Nothing writes an opacity to the Cesium container — doing
 * so would put a compositing layer between the render governor and the screen
 * for no benefit, and the effect on screen is identical.
 *
 * Smoothstep rather than linear: a linear alpha ramp between two photographic
 * images reads as a wipe with a hard start and stop, and 300 ms is short enough
 * that the eased ends are what make it read as a dissolve at all.
 *
 * @param {number} elapsedMs since the fade began
 * @param {{to:string, durationMs?:number}} options `to` is the view being entered
 */
export function crossFadeState(elapsedMs, { to, durationMs = CROSS_FADE_MS } = {}) {
  const duration = Math.max(1, Number(durationMs) || CROSS_FADE_MS);
  const t = clamp01((Number(elapsedMs) || 0) / duration);
  const eased = t * t * (3 - 2 * t);
  const towardsStreetView = to === VIEWS.STREET_VIEW;
  const streetView = towardsStreetView ? eased : 1 - eased;
  return {
    t,
    streetView,
    cesium: 1 - streetView,
    done: t >= 1,
    // The element stays in the tree for the whole fade and only leaves once it
    // is fully transparent — removing it at t=0.99 is a one-frame flash of the
    // 3D scene at the end of every transition into Street View's own view.
    showStreetView: streetView > 0,
  };
}

// ---------------------------------------------------------------------------
// The director
// ---------------------------------------------------------------------------

/**
 * @param {{element:Element, camera:object, visuals:object, drive:object,
 *   streetView?:object, onAnnounce?:Function, onView?:Function,
 *   timers?:object, now?:Function}} deps
 */
export function createViewDirector({
  element = null,
  camera = null,
  visuals = null,
  drive = null,
  streetView = null,
  onAnnounce = null,
  onView = null,
  timers = globalThis,
  now = () => Date.now(),
} = {}) {
  let view = VIEWS.DRIVE;
  let fadeTo = VIEWS.DRIVE;
  let fadeStartedAt = now() - CROSS_FADE_MS;
  let fadeTimer = null;
  /** Where the drive was when it last left the road, and facing which way. */
  let saved = null;
  let enabled = false;

  function applyFade(target) {
    fadeTo = target;
    fadeStartedAt = now();
    if (!element) return;
    const toStreetView = target === VIEWS.STREET_VIEW;
    // Un-hide and re-measure BEFORE the opacity starts climbing, or the first
    // 300 ms of every return to the road is a fade-in of a stale frame.
    if (toStreetView) {
      element.hidden = false;
      streetView?.setVisible?.(true);
    }
    element.dataset.tsSvActive = String(toStreetView);
    // The transition is the browser's; `crossFadeState` is the contract it
    // implements. One compositor-driven opacity beats a per-frame JS write,
    // and there is no scene state here for the render governor to own.
    element.style.transition = `opacity ${CROSS_FADE_MS}ms cubic-bezier(0.4, 0, 0.2, 1)`;
    element.style.opacity = toStreetView ? '1' : '0';
    if (fadeTimer) timers.clearTimeout?.(fadeTimer);
    fadeTimer = timers.setTimeout?.(() => {
      fadeTimer = null;
      if (toStreetView || !element) return;
      element.hidden = true;
      // An element at opacity 0 is still a panorama fetching Google's imagery.
      streetView?.setVisible?.(false);
    }, CROSS_FADE_MS);
  }

  /** Pause the drive and remember exactly where and which way it was going. */
  function parkOnTheRoad() {
    if (!drive || saved) return;
    saved = { alongM: drive.alongM, headingDeg: drive.headingDeg ?? null };
    drive.parkForAnswer?.();
  }

  const director = {
    get view() { return view; },
    get enabled() { return enabled; },
    get saved() { return saved ? { ...saved } : null; },
    get fade() { return crossFadeState(now() - fadeStartedAt, { to: fadeTo }); },

    /**
     * A drive is running, so there is a road to leave and come back to.
     *
     * Before this is true every view decision still resolves — the mapping is
     * pure and the tests exercise it directly — and none of them is acted on,
     * because there is no route position to save and nothing to return to.
     */
    setEnabled(next) {
      enabled = Boolean(next);
      if (!enabled) {
        view = VIEWS.DRIVE;
        saved = null;
      }
      return enabled;
    },

    /** Which view answers this, given the drive's own reading of the words. */
    route(text, parsed) {
      return viewForQuestion(text, parsed || {});
    },

    /**
     * Put a view on screen.
     *
     * Returns the spoken clause so the caller can lead with it rather than
     * appending it to whatever the answer itself says — the announcement is
     * about the move, and it belongs before the content.
     *
     * @param {string} next one of VIEWS
     * @param {{property?:object, reason?:string, angle?:Function,
     *   moveCamera?:boolean}} options `moveCamera: false` takes the fade and
     *   the park and leaves the flight to a caller that already owns it —
     *   "look closer" is the drive's own manoeuvre and has been since v1, and
     *   flying HERO twice would cancel the first flight mid-arc.
     */
    async show(next, {
      property = null, reason = null, angle = null, moveCamera = true,
    } = {}) {
      if (!enabled) return { ok: false, view, reason: 'no drive running' };
      const announce = announceFor(next, reason);
      if (announce) onAnnounce?.(announce);

      if (next === VIEWS.DRIVE) {
        const resumed = saved;
        saved = null;
        view = VIEWS.DRIVE;
        applyFade(VIEWS.DRIVE);
        // Position and direction first, then the fade reveals a scene that is
        // already where it was rather than one that arrives and then moves.
        drive?.resumeFromAnswer?.(resumed);
        onView?.(view, { reason, resumed });
        return { ok: true, view, announce, resumed };
      }

      /**
       * The panorama, standing still at the point the drive stopped.
       *
       * It parks like every other answer, and unlike every other answer the
       * thing it shows is a photograph rather than a camera move — so the fade
       * waits on the imagery. Revealing an empty grey layer and letting the
       * panorama arrive into it is the break this whole view exists to avoid.
       */
      if (next === VIEWS.STREET_VIEW) {
        parkOnTheRoad();
        view = VIEWS.STREET_VIEW;
        onView?.(view, { reason, property });
        const at = property && Number.isFinite(property.lat)
          ? { lat: property.lat, lng: property.lng }
          : drive?.position?.() || null;
        const shown = await streetView?.showAt?.(at, drive?.headingDeg ?? null);
        if (!shown?.ok) {
          // No coverage here is a fact about the street, not a failure. Put the
          // 3D scene back rather than fading to a grey rectangle.
          view = VIEWS.AERIAL;
          applyFade(VIEWS.AERIAL);
          if (property) {
            visuals?.setFocused?.(property.id);
            await camera?.fly?.('HERO', property);
          }
          const why = 'No Street View along this stretch — here it is from the air.';
          onAnnounce?.(why);
          onView?.(view, { reason: 'no-coverage' });
          return { ok: false, view, announce: why, reason: shown?.reason || 'no coverage' };
        }
        applyFade(VIEWS.STREET_VIEW);
        return { ok: true, view, announce, panoId: shown.panoId };
      }

      if (next === VIEWS.CARD || next === VIEWS.ANALYSIS) {
        // Over the current view: no fade, no camera, no pause.
        view = next;
        onView?.(view, { reason, property });
        return { ok: true, view, announce, overlay: true };
      }

      parkOnTheRoad();
      applyFade(next);
      view = next;
      onView?.(view, { reason, property });

      if (!moveCamera) return { ok: true, view, announce, moveCamera: false };
      if (next === VIEWS.CRUISE) {
        await camera?.fly?.('CRUISE', drive?.routePoints?.() || null);
        return { ok: true, view, announce };
      }
      if (!property) return { ok: false, view, announce, reason: 'no house in frame' };

      visuals?.setFocused?.(property.id);
      if (next === VIEWS.AERIAL) {
        await camera?.fly?.('HERO', property);
      } else if (next === VIEWS.TOPDOWN) {
        await camera?.fly?.('TOPDOWN', property);
      } else if (next === VIEWS.ANGLE) {
        // The any-angle shots already exist and already frame the house; the
        // director's job is to have put the scene in front of the user first.
        await camera?.fly?.('HERO', property);
        await angle?.();
      }
      return { ok: true, view, announce };
    },

    /** Back to the road, wherever the drive left it. */
    resume() {
      return this.show(VIEWS.DRIVE, { reason: 'resume' });
    },

    destroy() {
      if (fadeTimer) timers.clearTimeout?.(fadeTimer);
      fadeTimer = null;
      if (element) {
        element.style.transition = 'none';
        element.style.opacity = '0';
        element.hidden = true;
      }
    },
  };
  return director;
}
