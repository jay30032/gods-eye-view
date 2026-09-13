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
import { createDriveDemo } from './driveDemo.js';
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
import { governorRequestRender } from '../renderGovernor.js';
import { setScopeMaskEnabled } from '../scopeMask.js';
import {
  ensureKeylessVisibleBasemap,
  kickRenderBurst,
  releaseInvestorBootHolds,
  waitForFirstInvestorFrame,
} from './ensureBasemap.js';
import { applyInvestorChrome, relocateVoiceControl, setAiPrompt, setLodChip, setNavActive } from './ui/chrome.js';
import { bindDemoScript } from './ui/demoScript.js';
import { initFirstHunt } from './ui/firstHunt.js';
import { hideFocusCard, renderFocusCard } from './ui/focusCard.js';
import {
  ensureDriveBar,
  hideDriveIntro,
  readDriveLive,
  renderDriveIntro,
  setDriveProgress,
} from './ui/driveChrome.js';
import { hideSavedSheet, renderSavedSheet } from './ui/savedSheet.js';

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
  const drive = createDriveDemo({
    viewer,
    Cesium,
    camera,
    visuals,
    getProperties: () => properties,
    onAnnounce: (event) => {
      if (event.property && event.detail !== true) driveCard(event.property, event);
      setAiPrompt(event.spoken);
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
    renderFocusCard(property, { driveCallout: event?.spoken || null, compact: true });
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
    if (state.running) setDriveProgress(state.alongM, state.lengthM);
    else hideDriveIntro();
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
    get focused() { return focused; },
    get lastAnalysis() { return lastAnalysis; },
    getById(id) {
      return provider.getById(id) || properties.find((row) => row.id === id) || null;
    },
    focus(id, { fly = true } = {}) {
      const property = this.getById(id);
      if (!property) return { ok: false, action: 'focus_property', error: 'Unknown mock property' };
      const previous = focused;
      focused = property;
      conversation.focusedId = property.id;
      visuals.setFocused(property.id);
      const analysisForCard = lastAnalysisId === property.id ? lastAnalysis : null;
      const paintCard = () => renderFocusCard(property, {
        analysis: analysisForCard,
        strategy: conversation.lastStrategy,
        revealDeal: Boolean(analysisForCard),
        customNumbers: hasCustomNumbers(conversation),
      });
      if (fly) {
        // Moving house to house is a hop, not a slide across the rooftops.
        const arrival = previous && previous.id !== property.id
          ? camera.hop(previous, property)
          : camera.fly('HERO', property);
        arrival.then((result) => {
          // Only act if we actually landed — a superseded flight must not
          // orbit or open a card on a house the user has already left.
          if (result.cancelled || focused?.id !== property.id) return;
          paintCard();
          camera.orbit(property);
        });
      } else {
        paintCard();
      }
      hideSavedSheet();
      setNavActive('world');
      return { ok: true, action: 'focus_property', id: property.id, address: property.address };
    },
    setOpportunityVision(enabled) {
      const next = visuals.setEnabled(enabled);
      writeVisionPref(next);
      const box = document.getElementById('ts-opportunity-vision');
      if (box) box.checked = next;
      setAiPrompt(next ? 'Opportunity Vision on.' : 'Opportunity Vision off.');
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
      setAiPrompt(`${name.toUpperCase()} vision on the globe.`);
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
        visuals.setSaved(property.id);
        renderFocusCard(property, {
          analysis: lastAnalysisId === property.id ? lastAnalysis : null,
          strategy: conversation.lastStrategy,
          revealDeal: lastAnalysisId === property.id,
        });
        this.showSaved();
        setAiPrompt(result.spoken);
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
    handleIntent(text) {
      const parsed = parseDemoIntent(text);
      if (!parsed) return { ok: false, spoken: 'Say find me money.' };
      const slots = parsed.slots || {};

      if (parsed.intent === 'find_money') {
        if (this.drive.running) this.drive.stop();
        this.setOpportunityVision(true);
        const result = applyFindMoney(properties, conversation, slots);
        if (!result.ok) {
          setAiPrompt(result.spoken);
          return result;
        }
        visuals.setSaved(null);
        visuals.setShortlist(result.candidateIds);
        visuals.startScan();
        // REVEAL fits the whole shortlist; the gold halo is the payoff of that
        // shot, so it appears when the shot settles — not while still flying.
        const shortlist = result.candidateIds
          .map((candidateId) => this.getById(candidateId))
          .filter(Boolean);
        camera.fly('REVEAL', shortlist).then(async (reveal) => {
          if (reveal.cancelled) return;
          visuals.setTopPick(result.topPickId);
          await camera.dwell(DURATIONS.revealDwell);
          if (result.focusId) this.focus(result.focusId);
        });
        if (result.focusId) {
          focused = this.getById(result.focusId);
          conversation.focusedId = result.focusId;
          visuals.setFocused(result.focusId);
          setNavActive('world');
        }
        setAiPrompt(result.spoken);
        return result;
      }

      if (parsed.intent === 'focus') {
        // While the drive is running, "next" and "skip" belong to the route.
        if (this.drive.running && (slots.step === 'next' || slots.step === 'previous')) {
          const moved = slots.step === 'next' ? drive.next() : drive.skip();
          setAiPrompt(moved.spoken);
          return moved;
        }
        const result = applyFocus(properties, conversation, slots);
        if (result.ok) {
          // "Show me the best one" is a question about the whole board, so it
          // gets the same sweep "find me money" does before the answer lights.
          if (slots.step === 'top') visuals.startScan();
          this.focus(result.id);
        }
        setAiPrompt(result.spoken);
        return result;
      }

      if (parsed.intent === 'why') {
        if (slots.referring && drive.running) {
          const target = this.driveTarget('why_flagged');
          if (!target.ok) { setAiPrompt(target.spoken); return target; }
          const spoken = whyThisMatters(target.property);
          setAiPrompt(spoken);
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
        setAiPrompt(result.spoken);
        return result;
      }

      if (parsed.intent === 'show_deal') {
        const result = applyShowDeal(focused, conversation, slots);
        if (result.ok) {
          lastAnalysis = result.analysis;
          lastAnalysisId = focused.id;
          this.showDealVision(result.strategy);
        }
        setAiPrompt(result.spoken);
        return result;
      }

      if (parsed.intent === 'compare') {
        if (slots.withPrevious && drive.running) {
          const target = this.driveTarget('compare_last');
          if (!target.ok) { setAiPrompt(target.spoken); return target; }
          const previous = this.getById(target.previousId);
          const spoken = previous
            ? `${shortAddress(target.property)} scores ${Math.round(target.property.composite)}; `
              + `${shortAddress(previous)} scores ${Math.round(previous.composite)}.`
            : 'Nothing to compare with yet.';
          setAiPrompt(spoken);
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
        setAiPrompt(result.spoken);
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
        setAiPrompt(result.spoken);
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
        setAiPrompt(result.spoken);
        return result;
      }

      if (parsed.intent === 'save') {
        if (slots.referring && drive.running) {
          const target = this.driveTarget('save_that');
          if (!target.ok) { setAiPrompt(target.spoken); return target; }
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
        setAiPrompt(result.spoken);
        return result;
      }

      if (parsed.intent === 'show_saved') return this.showSaved();

      if (parsed.intent === 'vision_on' || parsed.intent === 'vision_off') {
        return this.setOpportunityVision(parsed.intent === 'vision_on');
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
        setAiPrompt(result.spoken);
        return result;
      }
      if (parsed.intent === 'drive_next') {
        const result = drive.running ? drive.next() : this.startDrive();
        setAiPrompt(result.spoken);
        return result;
      }
      if (parsed.intent === 'drive_skip') {
        const result = drive.skip();
        setAiPrompt(result.spoken);
        return result;
      }

      if (parsed.intent === 'camera_angle') {
        return this.cameraAngle(slots);
      }

      // ---- Drive Mode ----------------------------------------------------
      if (parsed.intent === 'drive_pause') {
        if (!drive.running) return this.cameraAngle({ orbit: 'stop' });
        const result = drive.pause();
        setAiPrompt(result.spoken);
        return result;
      }
      if (parsed.intent === 'drive_resume') {
        if (!drive.running) return { ok: false, spoken: 'No drive running.' };
        const result = drive.keepGoing();
        setAiPrompt(result.spoken);
        return result;
      }
      if (parsed.intent === 'drive_speed') {
        if (!drive.running) return { ok: false, spoken: 'No drive running.' };
        const result = slots.speed === 'slower' ? drive.slower() : drive.faster();
        setAiPrompt(result.spoken);
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
        setAiPrompt(result.spoken);
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
          renderFocusCard(result.property);
        }
        setAiPrompt(result.spoken);
        return result;
      }
      if (parsed.intent === 'drive_best') {
        if (!drive.running) return this.handleIntent('show me the best one');
        const result = drive.requestBestMatch();
        setAiPrompt(result.spoken);
        return result;
      }
      if (parsed.intent === 'drive_narration') {
        const result = drive.setNarrationLevel(slots.level);
        setAiPrompt(result.spoken);
        return result;
      }
      if (parsed.intent === 'how_recent') {
        const target = this.driveTarget('how_recent');
        if (!target.ok) { setAiPrompt(target.spoken); return target; }
        const signal = (target.property.signals || [])[0];
        const spoken = signal
          ? `${String(signal.type).replaceAll('_', ' ').toLowerCase()}, filed ${signal.ageDays} days ago.`
          : 'No filing date on that one.';
        setAiPrompt(spoken);
        return { ok: true, action: 'how_recent', id: target.id, spoken };
      }
      if (parsed.intent === 'more_like_it') {
        const target = this.driveTarget('more_like_it');
        if (!target.ok) { setAiPrompt(target.spoken); return target; }
        const type = (target.property.signals || [])[0]?.type;
        return this.handleIntent(`find ${String(type || '').replaceAll('_', ' ').toLowerCase() || 'money'}`);
      }

      if (parsed.intent === 'help') {
        setAiPrompt(HELP_LINE);
        // The rail is the written version of the same cheat sheet.
        const rail = document.getElementById('ts-demo-script');
        if (rail) {
          rail.hidden = false;
          rail.classList.add('visible');
          session.demoScript?.paint?.();
        }
        return { ok: true, action: 'help', spoken: HELP_LINE };
      }

      const suggestion = slots.suggestion || 'find me money';
      const spoken = `Didn't catch that. Try: ${suggestion}`;
      setAiPrompt(spoken);
      return { ok: false, action: 'unknown', suggestion, spoken };
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
        setAiPrompt(spoken);
        return { ok: false, action: 'camera_angle', spoken };
      }

      if (slots.orbit === 'stop') {
        camera.stopOrbit();
        const spoken = 'Holding here.';
        setAiPrompt(spoken);
        return { ok: true, action: 'camera_orbit', orbit: 'stop', spoken };
      }
      if (slots.orbit === 'start') {
        camera.orbit(focused);
        const spoken = `Circling ${shortAddress(focused)}.`;
        setAiPrompt(spoken);
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
          setAiPrompt(missing);
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
      setAiPrompt(spoken);
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
      renderDriveIntro(plan, { live });
      const result = drive.start({ live, gold: Boolean(slots.gold) });
      if (result.ok) {
        setNavActive('drive');
        setDriveChrome(true);
        if (live) requestWakeLock();
      }
      setAiPrompt(result.spoken);
      return result;
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
        setAiPrompt(result.spoken);
      }
    }
    if (name === 'saved') session.showSaved();
    if (name === 'ai') {
      document.getElementById('gev-voice-button')?.click();
      document.getElementById('ts-demo-input')?.focus();
    }
  });

  document.getElementById('ts-demo-form')?.addEventListener('submit', (event) => {
    event.preventDefault();
    const input = document.getElementById('ts-demo-input');
    const text = input?.value || '';
    if (!text.trim()) return;
    session.handleIntent(text);
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
