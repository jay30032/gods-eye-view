import {
  governorRequestRender,
  holdContinuousRender,
  releaseContinuousRender,
} from '../../renderGovernor.js';
import { primarySignal } from '../mock/schema.js';
import { cameraHeightM, isNearMarket, lodFromHeight } from '../lod.js';
import { clusterProperties } from './signalClusterer.js';
import {
  lookForSignal,
  pulseAlpha,
  pulseHeight,
  pulseScale,
  ringRotation,
} from './propertyPulse.js';
import { parcelGlowColor, parcelRadiusM } from './parcelGlow.js';
import { GOLD, goldColumnHeight, goldHaloAlpha, isTopPick } from './goldHalo.js';
import { dealVisionCaption } from '../focus.js';
import { createReducedMotionPolicy } from './reducedMotionPolicy.js';
import { SCAN_DURATION_MS, scanAlpha, scanIsActive, scanProgress, scanRadiusM } from './scanSweep.js';

const HOLD_ID = 'investor-opportunity';
const BASE_RADIUS = 14;
// Inside two weeks the sale is the headline, so the label goes gold with it.
const AUCTION_LABEL_GOLD_DAYS = 14;

function cesiumColor(Cesium, rgba, alphaOverride) {
  const [r, g, b, a] = rgba;
  return new Cesium.Color(r, g, b, alphaOverride ?? a);
}

function nowMs() {
  return Date.now();
}

/**
 * Opportunity Vision renderer. Animations ride Cesium CallbackProperty and
 * a single render-governor hold. There is no standalone requestAnimationFrame.
 */
