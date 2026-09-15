import { readDemoMode } from '../demoSequence.js';
import { initFirstHunt } from './firstHunt.js';

const HIDDEN_GEV = [
  '#title-bar',
  '#style-indicator',
  '#top-center-actions',
  '#data-panel',
  '#control-panel',
  '#location-bar',
  '#cctv-panel',
  '#scene-panel',
  '#global-context-panel',
  '#pp-toggles',
  '#first-run-launcher',
  '#command-dock',
  '#param-slider-panel',
  '#world-overlay-actions',
  '#intel-hud',
  '#safe-frame-overlay',
  '#cockpit-hud',
  '#scope-mask',
  '#world-overlay-root',
];

export function applyInvestorChrome({ productName, tagline }) {
  document.body.classList.add('terrasignal-investor');
  document.title = `${productName} — ${tagline}`;
  const loading = document.querySelector('#loading-screen h2');
  if (loading) loading.innerHTML = 'TERRA<span class="title-accent">SIGNAL</span>';
  const status = document.querySelector('#loading-screen .loader-status');
  if (status && /Initializing|photorealistic/i.test(status.textContent || '')) {
    status.textContent = 'Opening one world…';
  }

  for (const selector of HIDDEN_GEV) {
    document.querySelector(selector)?.setAttribute('data-terrasignal-hidden', '1');
  }

  ensureInvestorShell(productName, tagline);
  initFirstHunt({
    root: document.getElementById('ts-first-hunt'),
  });
  if (readDemoMode().enabled) {
    const rail = document.getElementById('ts-demo-script');
    if (rail) {
      rail.hidden = false;
      rail.classList.add('visible');
    }
  }
}

function ensureInvestorShell(productName, tagline) {
  if (document.getElementById('terrasignal-shell')) return;

  const shell = document.createElement('div');
  shell.id = 'terrasignal-shell';
  shell.innerHTML = `
    <header id="terrasignal-brand" aria-label="${productName}">
      <div class="ts-brand-mark">TS</div>
      <div class="ts-brand-copy">
        <strong>${productName}</strong>
        <span>${tagline}</span>
      </div>
      <label class="ts-vision-toggle">
        <input type="checkbox" id="ts-opportunity-vision" checked />
        <span>Opportunity Vision</span>
      </label>
      <div id="ts-lod-chip" aria-live="polite">CITY</div>
      <button type="button" id="ts-demo-chip">DEMO</button>
    </header>
    <div id="ts-vignette" aria-hidden="true"></div>
    <p id="ts-ai-prompt" role="status" aria-live="polite">Where are we hunting today?</p>
    <aside id="ts-imagery-status" hidden role="status">Loading Earth imagery…</aside>
    <aside id="ts-basemap-toast" hidden role="status"></aside>
    <aside id="ts-first-hunt" hidden>
      <span class="ts-kicker">First hunt</span>
      <strong id="ts-first-hunt-title">Where are we hunting today?</strong>
      <p>One world. One AI. Mock signals only — not listings, not advice.</p>
      <div class="ts-hunt-choices">
        <button type="button" data-ts-begin-hunt>
          <strong>Atlanta / Decatur</strong>
          <small>Foreclosure, tax sale, and distress pulses</small>
        </button>
        <button type="button" class="ts-hunt-explore" data-ts-hunt-explore>
          <strong>Stay on the globe</strong>
          <small>Look around first. MIC still works.</small>
        </button>
      </div>
      <label class="ts-hunt-suppress">
        <input type="checkbox" data-ts-hunt-suppress />
        <span>Don't show this again</span>
      </label>
    </aside>
    <aside id="ts-demo-script" hidden>
      <span class="ts-kicker">5-minute demo</span>
      <strong data-ts-demo-step-title>1 · Hunt</strong>
      <p data-ts-demo-step-copy>Where are we hunting today? Choose Atlanta / Decatur to descend.</p>
      <code data-ts-demo-phrase hidden></code>
      <div class="ts-demo-actions">
        <button type="button" data-ts-demo-next>Atlanta / Decatur</button>
        <button type="button" data-ts-demo-auto>Play</button>
      </div>
      <ol data-ts-demo-list></ol>
      <p class="ts-demo-hint">Typed commands work with no mic and no API keys. Voice is optional.</p>
    </aside>
    <aside id="ts-focus-card" hidden></aside>
    <aside id="ts-saved-sheet" hidden></aside>
    <nav id="ts-bottom-nav" aria-label="TerraSignal">
      <button type="button" data-ts-nav="world" class="is-active">WORLD</button>
      <button type="button" data-ts-nav="drive">DRIVE</button>
      <div id="ts-ai-slot">
        <button type="button" data-ts-nav="ai" id="ts-ai-button" aria-label="Hold Space to speak, or click the microphone">MIC</button>
      </div>
      <button type="button" data-ts-nav="saved">SAVED</button>
    </nav>
    <form id="ts-demo-form" autocomplete="off">
      <label class="visually-hidden" for="ts-demo-input">Talk to TerraSignal</label>
      <input id="ts-demo-input" name="q" placeholder="Find me money" />
      <button type="submit">SEND</button>
    </form>
    <p id="ts-attribution">
      Built on <a href="https://github.com/bilawalsidhu/gods-eye-view" rel="noreferrer">God's Eye View</a>
      by Bilawal Sidhu · MIT · Mock data only · Not investment advice
    </p>
  `;
  document.body.appendChild(shell);
}

