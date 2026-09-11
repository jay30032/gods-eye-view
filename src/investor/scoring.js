/**
 * Derived scoring for TerraSignal Investor.
 *
 * Nothing in here is typed by hand. A property's four strategy scores fall out
 * of the deal calculators, the signal term falls out of the signal block, and
 * the composite blends them with equity. That is what keeps a score from
 * disagreeing with the verdict printed next to it: the verdict *sets the band*
 * the score is allowed to sit in.
 *
 * The gold pick is not in here either. It is the first row of a ranking, which
 * makes it an output of `findMoney`, not a fact about a house.
 *
 * Note on imports: `mock/schema.js` imports `scoreProperty` for its
 * `compositeScore` fallback while this module imports `primarySignal` from it.
 * The cycle is call-time only — neither module touches the other while it is
 * still evaluating.
 */
import { analyzePropertyDeal } from './deal/index.js';
import { primarySignal } from './mock/schema.js';

export const STRATEGY_KEYS = Object.freeze(['flip', 'rental', 'brrrr', 'wholesale']);

/** How much a signal type is worth before confidence and age are applied. */
export const SIGNAL_WEIGHTS = Object.freeze({
  FORECLOSURE: 1.0,
  TAX_SALE: 0.95,
  PREFORECLOSURE: 0.80,
  DISTRESS: 0.65,
  LISTED_OPPORTUNITY: 0.50,
});

const DAY_MS = 86_400_000;
const RECENCY_FRESH_DAYS = 90;
const RECENCY_STALE_DAYS = 365;
const RECENCY_FLOOR = 0.6;
const STACK_BONUS = 8;
const STACK_BONUS_MAX = 16;
const EQUITY_FULL_PCT = 0.45;
const SUPPORT_BONUS = 2;
const SUPPORT_BONUS_MAX = 6;

