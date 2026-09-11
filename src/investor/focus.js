import { primarySignal, compositeScore, signalLabel } from './mock/schema.js';
import { analyzePropertyDeal, bestStrategyFor } from './deal/index.js';
import { signalStrength, strategyHeadline } from './scoring.js';
import { demoNow } from './clock.js';
import { countdownWords, formatSaleDate } from './georgia.js';

const SIGNAL_DATE = new Intl.DateTimeFormat('en-US', {
  month: 'short',
  day: 'numeric',
  timeZone: 'UTC',
});

/** `DeKalb County Courthouse, Decatur` is the record; you say the first half. */
function courthouseWords(courthouse) {
  return String(courthouse || '').split(',')[0].trim();
}

/**
 * The sale a notice is advertising, said the way it would be said out loud.
 * Georgia sales are always a Tuesday, so naming the day is not decoration.
 */
export function auctionSentence(auction) {
  if (!auction) return null;
  const when = formatSaleDate(auction.date);
  const countdown = countdownWords(auction.daysUntil);
  if (!when || !countdown) return null;
  return `Auction Tuesday ${when} at the ${courthouseWords(auction.courthouse)} — ${countdown}.`;
}

/** A redeemable deed means the exit clock does not start at the sale. */
export function taxDeedSentence(taxDeed) {
  if (!taxDeed) return null;
  const premium = Math.round(Number(taxDeed.premiumRate || 0) * 100);
  return `Tax deed — ${taxDeed.redemptionMonths}-month redemption at a ${premium}% premium `
    + 'applies, so the flip clock starts after redemption.';
}

/**
 * `MOCK/notice-of-sale — The Champion` is said as `The Champion`: the kebab
 * slug in front is the feed's name for the filing, and the label already said
 * it. Sources whose lead is real words (`code enforcement — City of Atlanta`)
 * keep both halves. The card keeps the MOCK kicker either way.
 */
function spokenSource(source) {
  const text = String(source || 'mock source').replace(/^MOCK\//i, '');
  const [lead, ...rest] = text.split(' — ');
  if (rest.length && /^[a-z0-9]+(-[a-z0-9]+)+$/.test(lead)) return rest.join(' — ');
  return text;
}

/** `filed Aug 12 (29 days ago)` — but a filing from this morning says today. */
function filedWords(effectiveDate, ageDays) {
  const filed = filedOn(effectiveDate);
  if (!filed || ageDays == null) return '';
  if (ageDays === 0) return `filed ${filed} (today), `;
  if (ageDays === 1) return `filed ${filed} (1 day ago), `;
  return `filed ${filed} (${ageDays} days ago), `;
}

function filedOn(effectiveDate) {
  const ms = Date.parse(`${String(effectiveDate || '').slice(0, 10)}T00:00:00Z`);
  return Number.isFinite(ms) ? SIGNAL_DATE.format(ms) : null;
}

function safeAnalyze(property, strategy) {
  try {
    return analyzePropertyDeal(property, strategy);
  } catch {
    return null;
  }
}

/**
 * The explanation is generated, never authored. It reads the same signal, the
 * same equity, and the same underwriting the score came from, so the sentence
 * and the number beside it cannot drift apart.
 *
 * One headline figure only — the full breakdown waits for "Show me the deal".
 *
 * @param {object} property enriched mock row
 * @param {object|null} [analysis] used only when it is the best strategy's run
 * @param {{now?:number|Date}} [options]
 */
export function whyThisMatters(property, analysis = null, { now = demoNow() } = {}) {
  if (!property) return '';
  const best = bestStrategyFor(property);
  const run = analysis?.strategy === best ? analysis : safeAnalyze(property, best);
  const signal = signalStrength(property, { now });
  const sentences = [];

  if (signal.type) {
    sentences.push(
      `${signalLabel(signal.type)} — ${spokenSource(signal.source)}, `
      + `${filedWords(signal.effectiveDate, signal.ageDays)}`
      + `${Math.round(signal.confidence * 100)}% confidence.`,
    );
    const auction = auctionSentence(signal.auction);
    if (auction) sentences.push(auction);
  }

  const equityPct = Math.round(Number(property.estimatedEquityPct || 0) * 100);
  const purchase = Number(property.deal?.purchase || 0);
  const value = Number(property.estimatedValue || 0);
  const discount = value > 0 ? Math.round((1 - purchase / value) * 100) : 0;
  sentences.push(
    `Owner equity ${equityPct}%; entry at ${formatUsd(purchase)} is `
    + `${discount}% under the ${formatUsd(value)} estimate.`,
  );

  if (run) sentences.push(`Best path: ${best.toUpperCase()} — ${strategyHeadline(run)}.`);
  const redemption = taxDeedSentence(signal.taxDeed);
  if (redemption) sentences.push(redemption);
  if (property.note) sentences.push(String(property.note));
  return sentences.join(' ');
}

export function formatUsd(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '—';
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 0,
  }).format(n);
}

export function formatPct(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '—';
  if (n >= 10) return '∞';
  return `${(n * 100).toFixed(1)}%`;
}

export const VERDICT_LABELS = Object.freeze({
  strong: 'Strong',
  thin: 'Thin',
  pass: 'Pass',
});

/** Human label for a calculator verdict. */
export function verdictLabel(verdict) {
  const key = String(verdict || '').trim().toLowerCase();
  return VERDICT_LABELS[key] || 'Pass';
}

