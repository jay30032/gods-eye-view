import { ATLANTA_DECATUR_PROPERTIES } from './atlantaDecatur.js';
import { cloneProperty, isDemoProperty, validateProperty } from './schema.js';
import { resolveMarket } from '../markets.js';

const DATASETS = Object.freeze({
  atlanta: ATLANTA_DECATUR_PROPERTIES,
});

/**
 * Mock-only property provider. Phase 1 never calls a live listing API.
 */
export function createMockPropertyProvider({ marketId = 'atlanta', provider = 'mock' } = {}) {
  if (provider && provider !== 'mock') {
    throw new Error(`Phase 1 supports PROPERTY_PROVIDER=mock only (got ${provider})`);
  }
  const market = resolveMarket(marketId);
  const rows = (DATASETS[market.id] || DATASETS.atlanta).map((row) => {
    const errors = validateProperty(row);
    if (errors.length) throw new Error(`Invalid mock property ${row?.id}: ${errors.join(', ')}`);
    if (!isDemoProperty(row)) throw new Error(`Mock inventory must be DEMO/MOCK: ${row?.id}`);
    return Object.freeze(cloneProperty(row));
  });

  return {
    id: 'mock',
    market,
    count: rows.length,
    list() {
      return rows.map((row) => cloneProperty(row));
    },
    getById(id) {
      const key = String(id || '').trim();
      const found = rows.find((row) => row.id === key);
      return found ? cloneProperty(found) : null;
    },
    allIds() {
      return rows.map((row) => row.id);
    },
  };
}
