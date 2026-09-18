/** Round currency to cents. */
export function money(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 100) / 100;
}

/** Round a ratio to 6 decimal places. */
export function ratio(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 1e6) / 1e6;
}

/** Standard amortizing payment. */
export function pmt(annualRate, years, principal) {
  const p = Number(principal);
  const n = Math.round(Number(years) * 12);
  if (!Number.isFinite(p) || p <= 0 || n <= 0) return 0;
  const monthly = Number(annualRate) / 12;
  if (!Number.isFinite(monthly) || monthly === 0) return money(p / n);
  const pow = (1 + monthly) ** n;
  return money((p * monthly * pow) / (pow - 1));
}

export function requireFinite(name, value) {
  const n = Number(value);
  if (!Number.isFinite(n)) {
    throw new TypeError(`${name} must be a finite number`);
  }
  return n;
}
