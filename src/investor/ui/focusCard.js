/**
 * The property card.
 *
 * Anchored to its house rather than parked in a corner: `positionFocusCard`
 * is called with the marker's screen point and puts the card beside it,
 * clamped inside the viewport (a bottom sheet on a phone). It enters on a
 * spring from the house's direction with a leader line back to the marker
 * for the first 600 ms, its score ring sweeps in, and its dollar figures
 * count up. When a moment asks for it, the card *assembles*: every section
 * starts hidden and `revealFocusLine(k)` brings them in one at a time, in
 * step with the spoken explanation.
 *
 * Numbers about the card's motion live in `motion.js` and `cardAnchor.js`.
 */
import { focusCardModel, formatPct, formatUsd, verdictLabel } from '../focus.js';
import { countdownWords, formatSaleDate, NOTICE_WEEKS } from '../georgia.js';
import { prefersReducedMotion } from '../visuals/reducedMotionPolicy.js';
import { escapeHtml } from './escapeHtml.js';
import { anchorCard, leaderLine } from './cardAnchor.js';
import { LEADER_MS, countUp, springIn, springOut } from './motion.js';

const STRATEGY_LABELS = Object.freeze({
  flip: 'FLIP',
  rental: 'RENT',
  brrrr: 'BRRRR',
  wholesale: 'WHOLESALE',
});

/** Everything the card remembers between renders. */
const state = {
  id: null,
  lines: 0,
  revealed: new Set(),
  assembling: false,
  /** Page-clock stamp until which the leader line is drawn. */
  leaderUntil: 0,
  /** Last shown value per figure, so a re-run counts from where it was. */
  lastValues: new Map(),
  counters: [],
  lastPosition: null,
  anchor: null,
  leaving: null,
};

function now() {
  return globalThis.performance?.now?.() ?? Date.now();
}

function reduced() {
  return prefersReducedMotion();
}

function root() {
  return globalThis.document?.getElementById?.('ts-focus-card') || null;
}

function inDriveMode() {
  return Boolean(globalThis.document?.body?.classList?.contains('ts-drive-mode'));
}

/** A figure that counts up: the text now, the number and its format for later. */
function figure(value, fmt, key) {
  const n = Number(value);
  const text = fmt === 'pct' ? formatPct(n) : fmt === 'plain' ? String(value) : formatUsd(n);
  if (!Number.isFinite(n) || fmt === 'plain') return escapeHtml(text);
  return `<span data-ts-count="${n}" data-ts-fmt="${fmt}" data-ts-key="${escapeHtml(key)}">${escapeHtml(text)}</span>`;
}

function formatFor(fmt) {
  if (fmt === 'pct') return (v) => formatPct(v);
  if (fmt === 'usd') return (v) => formatUsd(v);
  if (fmt === 'int') return (v) => String(Math.round(v));
  if (fmt === 'dscr') return (v) => Number(v).toFixed(2);
  return (v) => String(v);
}

/**
 * @param {object|null} property
 * @param {{analysis?:object, strategy?:string, revealDeal?:boolean,
 *   customNumbers?:boolean, compare?:Array, driveCallout?:string,
 *   compact?:boolean, assemble?:boolean, anchor?:{x:number,y:number}|null}} options
 * @returns {{lines:number}|null}
 */
