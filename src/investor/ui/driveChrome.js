/**
 * Drive Mode's chrome: the intro card, the drive bar, and hiding everything else.
 *
 * A drive is a single continuous shot. The standing HUD is a set of controls
 * for a camera the user is not currently flying — the vision toggle, the LOD
 * chip, the demo rail, the bottom nav, the typed bar's placeholder chatter —
 * and leaving it up turns the one moment the product looks like a product into
 * a screenshot of a control panel.
 *
 * So while driving the screen carries the scene, a subtle route line, the
 * active property card, the mic, pause and exit. Nothing else.
 *
 * The hiding is one class on `<body>` and a stylesheet injected once, rather
 * than a pile of `element.hidden` writes: a class can be reverted exactly, and
 * a drive that ends leaving two controls hidden is a bug nobody notices until
 * the next session.
 */
import { escapeHtml } from './escapeHtml.js';

const STYLE_ID = 'ts-drive-style';
const BAR_ID = 'ts-drive-bar';
const INTRO_ID = 'ts-drive-intro';

const SIGNAL_LABELS = Object.freeze({
  FORECLOSURE: 'notice of sale',
  PREFORECLOSURE: 'mortgage delinquency',
  TAX_SALE: 'tax sale',
  DISTRESS: 'code enforcement',
  LISTED_OPPORTUNITY: 'listed under comps',
});

/** `?drive=live` starts on GPS instead of playback. */
export function readDriveLive(location = globalThis.location) {
  try {
    const value = String(new URLSearchParams(location?.search || '').get('drive') || '')
      .trim()
      .toLowerCase();
    return value === 'live' || value === 'gps';
  } catch {
    return false;
  }
}

const CSS = `
/* Drive Mode: the scene, the route, the card, the mic, pause and exit. */
body.ts-drive-mode #ts-demo-script,
body.ts-drive-mode #ts-saved-sheet,
body.ts-drive-mode #ts-opportunity-vision,
body.ts-drive-mode label[for="ts-opportunity-vision"],
body.ts-drive-mode #ts-lod-chip,
body.ts-drive-mode #ts-attribution,
body.ts-drive-mode #ts-brand-tagline,
body.ts-drive-mode #ts-demo-chip,
body.ts-drive-mode #ts-street-chip {
  display: none !important;
}
/* The nav collapses to the mic; WORLD/DRIVE/SAVED are not drive controls. */
body.ts-drive-mode #ts-bottom-nav > button[data-ts-nav="world"],
body.ts-drive-mode #ts-bottom-nav > button[data-ts-nav="drive"],
body.ts-drive-mode #ts-bottom-nav > button[data-ts-nav="saved"] {
  display: none !important;
}
body.ts-drive-mode #ts-focus-card {
  max-height: 38vh;
  overflow: hidden;
}

#ts-drive-bar {
  position: fixed;
  left: 50%;
  transform: translateX(-50%);
  bottom: 96px;
  z-index: 40;
  display: flex;
  gap: 8px;
  align-items: center;
  padding: 6px 8px;
  border-radius: 999px;
  background: rgba(12, 14, 18, 0.72);
  backdrop-filter: blur(8px);
  border: 1px solid rgba(255, 255, 255, 0.12);
  font: 12px/1 Inter, system-ui, sans-serif;
  color: #f4f4f5;
}
#ts-drive-bar[hidden] { display: none !important; }
#ts-drive-bar button {
  appearance: none;
  border: 0;
  border-radius: 999px;
  padding: 7px 14px;
  background: rgba(255, 255, 255, 0.08);
  color: inherit;
  font: inherit;
  letter-spacing: 0.06em;
  cursor: pointer;
}
#ts-drive-bar button:hover { background: rgba(255, 255, 255, 0.16); }
#ts-drive-bar .ts-drive-progress {
  min-width: 84px;
  opacity: 0.72;
  letter-spacing: 0.04em;
  padding: 0 6px;
}
#ts-drive-bar[data-mode="property"] [data-ts-drive="pause"] { display: none; }
#ts-drive-bar:not([data-mode="property"]) [data-ts-drive="resume"] { display: none; }

#ts-drive-intro {
  position: fixed;
  left: 50%;
  top: 22%;
  transform: translateX(-50%);
  z-index: 60;
  width: min(340px, 82vw);
  padding: 16px 18px;
  border-radius: 14px;
  background: rgba(12, 14, 18, 0.9);
  backdrop-filter: blur(10px);
  border: 1px solid rgba(255, 255, 255, 0.14);
  color: #f4f4f5;
  font: 13px/1.5 Inter, system-ui, sans-serif;
  box-shadow: 0 20px 60px rgba(0, 0, 0, 0.45);
}
#ts-drive-intro[hidden] { display: none !important; }
#ts-drive-intro .ts-kicker {
  display: block;
  font-size: 10px;
  letter-spacing: 0.18em;
  opacity: 0.6;
  margin-bottom: 6px;
}
#ts-drive-intro strong { display: block; font-size: 17px; margin-bottom: 6px; }
#ts-drive-intro dl { display: flex; gap: 18px; margin: 10px 0 0; }
#ts-drive-intro dt { font-size: 10px; letter-spacing: 0.12em; opacity: 0.55; }
#ts-drive-intro dd { margin: 2px 0 0; font-size: 15px; }
#ts-drive-intro .ts-drive-types { margin-top: 10px; opacity: 0.78; font-size: 12px; }
#ts-drive-intro .ts-drive-live {
  margin-top: 10px;
  font-size: 11px;
  letter-spacing: 0.1em;
  color: #ffd479;
}
`;

