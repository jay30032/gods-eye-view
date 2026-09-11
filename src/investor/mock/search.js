import { compositeScore, primarySignal } from './schema.js';
import { bestStrategyFor } from '../deal/index.js';

function tokens(value) {
  return String(value || '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((part) => part.length > 1);
}

function matchesQuery(property, query) {
  const needle = String(query || '').trim().toLowerCase();
  if (!needle) return true;
  const hay = [
    property.id,
    property.address,
    property.neighborhood,
    property.city,
    property.propertyType,
    ...(property.signals || []).map((signal) => signal.type),
  ].join(' ').toLowerCase();
  if (hay.includes(needle)) return true;
  const parts = tokens(needle);
  return parts.every((part) => hay.includes(part));
}

function scoreForStrategy(property, strategy) {
  if (!strategy || strategy === 'composite') return compositeScore(property);
  const value = Number(property?.opportunityScore?.[strategy]);
  return Number.isFinite(value) ? value : 0;
}

export function searchMockProperties(properties, {
  query = '',
  signalType = null,
  county = null,
  maxPurchase = null,
  minScore = 0,
  strategy = 'composite',
  limit = 25,
} = {}) {
  const wantedSignal = signalType ? String(signalType).trim().toUpperCase() : null;
  const wantedCounty = county ? String(county).trim().toLowerCase() : null;
  const cap = maxPurchase == null || !Number.isFinite(Number(maxPurchase))
    ? null
    : Number(maxPurchase);
  const ranked = properties
    .filter((property) => matchesQuery(property, query))
    .filter((property) => {
      if (!wantedSignal) return true;
      return (property.signals || []).some((signal) => signal.type === wantedSignal);
    })
    .filter((property) => !wantedCounty || property.county === wantedCounty)
    .filter((property) => cap == null || Number(property.deal?.purchase || 0) <= cap)
    .filter((property) => scoreForStrategy(property, strategy) >= Number(minScore || 0))
    .map((property) => ({
      property,
      score: scoreForStrategy(property, strategy),
      primary: primarySignal(property),
      bestStrategy: bestStrategyFor(property),
    }))
    .sort((a, b) => b.score - a.score || a.property.id.localeCompare(b.property.id));

  return ranked.slice(0, Math.max(1, Number(limit) || 25));
}

export function rankMockProperties(properties, { strategy = 'composite', limit = 10 } = {}) {
  return searchMockProperties(properties, { strategy, limit });
}

export const FIND_MONEY_LIMIT = 4;

const FIND_MONEY_MIN_COMPOSITE = 70;
const URGENT_SIGNALS = new Set(['FORECLOSURE', 'TAX_SALE']);

/**
 * The shortlist "Find me money" lights up: ranked by composite, qualified by
 * score or by a clock-running signal. The first row is the gold pick — top
 * pick is the output of this ranking, never a field on a house.
 */
export function findMoney(properties, limit = FIND_MONEY_LIMIT) {
  const cap = Math.max(1, Number(limit) || FIND_MONEY_LIMIT);
  const ranked = rankMockProperties(properties, {
    strategy: 'composite',
    limit: Math.max(cap, properties.length || cap),
  });
  const qualified = ranked.filter((row) => row.score >= FIND_MONEY_MIN_COMPOSITE
    || (row.primary && URGENT_SIGNALS.has(row.primary.type)));
  if (qualified.length >= cap) return qualified.slice(0, cap);

  // The demo promises exactly four candidates activating, so a thin market
  // backfills from the ranking rather than lighting up three houses.
  const picked = new Set(qualified.map((row) => row.property.id));
  const filled = qualified.slice();
  for (const row of ranked) {
    if (filled.length >= cap) break;
    if (picked.has(row.property.id)) continue;
    picked.add(row.property.id);
    filled.push(row);
  }
  return filled;
}
