export const SIGNAL_TYPES = Object.freeze([
  'FORECLOSURE',
  'PREFORECLOSURE',
  'TAX_SALE',
  'DISTRESS',
  'LISTED_OPPORTUNITY',
  'TOP_PICK',
]);

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
  TOP_PICK: 6,
  FORECLOSURE: 5,
  TAX_SALE: 4,
  PREFORECLOSURE: 3,
  DISTRESS: 2,
  LISTED_OPPORTUNITY: 1,
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

export function compositeScore(property) {
  const scores = property?.opportunityScore || {};
  const values = ['flip', 'rental', 'brrrr', 'wholesale']
    .map((key) => Number(scores[key]))
    .filter(Number.isFinite);
  if (!values.length) return 0;
  return Math.round(values.reduce((sum, value) => sum + value, 0) / values.length);
}

export function validateProperty(property) {
  const errors = [];
  if (!property || typeof property !== 'object') return ['property is required'];
  if (!property.id) errors.push('id');
  if (!property.address) errors.push('address');
  if (!Number.isFinite(Number(property.lat))) errors.push('lat');
  if (!Number.isFinite(Number(property.lng))) errors.push('lng');
  if (!property.propertyType) errors.push('propertyType');
  if (!Number.isFinite(Number(property.estimatedValue))) errors.push('estimatedValue');
  if (!Number.isFinite(Number(property.estimatedEquityPct))) errors.push('estimatedEquityPct');
  const scores = property.opportunityScore || {};
  for (const key of ['flip', 'rental', 'brrrr', 'wholesale']) {
    if (!Number.isFinite(Number(scores[key]))) errors.push(`opportunityScore.${key}`);
  }
  if (!Array.isArray(property.signals) || property.signals.length === 0) errors.push('signals');
  else {
    property.signals.forEach((signal, index) => {
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