export function createOpportunityVisualManager({
  viewer,
  Cesium,
  market,
  getProperties,
  enabled: startEnabled = false,
}) {
  const entities = viewer.entities;
  const reducedPolicy = createReducedMotionPolicy({
    onChange: () => syncHold(),
  });
  const owned = new Map();
  let enabled = Boolean(startEnabled);
  let dealStrategy = null;
  let dealAnalysis = null;
  let dealCaption = null;
  let focusedId = null;
  let shortlistIds = null;
  let topPickId = null;
  let savedId = null;
  let scanStartedAt = 0;
  let destroyed = false;
  let removeMove = null;

  function reduced() {
    return reducedPolicy.reduced;
  }

  function visibleProperties() {
    return typeof getProperties === 'function' ? (getProperties() || []) : [];
  }

  function needsContinuous() {
    if (destroyed || !enabled) return false;
    if (reduced()) return false;
    const lod = lodFromHeight(cameraHeightM(viewer));
    // Parked globe / regional clusters are static. Holding continuous
    // render here pegged laptop GPUs (Air) during the first-hunt modal.
    if (lod.id === 'globe' || lod.id === 'regional') return false;
    if (!isNearMarket(viewer, market, 220)) return false;
    return lod.showPulses === true;
  }

  function syncHold() {
    if (needsContinuous()) holdContinuousRender(HOLD_ID);
    else releaseContinuousRender(HOLD_ID);
    governorRequestRender('investor-vision');
  }

  function clearOwned() {
    for (const entity of owned.values()) {
      try { entities.remove(entity); } catch { /* already gone */ }
    }
    owned.clear();
  }

  function addOwned(id, entity) {
    owned.set(id, entity);
    return entity;
  }

  function rebuild() {
    if (destroyed) return;
    clearOwned();
    if (!enabled) {
      syncHold();
      return;
    }

    const lod = lodFromHeight(cameraHeightM(viewer));
    const properties = visibleProperties();
    const clusters = clusterProperties(properties, lod.showClusters && !shortlistIds ? lod.id : null);

    if (lod.showClusters && !shortlistIds) {
      for (const cluster of clusters) {
        const look = lookForSignal(cluster.signalType);
        addOwned(`cluster:${cluster.id}`, entities.add({
          id: `ts-cluster-${cluster.id}`,
          position: Cesium.Cartesian3.fromDegrees(cluster.lng, cluster.lat, 40),
          ellipse: {
            semiMajorAxis: 180 + cluster.count * 40,
            semiMinorAxis: 180 + cluster.count * 40,
            material: cesiumColor(Cesium, look.color, 0.28),
            outline: true,
            outlineColor: cesiumColor(Cesium, look.color, 0.7),
            height: 8,
          },
          label: {
            text: `${cluster.count} · ${cluster.score}`,
            font: '12px Inter, sans-serif',
            fillColor: Cesium.Color.WHITE,
            outlineColor: Cesium.Color.BLACK,
            outlineWidth: 2,
            style: Cesium.LabelStyle.FILL_AND_OUTLINE,
            pixelOffset: new Cesium.Cartesian2(0, -18),
            disableDepthTestDistance: Number.POSITIVE_INFINITY,
          },
          properties: { terrasignalCluster: cluster },
        }));
      }
      paintScan(lod);
      syncHold();
      return;
    }

    for (const property of properties) {
      if (shortlistIds && !shortlistIds.has(property.id) && property.id !== focusedId) {
        continue;
      }
      paintProperty(property, lod);
    }
    paintScan(lod);
    syncHold();
  }

  function paintProperty(property, lod) {
    const signal = primarySignal(property);
    const type = signal?.type || 'DISTRESS';
    const look = lookForSignal(type);
    const focused = property.id === focusedId;
    const top = isTopPick(property.id, topPickId);
    const saved = property.id === savedId;
    const dealBoost = dealStrategy
      ? Number(property.opportunityScore?.[dealStrategy] || 0) / 100
      : 0;

    const position = Cesium.Cartesian3.fromDegrees(property.lng, property.lat, 6);
    const radius = parcelRadiusM(property.propertyType);

    if (lod.showPulses) {
      addOwned(`pulse:${property.id}`, entities.add({
        id: `ts-pulse-${property.id}`,
        position,
        ellipse: {
          semiMajorAxis: new Cesium.CallbackProperty(() => {
            const scale = pulseScale(nowMs(), look, reduced());
            return BASE_RADIUS * scale * (focused ? 1.25 : 1) * (1 + dealBoost * 0.2);
          }, false),
          semiMinorAxis: new Cesium.CallbackProperty(() => {
            const scale = pulseScale(nowMs(), look, reduced());
            return BASE_RADIUS * scale * (focused ? 1.25 : 1) * (1 + dealBoost * 0.2);
          }, false),
          material: new Cesium.ColorMaterialProperty(new Cesium.CallbackProperty(() => {
            return cesiumColor(Cesium, look.color, pulseAlpha(nowMs(), look, reduced()) * (focused ? 1 : 0.92));
          }, false)),
          stRotation: new Cesium.CallbackProperty(() => ringRotation(nowMs(), look, reduced()), false),
          height: 4,
          outline: true,
          outlineColor: cesiumColor(Cesium, look.color, 0.95),
        },
        properties: { terrasignalPropertyId: property.id },
      }));
    }

    if (lod.showGlow) {
      addOwned(`glow:${property.id}`, entities.add({
        id: `ts-glow-${property.id}`,
        position,
        ellipse: {
          semiMajorAxis: radius * 1.8,
          semiMinorAxis: radius * 1.8,
          material: new Cesium.ColorMaterialProperty(new Cesium.CallbackProperty(() => {
            return parcelGlowColor(Cesium, type, nowMs(), reduced());
          }, false)),
          height: 1,
        },
        properties: { terrasignalPropertyId: property.id },
      }));
    }

    if ((lod.showHalo && top) || focused || saved) {
      addOwned(`halo:${property.id}`, entities.add({
        id: `ts-halo-${property.id}`,
        position,
        ellipse: {
          semiMajorAxis: new Cesium.CallbackProperty(() => 26 + 6 * (reduced() ? 0 : goldHaloAlpha(nowMs(), reduced())), false),
          semiMinorAxis: new Cesium.CallbackProperty(() => 26 + 6 * (reduced() ? 0 : goldHaloAlpha(nowMs(), reduced())), false),
          material: new Cesium.ColorMaterialProperty(new Cesium.CallbackProperty(() => {
            return new Cesium.Color(GOLD.r, GOLD.g, GOLD.b, goldHaloAlpha(nowMs(), reduced()) * 0.35);
          }, false)),
          outline: true,
          outlineColor: saved
            ? new Cesium.Color(0.72, 0.86, 0.62, 0.95)
            : new Cesium.Color(GOLD.r, GOLD.g, GOLD.b, 0.9),
          height: 8,
        },
        cylinder: {
          length: new Cesium.CallbackProperty(() => goldColumnHeight(nowMs(), reduced()) * (focused ? 1.15 : 1), false),
          topRadius: 1.6,
          bottomRadius: 3.2,
          material: new Cesium.ColorMaterialProperty(new Cesium.CallbackProperty(() => {
            return new Cesium.Color(GOLD.r, GOLD.g, GOLD.b, 0.28 + goldHaloAlpha(nowMs(), reduced()) * 0.2);
          }, false)),
        },
        properties: { terrasignalPropertyId: property.id },
      }));
    }

    if (type === 'TAX_SALE' && lod.showPulses) {
      addOwned(`tax:${property.id}`, entities.add({
        id: `ts-tax-${property.id}`,
        position,
        cylinder: {
          length: new Cesium.CallbackProperty(() => pulseHeight(nowMs(), look, reduced(), 36), false),
          topRadius: 1.1,
          bottomRadius: 1.1,
          material: cesiumColor(Cesium, look.color, 0.45),
        },
        properties: { terrasignalPropertyId: property.id },
      }));
    }

    if (lod.showLabels || focused || (dealStrategy && focused)) {
      // A compare supplies its own caption — two paths, not one breakdown.
      const dealText = focused && dealStrategy
        ? `\n${dealCaption || dealVisionCaption(dealStrategy, dealAnalysis)}`
        : '';
      const savedText = saved ? '\nSAVED' : '';
      // Only the house in hand carries a countdown; the rest of the board is
      // already saying enough with colour and pulse.
      const auction = (focused || top) ? property.auction : null;
      const auctionDays = Number.isFinite(auction?.daysUntil) && auction.daysUntil >= 0
        ? auction.daysUntil
        : null;
      const auctionText = auctionDays == null ? '' : `\nAUCTION ${auctionDays}d`;
      const auctionUrgent = auctionDays != null && auctionDays <= AUCTION_LABEL_GOLD_DAYS;
      addOwned(`label:${property.id}`, entities.add({
        id: `ts-label-${property.id}`,
        position,
        label: {
          text: `${property.address.split(',')[0]}${savedText}${auctionText}${dealText}`,
          font: '11px Inter, sans-serif',
          fillColor: auctionUrgent
            ? new Cesium.Color(GOLD.r, GOLD.g, GOLD.b, 1)
            : Cesium.Color.WHITE,
          outlineColor: Cesium.Color.BLACK,
          outlineWidth: 2,
          style: Cesium.LabelStyle.FILL_AND_OUTLINE,
          verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
          pixelOffset: new Cesium.Cartesian2(0, -18),
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
        },
        properties: { terrasignalPropertyId: property.id },
      }));
    }
  }

  function paintScan(lod) {
    if (!scanStartedAt || !scanIsActive(scanStartedAt, nowMs(), reduced())) return;
    if (lod.id === 'globe') return;
    addOwned('scan', entities.add({
      id: 'ts-scan-sweep',
      position: Cesium.Cartesian3.fromDegrees(market.lng, market.lat, 12),
      ellipse: {
        semiMajorAxis: new Cesium.CallbackProperty(() => {
          return scanRadiusM(scanProgress(scanStartedAt, nowMs(), reduced()));
        }, false),
        semiMinorAxis: new Cesium.CallbackProperty(() => {
          return scanRadiusM(scanProgress(scanStartedAt, nowMs(), reduced()));
        }, false),
        material: new Cesium.ColorMaterialProperty(new Cesium.CallbackProperty(() => {
          const alpha = scanAlpha(scanProgress(scanStartedAt, nowMs(), reduced()), nowMs(), reduced());
          return new Cesium.Color(0.93, 0.74, 0.22, alpha);
        }, false)),
        height: 10,
      },
    }));
    globalThis.setTimeout(() => {
      if (destroyed) return;
      if (!scanIsActive(scanStartedAt, nowMs(), reduced())) rebuild();
    }, SCAN_DURATION_MS + 80);
  }

  function pickPropertyId(picked) {
    const entityId = String(picked?.id?.id || picked?.id || '');
    const fromName = entityId.match(/^ts-(?:pulse|glow|halo|tax|label)-(.+)$/);
    if (fromName) return fromName[1];
    const id = picked?.id?.properties?.terrasignalPropertyId
      || picked?.id?.properties?.get?.('terrasignalPropertyId');
    if (typeof id === 'string') return id;
    try {
      const value = picked?.id?.properties?.terrasignalPropertyId?.getValue?.();
      if (value) return String(value);
    } catch {
      // ignore
    }
    const cluster = picked?.id?.properties?.terrasignalCluster
      || picked?.id?.properties?.get?.('terrasignalCluster');
    if (cluster?.members?.length === 1) return cluster.members[0];
    return null;
  }

  const handler = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas);
  handler.setInputAction((movement) => {
    const picked = viewer.scene.pick(movement.position);
    const propertyId = pickPropertyId(picked);
    if (propertyId) {
      viewer.entities._terrasignalLastPick = propertyId;
      globalThis.dispatchEvent(new CustomEvent('terrasignal:pick-property', { detail: { id: propertyId } }));
    }
  }, Cesium.ScreenSpaceEventType.LEFT_CLICK);

  removeMove = viewer.camera.changed.addEventListener(() => {
    if (destroyed) return;
    const lod = lodFromHeight(cameraHeightM(viewer));
    const last = viewer._terrasignalLod;
    if (last !== lod.id) {
      viewer._terrasignalLod = lod.id;
      rebuild();
    } else {
      syncHold();
    }
  });

  rebuild();

  return {
    get enabled() { return enabled; },
    setEnabled(next) {
      enabled = Boolean(next);
      rebuild();
      return enabled;
    },
    toggle() {
      return this.setEnabled(!enabled);
    },
    setDealVision(strategy, analysis = null, { caption = null } = {}) {
      dealStrategy = strategy || null;
      dealAnalysis = analysis || null;
      dealCaption = caption || null;
      rebuild();
      return dealStrategy;
    },
    setShortlist(ids) {
      const list = Array.isArray(ids) ? ids.filter(Boolean) : [];
      shortlistIds = list.length ? new Set(list) : null;
      rebuild();
      return list.slice();
    },
    setTopPick(id) {
      topPickId = id || null;
      rebuild();
      return topPickId;
    },
    setSaved(id) {
      savedId = id || null;
      if (savedId) topPickId = null;
      rebuild();
      return savedId;
    },
    setFocused(id) {
      focusedId = id || null;
      rebuild();
    },
    startScan() {
      scanStartedAt = nowMs();
      rebuild();
    },
    rebuild,
    pickPropertyId,
    destroy() {
      destroyed = true;
      handler.destroy();
      if (typeof removeMove === 'function') removeMove();
      clearOwned();
      releaseContinuousRender(HOLD_ID);
      reducedPolicy.destroy();
    },
  };
}
