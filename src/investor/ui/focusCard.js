import { focusCardModel, formatPct, formatUsd } from '../focus.js';

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
    <dl>
      <div><dt>Score</dt><dd>${model.score}</dd></div>
      <div><dt>Value</dt><dd>${model.estimatedValue}</dd></div>
      <div><dt>Equity</dt><dd>${model.estimatedEquityPct}</dd></div>
      <div><dt>Path</dt><dd>${String(model.strategy).toUpperCase()}</dd></div>
    </dl>
    <p class="ts-why">${model.why}</p>
    ${renderAnalysis(model)}
    <footer>
      <button type="button" data-ts-focus-action="save">Save</button>
      <button type="button" data-ts-focus-action="deal">Show deal</button>
    </footer>
  `;
}

function renderAnalysis(model) {
  const a = model.analysis;
  if (!a) return '';
  if (a.strategy === 'flip') {
    return `<ul class="ts-deal"><li>Profit ${formatUsd(a.profit)}</li><li>ROI ${formatPct(a.roi)}</li><li>All-in ${formatUsd(a.allIn)}</li></ul>`;
  }
  if (a.strategy === 'rental') {
    return `<ul class="ts-deal"><li>Cash flow ${formatUsd(a.cashFlowMonthly)}/mo</li><li>Cap ${formatPct(a.capRate)}</li><li>CoC ${formatPct(a.coc)}</li></ul>`;
  }
  if (a.strategy === 'brrrr') {
    return `<ul class="ts-deal"><li>Cash left ${formatUsd(a.cashLeftIn)}</li><li>${formatUsd(a.cashFlowMonthly)}/mo</li><li>CoC ${formatPct(a.coc)}</li></ul>`;
  }
  if (a.strategy === 'wholesale') {
    return `<ul class="ts-deal"><li>Fee ${formatUsd(a.assignmentFee)}</li><li>Spread ${formatUsd(a.spread)}</li><li>MAO ${formatUsd(a.mao)}</li></ul>`;
  }
  return '';
}

export function hideFocusCard() {
  renderFocusCard(null);
}
