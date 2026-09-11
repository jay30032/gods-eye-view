/**
 * Door count by property type. Insurance and the rental operating model are
 * priced per unit, so a duplex is not a single-family house with two leases.
 */
export const UNITS_BY_PROPERTY_TYPE = Object.freeze({
  sfr: 1,
  condo: 1,
  townhouse: 1,
  duplex: 2,
  triplex: 3,
  quad: 4,
  small_multifamily: 3,
});

export const DEFAULT_UNITS = 1;

/** Explicit `property.units` always wins; otherwise infer from the type. */
export function unitsFor(propertyType, explicitUnits) {
  const explicit = Number(explicitUnits);
  if (Number.isFinite(explicit) && explicit >= 1) return Math.floor(explicit);
  const key = String(propertyType || '').trim().toLowerCase();
  return UNITS_BY_PROPERTY_TYPE[key] ?? DEFAULT_UNITS;
}
