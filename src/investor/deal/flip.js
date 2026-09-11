import { DEAL_ASSUMPTIONS, mergeAssumptions } from './assumptions.js';
import { hardMoneyAcquisition, rehabWithContingency } from './common.js';
import { money, ratio, requireFinite } from './math.js';

function flipVerdict(profit, margin, a) {
  if (profit >= a.flipStrongProfit && margin >= a.flipStrongMargin) return 'strong';
  if (profit >= a.flipThinProfit) return 'thin';
  return 'pass';
}

/**
 * Deterministic flip underwrite, financed with hard money by default.
 *
 * The loan is sized against total cost (purchase + rehab with contingency), so
 * cash in is the funding gap plus every cost the lender does not cover.
 * `allCash: true` removes the loan, its points, and its interest.
 *
 * @param {{purchase:number,rehab:number,arv:number}} deal
 * @param {object} [overrides] assumption overrides plus optional `allCash`
 */
export function analyzeFlip(deal, overrides = {}) {
  const purchase = requireFinite('purchase', deal?.purchase);
  const rehab = requireFinite('rehab', deal?.rehab);
  const arv = requireFinite('arv', deal?.arv);
  const a = mergeAssumptions(overrides);
  const allCash = overrides?.allCash === true;

  const rehabTotal = rehabWithContingency(rehab, a);
  const holdMonths = a.flipHoldMonths;
  const { buyClosing, loanAmount, points, interest, carry } = hardMoneyAcquisition(
    { purchase, rehabTotal, arv, holdMonths },
    a,
    allCash,
  );
  const sellClosing = money(arv * a.sellClosingRate);

  const allIn = money(purchase + rehabTotal + buyClosing + points + interest + carry + sellClosing);
  const profit = money(arv - allIn);
  const cashIn = money((purchase + rehabTotal - loanAmount) + buyClosing + points + interest + carry);
  const roi = cashIn > 0 ? ratio(profit / cashIn) : 0;
  const roiAnnualized = holdMonths > 0 ? ratio((roi * 12) / holdMonths) : 0;
  const margin = arv > 0 ? ratio(profit / arv) : 0;
  const mao70 = money(arv * 0.70 - rehabTotal);

  return Object.freeze({
    strategy: 'flip',
    purchase: money(purchase),
    rehab: money(rehab),
    rehabTotal,
    arv: money(arv),
    allCash,
    buyClosing,
    loanAmount,
    points,
    interest,
    carry,
    sellClosing,
    allIn,
    profit,
    cashIn,
    roi,
    roiAnnualized,
    margin,
    mao70,
    holdMonths,
    verdict: flipVerdict(profit, margin, a),
    assumptions: Object.freeze({ ...a }),
  });
}

export { DEAL_ASSUMPTIONS };
