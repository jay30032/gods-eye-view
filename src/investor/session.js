import * as Cesium from 'cesium';
import { INVESTOR_LAYER_DENYLIST, VISION_STORAGE_KEY, readInvestorConfig } from './config.js';
import { resolveMarket } from './markets.js';
import { createMockPropertyProvider } from './mock/provider.js';
import { rankMockProperties, searchMockProperties } from './mock/search.js';
import { analyzePropertyDeal, bestStrategyFor, normalizeStrategy } from './deal/index.js';
import { createOpportunityVisualManager } from './visuals/opportunityVisualManager.js';
import { prefersReducedMotion } from './visuals/reducedMotionPolicy.js';
import { whyThisMatters } from './focus.js';
import { createCameraDirector } from './camera/director.js';
import { DURATIONS, worldToggleTarget } from './camera/shots.js';
import { frontNormalDeg, headingForCompass, headingForSide } from './camera/orientation.js';
import { geometryFor } from './mock/geometry.js';
import { shortAddress } from './visuals/markers.js';
import { clampApplies, clampPitchDeg, pitchNeedsClamp } from './camera/pitchClamp.js';
import { cameraHeightM, lodFromHeight } from './lod.js';
import { readSavedProperties, removeSavedProperty, saveProperty } from './saved.js';
import { DRIVE_VIEWS, createDriveDemo } from './driveDemo.js';
import {
  createStreetViewDrive,
  ensureStreetViewHost,
  readMapsApiKey,
} from './drive/streetViewDrive.js';
import { VIEWS, announceFor, createViewDirector, isThreeD } from './drive/viewDirector.js';
import { WORLDS, createClearView, readWorldFromLocation } from './world/clearView.js';
import { createXray } from './visuals/effects/xray.js';
import { buildSixHouseScene, readSceneMode } from './scenes/sixHouse.js';
import {
  FIRST_HINT,
  HELP_LINE,
  applyCompare,
  applyFindMoney,
  applyFocus,
  applyReset,
  applySave,
  applyShowDeal,
  applyUnsave,
  applyWhatIf,
  applyWhy,
  applyWhyStrategy,
  createConversationState,
  hasCustomNumbers,
  overridesFor,
  parseDemoIntent,
} from './conversation.js';
import {
  governorRequestRender,
  holdContinuousRender,
  releaseContinuousRender,
} from '../renderGovernor.js';
import { setScopeMaskEnabled } from '../scopeMask.js';
import {
  ensureKeylessVisibleBasemap,
  kickRenderBurst,
  releaseInvestorBootHolds,
  waitForFirstInvestorFrame,
} from './ensureBasemap.js';
import {
  applyInvestorChrome,
  openTypedBar,
  relocateVoiceControl,
  setAiPrompt,
  setLodChip,
  setNavActive,
  setQuietToggle,
  setSoundChip,
  toggleTypedBar,
} from './ui/chrome.js';
import { bindDemoScript } from './ui/demoScript.js';
import { initFirstHunt } from './ui/firstHunt.js';
import {
  focusCardState,
  hideFocusCard,
  positionFocusCard,
  renderFocusCard,
  revealAllFocusLines,
  revealFocusLine,
} from './ui/focusCard.js';
import {
  buildFindMoney,
  buildLookCloser,
  buildSave,
  createSequencer,
  lineScheduleFor,
} from './sequences.js';
import { createAudioEngine } from './audio/engine.js';
import { createNarrator, splitSentences } from './ui/narrator.js';
import { createOrb } from './ui/orb.js';
import { installSpringEasing } from './ui/motion.js';
import {
  ensureDriveBar,
  hideDriveIntro,
  readDriveLive,
  renderDriveIntro,
  setDriveProgress,
  setDriveViewChrome,
  setProgressBarVisible,
} from './ui/driveChrome.js';
import { hideSavedSheet, renderSavedSheet } from './ui/savedSheet.js';
import { createTerra } from './terra/presence.js';
import { ASSISTANT_NAME } from './terra/identity.js';
import { demoNow } from './clock.js';

/** Commands that change a switch, not the board: they never interrupt a moment. */
const ASIDE_INTENTS = new Set([
  'sound_on', 'sound_off', 'voice_on', 'voice_off', 'vision_on', 'vision_off', 'help', 'unknown',
  'drive_narration', 'listen_on', 'listen_off', 'quiet_on', 'quiet_off',
]);

/** What the six-house scene says instead of the market's opening hint. */
const SIX_HOUSE_HINT = 'Six houses, five signals. Say "show me the best one".';

function readVisionPref(defaultValue) {
  try {
    const raw = localStorage.getItem(VISION_STORAGE_KEY);
    if (raw === '0') return false;
    if (raw === '1') return true;
  } catch {
    // ignore
  }
  return defaultValue;
}

function writeVisionPref(enabled) {
  try { localStorage.setItem(VISION_STORAGE_KEY, enabled ? '1' : '0'); } catch { /* ignore */ }
}

async function disableLiveFeeds(dataManager) {
  if (!dataManager?.layers) return;
  for (const layerId of INVESTOR_LAYER_DENYLIST) {
    if (!dataManager.layers.has(layerId)) continue;
    try {
      if (dataManager.isEnabled?.(layerId)) {
        await dataManager.setEnabled(layerId, false, { origin: 'tool' });
      }
    } catch {
      // investor path must not depend on these feeds
    }
  }
}

