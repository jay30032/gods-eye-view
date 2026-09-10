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
    </header>
    <p id="ts-ai-prompt" role="status" aria-live="polite">Where are we hunting today?</p>
    <aside id="ts-first-hunt" hidden>
      <span class="ts-kicker">TerraSignal · Hunt</span>
      <strong>Where are we hunting today?</strong>
      <p>One market. Mock signals only. Talk or type — the globe does the rest.</p>
      <button type="button" data-ts-begin-hunt>Begin Atlanta / Decatur</button>
    </aside>
    <aside id="ts-focus-card" hidden></aside>
    <aside id="ts-saved-sheet" hidden></aside>
    <nav id="ts-bottom-nav" aria-label="TerraSignal">
      <button type="button" data-ts-nav="world" class="is-active">WORLD</button>
      <button type="button" data-ts-nav="drive">DRIVE</button>
      <div id="ts-ai-slot">
        <button type="button" data-ts-nav="ai" id="ts-ai-button" aria-label="AI microphone">MIC</button>
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

export function relocateVoiceControl() {
  const slot = document.getElementById('ts-ai-slot');
  const voice = document.getElementById('gev-voice-control');
  if (slot && voice && voice.parentElement !== slot) {
    slot.appendChild(voice);
    voice.classList.add('ts-voice');
  }
}