function ensureStyle() {
  if (typeof document === 'undefined') return;
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = CSS;
  document.head.appendChild(style);
}

/** The pause / resume / exit bar. Created once, then shown and hidden. */
export function ensureDriveBar(handlers = {}) {
  if (typeof document === 'undefined') return null;
  ensureStyle();
  let bar = document.getElementById(BAR_ID);
  if (bar) return bar;

  bar = document.createElement('div');
  bar.id = BAR_ID;
  bar.hidden = true;
  bar.dataset.mode = 'drive';
  bar.innerHTML = `
    <button type="button" data-ts-drive="pause">PAUSE</button>
    <button type="button" data-ts-drive="resume">RESUME DRIVE</button>
    <span class="ts-drive-progress" data-ts-drive-progress>0.0 / 0.0 km</span>
    <button type="button" data-ts-drive="exit">EXIT</button>
  `;
  bar.addEventListener('click', (event) => {
    const action = event.target?.dataset?.tsDrive;
    if (!action) return;
    handlers[action]?.();
  });
  document.body.appendChild(bar);
  return bar;
}

/** Update the bar's progress readout. */
export function setDriveProgress(alongM, lengthM) {
  const el = document.querySelector(`#${BAR_ID} [data-ts-drive-progress]`);
  if (!el) return;
  const along = Math.max(0, Number(alongM) || 0) / 1000;
  const total = Math.max(0, Number(lengthM) || 0) / 1000;
  el.textContent = `${along.toFixed(1)} / ${total.toFixed(1)} km`;
}

/**
 * The card shown before the drive starts.
 *
 * Dismisses itself: it exists to orient, not to be another thing to close. The
 * timeout is generous enough to read twice and short enough that it is gone
 * before the first call-out.
 */
export function renderDriveIntro(plan, { live = false, timers = globalThis, dwellMs = 4200 } = {}) {
  if (typeof document === 'undefined' || !plan) return null;
  ensureStyle();
  let card = document.getElementById(INTRO_ID);
  if (!card) {
    card = document.createElement('div');
    card.id = INTRO_ID;
    document.body.appendChild(card);
  }
  const types = (plan.signalTypes || [])
    .map((type) => SIGNAL_LABELS[type] || String(type).replaceAll('_', ' ').toLowerCase());
  const where = [plan.area, plan.city].filter(Boolean).join(', ');

  card.hidden = false;
  card.innerHTML = `
    <span class="ts-kicker">DRIVE MODE</span>
    <strong>${escapeHtml(where || 'This neighborhood')}</strong>
    <dl>
      <div><dt>ROUTE</dt><dd>${(Number(plan.lengthM) / 1000).toFixed(1)} km</dd></div>
      <div><dt>FLAGGED</dt><dd>${Number(plan.properties) || 0}</dd></div>
    </dl>
    <p class="ts-drive-types">${escapeHtml(types.join(' · ') || 'no signals on this route')}</p>
    ${live ? '<p class="ts-drive-live">LIVE — following your position</p>' : ''}
  `;
  timers.setTimeout?.(() => { card.hidden = true; }, dwellMs);
  return card;
}

export function hideDriveIntro() {
  const card = typeof document === 'undefined' ? null : document.getElementById(INTRO_ID);
  if (card) card.hidden = true;
}
