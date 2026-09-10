import { DEAL_ASSUMPTIONS, mergeAssumptions } from './assumptions.js';
import { money, pmt, ratio, requireFinite } from './math.js';

/**
 * Deterministic BRRRR underwrite.
 * Refinance proceeds = ARV × LTV
 * Cash left in = max(0, all-in − refinance proceeds)
 * Infinite CoC is reported as 999 when cash left in is 0 and cash flow > 0.
 *
 * @param {{purchase:number,rehab:number,arv:number,rent:number}} deal
 * @param {object} [overrides]
 */
export function analyzeBrrrr(deal, overrides = {}) {
  const purchase = requireFinite('purchase', deal?.purchase);
  const rehab = requireFinite('rehab', deal?.rehab);
  const arv = requireFinite('arv', deal?.arv);
  const rent = requireFinite('rent', deal?.rent);
  const a = mergeAssumptions(overrides);

  const buyClosing = money(purchase * a.buyClosingRate);
  const allIn = money(purchase + rehab + buyClosing);
  const refinanceAmount = money(arv * a.brrrrLtv);
  const cashOut = money(Math.max(0, refinanceAmount - allIn));
  const cashLeftIn = money(Math.max(0, allIn - refinanceAmount));

  const grossRent = money(rent * 12);
  const vacancy = money(grossRent * a.vacancyRate);
  const opex = money(grossRent * a.rentalOpexRate);
  const noi = money(grossRent - vacancy - opex);
  const monthlyDebt = pmt(a.mortgageAnnualRate, a.mortgageYears, refinanceAmount);
  const cashFlowMonthly = money((noi / 12) - monthlyDebt);
  const cashFlowAnnual = money(cashFlowMonthly * 12);

  let coc = 0;
  if (cashLeftIn > 0) coc = ratio(cashFlowAnnual / cashLeftIn);
  else if (cashFlowAnnual > 0) coc = 999;
  else coc = 0;

  return Object.freeze({
    strategy: 'brrrr',
    purchase: money(purchase),
    rehab: money(rehab),
    arv: money(arv),
    rent: money(rent),
    buyClosing,
    allIn,
    refinanceAmount,
    ltv: a.brrrrLtv,
    cashOut,
    cashLeftIn,
    noi,
    monthlyDebt,
    cashFlowMonthly,
    cashFlowAnnual,
    coc,
    infiniteReturn: cashLeftIn === 0 && cashFlowAnnual > 0,
    assumptions: Object.freeze({ ...a }),
  });
}
