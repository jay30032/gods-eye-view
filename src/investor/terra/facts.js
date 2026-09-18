/**
 * Every number an investor could ask about a house, in plain labels.
 *
 * The snapshot carries one headline per house; this carries the whole
 * underwrite — all four strategies with every line item, the assumptions the
 * calculators ran under, the signals with their dates, the county, the lot,
 * the owner's equity and the entry against value — so the assistant can
 * answer "what are the rental numbers" or "what's the MAO" from a tool
 * result rather than from memory. Nothing here is rounded beyond what the
 * calculators themselves produce (cents on money, six places on ratios);
 * percentages are the ratio times 100 to two places, which is the same
 * number said as a percent.
 *
 * Pure. Overrides — the what-ifs in the conversation — are passed in.
 */
import { analyzePropertyDeal, bestStrategyFor } from '../deal/index.js';
import { equityScore, signalStrength, strategyHeadline } from '../scoring.js';
import { compositeScore, primarySignal, signalLabel } from '../mock/schema.js';
import { formatSaleDate, resolveCounty } from '../georgia.js';
import { geometryFor } from '../mock/geometry.js';
import { whyThisMatters } from '../focus.js';
import { demoNow } from '../clock.js';
import { PLAY_WORDS } from './snapshot.js';

export const STRATEGIES = Object.freeze(['flip', 'rental', 'brrrr', 'wholesale']);

/** A coverage ratio as it is quoted: 1.448629 → 1.45. */
export function coverage(value) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : null;
}

/** A ratio as a percentage to two places: 0.086739 → 8.67. */
export function pct(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.round(n * 10000) / 100;
}

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function shortAddress(property) {
  return String(property?.address || '').split(',')[0];
}

/** The assumptions a run used, said the way an investor says them. */
export function plainAssumptions(a) {
  if (!a) return null;
  return {
    buyClosingPct: pct(a.buyClosingRate),
    sellClosingPct: pct(a.sellClosingRate),
    rehabContingencyPct: pct(a.rehabContingencyRate),
    hardMoneyRatePct: pct(a.hardMoneyAnnualRate),
    hardMoneyPointsPct: pct(a.hardMoneyPoints),
    hardMoneyLoanToCostPct: pct(a.hardMoneyLtcRate),
    flipHoldMonths: a.flipHoldMonths,
    carryingCostPctOfArvPerYear: pct(a.carryAnnualRate),
    vacancyPct: pct(a.vacancyRate),
    managementPct: pct(a.managementRate),
    maintenancePct: pct(a.maintenanceRate),
    capexPct: pct(a.capexRate),
    propertyTaxPctOfArv: pct(a.propertyTaxRate),
    insurancePerUnitPerYear: a.insuranceAnnualPerUnit,
    downPaymentPct: pct(a.downPaymentRate),
    mortgageRatePct: pct(a.mortgageAnnualRate),
    mortgageYears: a.mortgageYears,
    refiLtvPct: pct(a.brrrrLtv),
    refiClosingPct: pct(a.refiClosingRate),
    seasoningMonths: a.brrrrSeasoningMonths,
    maoRulePctOfArv: pct(a.wholesaleMaoRate),
    wholesaleFeePctOfSpread: pct(a.wholesaleFeeRate),
    wholesaleFeeMin: a.wholesaleFeeMin,
    wholesaleFeeMax: a.wholesaleFeeMax,
    verdictBars: {
      flipStrongProfit: a.flipStrongProfit,
      flipStrongMarginPct: pct(a.flipStrongMargin),
      flipThinProfit: a.flipThinProfit,
      rentalStrongCashOnCashPct: pct(a.rentalStrongCoc),
      rentalStrongDscr: a.rentalStrongDscr,
      brrrrStrongCashLeftIn: a.brrrrStrongCashLeftIn,
      brrrrStrongCashFlowMonthly: a.brrrrStrongCashFlow,
      wholesaleStrongFee: a.wholesaleStrongFee,
      wholesaleThinFee: a.wholesaleThinFee,
    },
  };
}

