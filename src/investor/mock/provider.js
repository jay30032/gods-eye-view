import { ATLANTA_DECATUR_PROPERTIES } from './atlantaDecatur.js';
import { cloneProperty, isDemoProperty, validateProperty } from './schema.js';
import { enrichProperty } from '../scoring.js';
import { demoNow } from '../clock.js';
import { resolveMarket } from '../markets.js';

const DATASETS = Object.freeze({
  atlanta: ATLANTA_DECATUR_PROPERTIES,
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
  provider = 'mock',
  now = demoNow(),
  assumptions = null,
} = {}) {
  if (provider && provider !== 'mock') {
    throw new Error(`Phase 1 supports PROPERTY_PROVIDER=mock only (got ${provider})`);
  }
  const market = resolveMarket(marketId);
  const rows = Object.freeze((DATASETS[market.id] || DATASETS.atlanta).map((row) => {
    const errors = validateProperty(row);
    if (errors.length) throw new Error(`Invalid mock property ${row?.id}: ${errors.join(', ')}`);
    if (!isDemoProperty(row)) throw new Error(`Mock inventory must be DEMO/MOCK: ${row?.id}`);
    return enrichProperty(row, { now, assumptions });
  }));
  const byId = new Map(rows.map((row) => [row.id, row]));

  return {
    id: 'mock',
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
