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
  minScore = 0,
  strategy = 'composite',
  limit = 25,
} = {}) {
  const wantedSignal = signalType ? String(signalType).trim().toUpperCase() : null;
  const ranked = properties
    .filter((property) => matchesQuery(property, query))
    .filter((property) => {
      if (!wantedSignal) return true;
      return (property.signals || []).some((signal) => signal.type === wantedSignal);
    })
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

export function findMoney(properties, limit = FIND_MONEY_LIMIT) {
  const cap = Math.max(1, Number(limit) || FIND_MONEY_LIMIT);
  return rankMockProperties(properties, { strategy: 'composite', limit: Math.max(cap * 4, 16) })
    .filter((row) => row.score >= 70 || (row.primary && ['FORECLOSURE', 'TAX_SALE', 'TOP_PICK'].includes(row.primary.type)))
    .slice(0, cap);
}