export function clamp01(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.min(1, Math.max(0, n));
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function utcDay(value) {
  const date = value instanceof Date ? value : new Date(Number(value));
  const ms = date.getTime();
  if (!Number.isFinite(ms)) return null;
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
}

/** Parse a `YYYY-MM-DD` signal date as UTC midnight so ages never drift by zone. */
export function parseSignalDate(effectiveDate) {
  const text = String(effectiveDate || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return null;
  const ms = Date.parse(`${text}T00:00:00Z`);
  return Number.isFinite(ms) ? ms : null;
}

/** Whole days between a signal's effective date and `now`, never negative. */
export function signalAgeDays(effectiveDate, now = Date.now()) {
  const filed = parseSignalDate(effectiveDate);
  const today = utcDay(now);
  if (filed == null || today == null) return null;
  return Math.max(0, Math.round((today - filed) / DAY_MS));
}

/**
 * Fresh for a quarter, then a straight line down to a 0.6 floor at a year.
 * A foreclosure filed last week is not the same lead as one filed last spring.
 */
export function recencyFactor(ageDays) {
  if (ageDays == null) return RECENCY_FLOOR;
  if (ageDays <= RECENCY_FRESH_DAYS) return 1;
  if (ageDays >= RECENCY_STALE_DAYS) return RECENCY_FLOOR;
  const span = RECENCY_STALE_DAYS - RECENCY_FRESH_DAYS;
  return 1 - (1 - RECENCY_FLOOR) * ((ageDays - RECENCY_FRESH_DAYS) / span);
}

function rawStrategyScore(analysis) {
  if (!analysis) return 0;
  if (analysis.strategy === 'flip') {
    return clamp01(num(analysis.margin) / 0.20) * 60
      + clamp01(num(analysis.profit) / 60000) * 40;
  }
  if (analysis.strategy === 'rental') {
    return clamp01(num(analysis.coc) / 0.12) * 60
      + clamp01((num(analysis.dscr) - 1.0) / 0.5) * 40;
  }
  if (analysis.strategy === 'brrrr') {
    if (analysis.infiniteReturn && num(analysis.cashFlowAnnual) > 0) return 100;
    return (1 - clamp01(num(analysis.cashLeftIn) / 50000)) * 50
      + clamp01(num(analysis.cashFlowMonthly) / 400) * 50;
  }
  if (analysis.strategy === 'wholesale') {
    if (!analysis.viable) return 0;
    return clamp01(num(analysis.assignmentFee) / 25000) * 70
      + clamp01(num(analysis.buyerDiscountToArv) / 0.35) * 30;
  }
  return 0;
}

/**
 * 0–100 for one underwritten strategy, forced to agree with its own verdict.
 * A "pass" can never print 71 next to the word pass.
 */
export function scoreStrategy(analysis) {
  const raw = rawStrategyScore(analysis);
  const verdict = String(analysis?.verdict || 'pass').trim().toLowerCase();
  if (verdict === 'strong') return Math.round(Math.max(70, raw));
  if (verdict === 'thin') return Math.round(clamp(raw, 40, 69));
  return Math.round(Math.min(raw, 39));
}

/**
 * 0–100 for the urgency of a property's signal stack, plus the primary
 * signal's age so callers do not have to re-parse the date.
 */
export function signalStrength(property, { now = Date.now() } = {}) {
  const signals = Array.isArray(property?.signals) ? property.signals : [];
  const primary = primarySignal(property);
  if (!primary) {
    return Object.freeze({
      strength: 0,
      ageDays: null,
      type: null,
      confidence: 0,
      source: null,
      effectiveDate: null,
    });
  }
  const weight = SIGNAL_WEIGHTS[primary.type] ?? 0.5;
  const confidence = clamp01(primary.confidence);
  const ageDays = signalAgeDays(primary.effectiveDate, now);
  const base = weight * confidence * 100 * recencyFactor(ageDays);
  const stacked = Math.min(STACK_BONUS_MAX, Math.max(0, signals.length - 1) * STACK_BONUS);
  return Object.freeze({
    strength: clamp(base + stacked, 0, 100),
    ageDays,
    type: primary.type,
    confidence,
    source: primary.source || null,
    effectiveDate: primary.effectiveDate || null,
  });
}

/** 0–100, saturating at 45% owner equity. */
export function equityScore(property) {
  return clamp01(num(property?.estimatedEquityPct) / EQUITY_FULL_PCT) * 100;
}

/**
 * Headline money: `$61k` above ten grand, `$9.7k` in the thousands, exact
 * dollars below that. One figure an investor can repeat out loud.
 */
export function headlineUsd(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '$0';
  const sign = n < 0 ? '-' : '';
  const abs = Math.abs(n);
  if (abs >= 10000) return `${sign}$${Math.round(abs / 1000)}k`;
  if (abs >= 1000) {
    const k = Math.round(abs / 100) / 10;
    return `${sign}$${Number.isInteger(k) ? k : k.toFixed(1)}k`;
  }
  return `${sign}$${Math.round(abs).toLocaleString('en-US')}`;
}

function pct1(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '0%';
  if (n >= 10) return '∞';
  return `${(n * 100).toFixed(1)}%`;
}

/**
 * The one number that decides each strategy. `short` is the driver-strip form;
 * the full form is what "Why?" speaks. Neither is a breakdown — the breakdown
 * stays behind "Show me the deal".
 */
export function strategyHeadline(analysis, { short = false } = {}) {
  if (!analysis) return '';
  if (analysis.strategy === 'flip') {
    const profit = `${headlineUsd(analysis.profit)} profit`;
    return short ? profit : `${profit} on ${headlineUsd(analysis.cashIn)} cash in`;
  }
  if (analysis.strategy === 'rental') {
    const flow = `${headlineUsd(analysis.cashFlowMonthly)}/mo`;
    return short ? flow : `${flow}, ${pct1(analysis.coc)} cash-on-cash`;
  }
  if (analysis.strategy === 'brrrr') {
    if (num(analysis.cashLeftIn) > 0) {
      const left = `${headlineUsd(analysis.cashLeftIn)} left in`;
      return short ? left : `${left}, ${headlineUsd(analysis.cashFlowMonthly)}/mo`;
    }
    const out = `${headlineUsd(analysis.cashOut)} back out`;
    return short ? out : `${headlineUsd(0)} left in, ${out}`;
  }
  if (analysis.strategy === 'wholesale') {
    if (!analysis.viable) return 'no spread';
    const fee = `${headlineUsd(analysis.assignmentFee)} assignment`;
    return short ? fee : `${fee} on a ${headlineUsd(analysis.spread)} spread`;
  }
  return '';
}

function buildDrivers(property, { signal, discountToValue, bestStrategy, analyses }) {
  const drivers = [];
  if (signal.type) {
    const age = signal.ageDays == null ? 'date unknown' : `filed ${signal.ageDays} days ago`;
    drivers.push(`${signal.type.replaceAll('_', ' ')} ${Math.round(signal.confidence * 100)}%, ${age}`);
  }
  drivers.push(
    `${Math.round(num(property?.estimatedEquityPct) * 100)}% owner equity, `
    + `entry ${Math.round(discountToValue * 100)}% under value`,
  );
  const best = analyses[bestStrategy];
  if (best) {
    drivers.push(`${bestStrategy.toUpperCase()} ${best.verdict} — ${strategyHeadline(best, { short: true })}`);
  }
  const extra = (Array.isArray(property?.signals) ? property.signals.length : 0) - 1;
  if (extra > 0) drivers.push(`${extra} more signal${extra > 1 ? 's' : ''} stacked`);
  return drivers;
}

/**
 * Underwrite all four strategies, score each against its own verdict, and
 * blend the winner with signal urgency and owner equity.
 *
 * @param {object} property mock property row
 * @param {{now?:number|Date, assumptions?:object}} [options]
 */
export function scoreProperty(property, { now = Date.now(), assumptions = null } = {}) {
  const overrides = assumptions && typeof assumptions === 'object' ? assumptions : {};
  const analyses = {};
  const scores = {};
  for (const key of STRATEGY_KEYS) {
    let analysis = null;
    try {
      analysis = analyzePropertyDeal(property, key, overrides);
    } catch {
      // An incomplete deal block scores zero rather than taking down a rebuild.
      analysis = null;
    }
    analyses[key] = analysis;
    scores[key] = analysis ? scoreStrategy(analysis) : 0;
  }

  let bestStrategy = STRATEGY_KEYS[0];
  for (const key of STRATEGY_KEYS) {
    if (scores[key] > scores[bestStrategy]) bestStrategy = key;
  }
  const bestScore = scores[bestStrategy];

  const signal = signalStrength(property, { now });
  const equity = equityScore(property);
  const purchase = num(property?.deal?.purchase);
  const value = num(property?.estimatedValue);
  const discountToValue = value > 0 ? 1 - (purchase / value) : 0;

  // A house that only works one way is worth less than one that works three.
  const supporting = STRATEGY_KEYS
    .filter((key) => key !== bestStrategy)
    .filter((key) => analyses[key] && analyses[key].verdict !== 'pass').length;
  const supportBonus = Math.min(SUPPORT_BONUS_MAX, supporting * SUPPORT_BONUS);

  const composite = Math.round(clamp(
    0.55 * bestScore + 0.25 * signal.strength + 0.20 * equity + supportBonus,
    0,
    100,
  ));

  return Object.freeze({
    scores: Object.freeze(scores),
    analyses: Object.freeze(analyses),
    bestStrategy,
    bestScore,
    signalStrength: signal.strength,
    signalAgeDays: signal.ageDays,
    equityScore: equity,
    discountToValue,
    composite,
    drivers: Object.freeze(buildDrivers(property, {
      signal,
      discountToValue,
      bestStrategy,
      analyses,
    })),
  });
}

/**
 * A new frozen row carrying its derived scores. The input is never touched —
 * the mock dataset stays the only place facts live.
 */
export function enrichProperty(property, options = {}) {
  const scored = scoreProperty(property, options);
  return Object.freeze({
    ...property,
    opportunityScore: scored.scores,
    composite: scored.composite,
    bestStrategy: scored.bestStrategy,
    drivers: scored.drivers,
    analyses: scored.analyses,
  });
}
