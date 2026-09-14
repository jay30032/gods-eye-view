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
 * In v2 the scene is a Street View panorama filling the frame, and two things
 * change with it. Progress becomes a **thin bar** rather than a kilometre
 * readout — over a photograph the number is a HUD element competing with the
 * street, and the only question it answers at a glance is "how far through are
 * we", which a bar answers without being read. And the property card **slides
 * in over the bottom third** rather than sitting in the corner: the bottom of a
 * panorama is road surface, which is the one part of the frame nothing is ever
 * lost behind.
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
const PROGRESS_ID = 'ts-drive-progress-bar';

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
/**
 * The active property card, over the bottom third.
 *
 * A transform and not a bottom offset, so the slide is composited rather than
 * re-laying-out the card on every frame of it over a panorama that is already
 * decoding tiles.
 */
body.ts-drive-mode #ts-focus-card {
  max-height: 30vh;
  overflow: hidden;
  left: 50%;
  right: auto;
  /* Clear of the drive bar at 96 px. The card is the content; pause and exit
     are the controls, and a card that covers its own controls is the bug this
     number exists to prevent. */
  bottom: 9.6rem;
  width: min(30rem, 92vw);
  transform: translate(-50%, 140%);
  transition: transform 320ms cubic-bezier(0.22, 1, 0.36, 1), opacity 220ms linear;
  opacity: 0;
}
body.ts-drive-mode #ts-focus-card:not([hidden]) {
  transform: translate(-50%, 0);
  opacity: 1;
}
@media (prefers-reduced-motion: reduce) {
  body.ts-drive-mode #ts-focus-card { transition: none; }
}

/**
 * Street View owns the frame while it is the driving view.
 *
 * The panorama is a fixed element at z-index 1 with its own opacity; this only
 * says that the Cesium canvas must not try to draw HUD of its own over it and
 * that the drive bar sits above both.
 */
body.ts-drive-mode.ts-drive-streetview #ts-lod-chip,
body.ts-drive-mode.ts-drive-streetview #ts-vignette {
  display: none !important;
}

/**
 * Two attributions, both required, neither on top of the other.
 *
 * The 3D scene's Cesium/Google credit sits bottom-left at 36 px, which is
 * exactly where the panorama renders Google's own logo. Both have to stay
 * visible — the tileset is still loaded and the imagery is still Google's — so
 * the Cesium credit moves up rather than away.
 */
body.ts-drive-mode.ts-drive-streetview #cesium-credits {
  bottom: 74px;
}

/* Pause and exit are never covered by anything. */
body.ts-drive-mode #ts-drive-bar { z-index: 43; }

/**
 * Route progress: one thin bar across the top of the frame.
 *
 * Full-bleed and 3 px. Anything thicker reads as chrome; anything inset reads
 * as a widget. A progress bar over a photograph works when it is the frame
 * edge rather than an object in the frame.
 */
#${PROGRESS_ID} {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  height: 3px;
  z-index: 45;
  background: rgba(255, 255, 255, 0.1);
  pointer-events: none;
}
#${PROGRESS_ID}[hidden] { display: none !important; }
#${PROGRESS_ID} > span {
  display: block;
  height: 100%;
  width: 0%;
  background: linear-gradient(90deg, rgba(237, 189, 56, 0.75), rgba(237, 189, 56, 1));
  transition: width 220ms linear;
}
@media (prefers-reduced-motion: reduce) {
  #${PROGRESS_ID} > span { transition: none; }
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
/* Over a panorama the bar carries the progress; the readout is redundant. */
body.ts-drive-streetview #ts-drive-bar .ts-drive-progress { display: none; }
#ts-drive-bar .ts-drive-view {
  opacity: 0.6;
  letter-spacing: 0.14em;
  font-size: 10px;
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
    <span class="ts-drive-view" data-ts-drive-view></span>
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

/** The thin route-progress bar across the top of the frame. Created once. */
export function ensureProgressBar(doc = globalThis.document) {
  if (!doc?.createElement) return null;
  ensureStyle();
  let bar = doc.getElementById(PROGRESS_ID);
  if (bar) return bar;
  bar = doc.createElement('div');
  bar.id = PROGRESS_ID;
  bar.hidden = true;
  bar.setAttribute('role', 'progressbar');
  bar.setAttribute('aria-label', 'Route progress');
  bar.innerHTML = '<span data-ts-drive-progress-fill></span>';
  doc.body.appendChild(bar);
  return bar;
}

/**
 * Update both progress readouts.
 *
 * Both, and not one or the other, because which is *shown* is a stylesheet
 * decision keyed off the driving view — the bar is always right and the text
 * is always right, and a fallback to the chase camera mid-route must not also
 * be a moment where the progress readout is stale.
 */
export function setDriveProgress(alongM, lengthM) {
  const along = Math.max(0, Number(alongM) || 0);
  const total = Math.max(0, Number(lengthM) || 0);
  const el = document.querySelector(`#${BAR_ID} [data-ts-drive-progress]`);
  if (el) el.textContent = `${(along / 1000).toFixed(1)} / ${(total / 1000).toFixed(1)} km`;
  const track = ensureProgressBar();
  if (!track) return;
  const fill = track.querySelector('[data-ts-drive-progress-fill]');
  const pct = total > 0 ? Math.min(100, (along / total) * 100) : 0;
  if (fill) fill.style.width = `${pct.toFixed(2)}%`;
  track.setAttribute('aria-valuenow', String(Math.round(pct)));
}

/** Show or hide the thin progress bar with the drive itself. */
export function setProgressBarVisible(visible) {
  const track = ensureProgressBar();
  if (track) track.hidden = !visible;
}

/**
 * Which view the drive is showing, on the body and in the bar.
 *
 * A class rather than inline styles for the same reason the rest of Drive
 * Mode's chrome is a class: it reverts exactly, and a drive that ended with the
 * panorama's stylesheet still applied would leave the focus card pinned to the
 * bottom third of a globe.
 */
export function setDriveViewChrome(view, detail = {}) {
  const root = globalThis.document?.body;
  if (!root) return null;
  const streetView = view === 'streetview' && !detail?.chase;
  root.classList.toggle('ts-drive-streetview', streetView);
  const label = document.querySelector(`#${BAR_ID} [data-ts-drive-view]`);
  if (label) {
    label.textContent = streetView ? 'STREET VIEW' : String(view || '3D').toUpperCase();
  }
  return streetView;
}

/**
 * The card shown before the drive starts.
 *
 * Dismisses itself: it exists to orient, not to be another thing to close. The
 * timeout is generous enough to read twice and short enough that it is gone
 * before the first call-out.
 */
export function renderDriveIntro(plan, {
  live = false, view = 'streetview', timers = globalThis, dwellMs = 4200,
} = {}) {
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
    ${!live && view === 'streetview' ? '<p class="ts-drive-live">STREET VIEW — imagery © Google</p>' : ''}
  `;
  timers.setTimeout?.(() => { card.hidden = true; }, dwellMs);
  return card;
}

export function hideDriveIntro() {
  const card = typeof document === 'undefined' ? null : document.getElementById(INTRO_ID);
  if (card) card.hidden = true;
}
