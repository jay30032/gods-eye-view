# TerraSignal Investor — Phase 1 notes

Status: implemented on the existing Cesium / Vite / vanilla JS tree. No React, Next, or Three.js rewrite.

## Done criteria

- [x] Rebrand to TerraSignal Investor; MIT + Bilawal Sidhu / God's Eye View attribution kept
- [x] Investor default: globe-first park → hunt ritual “Where are we hunting today?” → Atlanta/Decatur → ≥25 mock properties animate by signal
- [x] Bottom nav only: WORLD · DRIVE · MIC · SAVED. Central mic. No filter dashboard
- [x] Mock dataset ≥25 with schema `{id,address,lat,lng,propertyType,estimatedValue,estimatedEquityPct,signals,deal,note}` — scores are derived, never authored
- [x] Visuals under `src/investor/visuals/` integrated with the render governor (no standalone `requestAnimationFrame`)
- [x] Signal looks: FORECLOSURE heartbeat, PREFORECLOSURE breathe, TAX_SALE vertical, DISTRESS shimmer, LISTED ring; gold halo/column is the ranked top pick
- [x] `prefers-reduced-motion` freezes animation; no strobing (periods ≥ 2.2s)
- [x] Opportunity Vision toggle + camera-height LOD
- [x] Property Focus: camera, highlight, composite score, driver strip, four-strategy strip, value/equity, generated why
- [x] Deterministic deal calculators + unit tests (flip, rental, brrrr, wholesale)
- [x] Deal Vision on the globe
- [x] Saved via `localStorage`
- [x] Existing GEV voice tools kept; investor tools added
- [x] Demo conversation: Find me money → Why? → Show me the deal → rehab +20k → Save it
- [x] `?demo=1` / DEMO chip scripts the acceptance sequence; typed bar works without mic or API keys
- [x] Find me money: vision ON, exactly 4 candidates, gold best, camera focus
- [x] Drive demo simulation (not GPS): strong signals only; why/save/skip/next
- [x] Investor path disables OpenSky / FIRMS / cables / news / other GEV live layers
- [x] Opportunity scores and the Why are derived from underwriting, signals, and equity — never authored
- [x] Gold pick is the head of the `findMoney` ranking, not a signal on a row
- [x] Signals read like Georgia: Notice of Sale Under Power, fi. fa. tax sales, servicer delinquency
- [x] Every foreclosure and tax sale carries a derived first-Tuesday auction date and countdown
- [x] Phase 2 not started

## Architecture

```
src/investor/
  config.js              product flags (default investor)
  markets.js             Atlanta / Decatur framing
  scoring.js             derived scores, signal strength, drivers, enrichment
  georgia.js             first-Tuesday sale calendar, counties, legal organs
  clock.js               the pinned demo clock behind every relative date
  mock/                  DEMO/MOCK inventory + search
  deal/                  deterministic underwriting
  visuals/               governor-held Cesium entities
  ui/                    brand, bottom nav, focus, saved, escapeHtml
  session.js             bootstrap + demo intents
  ensureBasemap.js       keyless Esri → OSM + requestRender bursts + empty-globe assert
  frameBudget.js         30 fps on battery/Air; classic stays 60
  voiceTools.js          additive GEV tool handlers
  driveDemo.js           simulated route
```

Keyless boot (`baseLayer: false`) starts with zero ImageryLayers. Esri credits can appear after provider construction without tiles painting. Investor forces Esri World Imagery, falls back to OSM on any failure, then **`renderUntilGlobePaints`**: a 4s `investor-first-paint` hold (released on first `tileLoadProgress`), 100ms `requestRender` ticks, and a 10s timeout that shows `#ts-globe-error` if the center pixel stays black. Attaching an ImageryLayer is not enough — idle `requestRenderMode` before the first paint is a black void.

Investor mode still *registers* GEV layers so `finalizeRegistrations` stays honest, then forces them off after layer-state restore. Opportunity Vision holds `investor-opportunity` only while enabled, near the market, and at pulse LOD — never while the first-hunt modal is parked on the globe. Drive holds `investor-drive` only while running.

## Scoring model

Phase 1 used to ship a hand-typed `opportunityScore` on every mock row next to a
hand-written `why`. Both were free to disagree with the calculators — a house
could print 92 beside a wholesale verdict of "pass". Scores and explanations are
now *derived*, in `src/investor/scoring.js`, from the same three inputs the card
shows: the underwriting, the signal, and the owner's equity.

**Strategy scores (0–100, one per path).** Each of the four calculators runs,
then its result is scored on the two numbers that actually decide that path:

| Path | What the score reads |
|---|---|
| Flip | margin against a 20% target (60 pts) + profit against $60k (40 pts) |
| Rental | cash-on-cash against 12% (60 pts) + DSCR headroom over 1.0, full at 1.5 (40 pts) |
| BRRRR | capital left in, full marks at $0 and none at $50k (50 pts) + cash flow against $400/mo (50 pts) — a true infinite return that also cash flows is 100 |
| Wholesale | assignment fee against $25k (70 pts) + buyer's discount to ARV against 35% (30 pts) — 0 when there is no viable spread |

Then the verdict wins. A **strong** verdict floors the score at 70, **thin**
holds it between 40 and 69, and **pass** caps it at 39. The raw formula decides
*where inside the band* a deal sits; the calculator decides which band it is in.
That is the whole point: the number and the word beside it can no longer
contradict each other.

