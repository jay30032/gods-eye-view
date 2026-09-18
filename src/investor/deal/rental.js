import { DEAL_ASSUMPTIONS, mergeAssumptions } from './assumptions.js';
import { operatingModel, rehabWithContingency } from './common.js';
import { money, pmt, ratio, requireFinite } from './math.js';
import { unitsFor } from './units.js';

function rentalVerdict(coc, dscr, cashFlowMonthly, a) {
  if (coc >= a.rentalStrongCoc && dscr >= a.rentalStrongDscr) return 'strong';
  if (cashFlowMonthly > 0) return 'thin';
  return 'pass';
}

/**
 * Deterministic buy-and-hold underwrite on conventional financing.
 *
 * NOI carries a real operating load (vacancy, management, maintenance, capex,
 * taxes on ARV, insurance per door) rather than a single blended opex rate.
 *
 * @param {{purchase:number,rehab:number,arv:number,rent:number,units?:number}} deal
 * @param {object} [overrides]
 */
export function analyzeRental(deal, overrides = {}) {
  const purchase = requireFinite('purchase', deal?.purchase);
  const rehab = requireFinite('rehab', deal?.rehab);
  const arv = requireFinite('arv', deal?.arv);
  const rent = requireFinite('rent', deal?.rent);
  const units = unitsFor(deal?.propertyType, deal?.units);
  const a = mergeAssumptions(overrides);

  const rehabTotal = rehabWithContingency(rehab, a);
  const ops = operatingModel({ rent, arv, units }, a);
  const { noi } = ops;

  const capRate = purchase > 0 ? ratio(noi / purchase) : 0;
  const yieldOnCost = (purchase + rehabTotal) > 0 ? ratio(noi / (purchase + rehabTotal)) : 0;

  const downPayment = money(purchase * a.downPaymentRate);
  const loan = money(purchase - downPayment);
  const monthlyDebt = pmt(a.mortgageAnnualRate, a.mortgageYears, loan);
  const cashFlowMonthly = money((noi / 12) - monthlyDebt);
  const cashFlowAnnual = money(cashFlowMonthly * 12);

  const buyClosing = money(purchase * a.buyClosingRate);
  const cashInvested = money(downPayment + rehabTotal + buyClosing);
  const coc = cashInvested > 0 ? ratio(cashFlowAnnual / cashInvested) : 0;
  const annualDebt = money(monthlyDebt * 12);
  const dscr = annualDebt > 0 ? ratio(noi / annualDebt) : 0;

  return Object.freeze({
    strategy: 'rental',
    purchase: money(purchase),
    rehab: money(rehab),
    rehabTotal,
    arv: money(arv),
    rent: money(rent),
    units,
    ...ops,
    capRate,
    yieldOnCost,
    downPayment,
    loan,
    buyClosing,
    monthlyDebt,
    annualDebt,
    cashFlowMonthly,
    cashFlowAnnual,
    cashInvested,
    coc,
    dscr,
    verdict: rentalVerdict(coc, dscr, cashFlowMonthly, a),
    assumptions: Object.freeze({ ...a }),
  });
}

export { DEAL_ASSUMPTIONS };
