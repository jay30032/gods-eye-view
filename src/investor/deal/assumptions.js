/**
 * Frozen underwriting defaults. Changing a number here is a product decision
 * and must update the unit fixtures in the matching *.test.mjs files.
 */
export const DEAL_ASSUMPTIONS = Object.freeze({
  buyClosingRate: 0.02,
  sellClosingRate: 0.06,
  holdingAnnualRate: 0.08,
  flipHoldMonths: 6,
  vacancyRate: 0.05,
  rentalOpexRate: 0.35,
  downPaymentRate: 0.25,
  mortgageAnnualRate: 0.07,
  mortgageYears: 30,
  brrrrLtv: 0.75,
  wholesaleMaoRate: 0.70,
  wholesaleFeeRate: 0.40,
  wholesaleFeeMin: 5000,
  wholesaleFeeMax: 25000,
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