export function renderFocusCard(property, options = {}) {
  const el = root();
  if (!el) return null;
  if (!property) {
    hideFocusCard();
    return null;
  }
  const model = focusCardModel(property, options);
  const fresh = el.hidden || state.id !== property.id || state.leaving;
  if (state.leaving) {
    try { state.leaving.cancel?.(); } catch { /* already done */ }
    state.leaving = null;
    try { for (const animation of el.getAnimations?.() || []) animation.cancel(); } catch { /* fine */ }
  }
  for (const counter of state.counters.splice(0)) counter.cancel();
  if (state.id !== property.id) state.lastValues.clear();
  state.id = property.id;
  state.assembling = Boolean(options.assemble) && !reduced();
  state.revealed = new Set();

  const sections = [];
  const line = (html) => { if (html) sections.push(html); };

  line(`
    <header>
      <div class="ts-focus-head">
        <div class="ts-focus-titles">
          <span class="ts-kicker ts-kicker-mock">MOCK</span>
          <span class="ts-kicker">${escapeHtml(model.signalLabel)} · ${model.signalConfidence}%</span>
          <strong>${escapeHtml(model.address)}</strong>
          <span>${escapeHtml(model.neighborhood || '')} · ${escapeHtml(String(model.propertyType).toUpperCase())}</span>
          ${renderSourceLine(model)}
        </div>
        ${renderScoreRing(model.score)}
      </div>
      ${options.driveCallout ? `<p class="ts-drive-callout">${escapeHtml(options.driveCallout)}</p>` : ''}
    </header>`);
  line(renderAuctionTimeline(model));
  line(renderCustomNumbers(options));
  line(renderDrivers(model));
  line(renderStrategyStrip(model));
  line(`<p class="ts-why">${escapeHtml(model.why)}</p>`);
  line(`
    <dl class="ts-focus-glance">
      <div><dt>Score</dt><dd>${figure(model.score, 'int', 'score')}</dd></div>
      <div><dt>Path</dt><dd>${escapeHtml(String(model.strategy).toUpperCase())}</dd></div>
      ${options.revealDeal ? `
      <div><dt>Value</dt><dd>${figure(property.estimatedValue, 'usd', 'value')}</dd></div>
      <div><dt>Equity</dt><dd>${figure(property.estimatedEquityPct, 'pct', 'equity')}</dd></div>
      ` : ''}
    </dl>`);
  line(renderCompare(options));
  line(options.revealDeal ? renderAnalysis(model) : '');
  line(`
    <footer>
      <button type="button" data-ts-focus-action="save">Save</button>
      <button type="button" data-ts-focus-action="deal">Show deal</button>
    </footer>`);

  state.lines = sections.length;
  el.innerHTML = sections
    .map((html, index) => `<div class="ts-line${state.assembling ? ' is-pending' : ' is-in'}" data-ts-line="${index}">${html}</div>`)
    .join('');
  el.classList.toggle('is-compact', Boolean(options.compact));
  el.classList.toggle('is-fresh', Boolean(fresh));
  el.hidden = false;
  el.dataset.property = property.id;

  if (options.anchor !== undefined) state.anchor = options.anchor;
  positionFocusCard(state.anchor, { force: true });

  if (fresh) {
    state.leaderUntil = now() + LEADER_MS;
    if (!inDriveMode()) {
      const from = state.lastPosition?.from || { dx: 0, dy: 24 };
      springIn(el, { dx: from.dx, dy: from.dy, reduced: reduced() });
    }
  }
  if (!state.assembling) {
    for (let k = 0; k < state.lines; k += 1) state.revealed.add(k);
    runCounters(el, { fresh });
  } else {
    // The header is the one line that never waits.
    revealFocusLine(0);
  }
  return { lines: state.lines };
}

/** Bring one assembled section in. Safe to call twice, or out of order. */
export function revealFocusLine(index) {
  const el = root();
  if (!el || el.hidden) return false;
  const k = Number(index);
  if (!Number.isFinite(k) || state.revealed.has(k)) return false;
  const line = el.querySelector(`[data-ts-line="${k}"]`);
  if (!line) return false;
  state.revealed.add(k);
  line.classList.remove('is-pending');
  line.classList.add('is-in');
  runCounters(line, { fresh: true });
  return true;
}

/** Every section, now — the end of the explanation, or a cancelled one. */
export function revealAllFocusLines() {
  for (let k = 0; k < state.lines; k += 1) revealFocusLine(k);
  return state.lines;
}

/**
 * Put the card beside its house.
 *
 * @param {{x:number,y:number}|null|undefined} point the marker on screen;
 *   `undefined` keeps the last anchor, `null` parks the card
 */
