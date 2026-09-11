import { money } from './math.js';

/** Rehab budget with the contingency an investor actually funds. */
export function rehabWithContingency(rehab, a) {
  return money(rehab * (1 + a.rehabContingencyRate));
}

/**
 * Hard-money acquisition block shared by flip and BRRRR.
 * `allCash` zeroes the loan, its points, and its interest — carry still applies.
 */
export function hardMoneyAcquisition({ purchase, rehabTotal, arv, holdMonths }, a, allCash = false) {
  const buyClosing = money(purchase * a.buyClosingRate);
  const loanAmount = allCash ? 0 : money((purchase + rehabTotal) * a.hardMoneyLtcRate);
  const points = money(loanAmount * a.hardMoneyPoints);
  const interest = money((loanAmount * a.hardMoneyAnnualRate * holdMonths) / 12);
  const carry = money((arv * a.carryAnnualRate * holdMonths) / 12);
  return { buyClosing, loanAmount, points, interest, carry };
}

/**
 * Operating model shared by rental and BRRRR. Taxes track ARV, insurance is
 * quoted per door, and the four rent-driven reserves come off gross rent.
 */
export function operatingModel({ rent, arv, units }, a) {
  const grossRent = money(rent * 12);
  const vacancy = money(grossRent * a.vacancyRate);
  const management = money(grossRent * a.managementRate);
  const maintenance = money(grossRent * a.maintenanceRate);
  const capex = money(grossRent * a.capexRate);
  const taxes = money(arv * a.propertyTaxRate);
  const insurance = money(a.insuranceAnnualPerUnit * units);
  const opex = money(vacancy + management + maintenance + capex + taxes + insurance);
  const noi = money(grossRent - opex);
  return { grossRent, vacancy, management, maintenance, capex, taxes, insurance, opex, noi };
}
