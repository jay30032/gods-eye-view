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

let voiceObserver = null;

function placeVoiceInSlot(slot) {
  const voice = document.getElementById('gev-voice-control');
  const fallback = document.getElementById('ts-ai-button');
  if (slot && voice && voice.parentElement !== slot) {
    slot.appendChild(voice);
    voice.classList.add('ts-voice');
  }
  if (voice && fallback) fallback.hidden = true;
  const label = voice?.querySelector('.gev-mic-label');
  if (label) label.textContent = 'MIC';
  return Boolean(voice);
}

export function relocateVoiceControl() {
  const slot = document.getElementById('ts-ai-slot');
  if (!slot) return;
  placeVoiceInSlot(slot);
  if (voiceObserver || typeof MutationObserver === 'undefined') return;
  voiceObserver = new MutationObserver(() => placeVoiceInSlot(slot));
  voiceObserver.observe(document.body, { childList: true, subtree: true });
}