export function positionFocusCard(point, { force = false } = {}) {
  const el = root();
  if (!el || el.hidden) return null;
  if (point !== undefined) state.anchor = point;
  if (inDriveMode() && !force) {
    // Drive Mode owns the card's place: the bottom third, by stylesheet.
    if (el.style.left) { el.style.left = ''; el.style.top = ''; }
    el.classList.remove('is-sheet', 'is-anchored');
    hideLeader();
    return null;
  }
  const viewport = { w: globalThis.innerWidth || 0, h: globalThis.innerHeight || 0 };
  const card = { w: el.offsetWidth || 0, h: el.offsetHeight || 0 };
  const placed = anchorCard({ marker: state.anchor, viewport, card });
  state.lastPosition = placed;
  if (placed.mode === 'sheet') {
    el.classList.add('is-sheet');
    el.classList.remove('is-anchored');
    el.style.left = '';
    el.style.top = '';
    el.dataset.side = 'sheet';
    hideLeader();
    return placed;
  }
  el.classList.add('is-anchored');
  el.classList.remove('is-sheet');
  if (inDriveMode()) {
    hideLeader();
    return placed;
  }
  const left = `${placed.left}px`;
  const top = `${placed.top}px`;
  if (el.style.left !== left) el.style.left = left;
  if (el.style.top !== top) el.style.top = top;
  el.dataset.side = placed.side;
  drawLeader(placed, card);
  return placed;
}

function drawLeader(placed, card) {
  const svg = globalThis.document?.getElementById?.('ts-leader');
  if (!svg) return;
  const marker = state.anchor;
  const active = marker && Number.isFinite(marker.x) && now() < state.leaderUntil && placed.side !== 'parked' && !reduced();
  if (!active) { hideLeader(); return; }
  const line = leaderLine(marker, { left: placed.left, top: placed.top, w: card.w, h: card.h });
  const path = svg.querySelector('line');
  const dot = svg.querySelector('circle');
  if (path) {
    path.setAttribute('x1', line.x1.toFixed(1));
    path.setAttribute('y1', line.y1.toFixed(1));
    path.setAttribute('x2', line.x2.toFixed(1));
    path.setAttribute('y2', line.y2.toFixed(1));
  }
  if (dot) {
    dot.setAttribute('cx', line.x1.toFixed(1));
    dot.setAttribute('cy', line.y1.toFixed(1));
  }
  const remaining = Math.max(0, state.leaderUntil - now()) / LEADER_MS;
  svg.style.opacity = String(Math.min(1, remaining * 3).toFixed(2));
  if (svg.hidden) svg.hidden = false;
}

function hideLeader() {
  const svg = globalThis.document?.getElementById?.('ts-leader');
  if (svg && !svg.hidden) svg.hidden = true;
}

/** Count every figure inside `scope` up to its value. */
function runCounters(scope, { fresh }) {
  const still = reduced();
  for (const node of scope.querySelectorAll('[data-ts-count]')) {
    const to = Number(node.dataset.tsCount);
    if (!Number.isFinite(to)) continue;
    const key = node.dataset.tsKey || '';
    const format = formatFor(node.dataset.tsFmt);
    const previous = state.lastValues.get(key);
    const from = Number.isFinite(previous) ? previous : (fresh ? 0 : to);
    state.lastValues.set(key, to);
    if (from === to) { node.textContent = format(to); continue; }
    state.counters.push(countUp(node, { from, to, format, reduced: still }));
  }
}

/** The composite score as a ring that sweeps in. */
function renderScoreRing(score) {
  const value = Math.max(0, Math.min(100, Number(score) || 0));
  return `
    <span class="ts-score-ring" style="--p: ${(value / 100).toFixed(3)}" title="Composite score ${value}">
      <svg viewBox="0 0 36 36" aria-hidden="true">
        <circle class="ts-ring-track" cx="18" cy="18" r="15.5" pathLength="100" />
        <circle class="ts-ring-fill" cx="18" cy="18" r="15.5" pathLength="100" />
      </svg>
      <b>${figure(value, 'int', 'score-ring')}</b>
    </span>`;
}

