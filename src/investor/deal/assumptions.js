/**
 * Frozen underwriting defaults. Changing a number here is a product decision
 * and must update the unit fixtures in the matching *.test.mjs files.
 *
 * Rates are annual unless the name says otherwise. Carrying costs, property
 * tax, and insurance are modelled the way a real underwriter quotes them:
 * taxes and carry against ARV, insurance per unit.
 */
export const DEAL_ASSUMPTIONS = Object.freeze({
  // Transaction costs
  buyClosingRate: 0.02,
  sellClosingRate: 0.06,
  rehabContingencyRate: 0.10,

  // Hard money acquisition (flip + BRRRR)
  hardMoneyAnnualRate: 0.12,
  hardMoneyPoints: 0.02,
  hardMoneyLtcRate: 0.90,
  flipHoldMonths: 6,
  carryAnnualRate: 0.015, // taxes + insurance + utilities as % of ARV per year

  // Rental operating model
  vacancyRate: 0.05,
  managementRate: 0.08,
  maintenanceRate: 0.05,
  capexRate: 0.05,
  propertyTaxRate: 0.011, // % of ARV per year
  insuranceAnnualPerUnit: 1400,

  // Conventional financing
  downPaymentRate: 0.25,
  mortgageAnnualRate: 0.07,
  mortgageYears: 30,

  // BRRRR refinance
  brrrrLtv: 0.75,
  refiClosingRate: 0.02,
  brrrrSeasoningMonths: 6,

  // Wholesale
  wholesaleMaoRate: 0.70,
  wholesaleFeeRate: 0.40,
  wholesaleFeeMin: 5000,
  wholesaleFeeMax: 25000,

  // Verdict thresholds
  flipStrongProfit: 30000,
  flipStrongMargin: 0.10,
  flipThinProfit: 15000,
  rentalStrongCoc: 0.08,
  rentalStrongDscr: 1.25,
  brrrrStrongCashLeftIn: 25000,
  brrrrStrongCashFlow: 150,
  wholesaleStrongFee: 15000,
  wholesaleThinFee: 7500,
});

export function mergeAssumptions(overrides = {}) {
  if (!overrides || typeof overrides !== 'object') return { ...DEAL_ASSUMPTIONS };
  const next = { ...DEAL_ASSUMPTIONS };
  for (const [key, value] of Object.entries(overrides)) {
    if (!Object.hasOwn(DEAL_ASSUMPTIONS, key)) continue;
    const numeric = Number(value);
    if (Number.isFinite(numeric)) next[key] = numeric;
  }
  return next;
}
