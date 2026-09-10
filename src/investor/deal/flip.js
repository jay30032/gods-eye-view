import { DEAL_ASSUMPTIONS, mergeAssumptions } from './assumptions.js';
import { money, ratio, requireFinite } from './math.js';

/**
 * Deterministic flip underwrite.
 * profit = ARV − (purchase + rehab + buy closing + sell closing + hold carrying)
 * ROI is against cash in (purchase + rehab). Margin is profit / ARV.
 *
 * @param {{purchase:number,rehab:number,arv:number}} deal
 * @param {object} [overrides]
 */
export function analyzeFlip(deal, overrides = {}) {
  const purchase = requireFinite('purchase', deal?.purchase);
  const rehab = requireFinite('rehab', deal?.rehab);
  const arv = requireFinite('arv', deal?.arv);
  const a = mergeAssumptions(overrides);

  const buyClosing = money(purchase * a.buyClosingRate);
  const sellClosing = money(arv * a.sellClosingRate);
  const holding = money((purchase * a.holdingAnnualRate * a.flipHoldMonths) / 12);
  const cashIn = money(purchase + rehab);
  const allIn = money(cashIn + buyClosing + sellClosing + holding);
  const profit = money(arv - allIn);
  const roi = cashIn > 0 ? ratio(profit / cashIn) : 0;
  const margin = arv > 0 ? ratio(profit / arv) : 0;

  return Object.freeze({
    strategy: 'flip',
    purchase: money(purchase),
    rehab: money(rehab),
    arv: money(arv),
    buyClosing,
    sellClosing,
    holding,
    cashIn,
    allIn,
    profit,
    roi,
    margin,
    holdMonths: a.flipHoldMonths,
    assumptions: Object.freeze({ ...a }),
  });
}

export { DEAL_ASSUMPTIONS };