/** One strategy's line items, labelled. */
export function plainStrategy(analysis) {
  if (!analysis) return null;
  const s = analysis.strategy;
  const common = {
    play: PLAY_WORDS[s] || s,
    verdict: analysis.verdict,
    headline: strategyHeadline(analysis),
    purchase: num(analysis.purchase),
    rehab: num(analysis.rehab),
    contingency: num(analysis.rehabTotal) != null && num(analysis.rehab) != null
      ? Math.round((analysis.rehabTotal - analysis.rehab) * 100) / 100
      : null,
    rehabWithContingency: num(analysis.rehabTotal),
    arv: num(analysis.arv),
  };
  if (s === 'flip') {
    return {
      ...common,
      financing: analysis.allCash ? 'all cash' : 'hard money',
      buyClosing: analysis.buyClosing,
      sellClosing: analysis.sellClosing,
      loanAmount: analysis.loanAmount,
      points: analysis.points,
      interest: analysis.interest,
      carryingCost: analysis.carry,
      holdMonths: analysis.holdMonths,
      allIn: analysis.allIn,
      profit: analysis.profit,
      cashNeeded: analysis.cashIn,
      cashOnCashPct: pct(analysis.roi),
      annualizedPct: pct(analysis.roiAnnualized),
      marginPct: pct(analysis.margin),
      mao70: analysis.mao70,
    };
  }
  if (s === 'rental') {
    return {
      ...common,
      rentMonthly: analysis.rent,
      units: analysis.units,
      grossRentAnnual: analysis.grossRent,
      vacancy: analysis.vacancy,
      management: analysis.management,
      maintenance: analysis.maintenance,
      capex: analysis.capex,
      propertyTaxes: analysis.taxes,
      insurance: analysis.insurance,
      operatingExpenses: analysis.opex,
      noi: analysis.noi,
      capRatePct: pct(analysis.capRate),
      yieldOnCostPct: pct(analysis.yieldOnCost),
      downPayment: analysis.downPayment,
      loan: analysis.loan,
      buyClosing: analysis.buyClosing,
      monthlyPayment: analysis.monthlyDebt,
      annualDebtService: analysis.annualDebt,
      cashFlowMonthly: analysis.cashFlowMonthly,
      cashFlowAnnual: analysis.cashFlowAnnual,
      cashInvested: analysis.cashInvested,
      cashOnCashPct: pct(analysis.coc),
      dscr: coverage(analysis.dscr),
    };
  }
  if (s === 'brrrr') {
    return {
      ...common,
      rentMonthly: analysis.rent,
      units: analysis.units,
      financing: analysis.allCash ? 'all cash' : 'hard money',
      buyClosing: analysis.buyClosing,
      loanAmount: analysis.loanAmount,
      points: analysis.points,
      interest: analysis.interest,
      carryingCost: analysis.carry,
      seasoningMonths: analysis.holdMonths,
      allIn: analysis.allIn,
      refinanceAmount: analysis.refinanceAmount,
      refiLtvPct: pct(analysis.ltv),
      refiClosing: analysis.refiClosing,
      cashLeftIn: analysis.cashLeftIn,
      cashOut: analysis.cashOut,
      noi: analysis.noi,
      monthlyPayment: analysis.monthlyDebt,
      annualDebtService: analysis.annualDebt,
      cashFlowMonthly: analysis.cashFlowMonthly,
      cashFlowAnnual: analysis.cashFlowAnnual,
      cashOnCashPct: analysis.infiniteReturn ? 'infinite' : pct(analysis.coc),
      dscr: coverage(analysis.dscr),
    };
  }
  if (s === 'wholesale') {
    return {
      ...common,
      mao: analysis.mao,
      spread: analysis.spread,
      assignmentFee: analysis.assignmentFee,
      buyerPays: analysis.buyerPays,
      buyerDiscountToArvPct: pct(analysis.buyerDiscountToArv),
      viable: Boolean(analysis.viable),
    };
  }
  return common;
}

function safe(property, strategy, overrides) {
  try {
    return analyzePropertyDeal(property, strategy, overrides);
  } catch {
    return null;
  }
}

