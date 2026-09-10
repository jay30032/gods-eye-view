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
import { readSavedProperties, saveProperty } from './saved.js';
import { createDriveDemo } from './driveDemo.js';
import {
  applyFindMoney,
  applyRehabDelta,
  applyShowDeal,
  applyWhy,
  createConversationState,
  parseDemoIntent,
} from './conversation.js';
import { applyInvestorChrome, relocateVoiceControl, setAiPrompt, setLodChip, setNavActive } from './ui/chrome.js';
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

  const visuals = createOpportunityVisualManager({
    viewer,
    Cesium,
    market,
    getProperties: () => properties,
  });
  visuals.setEnabled(readVisionPref(config.opportunityVisionDefault));

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
      visuals.setDealVision(name);
      if (focused) {
        lastAnalysis = analyzePropertyDeal(focused, name, { rehabDelta: conversation.rehabDelta });
        lastAnalysisId = focused.id;
        renderFocusCard(focused, { analysis: lastAnalysis, strategy: name, revealDeal: true });
      }
      setAiPrompt(`${name.toUpperCase()} vision on the globe.`);
      return { ok: true, action: 'show_deal_vision', strategy: name, id: focused?.id || null };
    },
    analyze(strategy, overrides = {}) {
      if (!focused) return { ok: false, error: 'No property focused' };
      const name = normalizeStrategy(strategy) || bestStrategyFor(focused);
      conversation.lastStrategy = name;
      lastAnalysis = analyzePropertyDeal(focused, name, {
        rehabDelta: conversation.rehabDelta,
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
      const result = saveProperty(property, {
        strategy: extras?.strategy || conversation.lastStrategy,
        note: extras?.note || '',
      });
      if (result.ok) setAiPrompt(`Saved ${property.address.split(',')[0]}.`);
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
    handleIntent(text) {
      const parsed = parseDemoIntent(text);
      if (!parsed) return { ok: false, spoken: 'Say find me money.' };
      if (parsed.intent === 'find_money') {
        const result = applyFindMoney(properties, conversation);
        if (result.focusId) this.focus(result.focusId);
        setAiPrompt(result.spoken);
        return result;
      }
      if (parsed.intent === 'why') {
        const result = applyWhy(focused, conversation);
        setAiPrompt(result.spoken);
        return result;
      }
      if (parsed.intent === 'show_deal') {
        const result = applyShowDeal(focused, conversation);
        if (result.ok) {
          lastAnalysis = result.analysis;
          this.showDealVision(result.strategy);
        }
        setAiPrompt(result.spoken);
        return result;
      }
      if (parsed.intent === 'rehab_plus_20k') {
        const result = applyRehabDelta(focused, conversation, 20000);
        if (result.ok) {
          lastAnalysis = result.analysis;
          lastAnalysisId = focused.id;
          renderFocusCard(focused, { analysis: lastAnalysis, strategy: result.strategy, revealDeal: true });
        }
        setAiPrompt(result.spoken);
        return result;
      }
      if (parsed.intent === 'save') {
        const result = this.save(focused?.id);
        return { ...result, spoken: result.ok ? `Saved ${focused.address.split(',')[0]}.` : 'Nothing to save.' };
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
      return { ok: false, spoken: 'Try: Find me money. Why? Show me the deal. Save it.' };
    },
    world() {
      hideSavedSheet();
      hideFocusCard();
      visuals.setFocused(null);
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
  relocateVoiceControl();
  globalThis.setTimeout(relocateVoiceControl, 800);

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

  const startHunt = async () => {
    setAiPrompt('Descending on Atlanta / Decatur…');
    await flyGlobeThenMarket(viewer, Cesium, market, { reduced: prefersReducedMotion() });
    visuals.startScan();
    setLodChip(lodFromHeight(cameraHeightM(viewer)).id);
    setAiPrompt(market.greeting);
  };

  hunt = initFirstHunt({
    root: document.getElementById('ts-first-hunt'),
    hasShareState: Boolean(styleManager?.hasShareState),
    onBegin: startHunt,
  });
  session.beginHunt = startHunt;
  session.firstHunt = hunt;
  if (!hunt?.show) await startHunt();

  return session;
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
