import { ATLANTA_DECATUR_PROPERTIES } from './atlantaDecatur.js';
import { SIX_HOUSE_PROPERTIES } from './sixHouse.js';
import { cloneProperty, isDemoProperty, validateProperty } from './schema.js';
import { enrichProperty } from '../scoring.js';
import { demoNow } from '../clock.js';
import { resolveMarket } from '../markets.js';

/**
 * Authored inventories. `atlanta` is the market board; `six` is the tight
 * Oakhurst cluster the near-field scene needs and the market board cannot
 * supply. Both are validated and enriched by exactly the same path.
 */
const DATASETS = Object.freeze({
  atlanta: ATLANTA_DECATUR_PROPERTIES,
  six: SIX_HOUSE_PROPERTIES,
});

/**
 * Mock-only property provider. Phase 1 never calls a live listing API.
 *
 * Rows are validated as authored, then enriched once at load. Scoring runs the
 * four calculators per row, so it is far too heavy for a render callback —
 * `list()` hands back the same frozen enriched objects every time.
 */
export function createMockPropertyProvider({
  marketId = 'atlanta',
  dataset = null,
  provider = 'mock',
  now = demoNow(),
  assumptions = null,
} = {}) {
  if (provider && provider !== 'mock') {
    throw new Error(`Phase 1 supports PROPERTY_PROVIDER=mock only (got ${provider})`);
  }
  const market = resolveMarket(marketId);
  const key = dataset || market.id;
  if (!DATASETS[key]) throw new Error(`Unknown mock dataset: ${key}`);
  const rows = Object.freeze(DATASETS[key].map((row) => {
    const errors = validateProperty(row);
    if (errors.length) throw new Error(`Invalid mock property ${row?.id}: ${errors.join(', ')}`);
    if (!isDemoProperty(row)) throw new Error(`Mock inventory must be DEMO/MOCK: ${row?.id}`);
    return enrichProperty(row, { now, assumptions });
  }));
  const byId = new Map(rows.map((row) => [row.id, row]));

  return {
    id: 'mock',
    dataset: key,
    market,
    count: rows.length,
    list() {
      return rows.slice();
    },
    getById(id) {
      return byId.get(String(id || '').trim()) || null;
    },
    allIds() {
      return rows.map((row) => row.id);
    },
  };
}

export { cloneProperty };