/** The signals, with their dates and the sale they lead to. */
export function plainSignals(property, { now = demoNow() } = {}) {
  const strength = signalStrength(property, { now });
  return (property?.signals || []).map((signal) => {
    const primary = primarySignal(property);
    const isPrimary = primary && primary.type === signal.type && primary.effectiveDate === signal.effectiveDate;
    const auction = isPrimary ? strength.auction : null;
    return {
      type: signalLabel(signal.type),
      source: String(signal.source || '').replace(/^MOCK\//i, ''),
      filed: signal.effectiveDate || null,
      ageDays: isPrimary ? strength.ageDays : null,
      confidencePct: Math.round(Number(signal.confidence || 0) * 100),
      auction: auction
        ? { date: formatSaleDate(auction.date), daysUntil: auction.daysUntil, courthouse: auction.courthouse, legalOrgan: auction.legalOrgan }
        : null,
      taxDeed: isPrimary && strength.taxDeed
        ? { redemptionMonths: strength.taxDeed.redemptionMonths, premiumPct: pct(strength.taxDeed.premiumRate) }
        : null,
    };
  });
}

/**
 * @param {object} property an enriched row
 * @param {{overrides?:object, now?:Date}} [options] `overrides` are the
 *   conversation's what-ifs, exactly as `analyzePropertyDeal` takes them
 */
export function propertyFacts(property, { overrides = {}, now = demoNow() } = {}) {
  if (!property) return null;
  const analyses = {};
  for (const strategy of STRATEGIES) analyses[strategy] = safe(property, strategy, overrides);
  const county = resolveCounty(property.county);
  const record = geometryFor(property.id);
  const parcel = record?.parcel && record.parcel.source !== 'synthetic'
    ? { acres: record.parcel.areaAcres ?? null, squareMeters: record.parcel.areaM2 ?? null, source: record.parcel.attribution || record.parcel.source }
    : null;
  const value = num(property.estimatedValue);
  const purchase = num(property.deal?.purchase);
  const best = bestStrategyFor(property);
  const any = Object.values(analyses).find(Boolean);
  const strength = signalStrength(property, { now });

  return {
    id: property.id,
    address: property.address,
    neighborhood: property.neighborhood || null,
    city: property.city || null,
    county: county ? { name: county.name, legalOrgan: county.legalOrgan, courthouse: county.courthouse } : null,
    propertyType: property.propertyType || null,
    beds: property.beds ?? null,
    baths: property.baths ?? null,
    sqft: property.sqft ?? null,
    yearBuilt: property.yearBuilt ?? null,
    estimatedValue: value,
    ownerEquityPct: pct(property.estimatedEquityPct),
    entry: value && purchase != null
      ? { purchase, underValuePct: pct(1 - purchase / value), discount: Math.round((value - purchase) * 100) / 100 }
      : null,
    parcel,
    signals: plainSignals(property, { now }),
    signalStrength: Math.round(strength.strength * 100) / 100,
    equityScore: Math.round(equityScore(property) * 100) / 100,
    composite: compositeScore(property),
    scores: property.opportunityScore || null,
    deal: {
      purchase,
      rehab: num(property.deal?.rehab),
      arv: num(property.deal?.arv),
      rentMonthly: num(property.deal?.rent),
      units: any?.units ?? null,
    },
    bestPlay: PLAY_WORDS[best] || best,
    verdicts: Object.fromEntries(STRATEGIES.map((s) => [s, analyses[s]?.verdict || null])),
    strategies: Object.fromEntries(STRATEGIES.map((s) => [s, plainStrategy(analyses[s])])),
    assumptions: plainAssumptions(any?.assumptions),
    overridesInUse: {
      dealOverrides: { ...(overrides.dealOverrides || {}) },
      rehabDelta: Number(overrides.rehabDelta || 0),
      assumptionOverrides: { ...(overrides.assumptionOverrides || {}) },
    },
    why: whyThisMatters(property, analyses[best], { now }),
    note: property.note || null,
  };
}

/**
 * Why each house ranks where it does: the composite and the three parts it is
 * made of, the best play, and the drivers the card shows.
 */
export function rankFacts(properties, ids = null, { now = demoNow() } = {}) {
  const rows = (ids && ids.length
    ? ids.map((id) => properties.find((row) => row.id === id)).filter(Boolean)
    : properties.slice().sort((a, b) => compositeScore(b) - compositeScore(a)));
  return rows.map((row, index) => {
    const best = bestStrategyFor(row);
    const strength = signalStrength(row, { now });
    const bestScore = Number(row.opportunityScore?.[best]) || 0;
    const others = STRATEGIES.filter((s) => s !== best && row.analyses?.[s]?.verdict && row.analyses[s].verdict !== 'pass').length;
    return {
      rank: index + 1,
      id: row.id,
      address: shortAddress(row),
      composite: compositeScore(row),
      bestPlay: PLAY_WORDS[best] || best,
      verdict: row.analyses?.[best]?.verdict || null,
      headline: row.analyses?.[best] ? strategyHeadline(row.analyses[best]) : null,
      parts: {
        bestPlayScore: bestScore,
        bestPlayWeightPct: 55,
        signalStrength: Math.round(strength.strength * 100) / 100,
        signalWeightPct: 25,
        equityScore: Math.round(equityScore(row) * 100) / 100,
        equityWeightPct: 20,
        otherPathsThatWork: others,
        otherPathsBonus: Math.min(6, others * 2),
      },
      scores: row.opportunityScore || null,
      drivers: Array.isArray(row.drivers) ? row.drivers.slice() : [],
      signal: signalLabel(primarySignal(row)?.type),
      auctionDays: row.auction?.daysUntil ?? null,
      ownerEquityPct: pct(row.estimatedEquityPct),
    };
  });
}

/** Two houses side by side on one strategy, with the differences. */
export function compareFacts(a, b, strategy = null, { overrides = {}, now = demoNow() } = {}) {
  if (!a || !b) return null;
  const play = STRATEGIES.includes(strategy) ? strategy : bestStrategyFor(a);
  const left = plainStrategy(safe(a, play, overrides));
  const right = plainStrategy(safe(b, play, {}));
  const deltas = {};
  for (const key of Object.keys(left || {})) {
    if (typeof left[key] === 'number' && typeof right?.[key] === 'number') {
      deltas[key] = Math.round((left[key] - right[key]) * 100) / 100;
    }
  }
  return {
    strategy: play,
    play: PLAY_WORDS[play] || play,
    a: { id: a.id, address: shortAddress(a), composite: compositeScore(a), auctionDays: a.auction?.daysUntil ?? null, ...left },
    b: { id: b.id, address: shortAddress(b), composite: compositeScore(b), auctionDays: b.auction?.daysUntil ?? null, ...right },
    aMinusB: deltas,
    clock: now.toISOString().slice(0, 10),
  };
}

const PCT_KEY = /Pct$/;
const RATIO_KEYS = new Set(['dscr']);
const KEEP_EXACT = new Set(['acres', 'squareMeters', 'ageDays', 'daysUntil', 'confidencePct', 'composite', 'rank',
  'beds', 'baths', 'sqft', 'yearBuilt', 'units', 'holdMonths', 'seasoningMonths', 'mortgageYears', 'flipHoldMonths',
  'bestPlayWeightPct', 'signalWeightPct', 'equityWeightPct', 'otherPathsThatWork', 'otherPathsBonus', 'signalStrength', 'equityScore']);

/**
 * The facts as they are said: money to the dollar, percentages to one
 * decimal, coverage to two. The calculators keep their cents and the card
 * shows them; the model gets what an investor would say out loud, so it
 * never has to round on its feet.
 */
export function spokenFacts(value, key = '') {
  if (Array.isArray(value)) return value.map((item) => spokenFacts(item, key));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, spokenFacts(v, k)]));
  }
  if (typeof value !== 'number' || !Number.isFinite(value)) return value;
  if (KEEP_EXACT.has(key)) return value;
  if (PCT_KEY.test(key)) return Math.round(value * 10) / 10;
  if (RATIO_KEYS.has(key)) return Math.round(value * 100) / 100;
  return Math.round(value);
}
