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
  ensureBasemap.js       keyless Esri → OSM + requestRender bursts + empty-globe assert
  frameBudget.js         30 fps on battery/Air; classic stays 60
  voiceTools.js          additive GEV tool handlers
  driveDemo.js           simulated route
```

Keyless boot (`baseLayer: false`) starts with zero ImageryLayers. Esri credits can appear after provider construction without tiles painting. Investor forces Esri World Imagery, falls back to OSM on any failure, then **`renderUntilGlobePaints`**: a 4s `investor-first-paint` hold (released on first `tileLoadProgress`), 100ms `requestRender` ticks, and a 10s timeout that shows `#ts-globe-error` if the center pixel stays black. Attaching an ImageryLayer is not enough — idle `requestRenderMode` before the first paint is a black void.

Investor mode still *registers* GEV layers so `finalizeRegistrations` stays honest, then forces them off after layer-state restore. Opportunity Vision holds `investor-opportunity` only while enabled, near the market, and at pulse LOD — never while the first-hunt modal is parked on the globe. Drive holds `investor-drive` only while running.

## Underwriting model

Four deterministic calculators live in `src/investor/deal/`. Every default sits in the frozen
`DEAL_ASSUMPTIONS` (`assumptions.js`); `mergeAssumptions` accepts numeric overrides per call, so
nothing is hardcoded inside a formula. Changing a default is a product decision and must move the
fixtures in the matching `*.test.mjs`.

**Shared inputs.** Rehab always carries a **10% contingency** before anything is sized off it —
`rehabTotal = rehab × 1.10`. The demo's "rehab is twenty thousand higher" adds to *base* rehab, so a
bigger scope also buys a bigger buffer ($42k → $62k → $68.2k funded). Door count comes from
`unitsFor(propertyType, units)` — sfr/condo/townhouse 1, duplex 2, triplex 3, quad 4,
small_multifamily 3, and an explicit `property.units` always wins. Insurance is priced per door.

**Defaults.** Buy closing 2% of purchase, sell closing 6% of ARV. Hard money at 12%/yr, 2 points,
90% loan-to-cost. Flip hold 6 months. Carry (taxes + insurance + utilities during a hold) 1.5% of
ARV per year. Vacancy 5%, management 8%, maintenance 5%, capex 5% — all of gross rent. Property tax
1.1% of ARV per year, insurance $1,400 per unit per year. Conventional: 25% down, 7% for 30 years.
BRRRR refinances at 75% LTV with 2% refi closing after 6 months seasoning. Wholesale: 70% rule, 40%
of spread as the fee, clamped to $5k–$25k.

**Flip** — financed with hard money unless `allCash: true`. The lender covers 90% of purchase plus
funded rehab; points and six months of interest are real money out. Carry runs on ARV, sell closing
is 6% of ARV. Profit is ARV minus everything. ROI is against *cash in* — the funding gap plus every
cost the loan does not cover — not against the full purchase price, which is what makes leverage
show up honestly. `mao70` is the 70% rule net of rehab. Verdict: **strong** at ≥$30k profit *and*
≥10% margin, **thin** at ≥$15k profit, otherwise **pass**.

**Rental** — conventional financing. NOI is gross rent less six separate lines (vacancy,
management, maintenance, capex, taxes on ARV, insurance per door) rather than one blended opex
rate. Cap rate is NOI over purchase; yield on cost also carries the rehab. Cash needed is down
payment + funded rehab + buy closing. DSCR is NOI over annual debt service. Verdict: **strong** at
≥8% cash-on-cash *and* ≥1.25 DSCR, **thin** if it merely cash flows, otherwise **pass**.

**BRRRR** — the same hard-money acquisition block as a flip, held for seasoning, with no sell
closing because there is no sale. The exit is a refinance at ARV × 75%; 2% refi closing comes out of
it. What the refinance does not return stays in as `cashLeftIn`; anything over comes back as
`cashOut`. NOI is computed exactly as the rental. Debt service is on the refinance balance.
Cash-on-cash is reported as **999 with `infiniteReturn: true`** when nothing is left in and the
property cash flows. Verdict: **strong** at ≤$25k left in *and* ≥$150/mo, **thin** if it cash flows,
otherwise **pass**.

**Wholesale** — the corrected formula. MAO is the 70% rule **net of rehab**
(`ARV × 0.70 − rehabTotal`), not a bare 70% of ARV; ignoring rehab is what previously made every
distressed house look assignable. Spread is MAO minus the contract price. The fee is 0 unless the
spread clears the $5k floor, then 40% of spread clamped to $5k–$25k and never more than the spread
itself. Verdict: **strong** at ≥$15k fee, **thin** at ≥$7.5k, otherwise **pass** — and a
non-viable deal says "No spread — pass" rather than showing a $0 fee next to a negative number.

Every result is frozen, returns its `verdict` and the `assumptions` it ran under, and the card,
globe caption, and spoken line all lead with that verdict.

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
