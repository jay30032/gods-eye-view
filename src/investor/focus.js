import { primarySignal, compositeScore } from './mock/schema.js';
import { analyzePropertyDeal, bestStrategyFor } from './deal/index.js';

export function whyThisMatters(property, analysis = null) {
  if (property?.why) return property.why;
  const signal = primarySignal(property);
  const strategy = bestStrategyFor(property);
  const score = compositeScore(property);
  const parts = [
    `${property?.address || 'This property'} scores ${score} on the mock board`,
    signal ? `with a ${signal.type.replaceAll('_', ' ').toLowerCase()} signal` : null,
    `Best path looks like ${strategy.toUpperCase()}`,
  ].filter(Boolean);
  if (analysis?.profit != null) parts.push(`modeled profit ${formatUsd(analysis.profit)}`);
  if (analysis?.coc != null) parts.push(`cash-on-cash ${formatPct(analysis.coc)}`);
  return `${parts.join(' — ')}.`;
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
  const best = strategy || bestStrategyFor(property);
  const run = analysis || analyzePropertyDeal(property, best);
  return {
    id: property.id,
    address: property.address,
    neighborhood: property.neighborhood,
    propertyType: property.propertyType,
    estimatedValue: formatUsd(property.estimatedValue),
    estimatedEquityPct: formatPct(property.estimatedEquityPct),
    score: compositeScore(property),
    scores: property.opportunityScore,
    signalType: signal?.type || 'DISTRESS',
    signalConfidence: signal ? Math.round(signal.confidence * 100) : 0,
    strategy: best,
    analysis: run,
    why: whyThisMatters(property, revealDeal ? run : null),
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
