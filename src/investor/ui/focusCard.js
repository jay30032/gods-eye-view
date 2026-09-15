import { focusCardModel, formatPct, formatUsd, verdictLabel } from '../focus.js';
import { countdownWords, formatSaleDate, NOTICE_WEEKS } from '../georgia.js';
import { escapeHtml } from './escapeHtml.js';

const STRATEGY_LABELS = Object.freeze({
  flip: 'FLIP',
  rental: 'RENT',
  brrrr: 'BRRRR',
  wholesale: 'WHOLESALE',
});

export function renderFocusCard(property, options = {}) {
  const root = document.getElementById('ts-focus-card');
  if (!root) return;
  if (!property) {
    root.hidden = true;
    root.innerHTML = '';
    return;
  }
  const model = focusCardModel(property, options);
  root.hidden = false;
  root.innerHTML = `
    <header>
      <span class="ts-kicker ts-kicker-mock">MOCK</span>
      <span class="ts-kicker">${escapeHtml(model.signalLabel)} · ${model.signalConfidence}%</span>
      <strong>${escapeHtml(model.address)}</strong>
      <span>${escapeHtml(model.neighborhood || '')} · ${escapeHtml(String(model.propertyType).toUpperCase())}</span>
      ${renderSourceLine(model)}
      <span class="ts-focus-score">Score ${model.score}</span>
    </header>
    ${renderAuctionTimeline(model)}
    ${renderCustomNumbers(options)}
    ${renderDrivers(model)}
    ${renderStrategyStrip(model)}
    <p class="ts-why">${escapeHtml(model.why)}</p>
    <dl class="ts-focus-glance">
      <div><dt>Score</dt><dd>${model.score}</dd></div>
      <div><dt>Path</dt><dd>${escapeHtml(String(model.strategy).toUpperCase())}</dd></div>
      ${options.revealDeal ? `
      <div><dt>Value</dt><dd>${model.estimatedValue}</dd></div>
      <div><dt>Equity</dt><dd>${model.estimatedEquityPct}</dd></div>
      ` : ''}
    </dl>
    ${renderCompare(options)}
    ${options.revealDeal ? renderAnalysis(model) : ''}
    <footer>
      <button type="button" data-ts-focus-action="save">Save</button>
      <button type="button" data-ts-focus-action="deal">Show deal</button>
    </footer>
  `;
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

  if (a.strategy === 'flip') {
    return list(a.verdict, [
      line('Profit', formatUsd(a.profit)),
      line('Cash needed', formatUsd(a.cashIn)),
      line('Cash-on-cash', `${formatPct(a.roi)} (${formatPct(a.roiAnnualized)} annualized)`),
      line('Margin', formatPct(a.margin)),
      line('MAO (70% rule)', formatUsd(a.mao70)),
      verdictLine(a.verdict),
    ]);
  }

  if (a.strategy === 'rental') {
    return list(a.verdict, [
      line('Cash flow', `${formatUsd(a.cashFlowMonthly)}/mo`),
      line('Cash-on-cash', formatPct(a.coc)),
      line('Cap rate', formatPct(a.capRate)),
      line('DSCR', a.dscr.toFixed(2)),
      line('Cash needed', formatUsd(a.cashInvested)),
      verdictLine(a.verdict),
    ]);
  }

  if (a.strategy === 'brrrr') {
    const capital = a.cashLeftIn > 0
      ? line('Cash left in', formatUsd(a.cashLeftIn))
      : line('Cash out', formatUsd(a.cashOut));
    return list(a.verdict, [
      capital,
      line('Cash flow', `${formatUsd(a.cashFlowMonthly)}/mo`),
      line('Cash-on-cash', a.infiniteReturn ? '∞' : formatPct(a.coc)),
      line('DSCR', a.dscr.toFixed(2)),
      verdictLine(a.verdict),
    ]);
  }

  if (a.strategy === 'wholesale') {
    if (!a.viable) {
      return list(a.verdict, [
        line('MAO', formatUsd(a.mao)),
        line('Spread', formatUsd(a.spread)),
        verdictLine(a.verdict, 'No spread — pass'),
      ]);
    }
    return list(a.verdict, [
      line('Assignment fee', formatUsd(a.assignmentFee)),
      line('MAO', formatUsd(a.mao)),
      line('Spread', formatUsd(a.spread)),
      line('Buyer discount to ARV', formatPct(a.buyerDiscountToArv)),
      verdictLine(a.verdict),
    ]);
  }
  return '';
}

export function hideFocusCard() {
  renderFocusCard(null);
}