export function setAiPrompt(text) {
  const el = document.getElementById('ts-ai-prompt');
  if (el) el.textContent = text;
}

export function setLodChip(lodId) {
  const el = document.getElementById('ts-lod-chip');
  if (el) el.textContent = String(lodId || '').toUpperCase();
}

export function setNavActive(name) {
  for (const button of document.querySelectorAll('#ts-bottom-nav [data-ts-nav]')) {
    button.classList.toggle('is-active', button.getAttribute('data-ts-nav') === name);
  }
}

/**
 * Moving the GEV voice control into the investor bottom nav.
 *
 * This used to observe `document.body` with `{childList, subtree}` and, on
 * every callback, assign `label.textContent = 'MIC'` unconditionally.
 * Assigning textContent replaces the text node even when the string is
 * identical, and that replacement is itself a childList mutation inside the
 * observed subtree — so the observer re-triggered itself forever. Observer
 * callbacks are microtasks, so the checkpoint never drained: no
 * requestAnimationFrame, no Cesium render, no response to anything. The page
 * hard-locked with a black globe.
 *
 * Four independent defences now, because one is a single edit away from being
 * undone:
 *   1. the label write is conditional, so a settled label mutates nothing;
 *   2. `applying` guards re-entrancy, so the callback cannot react to its own
 *      writes even if something in here starts mutating again;
 *   3. observation is `childList` WITHOUT subtree, on the slot's parent chain
 *      and the voice control's container — a text node deep inside the control
 *      is not watched at all;
 *   4. the observer disconnects once the control is placed, and re-arms only
 *      if that node is removed again.
 */
let placementObserver = null;
let removalObserver = null;
let placedVoiceNode = null;
let applying = false;

function disconnectVoiceObservers() {
  placementObserver?.disconnect?.();
  placementObserver = null;
  removalObserver?.disconnect?.();
  removalObserver = null;
}

/** The slot's ancestors plus wherever the voice control currently lives. */
function voiceWatchTargets(slot) {
  const targets = new Set();
  for (let node = slot; node; node = node.parentElement) targets.add(node);
  const voice = document.getElementById('gev-voice-control');
  if (voice?.parentElement) targets.add(voice.parentElement);
  // gevRealtime appends the control to #command-dock or straight to body.
  const dock = document.getElementById('command-dock');
  if (dock) targets.add(dock);
  if (document.body) targets.add(document.body);
  return [...targets].filter(Boolean);
}

/**
 * @returns {boolean} true once the control is in the slot and the label reads
 *   MIC — i.e. there is nothing left for an observer to do.
 */
function placeVoiceInSlot(slot) {
  const voice = document.getElementById('gev-voice-control');
  if (!voice) return false;
  const fallback = document.getElementById('ts-ai-button');
  if (slot && voice.parentElement !== slot) {
    slot.appendChild(voice);
    voice.classList.add('ts-voice');
  }
  if (fallback && !fallback.hidden) fallback.hidden = true;
  const label = voice.querySelector('.gev-mic-label');
  // The conditional is load-bearing: an unconditional assignment replaces the
  // text node and re-triggers any observer watching this subtree.
  if (label && label.textContent !== 'MIC') label.textContent = 'MIC';
  return voice.parentElement === slot && (!label || label.textContent === 'MIC');
}

/** Watch only for this exact node leaving the slot, then start over. */
function armRemovalWatch(slot) {
  if (typeof MutationObserver === 'undefined' || !slot) return;
  removalObserver = new MutationObserver((records) => {
    if (applying) return;
    for (const record of records) {
      for (const node of record.removedNodes || []) {
        if (node !== placedVoiceNode) continue;
        disconnectVoiceObservers();
        placedVoiceNode = null;
        relocateVoiceControl();
        return;
      }
    }
  });
  removalObserver.observe(slot, { childList: true });
}

function settleVoiceControl(slot) {
  if (applying) return false;
  applying = true;
  try {
    const settled = placeVoiceInSlot(slot);
    if (settled) {
      placedVoiceNode = document.getElementById('gev-voice-control');
      disconnectVoiceObservers();
      armRemovalWatch(slot);
    }
    return settled;
  } finally {
    applying = false;
  }
}

export function relocateVoiceControl() {
  const slot = document.getElementById('ts-ai-slot');
  if (!slot) return;
  if (settleVoiceControl(slot)) return;
  // The control has not been built yet. Watch the few containers it can appear
  // in — childList only, no subtree — until it does.
  if (placementObserver || typeof MutationObserver === 'undefined') return;
  placementObserver = new MutationObserver(() => {
    if (applying) return;
    settleVoiceControl(slot);
  });
  for (const target of voiceWatchTargets(slot)) {
    placementObserver.observe(target, { childList: true });
  }
}

/** Test seam: module-level observer state would otherwise leak between cases. */
export function _resetVoiceRelocationForTest() {
  disconnectVoiceObservers();
  placedVoiceNode = null;
  applying = false;
}