/**
 * A running what-if changes this card and the globe caption, but never the
 * score or the ranking — those stay on listed numbers so the board keeps
 * meaning the same thing. The chip says so and offers the way back.
 */
function renderCustomNumbers(options) {
  if (!options.customNumbers) return '';
  return '<p class="ts-custom-numbers" '
    + 'title="Score and ranking still use the listed numbers — only this deal is re-run.">'
    + '<span>Custom numbers</span>'
    + '<button type="button" data-ts-focus-action="reset">Reset</button></p>';
}

/** All four paths, verdict and headline, when the user asked to compare. */
function renderCompare(options) {
  const rows = Array.isArray(options.compare) ? options.compare : null;
  if (!rows || !rows.length) return '';
  const cells = rows.map((row) => `<li class="ts-verdict-${escapeHtml(row.verdict)}">`
    + `<span class="ts-deal-label">${escapeHtml(STRATEGY_LABELS[row.strategy] || row.strategy)}</span>`
    + `<span class="ts-compare-verdict">${escapeHtml(row.verdict)}</span>`
    + `<span class="ts-deal-value">${escapeHtml(row.headline || '—')}</span></li>`).join('');
  return `<ul class="ts-compare">${cells}</ul>`;
}

/** Who published it and where — a Georgia notice is only real in a legal organ. */
function renderSourceLine(model) {
  const county = model.auction?.county;
  const organ = model.auction?.legalOrgan;
  const where = county && organ ? `${county} County · ${organ}` : model.signalSource;
  return `<span class="ts-source">${escapeHtml(where)}</span>`;
}

/**
 * The whole Georgia clock in one line: when it was published, the four weekly
 * runs that have to clear, and the first Tuesday it can actually sell.
 */
function renderAuctionTimeline(model) {
  const auction = model.auction;
  if (!auction) return '';
  const sale = formatSaleDate(auction.date);
  if (!model.signalDate || !sale) return '';
  const days = Number.isFinite(auction.daysUntil) ? auction.daysUntil : null;
  const urgent = days != null && days >= 0 && days <= 14 ? ' is-urgent' : '';
  const countdown = days == null ? '' : ` (${days >= 0 ? `${days}d` : countdownWords(days)})`;
  return `<p class="ts-auction${urgent}">`
    + `Notice ${escapeHtml(model.signalDate)} → ${NOTICE_WEEKS}-week ad run → `
    + `Auction ${escapeHtml(sale)}${escapeHtml(countdown)}</p>`;
}

/** One line of why the score is what it is, straight from the scorer. */
function renderDrivers(model) {
  if (!model.drivers.length) return '';
  return `<p class="ts-drivers">${model.drivers.map(escapeHtml).join(' · ')}</p>`;
}

/** All four paths at a glance, so the best one is a comparison and not a claim. */
function renderStrategyStrip(model) {
  const cells = Object.entries(STRATEGY_LABELS).map(([key, label]) => {
    const score = Number(model.scores?.[key]) || 0;
    const best = key === model.bestStrategy ? ' is-best' : '';
    return `<span class="ts-strategy${best}">${label} ${score}</span>`;
  });
  return `<p class="ts-strategy-strip">${cells.join(' · ')}</p>`;
}

function line(label, value) {
  return `<li><span class="ts-deal-label">${label}</span><span class="ts-deal-value">${value}</span></li>`;
}

function verdictLine(verdict, note) {
  const text = note || verdictLabel(verdict);
  return `<li class="ts-verdict-line"><span class="ts-deal-label">Verdict</span>`
    + `<span class="ts-deal-value">${text}</span></li>`;
}

function list(verdict, items) {
  return `<ul class="ts-deal ts-verdict-${verdict}">${items.join('')}</ul>`;
}

