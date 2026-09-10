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
