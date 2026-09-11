import { focusCardModel, formatPct, formatUsd, verdictLabel } from '../focus.js';

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
      <span class="ts-kicker">${model.signalType.replaceAll('_', ' ')} · ${model.signalConfidence}%</span>
      <strong>${model.address}</strong>
      <span>${model.neighborhood || ''} · ${String(model.propertyType).toUpperCase()}</span>
    </header>
    <p class="ts-why">${model.why}</p>
    <dl class="ts-focus-glance">
      <div><dt>Score</dt><dd>${model.score}</dd></div>
      <div><dt>Path</dt><dd>${String(model.strategy).toUpperCase()}</dd></div>
      ${options.revealDeal ? `
      <div><dt>Value</dt><dd>${model.estimatedValue}</dd></div>
      <div><dt>Equity</dt><dd>${model.estimatedEquityPct}</dd></div>
      ` : ''}
    </dl>
    ${options.revealDeal ? renderAnalysis(model) : ''}
    <footer>
      <button type="button" data-ts-focus-action="save">Save</button>
      <button type="button" data-ts-focus-action="deal">Show deal</button>
    </footer>
  `;
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
