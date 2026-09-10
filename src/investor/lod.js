/**
 * Camera-height LOD for Opportunity Vision.
 *
 * globe      > 2,000 km   clusters only
 * regional     200–2,000 km clusters
 * city          20–200 km  pulses, no parcel
 * neighborhood   2–20 km   pulses + glow
 * street       < 2 km      full detail + halo
 */

export const LOD_BANDS = Object.freeze({
  globe: Object.freeze({ id: 'globe', minHeightM: 2_000_000, showClusters: true, showPulses: false, showGlow: false, showHalo: false, showLabels: false }),
  regional: Object.freeze({ id: 'regional', minHeightM: 200_000, showClusters: true, showPulses: false, showGlow: false, showHalo: false, showLabels: false }),
  city: Object.freeze({ id: 'city', minHeightM: 20_000, showClusters: false, showPulses: true, showGlow: false, showHalo: true, showLabels: false }),
  neighborhood: Object.freeze({ id: 'neighborhood', minHeightM: 2_000, showClusters: false, showPulses: true, showGlow: true, showHalo: true, showLabels: false }),
  street: Object.freeze({ id: 'street', minHeightM: 0, showClusters: false, showPulses: true, showGlow: true, showHalo: true, showLabels: true }),
});

export function lodFromHeight(heightM) {
  const height = Number(heightM);
  const safe = Number.isFinite(height) ? height : 20_000_000;
  if (safe >= LOD_BANDS.globe.minHeightM) return LOD_BANDS.globe;
  if (safe >= LOD_BANDS.regional.minHeightM) return LOD_BANDS.regional;
  if (safe >= LOD_BANDS.city.minHeightM) return LOD_BANDS.city;
  if (safe >= LOD_BANDS.neighborhood.minHeightM) return LOD_BANDS.neighborhood;
  return LOD_BANDS.street;
}

export function cameraHeightM(viewer) {
  try {
    return viewer?.camera?.positionCartographic?.height ?? null;
  } catch {
    return null;
  }
}

const DEG2RAD = Math.PI / 180;

export function haversineKm(lat1, lng1, lat2, lng2) {
  const r = 6371;
  const dLat = (lat2 - lat1) * DEG2RAD;
  const dLng = (lng2 - lng1) * DEG2RAD;
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(lat1 * DEG2RAD) * Math.cos(lat2 * DEG2RAD) * Math.sin(dLng / 2) ** 2;
  return 2 * r * Math.asin(Math.min(1, Math.sqrt(a)));
}

export function isNearMarket(viewer, market, radiusKm = 80) {
  try {
    const carto = viewer?.camera?.positionCartographic;
    if (!carto || !market) return false;
    const lat = carto.latitude * 180 / Math.PI;
    const lng = carto.longitude * 180 / Math.PI;
    return haversineKm(lat, lng, market.lat, market.lng) <= radiusKm;
  } catch {
    return false;
  }
}
