# TerraSignal Investor — Phase 1 notes

Status: implemented on the existing Cesium / Vite / vanilla JS tree. No React, Next, or Three.js rewrite.

## Done criteria

- [x] Rebrand to TerraSignal Investor; MIT + Bilawal Sidhu / God's Eye View attribution kept
- [x] Investor default: globe-first park → hunt ritual “Where are we hunting today?” → Atlanta/Decatur → ≥25 mock properties animate by signal
- [x] Bottom nav only: WORLD · DRIVE · MIC · SAVED. Central mic. No filter dashboard
- [x] Mock dataset ≥25 with schema `{id,address,lat,lng,propertyType,estimatedValue,estimatedEquityPct,opportunityScore,signals,deal}`
- [x] Visuals under `src/investor/visuals/` integrated with the render governor (no standalone `requestAnimationFrame`)
- [x] Signal looks: FORECLOSURE heartbeat, PREFORECLOSURE breathe, TAX_SALE vertical, DISTRESS shimmer, LISTED ring, TOP_PICK gold halo/column
- [x] `prefers-reduced-motion` freezes animation; no strobing (periods ≥ 2.2s)
- [x] Opportunity Vision toggle + camera-height LOD
- [x] Property Focus: camera, highlight, score/signal/value/equity/why
- [x] Deterministic deal calculators + unit tests (flip, rental, brrrr, wholesale)
- [x] Deal Vision on the globe
- [x] Saved via `localStorage`
- [x] Existing GEV voice tools kept; investor tools added
- [x] Demo conversation: Find me money → Why? → Show me the deal → rehab +20k → Save it
- [x] `?demo=1` / DEMO chip scripts the acceptance sequence; typed bar works without mic or API keys
- [x] Find me money: vision ON, exactly 4 candidates, gold best, camera focus
- [x] Drive demo simulation (not GPS): strong signals only; why/save/skip/next
- [x] Investor path disables OpenSky / FIRMS / cables / news / other GEV live layers
- [x] Phase 2 not started

## Architecture

```
src/investor/
  config.js              product flags (default investor)
  markets.js             Atlanta / Decatur framing
  mock/                  DEMO/MOCK inventory + search
  deal/                  deterministic underwriting
  visuals/               governor-held Cesium entities
  ui/                    brand, bottom nav, focus, saved
  session.js             bootstrap + demo intents
  ensureBasemap.js       keyless Esri → OSM + render hold + empty-globe assert
  voiceTools.js          additive GEV tool handlers
  driveDemo.js           simulated route
```

Keyless boot (`baseLayer: false`) starts with zero ImageryLayers. Esri credits can appear after provider construction without tiles painting. Investor forces Esri World Imagery, falls back to OSM on any failure, holds continuous render through first-hunt, and asserts `globe.show === true` plus at least one showing ImageryLayer after the stack is ready.

Investor mode still *registers* GEV layers so `finalizeRegistrations` stays honest, then forces them off after layer-state restore. Opportunity Vision holds `investor-opportunity` only while enabled and near/clustered; Drive holds `investor-drive` only while running.

## Env

See `.env.example`:

```
TERRASIGNAL_PRODUCT=investor
TERRASIGNAL_DEMO_MODE=true
TERRASIGNAL_DEFAULT_MARKET=atlanta
PROPERTY_PROVIDER=mock
TERRASIGNAL_OPPORTUNITY_VISION=true
TERRASIGNAL_DISABLE_LIVE_FEEDS=true
```

## Explicitly not Phase 2

Live property APIs, real GPS drive, multi-market production data, seller outreach, underwriting against county records, or a React rewrite.

## 5-minute demo

See [START_HERE.md](./START_HERE.md). URL: `http://localhost:4173/?demo=1&welcome=1` after `npm run dev`.