export async function startInvestorSession({ viewer, styleManager, dataManager }) {
  const config = readInvestorConfig();
  const market = resolveMarket(config.defaultMarket);
  /**
   * `?scene=six` swaps the inventory for the tight Oakhurst cluster and nothing
   * else: same provider, same validator, same derived scores. Everything
   * downstream — visuals, conversation, focus, saved — reads `properties` and
   * never learns which block it got.
   */
  const sceneMode = readSceneMode();
  const provider = createMockPropertyProvider({
    marketId: market.id,
    dataset: sceneMode === 'six' ? 'six' : null,
    provider: config.propertyProvider,
  });
  const properties = provider.list();
  const scene = sceneMode === 'six' ? buildSixHouseScene(properties) : null;
  const conversation = createConversationState();
  let focused = null;
  let lastAnalysis = null;
  let lastAnalysisId = null;
  let hunt = null;

  applyInvestorChrome(config);
  installSpringEasing();

  /**
   * The assistant's body: the sound palette, the voice, the orb, and the
   * sequencer that choreographs the hero moments. None of these touch data
   * or maths; they decide *when* a thing the session already does happens.
   */
  const audio = createAudioEngine();
  audio.bind();
  setSoundChip(audio.enabled);
  const orb = createOrb();
  const narrator = createNarrator({ onState: (state) => orb.set('narrator', state) });
  const sequences = createSequencer({ reduced: () => prefersReducedMotion() });
  let thinkingTimer = null;

  let terra = null;

  /**
   * The assistant says a line: the strip, the orb, and the reading pace.
   *
   * With the Realtime session live the line is written and paced but never
   * voiced by the browser: the assistant speaks for itself from the state,
   * and two voices saying two versions of one answer is the thing this file
   * exists to prevent.
   */
  function say(text, options = {}) {
    if (thinkingTimer) { globalThis.clearTimeout(thinkingTimer); thinkingTimer = null; }
    orb.set('session', 'idle');
    if (!text) return null;
    return narrator.say(text, { ...options, silent: options.silent || Boolean(terra?.live) });
  }

  /** Between a command arriving and its answer, the orb thinks. */
  function thinking() {
    orb.set('session', 'thinking');
    if (thinkingTimer) globalThis.clearTimeout(thinkingTimer);
    thinkingTimer = globalThis.setTimeout(() => orb.set('session', 'idle'), 2000);
  }

  /** Where the camera stands, for "nearest to the camera first". */
  function cameraPoint() {
    try {
      const carto = Cesium.Cartographic.fromCartesian(viewer.camera.positionWC);
      return { lat: Cesium.Math.toDegrees(carto.latitude), lng: Cesium.Math.toDegrees(carto.longitude) };
    } catch {
      return null;
    }
  }

  await disableLiveFeeds(dataManager);
  try { styleManager?.hud?.setVisible?.(false); } catch { /* optional */ }
  try { setScopeMaskEnabled(false); } catch { /* optional */ }
  const tileset = globalThis.__godsEyeView?.tileset || null;
  const mapStackController = globalThis.__godsEyeView?.mapStackController
    || styleManager?.mapStackController
    || null;
  if (viewer?.scene?.globe && !tileset) {
    viewer.scene.globe.show = true;
    releaseInvestorBootHolds();
    kickRenderBurst(viewer);
    await ensureKeylessVisibleBasemap({
      viewer,
      mapStackController,
      styleManager,
      tileset,
      phase: 'session',
    });
    await waitForFirstInvestorFrame(viewer);
  }
  try { viewer?.resize?.(); } catch { /* optional */ }
  governorRequestRender('investor-session');

  // One owner for the camera. Nothing else in the investor path calls flyTo.
  const camera = createCameraDirector({ viewer, Cesium, market });

  const visuals = createOpportunityVisualManager({
    viewer,
    Cesium,
    market,
    getProperties: () => properties,
  });
  // Keep pulses off until the first-hunt modal is done so a parked globe
  // does not take investor-opportunity (continuous 60 fps) on a laptop GPU.
  visuals.setEnabled(false);

  // Visuals never fight the camera: freeze animation and defer rebuilds for the
  // duration of every flight, resume the moment it settles.
  camera.onFlight(({ flying }) => visuals.setFlightActive(flying));

  /**
   * Keep the user inside a watchable pitch band without disabling scroll-zoom.
   * Only ever corrects camera state the user produced — a flight owns the
   * camera while it runs, and WORLD/STAGING are nadir on purpose.
   */
  viewer.camera.changed.addEventListener(() => {
    if (!clampApplies({ shot: camera.shot, flying: camera.flying })) return;
    const pitchDeg = Cesium.Math.toDegrees(viewer.camera.pitch);
    if (!pitchNeedsClamp(pitchDeg)) return;
    viewer.camera.setView({
      orientation: {
        heading: viewer.camera.heading,
        pitch: Cesium.Math.toRadians(clampPitchDeg(pitchDeg)),
        roll: 0,
      },
    });
    governorRequestRender('investor-pitch-clamp');
  });

  /**
   * Drive Mode.
   *
   * `onAnnounce` no longer focuses the house it mentions. That was right when a
   * "drive" was a series of stops — the camera was *at* the house, so focusing
   * it was the truth. Now the drive passes houses at speed and only mentions
   * them; focusing every call-out would open a card for a house 100 m up the
   * road and dim the rest of the street to answer a question nobody asked.
   * Focus happens on "look closer" and nowhere else.
   */
  /**
   * Drive Mode v2: Street View drives, the 3D scene answers.
   *
   * The three pieces are built here, in the order they depend on each other —
   * the panorama needs the route and the drive's rows; the view director needs
   * the panorama's element and the drive; the drive needs both. The cycle is
   * broken with a late binding rather than with a fourth object: `drive` is
   * assigned before anything can call into it, because nothing here runs until
   * a fix arrives.
   */
  /**
   * Clear View — parked. `?world=clear` only, for experiments.
   *
   * The tree-free world (ion terrain, Bing aerial, OSM building boxes) is not
   * shipped: reviewed headed it was untextured boxes on a photo. The module
   * stays so the experiment can be reopened from a URL, and nothing else in the
   * product — no chip, no spoken command, no remembered choice — leads to it.
   */
  const clearView = createClearView({
    viewer,
    Cesium,
    mapStackController,
    getProperties: () => properties,
    getTopPickId: () => conversation.topPickId || scene?.goldId || null,
    getFocusedId: () => focused?.id || null,
    // A world swap ends any x-ray: the effect belongs to the photo world. The
    // near field learns the world too — the draped outline is Clear View only.
    onWorld: (world) => { xray.end(); visuals.setWorld(world); },
  });

  /**
   * X-ray — the photo world goes translucent for a moment so the subject reads.
   *
   * Fires automatically when a flight lands on a house ("look closer", any
   * focus, "show me the lot") and on demand with "x-ray"; "solid" ends it
   * early. The tileset is read at trigger time: a keyless boot has none, and
   * the parked Clear View hides it, and both are simply "nothing to see
   * through" rather than a style on nothing.
   */
  const xray = createXray({
    Cesium,
    scene: viewer.scene,
    getTileset: () => (clearView.active ? null : (globalThis.__godsEyeView?.tileset || tileset)),
    holdRender: holdContinuousRender,
    releaseRender: releaseContinuousRender,
    requestRender: () => governorRequestRender('investor-xray'),
    reduced: () => prefersReducedMotion(),
    onFire: () => terra?.emit('xray', { propertyId: focused?.id || null }),
  });
  camera.onFlight((state) => xray.onFlight(state));

  const streetViewHost = ensureStreetViewHost();
  let drive = null;
  const streetView = createStreetViewDrive({
    getRoute: () => drive?.route || null,
    host: streetViewHost,
    apiKey: readMapsApiKey(),
    getRows: () => drive?.onRoute || [],
    getTopPickId: () => drive?.goldId || conversation.topPickId || null,
    onPano: ({ panoId }) => { lastPanoId = panoId; panoAdvances += 1; },
    onError: (reason) => console.warn('[TerraSignal] Street View unavailable:', reason),
  });
  let lastPanoId = null;
  let panoAdvances = 0;

  const viewDirector = createViewDirector({
    element: streetViewHost,
    streetView,
    camera,
    visuals,
    drive: {
      get alongM() { return drive?.alongM ?? 0; },
      get headingDeg() { return drive?.headingDeg ?? null; },
      position: () => drive?.position?.() || null,
      parkForAnswer: () => drive?.parkForAnswer?.(),
      resumeFromAnswer: (saved) => drive?.resumeFromAnswer?.(saved),
      routePoints: () => drive?.routePoints?.() || null,
    },
    onAnnounce: (clause) => setAiPrompt(clause),
    onView: (view, detail) => {
      drive?.setPanoStopped?.(view === VIEWS.STREET_VIEW);
      setDriveViewChrome(view, detail);
      // "Show me the lot" on a drive: the director starts the hero flight
      // right after this callback returns, so the arm is deferred a microtask
      // to read the flight as in the air and fire when it lands.
      if (view === VIEWS.AERIAL && detail?.property) {
        queueMicrotask(() => xray.arm({ flying: camera.flying }));
      }
    },
  });

  drive = createDriveDemo({
    viewer,
    Cesium,
    camera,
    visuals,
    streetView,
    viewDirector,
    getProperties: () => properties,
    onAnnounce: (event) => {
      if (event.property && event.detail !== true) driveCard(event.property, event);
      say(event.spoken);
      if (event.property && event.detail !== true) {
        terra?.emit('drive_approach', { propertyId: event.property.id });
      }
    },
    onState: (state) => applyDriveChrome(state),
    onStop: () => {
      setDriveChrome(false);
      releaseWakeLock();
      setNavActive('world');
    },
  });

  /**
   * The drive's own card: the house currently being talked about.
   *
   * Not the full focus card — that opens on "look closer", in Property Mode.
   * At speed the useful thing is one line saying which house is being mentioned
   * so "save that one" has a visible referent.
   */
  function driveCard(property, event) {
    renderFocusCard(property, {
      driveCallout: event?.spoken || null,
      compact: true,
      anchor: visuals.screenPositionFor(property.id),
    });
  }

  /**
   * Drive Mode chrome: the scene, the route, the card, the mic, pause, exit.
   *
   * Everything else goes. A drive is a single continuous shot and the standing
   * HUD — the vision toggle, the LOD chip, the demo rail, the bottom nav — is
   * all controls for a camera the user is not currently flying.
   */
  function setDriveChrome(on) {
    const root = document.body;
    if (!root) return;
    root.classList.toggle('ts-drive-mode', Boolean(on));
  }

  function applyDriveChrome(state) {
    setDriveChrome(state.running);
    const bar = ensureDriveBar({
      pause: () => session.handleIntent('pause here'),
      resume: () => session.handleIntent('keep going'),
      exit: () => session.handleIntent('stop drive'),
    });
    if (bar) {
      bar.hidden = !state.running;
      bar.dataset.mode = state.mode || 'drive';
      bar.dataset.paused = String(Boolean(state.paused));
    }
    setProgressBarVisible(Boolean(state.running));
    if (state.running) {
      setDriveProgress(state.alongM, state.lengthM);
      // What the chrome has to match is what is actually on screen, which is
      // the panorama only while it is parked there as an answer.
      setDriveViewChrome(state.panoStopped ? 'streetview' : '3d');
    } else {
      hideDriveIntro();
      setDriveViewChrome('3d', { chase: true });
    }
  }

  /**
   * The drive's clock.
   *
   * Playback advances on real elapsed time from the render loop rather than on
   * a `setInterval`: a drive that stepped on a timer would run at a different
   * speed whenever the frame rate moved, and `frameBudget.js` deliberately caps
   * this viewer at 30 fps on battery. GPS ignores this — its fixes arrive on
   * their own schedule — which is why `tick` is a no-op for that source.
   */
  /**
   * The card follows its house.
   *
   * One screen projection per frame while a card is up, and a style write only
   * when the answer moved. During a flight the card is already gone — the
   * moment that lands it paints a new one on arrival.
   */
  viewer.scene.postRender.addEventListener(() => {
    const card = document.getElementById('ts-focus-card');
    const up = Boolean(focused && card && !card.hidden);
    visuals.setCardOn(up ? focused.id : null);
    if (!up) return;
    positionFocusCard(visuals.screenPositionFor(focused.id));
  });

  let lastDriveTickMs = null;
  viewer.scene.preRender.addEventListener(() => {
    if (!drive.running) { lastDriveTickMs = null; return; }
    const stamp = globalThis.performance?.now?.() ?? Date.now();
    const dt = lastDriveTickMs === null ? 0 : (stamp - lastDriveTickMs) / 1000;
    lastDriveTickMs = stamp;
    // Cap after a stall: a backgrounded tab would otherwise resume by teleporting
    // half a kilometre down the road.
    if (dt > 0) drive.tick(Math.min(0.25, dt));
  });

  /**
   * Keep the screen awake while a live drive is running.
   *
   * A phone on a windscreen mount locks in thirty seconds, which ends the
   * drive. The lock is released the moment the drive stops — holding it longer
   * is a battery bug — and every failure is non-fatal: a browser without the
   * API, or a user who denied it, still gets the drive.
   */
  let wakeLock = null;
  async function requestWakeLock() {
    try {
      if (!globalThis.navigator?.wakeLock?.request) return false;
      wakeLock = await globalThis.navigator.wakeLock.request('screen');
      return true;
    } catch {
      return false;
    }
  }
  function releaseWakeLock() {
    try { wakeLock?.release?.(); } catch { /* already gone */ }
    wakeLock = null;
  }

  const session = {
    config,
    market,
    provider,
    scene,
    sceneMode,
    properties,
    conversation,
    visuals,
    camera,
    drive,
    streetView,
    viewDirector,
    clearView,
    xray,
    audio,
    narrator,
    orb,
    sequences,
    /** The assistant's presence: the always-on session, briefs, metrics. */
    get terra() { return terra; },
    /** What the card is doing, for the headed check. */
    get card() { return focusCardState(); },
    get focused() { return focused; },
    get lastAnalysis() { return lastAnalysis; },
    getById(id) {
      return provider.getById(id) || properties.find((row) => row.id === id) || null;
    },
    /**
     * Focus a house.
     *
     * With `fly`, this is the LOOK_CLOSER moment: the dive (a hop when coming
     * from another house), the x-ray as it lands, and the card assembling line
     * by line as the explanation is spoken. `line` is what is said as the
     * camera takes off — the caller's answer — so the strip never says one
     * thing while the flight says another.
     */
    focus(id, { fly = true, line = null } = {}) {
      const property = this.getById(id);
      if (!property) return { ok: false, action: 'focus_property', error: 'Unknown mock property' };
      const previous = focused;
      focused = property;
      conversation.focusedId = property.id;
      visuals.setFocused(property.id);
      // The building tint is the same answer as the marker and the outline.
      clearView.repaint();
      const cardOptions = (extra = {}) => ({
        analysis: lastAnalysisId === property.id ? lastAnalysis : null,
        strategy: conversation.lastStrategy,
        revealDeal: Boolean(lastAnalysisId === property.id && lastAnalysis),
        customNumbers: hasCustomNumbers(conversation),
        anchor: visuals.screenPositionFor(property.id),
        ...extra,
      });
      hideSavedSheet();
      setNavActive('world');

      if (!fly) {
        renderFocusCard(property, cardOptions());
        xray.arm({ flying: camera.flying });
        if (line) say(line);
        terra?.emit('house_focused', { propertyId: property.id });
        return { ok: true, action: 'focus_property', id: property.id, address: property.address };
      }

      // The old card leaves as the camera does; the new one assembles on landing.
      hideFocusCard();
      const why = whyThisMatters(property);
      const sentences = splitSentences(why);
      const hop = Boolean(previous && previous.id !== property.id);
      const timeline = buildLookCloser({
        propertyId: property.id,
        hop,
        line: line || `${shortAddress(property)}.`,
        sentences,
      });
      const run = sequences.play(timeline, {
        speak: (event) => say(event.text),
        sound: (event) => audio.play(event.sound),
        flight: async (event, ctx) => {
          // Moving house to house is a hop, not a slide across the rooftops.
          const arrival = event.shot === 'HOP'
            ? camera.hop(previous, property)
            : camera.fly('HERO', property);
          const result = await arrival;
          // Only act if we actually landed — a superseded flight must not
          // orbit or open a card on a house the user has already left.
          if (result.cancelled || focused?.id !== property.id) ctx.cancel();
        },
        xray: () => xray.arm({ flying: camera.flying }),
        card: () => renderFocusCard(property, cardOptions({ assemble: true })),
        orbit: () => camera.orbit(property),
        explain: (event) => {
          if (!event.sentences?.length) return null;
          const lines = focusCardState().lines;
          const schedule = lineScheduleFor(lines, event.sentences.length);
          const speech = say(why, {
            sentences: event.sentences,
            perSentence: true,
            onSentence: (index) => {
              schedule.forEach((at, k) => { if (at <= index) revealFocusLine(k); });
            },
          });
          return speech?.done || null;
        },
        revealAll: () => revealAllFocusLines(),
      });
      run.done.then((summary) => {
        if (summary.cancelled && focused?.id === property.id) revealAllFocusLines();
        if (!summary.cancelled) terra?.emit('house_focused', { propertyId: property.id });
      });
      return { ok: true, action: 'focus_property', id: property.id, address: property.address };
    },
    setOpportunityVision(enabled) {
      const next = visuals.setEnabled(enabled);
      writeVisionPref(next);
      const box = document.getElementById('ts-opportunity-vision');
      if (box) box.checked = next;
      say(next ? 'Opportunity Vision on.' : 'Opportunity Vision off.');
      return { ok: true, action: 'set_opportunity_vision', enabled: next };
    },
    showDealVision(strategy) {
      const name = normalizeStrategy(strategy) || conversation.lastStrategy || (focused ? bestStrategyFor(focused) : 'flip');
      conversation.lastStrategy = name;
      if (focused) {
        lastAnalysis = analyzePropertyDeal(focused, name, overridesFor(conversation));
        lastAnalysisId = focused.id;
        renderFocusCard(focused, { analysis: lastAnalysis, strategy: name, revealDeal: true });
      }
      visuals.setDealVision(name, lastAnalysis);
      say(`${name.toUpperCase()} vision on the globe.`);
      return { ok: true, action: 'show_deal_vision', strategy: name, id: focused?.id || null };
    },
    analyze(strategy, overrides = {}) {
      if (!focused) return { ok: false, error: 'No property focused' };
      const name = normalizeStrategy(strategy) || bestStrategyFor(focused);
      conversation.lastStrategy = name;
      lastAnalysis = analyzePropertyDeal(focused, name, {
        ...overridesFor(conversation),
        ...overrides,
      });
      lastAnalysisId = focused.id;
      renderFocusCard(focused, { analysis: lastAnalysis, strategy: name, revealDeal: true });
      return { ok: true, action: `run_${name}_analysis`, id: focused.id, strategy: name, analysis: lastAnalysis };
    },
    search(args) {
      return searchMockProperties(properties, args);
    },
    rank(args) {
      return rankMockProperties(properties, args);
    },
    save(id, extras) {
      const property = this.getById(id) || focused;
      const result = applySave(property, conversation, (row, meta) => saveProperty(row, {
        strategy: extras?.strategy || meta?.strategy || conversation.lastStrategy,
        note: extras?.note || '',
      }));
      if (result.ok && property) {
        const paint = () => renderFocusCard(property, {
          analysis: lastAnalysisId === property.id ? lastAnalysis : null,
          strategy: conversation.lastStrategy,
          revealDeal: lastAnalysisId === property.id,
          customNumbers: hasCustomNumbers(conversation),
          anchor: visuals.screenPositionFor(property.id),
        });
        const run = sequences.play(buildSave({ propertyId: property.id }), {
          saved: () => visuals.setSaved(property.id),
          drop: () => visuals.dropBookmark(property.id),
          sound: (event) => audio.play(event.sound),
          card: () => { paint(); this.showSaved(); },
        });
        run.done.then((summary) => {
          if (!summary.cancelled) {
            terra?.emit('save_done', { propertyId: property.id });
            return;
          }
          visuals.setSaved(property.id);
          paint();
        });
        say(result.spoken);
      } else if (!result.ok) {
        audio.play('errorTone');
      }
      return result;
    },
    showSaved() {
      renderSavedSheet({
        open: true,
        resolveProperty: (id) => this.getById(id),
      });
      setNavActive('saved');
      return { ok: true, action: 'show_saved_properties', saved: readSavedProperties() };
    },
    /** Re-paint the focus card from whatever the conversation currently holds. */
    paintFocus({ compare = null } = {}) {
      if (!focused) return;
      renderFocusCard(focused, {
        analysis: lastAnalysisId === focused.id ? lastAnalysis : null,
        strategy: conversation.lastStrategy,
        revealDeal: conversation.dealVisible && lastAnalysisId === focused.id,
        customNumbers: hasCustomNumbers(conversation),
        compare,
      });
    },
    /**
     * Anything typed or spoken lands here.
     *
     * A new command interrupts the moment in progress — the choreography stops
     * where it is and its end state is applied — except for the side switches
     * (sound, voice, vision, help), which change nothing on the board. The orb
     * thinks until the answer is said, and a miss gets the error tone.
     */
    handleIntent(text) {
      const parsed = parseDemoIntent(text);
      if (!parsed) {
        audio.play('errorTone');
        return { ok: false, spoken: 'Say find me money.' };
      }
      if (!ASIDE_INTENTS.has(parsed.intent)) sequences.cancel();
      thinking();
      this.lastIntent = { intent: parsed.intent, slots: parsed.slots || {}, text, at: Date.now() };
      const result = this.dispatch(text, parsed);
      if (result && result.ok === false) audio.play('errorTone');
      if (result && !narrator.speaking) orb.set('session', 'idle');
      return result;
    },

    dispatch(text, parsed) {
      const slots = parsed.slots || {};

      // Drive Mode v2: decide what the answer is *shown on* before working out
      // what the answer is. The view director runs first and only while a
      // Street View drive is up — it returns null for everything that does not
      // change the view, which is most of what is said during a drive.
      const viewDecision = this.routeView(text, parsed);
      /**
       * When the view IS the answer, stop here.
       *
       * "How big is the lot" has no vocabulary in `parse.js` and never will —
       * it is a question about land, not a camera command — so it arrives as
       * `unknown`, and "show me the roof" arrives as a `focus` on the word
       * "roof". Both were answered correctly by the view director and then had
       * their spoken line overwritten by the fallback: a headed run showed the
       * lot, the parcel glowing, and the assistant saying "Didn't catch that.
       * Try: reset the numbers" over the top of it.
       */
      if (viewDecision && isThreeD(viewDecision.view) && viewDecision.view !== VIEWS.ANGLE) {
        const unanswerable = parsed.intent === 'unknown'
          || (parsed.intent === 'focus' && slots.query);
        if (unanswerable) {
          const spoken = announceFor(viewDecision.view, viewDecision.reason);
          return { ok: true, action: 'view', view: viewDecision.view, spoken };
        }
      }

      if (parsed.intent === 'find_money') {
        if (this.drive.running) this.drive.stop();
        this.setOpportunityVision(true);
        const result = applyFindMoney(properties, conversation, slots);
        if (!result.ok) {
          say(result.spoken);
          return result;
        }
        hideFocusCard();
        hideSavedSheet();
        visuals.setSaved(null);
        // The board goes quiet under the scan; the matches light one by one.
        visuals.setShortlist(result.candidateIds, { lit: false });
        visuals.setTopPick(null);
        visuals.setFocused(null);
        focused = null;
        clearView.repaint();
        const shortlist = result.candidateIds
          .map((candidateId) => this.getById(candidateId))
          .filter(Boolean);
        const goldId = result.topPickId;
        const timeline = buildFindMoney({
          matches: shortlist,
          goldId,
          camera: cameraPoint(),
          brief: result.spoken,
          focusId: result.focusId,
        });
        const run = sequences.play(timeline, {
          scan: () => visuals.startScan(),
          sound: (event) => audio.play(event.sound),
          ignite: (event) => visuals.ignite(event.propertyId),
          gold: (event) => {
            visuals.ignite(event.propertyId);
            visuals.setTopPick(event.propertyId);
            conversation.topPickId = event.propertyId;
            focused = this.getById(event.propertyId);
            conversation.focusedId = event.propertyId;
            visuals.setFocused(event.propertyId);
            clearView.repaint();
            setNavActive('world');
          },
          beaconRise: (event) => visuals.raiseBeacon(event.propertyId),
          // REVEAL fits the whole shortlist; the brief is spoken when it lands.
          flight: async (_event, ctx) => {
            const reveal = await camera.fly('REVEAL', shortlist);
            if (reveal.cancelled) ctx.cancel();
          },
          speak: (event) => say(event.text),
          // Deferred a tick: the dive is FIND_MONEY's last beat and starts the
          // next moment, which must not read as this one being interrupted.
          dive: (event) => { globalThis.setTimeout(() => this.focus(event.propertyId), 0); },
        });
        run.done.then((summary) => {
          if (!summary.cancelled) {
            terra?.emit('find_money_complete', { propertyId: goldId });
            return;
          }
          // Interrupted: land the end state so the board still reads as answered.
          visuals.igniteAll();
          if (goldId && conversation.topPickId !== goldId) {
            visuals.setTopPick(goldId);
            conversation.topPickId = goldId;
          }
        });
        return result;
      }

      if (parsed.intent === 'focus') {
        // While the drive is running, "next" and "skip" belong to the route.
        if (this.drive.running && (slots.step === 'next' || slots.step === 'previous')) {
          const moved = slots.step === 'next' ? drive.next() : drive.skip();
          say(moved.spoken);
          return moved;
        }
        const result = applyFocus(properties, conversation, slots);
        if (result.ok) {
          // "Show me the best one" is a question about the whole board, so it
          // gets the same sweep "find me money" does before the answer lights.
          if (slots.step === 'top') { visuals.startScan(); audio.play('scanSweep'); }
          this.focus(result.id, { line: result.spoken });
          return result;
        }
        say(result.spoken);
        return result;
      }

      if (parsed.intent === 'why') {
        if (slots.referring && drive.running) {
          const target = this.driveTarget('why_flagged');
          if (!target.ok) { say(target.spoken); return target; }
          const spoken = whyThisMatters(target.property);
          say(spoken);
          return { ok: true, action: 'explain_property', id: target.id, spoken };
        }
        const result = slots.strategy
          ? applyWhyStrategy(focused, conversation, slots.strategy)
          : applyWhy(focused, conversation);
        if (result.ok && result.analysis) {
          lastAnalysis = result.analysis;
          lastAnalysisId = focused.id;
        }
        this.paintFocus();
        say(result.spoken);
        return result;
      }

      if (parsed.intent === 'show_deal') {
        const result = applyShowDeal(focused, conversation, slots);
        if (result.ok) {
          lastAnalysis = result.analysis;
          lastAnalysisId = focused.id;
          this.showDealVision(result.strategy);
        }
        say(result.spoken);
        return result;
      }

      if (parsed.intent === 'compare') {
        if (slots.withPrevious && drive.running) {
          const target = this.driveTarget('compare_last');
          if (!target.ok) { say(target.spoken); return target; }
          const previous = this.getById(target.previousId);
          const spoken = previous
            ? `${shortAddress(target.property)} scores ${Math.round(target.property.composite)}; `
              + `${shortAddress(previous)} scores ${Math.round(previous.composite)}.`
            : 'Nothing to compare with yet.';
          say(spoken);
          return { ok: Boolean(previous), action: 'compare_drive', id: target.id, spoken };
        }
        const result = applyCompare(focused, conversation);
        if (result.ok) {
          lastAnalysis = result.analyses[result.best];
          lastAnalysisId = focused.id;
          this.paintFocus({ compare: result.rows });
          // The globe caption carries the two paths worth arguing about.
          const runnerUp = result.rows
            .filter((row) => row.strategy !== result.best && row.verdict !== 'pass')
            .sort((a, b) => (Number(focused.opportunityScore?.[b.strategy]) || 0)
              - (Number(focused.opportunityScore?.[a.strategy]) || 0))[0];
          visuals.setDealVision(result.best, lastAnalysis, {
            caption: compareCaption(result, runnerUp),
          });
        }
        say(result.spoken);
        return result;
      }

      if (parsed.intent === 'what_if') {
        const result = applyWhatIf(focused, conversation, slots);
        if (result.ok) {
          lastAnalysis = result.analysis;
          lastAnalysisId = focused.id;
          this.paintFocus();
          visuals.setDealVision(result.strategy, lastAnalysis);
        }
        say(result.spoken);
        return result;
      }

      if (parsed.intent === 'reset_assumptions') {
        const result = applyReset(conversation);
        if (focused) {
          const strategy = conversation.lastStrategy || bestStrategyFor(focused);
          lastAnalysis = analyzePropertyDeal(focused, strategy, overridesFor(conversation));
          lastAnalysisId = focused.id;
          this.paintFocus();
          visuals.setDealVision(strategy, lastAnalysis);
        }
        say(result.spoken);
        return result;
      }

      if (parsed.intent === 'save') {
        if (slots.referring && drive.running) {
          const target = this.driveTarget('save_that');
          if (!target.ok) { say(target.spoken); return target; }
          return this.save(target.id, { note: slots.note || '' });
        }
        return this.save(focused?.id, { note: slots.note || '' });
      }

      if (parsed.intent === 'unsave') {
        const result = applyUnsave(focused, conversation, (id) => removeSavedProperty(id));
        if (result.ok) {
          visuals.setSaved(null);
          this.paintFocus();
          this.showSaved();
        }
        say(result.spoken);
        return result;
      }

      if (parsed.intent === 'show_saved') return this.showSaved();

      if (parsed.intent === 'vision_on' || parsed.intent === 'vision_off') {
        return this.setOpportunityVision(parsed.intent === 'vision_on');
      }

      if (parsed.intent === 'sound_on' || parsed.intent === 'sound_off') {
        return this.setSound(parsed.intent === 'sound_on');
      }
      if (parsed.intent === 'voice_on' || parsed.intent === 'voice_off') {
        return this.setVoice(parsed.intent === 'voice_on');
      }
      if (parsed.intent === 'listen_on' || parsed.intent === 'listen_off') {
        return this.setListening(parsed.intent === 'listen_on');
      }
      if (parsed.intent === 'quiet_on' || parsed.intent === 'quiet_off') {
        return this.setQuiet(parsed.intent === 'quiet_on');
      }

      if (parsed.intent === 'xray') return this.seeThrough();
      if (parsed.intent === 'solid') return this.goSolid();
      if (parsed.intent === 'show_lot') {
        // On a drive the view director has already put the aerial up and the
        // flight it started arms the x-ray through `onView`.
        if (viewDecision?.view === VIEWS.AERIAL) {
          const spoken = announceFor(VIEWS.AERIAL, viewDecision.reason);
          return { ok: true, action: 'show_lot', view: VIEWS.AERIAL, spoken };
        }
        return this.showLot();
      }

      if (parsed.intent === 'world') {
        this.world();
        return { ok: true, action: 'world', spoken: FIRST_HINT };
      }

      if (parsed.intent === 'start_drive') {
        // "start here and show me the surrounding streets" begins from the
        // house already in frame; every other entry begins at the route's head.
        return this.startDrive({ ...slots, gold: Boolean(slots.gold) });
      }
      if (parsed.intent === 'stop_drive') {
        const result = drive.stop();
        // Exit returns to the market view over the cluster, which is where the
        // drive was entered from.
        camera.fly('CRUISE', scene ? scene.rows : null);
        say(result.spoken);
        return result;
      }
      if (parsed.intent === 'drive_next') {
        const result = drive.running ? drive.next() : this.startDrive();
        say(result.spoken);
        return result;
      }
      if (parsed.intent === 'drive_skip') {
        const result = drive.skip();
        say(result.spoken);
        return result;
      }

      if (parsed.intent === 'camera_angle') {
        // The view director has already brought the 3D scene up and run the
        // re-framing through its `angle` callback; doing it again would cancel
        // that flight mid-arc and land the camera somewhere between the two.
        if (viewDecision?.view === VIEWS.ANGLE) {
          return { ok: true, action: 'camera_angle', view: VIEWS.ANGLE, ...slots, spoken: '' };
        }
        // "From the street" while a drive is running is the panorama, which
        // `routeView` has already put up; standing still it is still the 3D
        // front-wall framing, which is what `cameraAngle` does below.
        if (viewDecision?.view === VIEWS.STREET_VIEW) {
          return { ok: true, action: 'camera_angle', view: VIEWS.STREET_VIEW, ...slots, spoken: '' };
        }
        return this.cameraAngle(slots);
      }

      // ---- Drive Mode ----------------------------------------------------
      if (parsed.intent === 'drive_pause') {
        if (!drive.running) return this.cameraAngle({ orbit: 'stop' });
        const result = drive.pause();
        say(result.spoken);
        return result;
      }
      if (parsed.intent === 'drive_resume') {
        if (!drive.running) return { ok: false, spoken: 'No drive running.' };
        // The view director has already put the panorama back at the saved
        // position; calling `keepGoing` as well would resume a drive that is
        // already running and overwrite "Back on the road." with a second line.
        if (viewDecision?.view === VIEWS.DRIVE) {
          return { ok: true, action: 'drive_resume', view: VIEWS.DRIVE, spoken: 'Back on the road.' };
        }
        const result = drive.keepGoing();
        say(result.spoken);
        return result;
      }
      if (parsed.intent === 'drive_speed') {
        if (!drive.running) return { ok: false, spoken: 'No drive running.' };
        const result = slots.speed === 'slower' ? drive.slower() : drive.faster();
        say(result.spoken);
        return result;
      }
      if (parsed.intent === 'drive_look') {
        // Standing still, "look left" is a request to see the left side of the
        // focused house — the camera command it was before Drive Mode existed.
        if (!drive.running) {
          const side = slots.look === 'overhead' ? null : slots.look;
          return side
            ? this.cameraAngle({ side })
            : this.cameraAngle({ height: 'higher' });
        }
        const result = drive.look(slots.look);
        say(result.spoken);
        return result;
      }
      if (parsed.intent === 'look_closer') {
        if (!drive.running) {
          return focused ? this.cameraAngle({ range: 'closer' }) : { ok: false, spoken: 'Nothing focused.' };
        }
        const result = drive.lookCloser();
        if (result.ok) {
          focused = result.property;
          conversation.focusedId = result.id;
          renderFocusCard(result.property, { anchor: visuals.screenPositionFor(result.id) });
          xray.arm({ flying: camera.flying });
        }
        say(result.spoken);
        return result;
      }
      if (parsed.intent === 'drive_best') {
        if (!drive.running) return this.handleIntent('show me the best one');
        const result = drive.requestBestMatch();
        say(result.spoken);
        return result;
      }
      if (parsed.intent === 'drive_narration') {
        const result = drive.setNarrationLevel(slots.level);
        say(result.spoken);
        return result;
      }
      if (parsed.intent === 'how_recent') {
        const target = this.driveTarget('how_recent');
        if (!target.ok) { say(target.spoken); return target; }
        const signal = (target.property.signals || [])[0];
        const spoken = signal
          ? `${String(signal.type).replaceAll('_', ' ').toLowerCase()}, filed ${signal.ageDays} days ago.`
          : 'No filing date on that one.';
        say(spoken);
        return { ok: true, action: 'how_recent', id: target.id, spoken };
      }
      if (parsed.intent === 'more_like_it') {
        const target = this.driveTarget('more_like_it');
        if (!target.ok) { say(target.spoken); return target; }
        const type = (target.property.signals || [])[0]?.type;
        return this.handleIntent(`find ${String(type || '').replaceAll('_', ' ').toLowerCase() || 'money'}`);
      }

      if (parsed.intent === 'help') {
        say(HELP_LINE);
        // The rail is the written version of the same cheat sheet — demo
        // furniture, so it only exists with ?demo=1. The product opens the
        // typed bar instead, which is the thing "help" is usually asking for.
        const rail = document.getElementById('ts-demo-script');
        if (rail && document.body.classList.contains('ts-demo')) {
          rail.hidden = false;
          rail.classList.add('visible');
          session.demoScript?.paint?.();
        } else {
          openTypedBar({ focus: false });
        }
        return { ok: true, action: 'help', spoken: HELP_LINE };
      }

      const suggestion = slots.suggestion || 'find me money';
      const spoken = `Didn't catch that. Try: ${suggestion}`;
      say(spoken);
      return { ok: false, action: 'unknown', suggestion, spoken };
    },
    /** "sound on" / "sound off": the palette, remembered per browser. */
    setSound(enabled) {
      const on = audio.setEnabled(enabled);
      setSoundChip(on);
      if (on) {
        audio.unlock();
        audio.play('saveConfirm');
      }
      const spoken = on ? 'Sound on.' : 'Sound off.';
      say(spoken);
      return { ok: true, action: 'set_sound', enabled: on, spoken };
    },

    /** "voice on" / "voice off": the assistant reads its lines aloud, or not. */
    setVoice(enabled) {
      if (enabled && !narrator.synthAvailable) {
        const spoken = 'No speech voice in this browser — the lines stay written.';
        say(spoken);
        return { ok: false, action: 'set_voice', enabled: false, spoken };
      }
      const on = narrator.setVoice(enabled);
      const spoken = on ? 'Voice on.' : 'Voice off.';
      say(spoken);
      return { ok: true, action: 'set_voice', enabled: on, spoken };
    },

    /**
     * "quiet mode" / "quiet mode off": replies in text only, no audio.
     *
     * For the places you cannot talk. The session keeps listening; the reply
     * comes back written, the orb shows muted, and the choice is remembered.
     */
    setQuiet(enabled) {
      const on = terra ? terra.setQuiet(enabled) : Boolean(enabled);
      setQuietToggle(on);
      const spoken = on ? 'Quiet mode — replies in text.' : 'Quiet mode off.';
      say(spoken);
      return { ok: true, action: 'set_quiet', enabled: on, spoken };
    },

    /**
     * "stop listening" / "listen": the assistant's ear.
     *
     * Pausing keeps the session up and mutes the mic, so "listen" is instant;
     * with no key there is no ear to pause and the typed bar is the answer.
     */
    setListening(enabled) {
      if (!terra) {
        const spoken = 'No voice session in this build.';
        say(spoken);
        return { ok: false, action: enabled ? 'listen_on' : 'listen_off', spoken };
      }
      if (enabled) {
        const result = terra.resume();
        const outcome = typeof result?.then === 'function' ? { ok: true, action: 'listen_on', spoken: `${ASSISTANT_NAME} is listening.` } : result;
        if (outcome?.spoken) say(outcome.spoken);
        return outcome;
      }
      const result = terra.pause();
      const spoken = result.ok ? result.spoken : `${ASSISTANT_NAME} is not listening.`;
      say(spoken);
      return { ...result, spoken };
    },

    /**
     * Which way the focused house faces, and where that came from.
     *
     * `street` means a real OSM way decided it; `long-axis` means the row had
     * no street within range and the long-wall convention was used, which is a
     * convention and not a measurement. The distinction is surfaced in the
     * spoken line so a reviewer is never told "this is the front" with more
     * confidence than the data supports.
     */
    frontOf(property) {
      const record = geometryFor(property?.id);
      const ring = record?.building?.footprint?.[0] || null;
      if (!ring) return null;
      const bearing = record?.street?.bearingDeg;
      return frontNormalDeg(ring, Number.isFinite(bearing) ? bearing : null);
    },

    /**
     * "Show me the back", "from the street", "closer", "orbit".
     *
     * Every one of these is relative to the house already in frame, so with
     * nothing focused there is no question to answer — say so rather than
     * moving a camera that is looking at a neighbourhood.
     */
    cameraAngle(slots = {}) {
      if (!focused) {
        const spoken = 'Pick a house first — try "show me the best one".';
        say(spoken);
        return { ok: false, action: 'camera_angle', spoken };
      }

      if (slots.orbit === 'stop') {
        camera.stopOrbit();
        const spoken = 'Holding here.';
        say(spoken);
        return { ok: true, action: 'camera_orbit', orbit: 'stop', spoken };
      }
      if (slots.orbit === 'start') {
        camera.orbit(focused);
        const spoken = `Circling ${shortAddress(focused)}.`;
        say(spoken);
        return { ok: true, action: 'camera_orbit', orbit: 'start', spoken };
      }

      let headingDeg = null;
      let spoken = '';
      let source = null;

      if (slots.compass) {
        headingDeg = headingForCompass(slots.compass);
        spoken = `Looking from the ${slots.compass}.`;
      } else if (slots.side) {
        const front = this.frontOf(focused);
        if (!front) {
          const missing = 'No footprint for that one, so I cannot tell front from back.';
          say(missing);
          return { ok: false, action: 'camera_angle', spoken: missing };
        }
        headingDeg = headingForSide(slots.side, front.bearingDeg);
        source = front.source;
        const where = slots.viaStreet ? 'From the street' : `The ${slots.side}`;
        // An honest hedge when the front came from the long-wall convention
        // rather than from a real street.
        spoken = source === 'street'
          ? `${where}.`
          : `${where} — estimated from the building's long wall, no street mapped.`;
      } else if (slots.range) {
        spoken = slots.range === 'closer' ? 'Moving in.' : 'Pulling back.';
      } else if (slots.height) {
        spoken = slots.height === 'higher' ? 'Going up.' : 'Coming down.';
      }

      camera.reframe({
        headingDeg: Number.isFinite(headingDeg) ? headingDeg : undefined,
        range: slots.range,
        height: slots.height,
      });
      say(spoken);
      return {
        ok: true,
        action: 'camera_angle',
        id: focused.id,
        headingDeg,
        frontSource: source,
        ...slots,
        spoken,
      };
    },

    /**
     * Which house a referring command means, or the question to ask instead.
     *
     * The ambiguous branch is the one that matters. When a call-out named two
     * houses at once and the user says "save that one", there is no honest
     * answer — so the drive asks rather than saving one at random and being
     * wrong half the time.
     */
    driveTarget(intent) {
      const outcome = drive.resolve(intent);
      if (outcome.ok) {
        const property = outcome.property || this.getById(outcome.id);
        return { ...outcome, property, spoken: '' };
      }
      return { ok: false, action: intent, ...outcome };
    },

    /**
     * The card shown before a drive starts.
     *
     * One small card, and deliberately before: a drive that simply begins is
     * disorienting, and "Oakhurst · 1.4 km · 5 signal types" is the difference
     * between a demo and a surprise.
     */
    startDrive(slots = {}) {
      if (drive.running) return { ok: true, action: 'start_drive', spoken: 'Already driving.' };
      const plan = drive.plan();
      const live = slots.live ?? readDriveLive();
      /**
       * One driving view: the 3D chase camera. "Drive in 3D" still parses and
       * means what "drive" already does.
       */
      renderDriveIntro(plan, { live, view: DRIVE_VIEWS.CHASE });
      const result = drive.start({ live, gold: Boolean(slots.gold) });
      if (result.ok) {
        setNavActive('drive');
        setDriveChrome(true);
        if (live) requestWakeLock();
      }
      say(result.spoken);
      return result;
    },

    /**
     * Put the right view behind the answer.
     *
     * Deliberately fire-and-forget. The camera move and the cross-fade take
     * 300 ms and two seconds respectively, and the answer itself — the card,
     * the underwriting, the spoken line — must not wait on either: the user
     * asked a question, and a product that stays silent for two seconds while
     * a camera flies has answered late even if it answers well.
     */
    routeView(text, parsed) {
      if (!drive.running || !viewDirector.enabled) return null;
      const decision = viewDirector.route(text, parsed);
      if (!decision) return null;
      // A 3D answer needs a subject. The house being discussed is the one the
      // question is about; with nothing discussed, a lot view is a lot view of
      // nowhere, so the view stays where it is and the answer still lands.
      const property = focused
        || drive.current
        || (drive.goldId ? this.getById(drive.goldId) : null);
      if ((isThreeD(decision.view) || decision.view === VIEWS.STREET_VIEW)
        && decision.view !== VIEWS.CRUISE && !property) {
        // The panorama is the one answer that works without a house: it shows
        // the street the drive is standing on.
        if (decision.view !== VIEWS.STREET_VIEW) return null;
      }
      // The Maps JavaScript API is only loaded when something asks to see a
      // photograph, which on most drives is never.
      if (decision.view === VIEWS.STREET_VIEW) {
        drive.mountStreetView().then((mounted) => {
          if (!mounted?.ok) return;
          viewDirector.show(VIEWS.STREET_VIEW, { property, reason: decision.reason });
        });
        if (property) {
          focused = property;
          conversation.focusedId = property.id;
        }
        return decision;
      }
      const angle = decision.view === VIEWS.ANGLE
        ? () => {
          focused = property;
          conversation.focusedId = property?.id || null;
          return this.cameraAngle(parsed.slots || {});
        }
        : null;
      if (property && decision.view !== VIEWS.CRUISE) {
        focused = property;
        conversation.focusedId = property.id;
      }
      viewDirector.show(decision.view, {
        property,
        reason: decision.reason,
        angle,
        // "look closer" has flown its own HERO since v1 and opens Property
        // Mode with it; the director takes the fade and leaves the flight.
        moveCamera: parsed.intent !== 'look_closer',
      });
      return decision;
    },

    /**
     * Swap worlds, keeping the camera and everything on the board.
     *
     * Not a reload and not a different scene: the same properties, the same
     * scores, the same shot. What changes is what the ground and the roofs are
     * made of.
     */
    setWorld(next) {
      const target = next === WORLDS.CLEAR ? WORLDS.CLEAR : WORLDS.PHOTO;
      const already = clearView.world === target;
      clearView.setWorld(target);
      const spoken = target === WORLDS.CLEAR
        ? 'Clear View — an experiment, not the product.'
        : 'Photo world.';
      say(spoken);
      return {
        ok: true, action: 'set_world', world: target, changed: !already, spoken,
      };
    },

    /** "x-ray" / "see through": the photo world goes translucent now. */
    seeThrough() {
      const result = xray.trigger();
      if (result.ok) audio.play('xrayHum');
      const spoken = result.ok
        ? 'X-ray.'
        : (result.reason === 'tileset hidden'
          ? 'X-ray needs the photo world.'
          : 'No photo world to see through.');
      say(spoken);
      return { ok: result.ok, action: 'xray', spoken, ...result };
    },

    /** "solid": end the x-ray early, easing back rather than snapping. */
    goSolid() {
      const result = xray.end();
      const spoken = result.wasRunning ? 'Solid.' : 'Already solid.';
      say(spoken);
      return { ok: true, action: 'solid', spoken, ...result };
    },

    /**
     * "show me the lot", standing still: the hero framing on the focused house
     * with the lot line and the outline, and an x-ray once the flight lands.
     */
    showLot() {
      if (!focused) {
        const spoken = 'Nothing focused. Say show me the best one.';
        say(spoken);
        return { ok: false, action: 'show_lot', spoken };
      }
      const property = focused;
      hideSavedSheet();
      setNavActive('world');
      camera.fly('HERO', property).then((result) => {
        if (result.cancelled || focused?.id !== property.id) return;
        xray.arm({ flying: camera.flying });
      });
      const spoken = 'Here\'s the lot.';
      say(spoken);
      return { ok: true, action: 'show_lot', id: property.id, spoken };
    },

    world() {
      hideSavedSheet();
      hideFocusCard();
      visuals.setFocused(null);
      visuals.setShortlist(null);
      visuals.setTopPick(null);
      visuals.setDealVision(null);
      focused = null;
      setNavActive('world');
      hunt?.dismiss?.({ persistSession: true });
      // First press comes back to the market; pressing again from the market
      // goes all the way out to the globe.
      const target = worldToggleTarget(camera.shot);
      // In the six-house scene the "market" is the cluster.
      camera.fly(target, target === 'CRUISE' && scene ? scene.rows : null);
      if (target === 'CRUISE') visuals.startScan();
      setAiPrompt(market.greeting);
    },
  };

  /**
   * The assistant's presence rides on GEV's Realtime controller, which
   * `main.js` built before this session started. Its snapshot is gathered
   * here because this is the one place that can see everything at once.
   */
  terra = createTerra({
    session,
    controller: globalThis.__gevVoiceCommands || null,
    parseIntent: parseDemoIntent,
    strip: setAiPrompt,
    openTyped: () => openTypedBar(),
    onQuiet: (on) => setQuietToggle(on),
    onInterrupt: () => {
      // The half-spoken line ends; the card it was assembling finishes now.
      narrator.cancel();
      revealAllFocusLines();
    },
    gather: () => ({
      market,
      clock: demoNow().toISOString().slice(0, 10),
      camera: {
        shot: camera.shot,
        flying: camera.flying,
        orbiting: camera.orbiting,
        heightM: cameraHeightM(viewer),
      },
      drive: {
        running: drive.running,
        paused: drive.paused,
        alongM: drive.alongM,
        lengthM: drive.lengthM,
        current: drive.current,
        goldId: drive.goldId,
        panoStopped: Boolean(drive.panoStopped),
      },
      properties,
      shortlistIds: conversation.candidateIds,
      topPickId: conversation.topPickId || scene?.goldId || null,
      focused,
      analysis: focused && lastAnalysisId === focused.id ? lastAnalysis : null,
      strategy: conversation.dealVisible ? conversation.lastStrategy : null,
      saved: focused ? readSavedProperties().some((row) => row.id === focused.id) : false,
      level: drive.level,
      screen: {
        card: Boolean(focused && !document.getElementById('ts-focus-card')?.hidden),
        cardAssembling: focusCardState().assembling,
        savedSheet: !document.getElementById('ts-saved-sheet')?.hidden,
        dealVision: conversation.dealVisible ? conversation.lastStrategy : null,
        opportunityVision: visuals.enabled,
        xray: xray.running,
        strip: document.getElementById('ts-ai-prompt')?.textContent || null,
      },
    }),
  });
  terra.attach();
  void terra.probe();

  bindUi(session);
  bindDemoScript(session);
  // No retry timer: relocateVoiceControl arms a placement observer when the
  // voice control does not exist yet, so a late build is handled on arrival.
  relocateVoiceControl();

  viewer.camera.changed.addEventListener(() => {
    setLodChip(lodFromHeight(cameraHeightM(viewer)).id);
  });

  globalThis.addEventListener('terrasignal:pick-property', (event) => {
    if (event.detail?.id) session.focus(event.detail.id, { fly: true });
  });

  camera.fly('WORLD');
  setAiPrompt('Where are we hunting today?');

  const enableVision = () => {
    visuals.setEnabled(readVisionPref(config.opportunityVisionDefault));
  };

  /**
   * Safety net, not a fix.
   *
   * Measured on Cesium 1.124: an illegal geometry value thrown while the entity
   * layer updates does NOT raise `scene.renderError`. What actually happens is
   * that CesiumWidget catches it in the render loop, shows its error panel, and
   * sets `viewer.useDefaultRenderLoop = false` — rendering stops and the user is
   * left on a frozen globe behind a modal. So a renderError listener alone would
   * never fire for the bug this was written for; the loop flag is the real
   * signal, and it has to be polled.
   *
   * Recovery is capped: if the offending value is still there, re-arming just
   * reproduces the error, and burning CPU on that loop is worse than showing the
   * dialog. Either way the smoke checks still fail on any of this — getting here
   * means something handed Cesium an illegal value, which is a bug to go find.
   */
  const RENDER_RECOVERY_LIMIT = 3;
  const RENDER_WATCHDOG_MS = 2000;
  let renderRecoveries = 0;

  const noteRenderFailure = (message, error) => {
    console.error('[TerraSignal] render failure — recovering:', message, error?.stack || '');
    const seen = globalThis.__terraSignalRenderErrors || [];
    seen.push({ message, at: Date.now() });
    globalThis.__terraSignalRenderErrors = seen;
  };

  const armRenderErrorRecovery = () => {
    const scene = viewer?.scene;
    // Genuine in-render errors do raise this; keep it even though the entity
    // path does not come through here.
    scene?.renderError?.addEventListener?.((_scene, error) => {
      noteRenderFailure(String(error?.message || error), error);
      try {
        scene.rethrowRenderErrors = false;
        governorRequestRender('investor-render-error');
        scene.requestRender();
      } catch (recoveryError) {
        console.error('[TerraSignal] render recovery failed:', recoveryError);
      }
    });

    const watchdog = globalThis.setInterval(() => {
      if (!viewer || viewer.isDestroyed?.()) {
        globalThis.clearInterval(watchdog);
        return;
      }
      if (viewer.useDefaultRenderLoop !== false) return;
      if (renderRecoveries >= RENDER_RECOVERY_LIMIT) {
        globalThis.clearInterval(watchdog);
        return;
      }
      renderRecoveries += 1;
      const panel = document.querySelector('.cesium-widget-errorPanel');
      const text = (panel?.textContent || 'render loop stopped').trim().slice(0, 300);
      noteRenderFailure(text, null);
      try {
        panel?.remove();
        viewer.useDefaultRenderLoop = true;
        governorRequestRender('investor-render-recovery');
        viewer.scene?.requestRender?.();
      } catch (recoveryError) {
        console.error('[TerraSignal] render recovery failed:', recoveryError);
      }
    }, RENDER_WATCHDOG_MS);
  };
  armRenderErrorRecovery();

  const startHunt = async () => {
    releaseInvestorBootHolds();
    session.demoScript?.collapse?.();
    setAiPrompt('Descending on Atlanta / Decatur…');
    if (!tileset) {
      if (viewer?.scene?.globe) viewer.scene.globe.show = true;
      kickRenderBurst(viewer, { times: 6, intervalMs: 200 });
    }
    // WORLD → STAGING (nadir at 40 km, tiles stream) → CRUISE. In the
    // six-house scene that last leg aims at the cluster at 900 m instead of
    // the market at 1,800 m, which is already inside the near-field ceiling —
    // so the parcel glow and the columns are up when the shot settles.
    await camera.descend({ cruiseTarget: scene ? scene.rows : null });
    // The descent is over; stop telling the user it is still happening.
    setAiPrompt(scene ? SIX_HOUSE_HINT : FIRST_HINT);
    enableVision();
    terra?.emit('descent_settled');
    if (!tileset) {
      const painted = await ensureKeylessVisibleBasemap({
        viewer,
        mapStackController,
        styleManager,
        tileset,
        phase: 'after-market',
      });
      if (painted.empty) {
        setAiPrompt('Earth imagery failed — the gray globe is empty, not the Decatur market.');
      }
    }
    visuals.startScan();
    // The gold house is the head of the ranking, computed from the same
    // composite `findMoney` uses — the scene does not get to pick a favourite.
    // Arming it here is what makes "show me the best one" and a tap on the
    // gold parcel both land on the same house.
    if (scene?.goldId) {
      visuals.setTopPick(scene.goldId);
      conversation.topPickId = scene.goldId;
      clearView.repaint();
    }
    /**
     * The experiment world, from the URL only, applied after the descent.
     *
     * Switching worlds changes the terrain provider, and doing that while the
     * opening flight is in the air leaves the camera at an altitude measured
     * against a surface that has since moved. After CRUISE has settled the
     * camera is stationary. `fade: false` because there is nothing to
     * cross-fade *from* on a first load.
     */
    if (readWorldFromLocation() === WORLDS.CLEAR) {
      await clearView.setWorld(WORLDS.CLEAR, { fade: false });
    }
    setLodChip(lodFromHeight(cameraHeightM(viewer)).id);
    const banner = document.getElementById('ts-globe-error');
    if (!banner || banner.hidden) {
      setAiPrompt(scene ? SIX_HOUSE_HINT : FIRST_HINT);
    }
  };

  hunt = initFirstHunt({
    root: document.getElementById('ts-first-hunt'),
    hasShareState: Boolean(styleManager?.hasShareState),
    onBegin: startHunt,
    onDismiss: () => {
      releaseInvestorBootHolds();
      enableVision();
    },
  });
  session.beginHunt = startHunt;
  session.firstHunt = hunt;
  // A scene URL has already answered "where are we hunting today?" — asking
  // again would park a modal over the six houses it was opened to show.
  if (scene) hunt?.dismiss?.({ persistSession: true });
  if (scene || !hunt?.show) {
    releaseInvestorBootHolds();
    await startHunt();
  }

  return session;
}