**Signal strength (0–100).** The primary signal is the highest-ranked one on the
row (FORECLOSURE, then TAX_SALE, PREFORECLOSURE, DISTRESS, LISTED_OPPORTUNITY).
It is weighted by type — 1.0, 0.95, 0.80, 0.65, 0.50 — multiplied by its own
confidence, then decayed by age: full credit for the first 90 days, a straight
line down to a 0.6 floor at one year, and nothing below that floor. A
foreclosure filed last week is not the same lead as one filed last spring. Every
*additional* signal on the row adds 8, capped at +16, because a house wearing a
tax-sale notice *and* a code-enforcement file is a better lead than one wearing
either alone.

**Equity score (0–100).** Owner equity against a 45% saturation point.

**Composite.** `0.55 × best strategy score + 0.25 × signal strength + 0.20 ×
equity score`, plus 2 points for each *other* strategy that is not a pass
(capped at +6, so a house that works three ways beats one that only works once),
clamped to 0–100. `findMoney` ranks on this, and the row it puts first is the
gold pick.

**TOP_PICK is an output.** It used to be a signal type stored on four rows,
which meant the data could paint itself gold regardless of how it underwrote.
It is gone from the schema, the dataset, and the visuals. The session calls
`visuals.setTopPick(id)` with the head of the ranking, and `goldHalo.isTopPick`
compares against that id and nothing else.

**"Why?" is generated.** `whyThisMatters` builds two to three sentences from the
same numbers — signal type, source, filing date and age, confidence, owner
equity, entry discount against the estimate, and the best path with **one**
headline figure. The full breakdown still waits for "Show me the deal". Each
row's old `why` is now `note`: one line of local color appended at the end, not
the explanation itself. A row that still carries `opportunityScore`, `composite`,
or `why` fails `validateProperty`.

**Where it runs.** Scoring executes the four calculators per row, so it is far
too heavy for a render callback. `createMockPropertyProvider` enriches every row
once at load and hands back the same frozen objects; visuals read
`property.opportunityScore` and `property.composite` and never re-score.

## Georgia signal model

The mock feed used to say `lis-pendens` and `court-docket`, which is how
foreclosure works in a *judicial* state. Georgia is not one, and an investor
who hunts Atlanta would notice in about four seconds.

**Non-judicial, first Tuesday.** There is no lawsuit and no court date. The
lender advertises a **Notice of Sale Under Power** in the county's legal organ
for **four consecutive weeks**, and the sale happens on the **first Tuesday of
the month** on the courthouse steps. County tax sales — `fi. fa.` executions
out of the Tax Commissioner — run on the same calendar. If the first Tuesday is
a legal holiday, which in practice only ever means **January 1 or July 4**, the
sale slides to the next day.

**So the sale date is derived, not authored.** `georgia.js` computes it:
`auctionDateForNotice(effectiveDate)` = the first sale Tuesday **on or after**
`effectiveDate + 28 days`, because the four weekly publications have to clear
first. A notice published Aug 12 2026 sells Oct 6; one published a month later
on Sep 9 misses that window and sells Nov 3. Nothing in the dataset types a sale
date, so none of them can be wrong.

**There is no pre-foreclosure filing.** `PREFORECLOSURE` is a **servicer
delinquency**, not a courthouse record — the label is "Mortgage delinquency" and
the source is a 90-day delinquency feed. It gets no auction date, because no
sale has been advertised.

| County | Legal organ | Courthouse |
|---|---|---|
| DeKalb | The Champion | DeKalb County Courthouse, Decatur |
| Fulton | Fulton County Daily Report | Fulton County Courthouse, Atlanta |

Every row carries a `county` and `validateProperty` requires it: without one
there is no legal organ to publish in and no courthouse to sell at.

**Labels.** The enum keys are unchanged so the visuals and LOD logic do not
churn; `SIGNAL_LABELS` supplies the words a human reads.

| Key | Reads as |
|---|---|
| `FORECLOSURE` | Notice of Sale Under Power |
| `PREFORECLOSURE` | Mortgage delinquency |
| `TAX_SALE` | Tax sale (fi. fa.) |
| `DISTRESS` | Distress |
| `LISTED_OPPORTUNITY` | Listed under comps |

**A tax deed is not a deed yet.** Winning a Georgia tax sale buys a
*redeemable* tax deed: the owner has **12 months** to redeem at a **20%
premium**. Any exit that needs clear title waits out that year, so the Why on a
tax-sale row says so out loud rather than quoting a flip timeline that cannot
happen. Foreclosure rows carry no such caveat.

**Urgency.** A sale already on the calendar is a deadline, not a lead, so
`signalStrength` adds **+5** when the auction is within **45 days** (still
clamped to 100). At the demo clock that separates the Oct 6 board from the
Nov 3 board. The globe label on the focused or gold house appends
`AUCTION <N>d`, and goes gold inside 14 days.

**The demo clock.** Every "filed 29 days ago" and "auction in 26 days" is
relative, so a fixed dataset rots as the real calendar moves. `clock.js`
resolves the date in this order:

1. `?clock=YYYY-MM-DD`
2. `TERRASIGNAL_DEMO_CLOCK` (see `.env.example`; empty by default)
3. `DEMO_CLOCK_DEFAULT` = **2026-09-10**, when demo mode is on (`?demo=1` or
   `TERRASIGNAL_DEMO_MODE`)
4. otherwise the real clock

`scoring.js` and `focus.js` default their `now` to `demoNow()`; tests pass an
explicit `now` and never depend on the wall clock.

**Notes carry no underwriting.** Each row's `note` is one sentence of place and
condition — what the house and the street look like. No strategy names, no
dollars, no percentages; a test greps the dataset for them. Everything an
investor would argue with is generated in the Why, where it is derived from the
calculators and cannot drift.

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
