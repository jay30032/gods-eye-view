import { analyzeFlip } from './flip.js';
import { analyzeRental } from './rental.js';
import { analyzeBrrrr } from './brrrr.js';
import { analyzeWholesale } from './wholesale.js';
import { DEAL_ASSUMPTIONS, mergeAssumptions } from './assumptions.js';

export { analyzeFlip, analyzeRental, analyzeBrrrr, analyzeWholesale, DEAL_ASSUMPTIONS, mergeAssumptions };

const STRATEGIES = Object.freeze({
  flip: analyzeFlip,
  rental: analyzeRental,
  brrrr: analyzeBrrrr,
  wholesale: analyzeWholesale,
});

export function normalizeStrategy(value) {
  const key = String(value || '').trim().toLowerCase();
  if (key === 'rent') return 'rental';
  if (key === 'brrr') return 'brrrr';
  if (Object.hasOwn(STRATEGIES, key)) return key;
  return null;
}

/**
 * Run one strategy against a property's deal block.
 * `rehabDelta` is added to listed rehab (demo: "rehab is twenty thousand higher").
 */
export function analyzePropertyDeal(property, strategy, overrides = {}) {
  const name = normalizeStrategy(strategy);
  if (!name) throw new Error(`Unknown deal strategy: ${strategy || 'missing'}`);
  const deal = property?.deal && typeof property.deal === 'object' ? { ...property.deal } : {};
  const rehabDelta = Number(overrides.rehabDelta) || 0;
  if (rehabDelta) deal.rehab = Number(deal.rehab || 0) + rehabDelta;
  const { rehabDelta: _ignored, ...assumptionOverrides } = overrides;
  return STRATEGIES[name](deal, assumptionOverrides);
}

export function bestStrategyFor(property) {
  const scores = property?.opportunityScore || {};
  let best = 'flip';
  let top = -Infinity;
  for (const key of ['flip', 'rental', 'brrrr', 'wholesale']) {
    const value = Number(scores[key]);
    if (Number.isFinite(value) && value > top) {
      top = value;
      best = key;
    }
  }
  return best;
}
