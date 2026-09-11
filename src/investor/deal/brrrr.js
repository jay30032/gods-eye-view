import { DEAL_ASSUMPTIONS, mergeAssumptions } from './assumptions.js';
import { hardMoneyAcquisition, operatingModel, rehabWithContingency } from './common.js';
import { money, pmt, ratio, requireFinite } from './math.js';
import { unitsFor } from './units.js';

function brrrrVerdict(cashLeftIn, cashFlowMonthly, a) {
  if (cashLeftIn <= a.brrrrStrongCashLeftIn && cashFlowMonthly >= a.brrrrStrongCashFlow) return 'strong';
  if (cashFlowMonthly > 0) return 'thin';
  return 'pass';
}

/**
 * Deterministic BRRRR underwrite: buy and rehab on hard money, season, then
 * refinance into a conventional loan at ARV × LTV.
 *
 * There is no sale, so no sell closing — the exit is the refinance, and what
 * the refinance does not return stays in the deal as cash left in.
 * Infinite CoC is reported as 999 when nothing is left in and cash flow is positive.
 *
 * @param {{purchase:number,rehab:number,arv:number,rent:number,units?:number}} deal
 * @param {object} [overrides] assumption overrides plus optional `allCash`
 */
export function analyzeBrrrr(deal, overrides = {}) {
  const purchase = requireFinite('purchase', deal?.purchase);
  const rehab = requireFinite('rehab', deal?.rehab);
  const arv = requireFinite('arv', deal?.arv);
  const rent = requireFinite('rent', deal?.rent);
  const units = unitsFor(deal?.propertyType, deal?.units);
  const a = mergeAssumptions(overrides);
  const allCash = overrides?.allCash === true;

  const rehabTotal = rehabWithContingency(rehab, a);
  const holdMonths = a.brrrrSeasoningMonths;
  const { buyClosing, loanAmount, points, interest, carry } = hardMoneyAcquisition(
    { purchase, rehabTotal, arv, holdMonths },
    a,
    allCash,
  );
  const allIn = money(purchase + rehabTotal + buyClosing + points + interest + carry);

  const refinanceAmount = money(arv * a.brrrrLtv);
  const refiClosing = money(refinanceAmount * a.refiClosingRate);
  const cashLeftIn = money(Math.max(0, allIn + refiClosing - refinanceAmount));
  const cashOut = money(Math.max(0, refinanceAmount - refiClosing - allIn));

  const ops = operatingModel({ rent, arv, units }, a);
  const { noi } = ops;
  const monthlyDebt = pmt(a.mortgageAnnualRate, a.mortgageYears, refinanceAmount);
  const cashFlowMonthly = money((noi / 12) - monthlyDebt);
  const cashFlowAnnual = money(cashFlowMonthly * 12);
  const annualDebt = money(monthlyDebt * 12);
  const dscr = annualDebt > 0 ? ratio(noi / annualDebt) : 0;

  const infiniteReturn = cashLeftIn === 0 && cashFlowAnnual > 0;
  let coc = 0;
  if (cashLeftIn > 0) coc = ratio(cashFlowAnnual / cashLeftIn);
  else if (infiniteReturn) coc = 999;

  return Object.freeze({
    strategy: 'brrrr',
    purchase: money(purchase),
    rehab: money(rehab),
    rehabTotal,
    arv: money(arv),
    rent: money(rent),
    units,
    allCash,
    buyClosing,
    loanAmount,
    points,
    interest,
    carry,
    holdMonths,
    allIn,
    refinanceAmount,
    refiClosing,
    ltv: a.brrrrLtv,
    cashLeftIn,
    cashOut,
    ...ops,
    monthlyDebt,
    annualDebt,
    cashFlowMonthly,
    cashFlowAnnual,
    coc,
    dscr,
    infiniteReturn,
    verdict: brrrrVerdict(cashLeftIn, cashFlowMonthly, a),
    assumptions: Object.freeze({ ...a }),
  });
}

export { DEAL_ASSUMPTIONS };