/** Globe caption for a compare: the winner, then the best path that also works. */
function compareCaption(result, runnerUp) {
  return result.rows
    .filter((row) => row.strategy === result.best || row === runnerUp)
    .map((row) => `${row.strategy.toUpperCase()} ${row.verdict.toUpperCase()}`
      + `${row.headline ? ` ${row.headline}` : ''}`)
    .join('\n');
}

function bindUi(session) {
  document.getElementById('ts-opportunity-vision')?.addEventListener('change', (event) => {
    session.setOpportunityVision(event.target.checked);
  });

  document.getElementById('ts-bottom-nav')?.addEventListener('click', (event) => {
    const button = event.target.closest('[data-ts-nav]');
    if (!button) return;
    const name = button.getAttribute('data-ts-nav');
    if (name === 'world') session.world();
    if (name === 'drive') {
      if (session.drive.running) session.drive.stop();
      else {
        setNavActive('drive');
        const result = session.drive.start();
        say(result.spoken);
      }
    }
    if (name === 'saved') session.showSaved();
    if (name === 'ai') {
      const voice = document.getElementById('gev-voice-button');
      if (voice) voice.click();
      else openTypedBar();
    }
    // 'type' is bound by the chrome itself (toggleTypedBar); nothing here.
  });

  /**
   * The orb is the assistant's one control: first tap opens the always-on
   * session (or the typed bar when there is no key), the next pauses it, the
   * next resumes. The classic start/stop handler is replaced, not wrapped —
   * "stop" on a click was the push-to-talk product's idea of a mic button.
   */
  const controller = globalThis.__gevVoiceCommands;
  const voiceButton = controller?.ui?.button || document.getElementById('gev-voice-button');
  if (controller && voiceButton && session.terra) {
    if (controller.buttonHandler) voiceButton.removeEventListener('click', controller.buttonHandler);
    controller.buttonHandler = () => { void session.terra.toggle(); };
    voiceButton.addEventListener('click', controller.buttonHandler);
    voiceButton.setAttribute('aria-label', `${ASSISTANT_NAME} — tap to listen, tap again to pause`);
  }

  document.getElementById('ts-quiet-toggle')?.addEventListener('change', (event) => {
    session.setQuiet(Boolean(event.target.checked));
  });

  document.getElementById('ts-demo-form')?.addEventListener('submit', (event) => {
    event.preventDefault();
    const input = document.getElementById('ts-demo-input');
    const text = input?.value || '';
    if (!text.trim()) return;
    // With the assistant available, typed words go through the same session
    // the voice does — same state item, same tools, same wording — opening
    // it if it is not up yet. Without it (no key), the parser answers
    // directly: the product before there was a voice.
    const viaTerra = session.terra && session.terra.available !== false && !session.terra.paused
      && session.terra.sendText(text);
    if (!viaTerra) session.handleIntent(text);
    input.value = '';
  });

  document.getElementById('ts-focus-card')?.addEventListener('click', (event) => {
    const action = event.target.closest('[data-ts-focus-action]')?.getAttribute('data-ts-focus-action');
    if (action === 'save') session.save(session.focused?.id);
    if (action === 'deal') session.handleIntent('Show me the deal');
    if (action === 'reset') session.handleIntent('reset the numbers');
    if (action === 'compare') session.handleIntent('compare');
  });

  document.getElementById('ts-saved-sheet')?.addEventListener('click', (event) => {
    if (event.target.closest('[data-ts-saved-close]')) {
      hideSavedSheet();
      setNavActive('world');
      return;
    }
    const id = event.target.closest('[data-ts-saved-id]')?.getAttribute('data-ts-saved-id');
    if (id) session.focus(id);
  });
}

export { explainProperty } from './voiceTools.js';
