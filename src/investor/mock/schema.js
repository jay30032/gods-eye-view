import { scoreProperty } from '../scoring.js';
import { AUCTION_SIGNAL_TYPES, COUNTIES } from '../georgia.js';

export const SIGNAL_TYPES = Object.freeze([
  'FORECLOSURE',
  'PREFORECLOSURE',
  'TAX_SALE',
  'DISTRESS',
  'LISTED_OPPORTUNITY',
]);

/**
 * What each enum key is actually called in Georgia. The keys stay stable so the
 * visuals and the LOD logic do not churn; only the words a human reads change.
 * There is no recorded Notice of Default in a non-judicial state, so
 * PREFORECLOSURE is a servicer delinquency, not a courthouse filing.
 */
export const SIGNAL_LABELS = Object.freeze({
  FORECLOSURE: 'Notice of Sale Under Power',
  PREFORECLOSURE: 'Mortgage delinquency',
  TAX_SALE: 'Tax sale (fi. fa.)',
  DISTRESS: 'Distress',
  LISTED_OPPORTUNITY: 'Listed under comps',
});

export { AUCTION_SIGNAL_TYPES };

export function signalLabel(type) {
  return SIGNAL_LABELS[type] || SIGNAL_LABELS.DISTRESS;
}

export const PROPERTY_TYPES = Object.freeze([
  'sfr',
  'townhouse',
  'duplex',
  'triplex',
  'quad',
  'condo',
  'small_multifamily',
]);

export const PRIMARY_SIGNAL_RANK = Object.freeze({
  FORECLOSURE: 5,
  TAX_SALE: 4,
  PREFORECLOSURE: 3,
  DISTRESS: 2,
  LISTED_OPPORTUNITY: 1,
});

/** Fields a mock row must never carry — they are derived, not authored. */
const DERIVED_FIELDS = Object.freeze({
  opportunityScore: 'opportunityScore is derived from the deal calculators — remove it from the row',
  composite: 'composite is derived — remove it from the row',
  bestStrategy: 'bestStrategy is derived — remove it from the row',
  why: "why is generated from the signal and the underwriting — use 'note' for local color",
});

function finite(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

export function primarySignal(property) {
  const signals = Array.isArray(property?.signals) ? property.signals : [];
  let best = null;
  let rank = -1;
  for (const signal of signals) {
    const type = String(signal?.type || '');
    const next = PRIMARY_SIGNAL_RANK[type] ?? 0;
    if (next > rank) {
      rank = next;
      best = signal;
    }
  }
  return best;
}

/**
 * An enriched row already carries its composite; a bare row is scored on the
 * spot so nothing has to guess at an average of four strategy scores.
 */
export function compositeScore(property) {
  const stored = Number(property?.composite);
  if (Number.isFinite(stored)) return stored;
  if (!property) return 0;
  return scoreProperty(property).composite;
}

/**
 * Validates an *authored* mock row. Enriched rows deliberately fail this —
 * a row that ships its own opportunityScore is a row that can contradict the
 * underwriting sitting next to it.
 */
export function validateProperty(property) {
  const errors = [];
  if (!property || typeof property !== 'object') return ['property is required'];
  if (!property.id) errors.push('id');
  if (!property.address) errors.push('address');
  if (!Number.isFinite(Number(property.lat))) errors.push('lat');
  if (!Number.isFinite(Number(property.lng))) errors.push('lng');
  if (!property.propertyType) errors.push('propertyType');
  // A sale date cannot be derived without knowing whose courthouse it is on.
  if (!Object.hasOwn(COUNTIES, String(property.county || ''))) errors.push('county');
  if (!Number.isFinite(Number(property.estimatedValue))) errors.push('estimatedValue');
  if (!Number.isFinite(Number(property.estimatedEquityPct))) errors.push('estimatedEquityPct');
  for (const [field, message] of Object.entries(DERIVED_FIELDS)) {
    if (Object.hasOwn(property, field)) errors.push(message);
  }
  if (!Array.isArray(property.signals) || property.signals.length === 0) errors.push('signals');
  else {
    property.signals.forEach((signal, index) => {
      // A ranking label smuggled in as a signal fails here: it is not a type.
      if (!SIGNAL_TYPES.includes(signal?.type)) errors.push(`signals[${index}].type`);
      if (!Number.isFinite(Number(signal?.confidence))) errors.push(`signals[${index}].confidence`);
      if (!signal?.effectiveDate) errors.push(`signals[${index}].effectiveDate`);
      if (!signal?.source) errors.push(`signals[${index}].source`);
    });
  }
  const deal = property.deal || {};
  for (const key of ['purchase', 'rehab', 'arv', 'rent']) {
    if (!Number.isFinite(Number(deal[key]))) errors.push(`deal.${key}`);
  }
  return errors;
}

export function isDemoProperty(property) {
  const id = String(property?.id || '');
  return id.startsWith('DEMO-') || id.startsWith('MOCK-') || property?.demo === true;
}

export function cloneProperty(property) {
  return structuredClone
    ? structuredClone(property)
    : JSON.parse(JSON.stringify(property));
}

export { finite };
