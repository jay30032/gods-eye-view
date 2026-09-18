import { compositeScore, primarySignal } from '../mock/schema.js';

const CELL_BY_LOD = Object.freeze({
  globe: 0.35,
  regional: 0.12,
  city: 0.04,
});

function cellKey(lat, lng, size) {
  const y = Math.floor(lat / size);
  const x = Math.floor(lng / size);
  return `${y}:${x}`;
}

export function clusterProperties(properties, lodId) {
  const size = CELL_BY_LOD[lodId];
  if (!size) {
    return properties.map((property) => ({
      id: `single:${property.id}`,
      lat: property.lat,
      lng: property.lng,
      count: 1,
      score: compositeScore(property),
      signalType: primarySignal(property)?.type || 'DISTRESS',
      members: [property.id],
      singleton: true,
      property,
    }));
  }

  const buckets = new Map();
  for (const property of properties) {
    const key = cellKey(property.lat, property.lng, size);
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = { key, lat: 0, lng: 0, score: 0, members: [], best: property };
      buckets.set(key, bucket);
    }
    bucket.lat += property.lat;
    bucket.lng += property.lng;
    const score = compositeScore(property);
    bucket.score += score;
    bucket.members.push(property.id);
    if (score > compositeScore(bucket.best)) bucket.best = property;
  }

  return [...buckets.values()].map((bucket) => {
    const count = bucket.members.length;
    return {
      id: `cluster:${bucket.key}`,
      lat: bucket.lat / count,
      lng: bucket.lng / count,
      count,
      score: Math.round(bucket.score / count),
      signalType: primarySignal(bucket.best)?.type || 'DISTRESS',
      members: bucket.members,
      singleton: count === 1,
      property: count === 1 ? bucket.best : null,
    };
  });
}
