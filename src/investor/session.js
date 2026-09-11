import * as Cesium from 'cesium';
import { INVESTOR_LAYER_DENYLIST, VISION_STORAGE_KEY, readInvestorConfig } from './config.js';
import { resolveMarket } from './markets.js';
import { createMockPropertyProvider } from './mock/provider.js';
import { rankMockProperties, searchMockProperties } from './mock/search.js';
import { analyzePropertyDeal, bestStrategyFor, normalizeStrategy } from './deal/index.js';
import { createOpportunityVisualManager } from './visuals/opportunityVisualManager.js';
import { prefersReducedMotion } from './visuals/reducedMotionPolicy.js';
import { flyGlobeThenMarket, flyToMarket, flyToProperty, whyThisMatters } from './focus.js';
import { cameraHeightM, lodFromHeight } from './lod.js';
import { readSavedProperties, removeSavedProperty, saveProperty } from './saved.js';
import { createDriveDemo } from './driveDemo.js';
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
import { hideSavedSheet, renderSavedSheet } from './ui/savedSheet.js';

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
  const provider = createMockPropertyProvider({
    marketId: market.id,
    provider: config.propertyProvider,
  });
  const properties = provider.list();
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

  const visuals = createOpportunityVisualManager({
    viewer,
    Cesium,
    market,
    getProperties: () => properties,
  });
  // Keep pulses off until the first-hunt modal is done so a parked globe
  // does not take investor-opportunity (continuous 60 fps) on a laptop GPU.
  visuals.setEnabled(false);

  const drive = createDriveDemo({
    viewer,
    Cesium,
    getProperties: () => properties,
    onAnnounce: (event) => {
      focused = event.property;
      conversation.focusedId = event.id;
      visuals.setFocused(event.id);
      renderFocusCard(event.property);
      setAiPrompt(event.spoken);
    },
    onStop: () => setNavActive('world'),
  });

  const session = {
    config,
    market,
    provider,
    properties,
    conversation,
    visuals,
    drive,
    get focused() { return focused; },
    get lastAnalysis() { return lastAnalysis; },
    getById(id) {
      return provider.getById(id) || properties.find((row) => row.id === id) || null;
    },
    focus(id, { fly = true } = {}) {
      const property = this.getById(id);
      if (!property) return { ok: false, action: 'focus_property', error: 'Unknown mock property' };
      focused = property;
      conversation.focusedId = property.id;
      visuals.setFocused(property.id);
      if (fly) flyToProperty(viewer, Cesium, property, { reduced: prefersReducedMotion() });
      const analysisForCard = lastAnalysisId === property.id ? lastAnalysis : null;
      renderFocusCard(property, {
        analysis: analysisForCard,
        strategy: conversation.lastStrategy,
        revealDeal: Boolean(analysisForCard),
      });
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
        visuals.setTopPick(result.topPickId);
        visuals.startScan();
        if (result.focusId) this.focus(result.focusId);
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
        if (result.ok) this.focus(result.id);
        setAiPrompt(result.spoken);
        return result;
      }

      if (parsed.intent === 'why') {
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
        return { ok: true, action: 'world', spoken: market.greeting };
      }

      if (parsed.intent === 'start_drive') {
        setNavActive('drive');
        const result = drive.start();
        setAiPrompt(result.spoken);
        return result;
      }
      if (parsed.intent === 'stop_drive') {
        const result = drive.stop();
        setAiPrompt(result.spoken);
        return result;
      }
      if (parsed.intent === 'drive_next') {
        const result = drive.running ? drive.next() : drive.start();
        setAiPrompt(result.spoken);
        return result;
      }
      if (parsed.intent === 'drive_skip') {
        const result = drive.skip();
        setAiPrompt(result.spoken);
        return result;
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
      flyToMarket(viewer, Cesium, market, {
        heightM: market.overviewHeightM,
        duration: prefersReducedMotion() ? 0.8 : 2.6,
      });
      visuals.startScan();
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

  viewer.camera.setView({
    destination: Cesium.Cartesian3.fromDegrees(market.globeLng, market.globeLat, 18_000_000),
    orientation: {
      heading: 0,
      pitch: Cesium.Math.toRadians(-90),
      roll: 0,
    },
  });
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
    setAiPrompt('Descending on Atlanta / Decatur…');
    if (!tileset) {
      if (viewer?.scene?.globe) viewer.scene.globe.show = true;
      kickRenderBurst(viewer, { times: 6, intervalMs: 200 });
    }
    await flyGlobeThenMarket(viewer, Cesium, market, { reduced: prefersReducedMotion() });
    // The descent is over; stop telling the user it is still happening.
    setAiPrompt(FIRST_HINT);
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
    setLodChip(lodFromHeight(cameraHeightM(viewer)).id);
    const banner = document.getElementById('ts-globe-error');
    if (!banner || banner.hidden) setAiPrompt(FIRST_HINT);
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
  if (!hunt?.show) {
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