/**
 * Globe caption: strategy, verdict, and the two numbers that decide the deal.
 */
export function dealVisionCaption(strategy, analysis) {
  const name = String(strategy || analysis?.strategy || 'flip').toUpperCase();
  if (!analysis) return name;
  const head = `${name} · ${verdictLabel(analysis.verdict).toUpperCase()}`;

  if (analysis.strategy === 'flip' || name === 'FLIP') {
    return `${head}\nProfit ${formatUsd(analysis.profit)}\nCash in ${formatUsd(analysis.cashIn)}`;
  }
  if (analysis.strategy === 'rental' || name === 'RENTAL') {
    return `${head}\n${formatUsd(analysis.cashFlowMonthly)}/mo\nCoC ${formatPct(analysis.coc)}`;
  }
  if (analysis.strategy === 'brrrr' || name === 'BRRRR') {
    const capital = analysis.cashLeftIn > 0
      ? `Left in ${formatUsd(analysis.cashLeftIn)}`
      : `Cash out ${formatUsd(analysis.cashOut)}`;
    return `${head}\n${capital}\n${formatUsd(analysis.cashFlowMonthly)}/mo`;
  }
  if (analysis.strategy === 'wholesale' || name === 'WHOLESALE') {
    if (!analysis.viable) return `${head}\nNo spread\nMAO ${formatUsd(analysis.mao)}`;
    return `${head}\nFee ${formatUsd(analysis.assignmentFee)}\nSpread ${formatUsd(analysis.spread)}`;
  }
  return head;
}

export function focusCardModel(property, { analysis = null, strategy = null, revealDeal = false } = {}) {
  if (!property) return null;
  const signal = primarySignal(property);
  const bestStrategy = bestStrategyFor(property);
  const best = strategy || bestStrategy;
  const run = analysis || analyzePropertyDeal(property, best);
  return {
    id: property.id,
    address: property.address,
    neighborhood: property.neighborhood,
    propertyType: property.propertyType,
    note: property.note || '',
    estimatedValue: formatUsd(property.estimatedValue),
    estimatedEquityPct: formatPct(property.estimatedEquityPct),
    score: compositeScore(property),
    scores: property.opportunityScore || {},
    drivers: Array.isArray(property.drivers) ? property.drivers.slice() : [],
    signalType: signal?.type || 'DISTRESS',
    signalLabel: signalLabel(signal?.type),
    signalSource: spokenSource(signal?.source),
    signalDate: filedOn(signal?.effectiveDate),
    signalConfidence: signal ? Math.round(signal.confidence * 100) : 0,
    auction: property.auction || null,
    taxDeed: property.taxDeed || null,
    bestStrategy,
    strategy: best,
    analysis: run,
    // Why never changes when the deal opens — the reveal adds the breakdown,
    // it does not rewrite the reason.
    why: whyThisMatters(property),
    revealDeal: Boolean(revealDeal),
    demo: true,
  };
}

export function flyToProperty(viewer, Cesium, property, {
  heightM = 420,
  duration = 2.4,
  pitchDeg = -32,
} = {}) {
  if (!viewer || !property) return false;
  viewer.camera.cancelFlight();
  viewer.camera.flyTo({
    destination: Cesium.Cartesian3.fromDegrees(property.lng, property.lat, heightM),
    orientation: {
      heading: Cesium.Math.toRadians(18),
      pitch: Cesium.Math.toRadians(pitchDeg),
      roll: 0,
    },
    duration,
  });
  return true;
}

export function flyToMarket(viewer, Cesium, market, {
  heightM = market?.huntHeightM || 2200,
  duration = 3.2,
  onComplete,
} = {}) {
  if (!viewer || !market) return false;
  viewer.camera.cancelFlight();
  viewer.camera.flyTo({
    destination: Cesium.Cartesian3.fromDegrees(market.lng, market.lat, heightM),
    orientation: {
      heading: Cesium.Math.toRadians(12),
      pitch: Cesium.Math.toRadians(-48),
      roll: 0,
    },
    duration,
    complete: onComplete,
  });
  return true;
}

export function flyGlobeThenMarket(viewer, Cesium, market, { reduced = false } = {}) {
  if (!viewer || !market) return Promise.resolve();
  viewer.camera.setView({
    destination: Cesium.Cartesian3.fromDegrees(market.globeLng, market.globeLat, 18_000_000),
    orientation: {
      heading: 0,
      pitch: Cesium.Math.toRadians(-90),
      roll: 0,
    },
  });
  const first = reduced ? 0.6 : 4.8;
  const second = reduced ? 0.8 : 5.2;
  return new Promise((resolve) => {
    viewer.camera.flyTo({
      destination: Cesium.Cartesian3.fromDegrees(market.lng, market.lat, market.overviewHeightM),
      orientation: {
        heading: Cesium.Math.toRadians(8),
        pitch: Cesium.Math.toRadians(-55),
        roll: 0,
      },
      duration: first,
      complete: () => {
        viewer.camera.flyTo({
          destination: Cesium.Cartesian3.fromDegrees(market.lng, market.lat, market.huntHeightM),
          orientation: {
            heading: Cesium.Math.toRadians(16),
            pitch: Cesium.Math.toRadians(-38),
            roll: 0,
          },
          duration: second,
          complete: resolve,
        });
      },
    });
  });
}
