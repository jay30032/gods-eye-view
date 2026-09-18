import { readDemoMode } from '../demoSequence.js';
import { initFirstHunt } from './firstHunt.js';
import { SIGNAL_LABELS, SIGNAL_TYPES } from '../mock/schema.js';
import { SIGNAL_LOOK } from '../visuals/propertyPulse.js';
import { escapeHtml } from './escapeHtml.js';

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

/**
 * Product mode vs demo mode.
 *
 * The product shows the map, the orb and one line of status, and nothing
 * else until asked. `?demo=1` adds the scripted rail and the WORLD / DRIVE /
 * SAVED buttons a reviewer with a mouse wants — those are demo furniture, not
 * the product.
 */
export function applyInvestorChrome({ productName, tagline }) {
  document.body.classList.add('terrasignal-investor');
  const demo = readDemoMode().enabled;
  document.body.classList.toggle('ts-demo', demo);
  document.body.classList.toggle('ts-product', !demo);
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
  bindTypedBar();
  if (demo) {
    const rail = document.getElementById('ts-demo-script');
    if (rail) {
      rail.hidden = false;
      rail.classList.add('visible');
    }
    const chip = document.getElementById('ts-demo-chip');
    if (chip) chip.hidden = false;
  }
}

/** The five signals, as a legend the brand mark reveals on hover. */
function legendMarkup() {
  return SIGNAL_TYPES.map((type) => {
    const [r, g, b] = (SIGNAL_LOOK[type] || SIGNAL_LOOK.DISTRESS).color;
    const rgb = `${Math.round(r * 255)}, ${Math.round(g * 255)}, ${Math.round(b * 255)}`;
    return `<li><i style="--c: rgb(${rgb})"></i>${escapeHtml(SIGNAL_LABELS[type] || type)}</li>`;
  }).join('');
}

/**
 * The typed bar is not furniture: it appears on "/" or a tap on the status
 * strip, and goes away on Escape or when it is empty and loses focus. The
 * form is always in the DOM — a hidden form still submits, which is how the
 * headed checks talk to the product — it is only *shown* on request.
 */
export function openTypedBar({ focus = true } = {}) {
  document.body.classList.add('ts-typing');
  const input = document.getElementById('ts-demo-input');
  if (focus) {
    try { input?.focus?.({ preventScroll: true }); } catch { input?.focus?.(); }
  }
  document.getElementById('ts-type-button')?.setAttribute('aria-pressed', 'true');
  return true;
}

export function closeTypedBar() {
  document.body.classList.remove('ts-typing');
  const input = document.getElementById('ts-demo-input');
  try { input?.blur?.(); } catch { /* fine */ }
  document.getElementById('ts-type-button')?.setAttribute('aria-pressed', 'false');
  return false;
}

/** The Type button: open with focus, or close if already open. */
export function toggleTypedBar() {
  return isTypedBarOpen() ? closeTypedBar() : openTypedBar({ focus: true });
}

/** The Quiet toggle inside the typed bar, kept in step with the assistant. */
export function setQuietToggle(on) {
  const box = document.getElementById('ts-quiet-toggle');
  if (box && box.checked !== Boolean(on)) box.checked = Boolean(on);
  const slot = document.getElementById('ts-ai-slot');
  if (slot) {
    if (on) slot.dataset.tsQuiet = '1';
    else delete slot.dataset.tsQuiet;
  }
}

export function isTypedBarOpen() {
  return Boolean(document.body?.classList.contains('ts-typing'));
}