function renderAnalysis(model) {
  const a = model.analysis;
  if (!a) return '';
  const usd = (value, key) => figure(value, 'usd', key);
  const pct = (value, key) => figure(value, 'pct', key);

  if (a.strategy === 'flip') {
    return list(a.verdict, [
      line('Profit', usd(a.profit, 'profit')),
      line('Cash needed', usd(a.cashIn, 'cashIn')),
      line('Cash-on-cash', `${pct(a.roi, 'roi')} (${pct(a.roiAnnualized, 'roiAnnualized')} annualized)`),
      line('Margin', pct(a.margin, 'margin')),
      line('MAO (70% rule)', usd(a.mao70, 'mao70')),
      verdictLine(a.verdict),
    ]);
  }

  if (a.strategy === 'rental') {
    return list(a.verdict, [
      line('Cash flow', `${usd(a.cashFlowMonthly, 'cashFlow')}/mo`),
      line('Cash-on-cash', pct(a.coc, 'coc')),
      line('Cap rate', pct(a.capRate, 'capRate')),
      line('DSCR', figure(a.dscr, 'dscr', 'dscr')),
      line('Cash needed', usd(a.cashInvested, 'cashInvested')),
      verdictLine(a.verdict),
    ]);
  }

  if (a.strategy === 'brrrr') {
    const capital = a.cashLeftIn > 0
      ? line('Cash left in', usd(a.cashLeftIn, 'cashLeftIn'))
      : line('Cash out', usd(a.cashOut, 'cashOut'));
    return list(a.verdict, [
      capital,
      line('Cash flow', `${usd(a.cashFlowMonthly, 'cashFlow')}/mo`),
      line('Cash-on-cash', a.infiniteReturn ? '∞' : pct(a.coc, 'coc')),
      line('DSCR', figure(a.dscr, 'dscr', 'dscr')),
      verdictLine(a.verdict),
    ]);
  }

  if (a.strategy === 'wholesale') {
    if (!a.viable) {
      return list(a.verdict, [
        line('MAO', usd(a.mao, 'mao')),
        line('Spread', usd(a.spread, 'spread')),
        verdictLine(a.verdict, 'No spread — pass'),
      ]);
    }
    return list(a.verdict, [
      line('Assignment fee', usd(a.assignmentFee, 'fee')),
      line('MAO', usd(a.mao, 'mao')),
      line('Spread', usd(a.spread, 'spread')),
      line('Buyer discount to ARV', pct(a.buyerDiscountToArv, 'buyerDiscount')),
      verdictLine(a.verdict),
    ]);
  }
  return '';
}

/** Leave on a spring towards the house, then hide. */
export function hideFocusCard() {
  const el = root();
  if (!el || el.hidden || state.leaving) return;
  for (const counter of state.counters.splice(0)) counter.cancel();
  hideLeader();
  const from = state.lastPosition?.from || { dx: 0, dy: 16 };
  const token = { cancelled: false, cancel() { this.cancelled = true; } };
  state.leaving = token;
  const finish = () => {
    if (token.cancelled) return;
    state.leaving = null;
    el.hidden = true;
    el.innerHTML = '';
    el.classList.remove('is-anchored', 'is-sheet');
    el.style.left = '';
    el.style.top = '';
    state.id = null;
    state.lines = 0;
    state.revealed = new Set();
  };
  if (inDriveMode() || reduced()) { finish(); return; }
  springOut(el, { dx: from.dx, dy: from.dy, reduced: false }).then(() => {
    finish();
    // The fill-forwards animation is gone with the element's visibility;
    // clear any residue so the next entrance starts clean.
    try { for (const animation of el.getAnimations?.() || []) animation.cancel(); } catch { /* fine */ }
  });
}

/** For the headed check: what the card is doing right now. */
export function focusCardState() {
  const el = root();
  return {
    visible: Boolean(el && !el.hidden),
    id: state.id,
    lines: state.lines,
    revealed: [...state.revealed].sort((a, b) => a - b),
    assembling: state.assembling,
    side: el?.dataset?.side || null,
    sheet: Boolean(el?.classList?.contains('is-sheet')),
    left: el?.style?.left || null,
    top: el?.style?.top || null,
  };
}
