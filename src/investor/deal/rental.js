import { DEAL_ASSUMPTIONS, mergeAssumptions } from './assumptions.js';
import { money, pmt, ratio, requireFinite } from './math.js';

/**
 * Deterministic rental underwrite.
 * NOI = gross rent − vacancy − opex
 * Cash invested = down payment + rehab
 * Cash-on-cash = annual cash flow / cash invested
 *
 * @param {{purchase:number,rehab:number,rent:number}} deal
 * @param {object} [overrides]
 */
export function analyzeRental(deal, overrides = {}) {
  const purchase = requireFinite('purchase', deal?.purchase);
  const rehab = requireFinite('rehab', deal?.rehab);
  const rent = requireFinite('rent', deal?.rent);
  const a = mergeAssumptions(overrides);

  const grossRent = money(rent * 12);
  const vacancy = money(grossRent * a.vacancyRate);
  const opex = money(grossRent * a.rentalOpexRate);
  const noi = money(grossRent - vacancy - opex);
  const capRate = purchase > 0 ? ratio(noi / purchase) : 0;
  const downPayment = money(purchase * a.downPaymentRate);
  const loan = money(purchase - downPayment);
  const monthlyDebt = pmt(a.mortgageAnnualRate, a.mortgageYears, loan);
  const cashFlowMonthly = money((noi / 12) - monthlyDebt);
  const cashFlowAnnual = money(cashFlowMonthly * 12);
  const cashInvested = money(downPayment + rehab);
  const coc = cashInvested > 0 ? ratio(cashFlowAnnual / cashInvested) : 0;

  return Object.freeze({
    strategy: 'rental',
    purchase: money(purchase),
    rehab: money(rehab),
    rent: money(rent),
    grossRent,
    vacancy,
    opex,
    noi,
    capRate,
    downPayment,
    loan,
    monthlyDebt,
    cashFlowMonthly,
    cashFlowAnnual,
    cashInvested,
    coc,
    assumptions: Object.freeze({ ...a }),
  });
}