let typedBarBound = false;
function bindTypedBar() {
  if (typedBarBound || typeof document === 'undefined') return;
  typedBarBound = true;
  document.getElementById('ts-ai-prompt')?.addEventListener('click', () => {
    if (isTypedBarOpen()) closeTypedBar();
    else openTypedBar();
  });
  document.getElementById('ts-ai-prompt')?.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      openTypedBar();
    }
  });
  const input = document.getElementById('ts-demo-input');
  input?.addEventListener('blur', (event) => {
    // Empty and abandoned: fold away. Half-typed stays, so a stray click on the
    // map does not lose the sentence. Moving to the Quiet toggle or the Type
    // button is not abandoning it.
    const next = event.relatedTarget;
    if (next && (next.closest?.('#ts-demo-form') || next.id === 'ts-type-button')) return;
    if (!String(input.value || '').trim() && !document.body.classList.contains('ts-demo')) {
      closeTypedBar();
    }
  });
  /**
   * The Type button. A tap opens the bar with focus in it; a second tap
   * closes it. On a phone a long press shows the "Type" label the way hover
   * does on a desktop.
   */
  const typeButton = document.getElementById('ts-type-button');
  typeButton?.addEventListener('click', (event) => {
    event.preventDefault();
    toggleTypedBar();
  });
  let pressTimer = null;
  typeButton?.addEventListener('pointerdown', () => {
    globalThis.clearTimeout(pressTimer);
    pressTimer = globalThis.setTimeout(() => typeButton.classList.add('is-pressed'), 350);
  });
  for (const type of ['pointerup', 'pointercancel', 'pointerleave']) {
    typeButton?.addEventListener(type, () => {
      globalThis.clearTimeout(pressTimer);
      globalThis.setTimeout(() => typeButton.classList.remove('is-pressed'), 900);
    });
  }
  typeButton?.addEventListener('contextmenu', (event) => event.preventDefault());
  document.addEventListener('keydown', (event) => {
    if (event.defaultPrevented) return;
    const target = event.target;
    const typing = target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable);
    if (event.key === 'Escape' && isTypedBarOpen()) {
      closeTypedBar();
      return;
    }
    if (event.key === '/' && !typing && !event.metaKey && !event.ctrlKey && !event.altKey) {
      event.preventDefault();
      openTypedBar();
    }
  });
}

function ensureInvestorShell(productName, tagline) {
  if (document.getElementById('terrasignal-shell')) return;

  const shell = document.createElement('div');
  shell.id = 'terrasignal-shell';
  shell.innerHTML = `
    <header id="terrasignal-brand" aria-label="${productName}">
      <button type="button" class="ts-brand-mark" aria-label="${productName} — legend" aria-haspopup="true">TS</button>
      <div class="ts-brand-flyout" role="group" aria-label="Legend">
        <div class="ts-brand-copy">
          <strong>${productName}</strong>
          <span id="ts-brand-tagline">${tagline}</span>
        </div>
        <ul class="ts-legend" aria-label="Signals">${legendMarkup()}</ul>
        <label class="ts-vision-toggle">
          <input type="checkbox" id="ts-opportunity-vision" checked />
          <span>Opportunity Vision</span>
        </label>
        <div class="ts-brand-chips">
          <div id="ts-lod-chip" aria-live="polite">CITY</div>
          <span id="ts-sound-chip" data-on="1">SOUND ON</span>
          <button type="button" id="ts-demo-chip" hidden>DEMO</button>
        </div>
        <p class="ts-brand-help">Press / to type · "sound off" · "voice on"</p>
        <p id="ts-attribution">
          Built on <a href="https://github.com/bilawalsidhu/gods-eye-view" rel="noreferrer">God's Eye View</a>
          by Bilawal Sidhu · MIT · Mock data only · Not investment advice
        </p>
      </div>
    </header>
    <div id="ts-vignette" aria-hidden="true"></div>
    <svg id="ts-leader" aria-hidden="true" hidden><line x1="0" y1="0" x2="0" y2="0" /><circle cx="0" cy="0" r="3" /></svg>
    <p id="ts-ai-prompt" role="status" aria-live="polite" tabindex="0" title="Tap to type, or press /">Where are we hunting today?</p>
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
      <button type="button" data-ts-nav="type" id="ts-type-button" aria-label="Type" aria-pressed="false" title="Type">
        <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><rect x="2.5" y="6.5" width="19" height="11" rx="2" /><path d="M6 10h1M9.5 10h1M13 10h1M16.5 10h1M6 13.5h1M9.5 13.5h5M16.5 13.5h1" /></svg>
        <span class="ts-type-label">Type</span>
      </button>
      <button type="button" data-ts-nav="saved">SAVED</button>
    </nav>
    <form id="ts-demo-form" autocomplete="off">
      <label class="visually-hidden" for="ts-demo-input">Talk to TerraSignal</label>
      <input id="ts-demo-input" name="q" placeholder="Find me money" />
      <label class="ts-quiet-toggle" title="Quiet mode — replies in text, no audio">
        <input type="checkbox" id="ts-quiet-toggle" />
        <span>Quiet</span>
      </label>
      <button type="submit">SEND</button>
    </form>
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

/** The legend's sound line, kept in step with the engine. */
export function setSoundChip(enabled) {
  const el = document.getElementById('ts-sound-chip');
  if (!el) return;
  el.textContent = enabled ? 'SOUND ON' : 'SOUND OFF';
  el.dataset.on = enabled ? '1' : '0';
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
      // The orb watches the control's status once it is in the slot.
      try {
        globalThis.dispatchEvent?.(new CustomEvent('terrasignal:voice-placed', { detail: { node: placedVoiceNode } }));
      } catch { /* no CustomEvent in a test harness */ }
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
