import { analyzeFlip } from './flip.js';
import { analyzeRental } from './rental.js';
import { analyzeBrrrr } from './brrrr.js';
import { analyzeWholesale } from './wholesale.js';
import { DEAL_ASSUMPTIONS, mergeAssumptions } from './assumptions.js';
import { UNITS_BY_PROPERTY_TYPE, unitsFor } from './units.js';
import { scoreProperty } from '../scoring.js';

export {
  analyzeFlip,
  analyzeRental,
  analyzeBrrrr,
  analyzeWholesale,
  DEAL_ASSUMPTIONS,
  mergeAssumptions,
  unitsFor,
  UNITS_BY_PROPERTY_TYPE,
};

const STRATEGIES = Object.freeze({
  flip: analyzeFlip,
  rental: analyzeRental,
  brrrr: analyzeBrrrr,
  wholesale: analyzeWholesale,
});

export const VERDICTS = Object.freeze(['strong', 'thin', 'pass']);

export function normalizeStrategy(value) {
  const key = String(value || '').trim().toLowerCase();
  if (key === 'rent') return 'rental';
  if (key === 'brrr') return 'brrrr';
  if (Object.hasOwn(STRATEGIES, key)) return key;
  return null;
}

/** Deal-block fields a what-if may replace outright. */
export const DEAL_OVERRIDE_FIELDS = Object.freeze(['purchase', 'rehab', 'arv', 'rent']);

/**
 * Run one strategy against a property's deal block.
 *
 * `dealOverrides` replaces listed figures ("what if i pay 110"); `rehabDelta`
 * is then added on top ("rehab is twenty thousand higher") so the two compose
 * — a replaced rehab can still be bumped. Both land before the contingency, so
 * a bigger scope also carries a bigger buffer. Everything else is an
 * assumption override and goes to `mergeAssumptions`.
 */
export function analyzePropertyDeal(property, strategy, overrides = {}) {
  const name = normalizeStrategy(strategy);
  if (!name) throw new Error(`Unknown deal strategy: ${strategy || 'missing'}`);
  const base = property?.deal && typeof property.deal === 'object' ? property.deal : {};
  const deal = { ...base, units: unitsFor(property?.propertyType, property?.units) };

  const dealOverrides = overrides.dealOverrides && typeof overrides.dealOverrides === 'object'
    ? overrides.dealOverrides
    : null;
  if (dealOverrides) {
    for (const field of DEAL_OVERRIDE_FIELDS) {
      const value = Number(dealOverrides[field]);
      if (Number.isFinite(value)) deal[field] = value;
    }
  }

  const rehabDelta = Number(overrides.rehabDelta) || 0;
  if (rehabDelta) deal.rehab = Number(deal.rehab || 0) + rehabDelta;

  const {
    rehabDelta: _ignoredDelta,
    dealOverrides: _ignoredDeal,
    assumptionOverrides: nested,
    ...rest
  } = overrides;
  return STRATEGIES[name](deal, { ...rest, ...(nested || {}) });
}

/**
 * The strategy an enriched row already ranked highest. A bare row is scored on
 * the spot, which is why scoring.js is imported here even though it underwrites
 * through this module — the cycle is call-time only, neither side touches the
 * other while it is evaluating.
 */
export function bestStrategyFor(property) {
  const stored = String(property?.bestStrategy || '');
  if (Object.hasOwn(STRATEGIES, stored)) return stored;
  if (!property) return 'flip';
  return scoreProperty(property).bestStrategy;
}
