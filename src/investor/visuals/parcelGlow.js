import { lookForSignal, pulseAlpha } from './propertyPulse.js';

export function parcelGlowColor(Cesium, signalType, nowMs, reduced) {
  const look = lookForSignal(signalType);
  const [r, g, b] = look.color;
  const alpha = Math.min(0.38, pulseAlpha(nowMs, look, reduced) * 0.42);
  return new Cesium.Color(r, g, b, reduced ? 0.22 : alpha);
}

export function parcelRadiusM(propertyType) {
  if (propertyType === 'quad' || propertyType === 'small_multifamily') return 28;
  if (propertyType === 'duplex' || propertyType === 'triplex') return 22;
  if (propertyType === 'townhouse' || propertyType === 'condo') return 16;
  return 20;
}
