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
- [x] The near-field outline traces the real OSM building footprint — 2 px core,
      ~6 px glow — and synthetic parcels are gone from the render entirely
- [x] Real DeKalb / Fulton county parcels where a public layer has one, drawn as
      a secondary hairline at 40% of the building glow; geometry only, never
      owner identity
- [x] A mock signal is never attached to a real site address — enforced at fetch
      time and pinned by `siteAddress.test.mjs`
- [x] The focused house is lit by a `ClassificationPrimitive` tint on its own
      tiles (verified headed: the classification takes)
- [x] Any angle on command: sides, compass points, the street, closer/farther,
      higher/lower, orbit/stop — each a 2 s cubic re-framing that holds the
      house on the same part of the screen
- [x] Best-angle framing: eight headings ray-cast against the tiles before the
      hero flight, ties to the street, cached per property
- [x] A ring around the top pick and a scan wave across the scene, both
      shader-animated off the one shared clock
- [x] Clear View: a tree-free world from ion terrain, Bing aerial and Cesium
      OSM Buildings; footprints matched to building features so the answer is a
      tinted building; TREES chip, spoken toggle, remembered choice
- [x] Drive Mode v2: the 3D chase camera drives, the scene answers; view
      director maps questions to views over a 300 ms cross-fade; Street View is
      an on-demand stop view; route position survives every answer
- [x] Drive Mode v1: a committed road-following loop, a chase camera on a
      spline, activation by distance ahead, narration that speaks only when
      useful, and a pluggable position source with a live GPS implementation
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
  visuals/               governor-held Cesium primitives
  visuals/effects/       building outline, lot line, tint, columns, ground pulses
  camera/                shot list, director, front-side derivation, best angle
  drive/                 route spline, activation, narration, position sources,
                         Street View stop view, view director
  world/                 Clear View — the tree-free world
  scenes/                ?scene=six — the six-house near-field scene
  mock/parcel.js         tangent-plane geometry helpers (its synthetic parcel
                         is data only — nothing renders it)
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

## Black globe — root cause

For weeks the investor demo rendered its HUD over a black disc with only the
atmosphere ring, then stopped responding. Several rounds of fixes went into the
*rendering* path on the theory that the globe was not being asked to paint.
That was the wrong half of the problem.

**The actual cause was one line of DOM code.** `relocateVoiceControl()` in
`src/investor/ui/chrome.js` observed `document.body` with
`{childList: true, subtree: true}`, and its callback ended with an
unconditional:

```js
if (label) label.textContent = 'MIC';
```

Assigning `textContent` **replaces the text node even when the string is
identical**. That replacement is a childList mutation inside the observed
subtree, so the observer re-triggered itself — forever.

**Why it read as a hang rather than as burnt CPU.** MutationObserver callbacks
are *microtasks*. A microtask that queues another microtask drains the
checkpoint forever and never returns to the task queue. So
`requestAnimationFrame` never fired (Cesium stopped rendering — the black disc
is the last frame before the lock), CDP `Runtime.evaluate` never ran,
`Profiler.stop` never returned, and `PerformanceObserver` never delivered. A
headed probe recorded 14/14 blocked samples, zero long tasks, and exactly one
network request to `tile.googleapis.com` — the root `tileset.json`. Child tiles
are requested from Cesium's update loop, which never ran again.

Three things that look like missing data in those logs are findings: zero long
tasks, unreadable governor holds, and one tile request are all *starvation
artifacts*, not evidence that rendering was configured wrong.

**Why classic was unaffected.** `relocateVoiceControl` is only called from
`startInvestorSession`. Classic never installs the observer, so it painted at
~1.5s and stayed responsive throughout.

**Why the watchdog could not fire.** `renderUntilGlobePaints` and the
`#ts-globe-error` assertion in `ensureBasemap.js` are designed to catch exactly
this symptom. They never ran: their `setTimeout`/`setInterval` callbacks are
tasks, starved by the same microtask loop. The watchdog and the thing it
watches shared a thread. A watchdog on the monitored thread can only catch
slowness, never a starvation lock.

**Why the unit suite was green.** `npm test` is Node-only and drives no WebGL,
no render loop, and no DOM lifecycle. 2,897 assertions passed while the page
hard-locked on load.

### The fix

Four independent defences, because one is a single edit away from being undone:

1. the label write is conditional, so a settled label mutates nothing;
2. an `applying` re-entrancy flag, so the callback cannot react to its own writes;
3. observation is `childList` **without** subtree, scoped to the slot's parent
   chain and the voice control's container — a text node deep inside the
   control is not watched at all;
4. the observer disconnects once the control is placed, and re-arms only if
   that node is removed again.

The 800 ms `relocateVoiceControl` retry in `session.js` is gone: it existed
because the old observer could miss a late-built control, and the placement
observer now handles arrival deterministically.

`src/investor/ui/chrome.test.mjs` pins all of it without a browser — a fake node
whose `textContent` setter counts writes, and a fake observer that re-delivers
the mutations its own callback causes. One case asserts the harness itself still
reproduces the original loop, because a harness that cannot reproduce the bug
cannot prove the fix.

### Smoke checks

Unit tests cannot see this class of bug. Three headed checks can:

```bash
npm run dev                      # 4173
npm run smoke:investor           # demo URL
npm run smoke:classic            # classic chrome
npm run smoke:investor-keyless   # spawns its own :4174 with the Google key
                                 # blanked in env only — never touches .env
npm run smoke:demo               # drives the whole acceptance conversation
npm run smoke:six                # the six-house near-field scene
npm run smoke:drive              # Drive Mode, the whole loop at 4x
npm run smoke:clear              # the six-house scene in Clear View
```

Geometry is refreshed by hand, never by `npm test`:

```bash
node scripts/fetch-footprints.mjs   # OSM buildings  → geometry files
node scripts/fetch-parcels.mjs      # county parcels → geometry files
node scripts/fetch-streets.mjs      # street bearings → geometry files
node scripts/fetch-route.mjs        # OSRM loop      → mock/sixRoute.js
```

Each launches **real Chrome** (`channel: 'chrome'`, `headless: false` — this
does not reproduce under SwiftShader) and exits non-zero unless: the canvas
centre pixel goes non-black within 8s, the page answers a `page.evaluate()`
within 1s at the 15s mark, and there are no console errors.

| check | first paint | responds @15s | console errors | tiles |
|---|---|---|---|---|
| investor | 1,467 ms | 3 ms | 0 | 105 |
| classic | 1,470 ms | 2 ms | 0 | 689 |
| investor-keyless | 2,392 ms | 3 ms | 0 | 105 |

Note that "keyless" only blanks the **direct Google key**. `CESIUM_ION_TOKEN`
is still set, and ion serves Google 3D — which is why that run still loads 105
tiles and never touches Esri. A genuinely credential-free run needs both
blanked.

### Probably-redundant black-globe workarounds

These were added while the cause was believed to be in the rendering path. With
the microtask loop gone, the globe paints at ~1.5s with the governor `idle` and
**zero holds** in all three smoke runs. **Nothing below has been removed** —
each needs its own verification against the keyless/no-ion path before deletion:

- **`renderUntilGlobePaints`** (the 4s `investor-first-paint` hold, the 100 ms
  `requestRender` interval, the 10 s timeout) — the globe now paints without any
  hold being taken. Strongest candidate for removal.
- **`INVESTOR_PAINT_HOLD` / `INVESTOR_BASEMAP_HOLD` / `INVESTOR_HUNT_HOLD`** —
  all three smoke runs end with `holds=[]`, so none is doing load-bearing work
  at steady state.
- **The ellipsoid/`globe.show = true` force** in the investor bootstrap — with
  Google 3D tiles present, classic hides the globe and renders the tileset;
  investor forcing it visible was compensating for a scene that never painted.
- **`ensureKeylessVisibleBasemap` retries and `probeEsriWorldImagery`** — Esri
  was requested **zero** times in every run, including keyless, because ion
  covers that path. The fallback may be dead code on any machine with an ion
  token.
- **`scheduleInvestorImageryWatchdog` / `assertInvestorGlobeReady`** — worth
  keeping in *some* form, but as written they cannot fire during a starvation
  lock, which is the failure they were written for.

The honest test for each is the keyless smoke check with `CESIUM_ION_TOKEN`
blanked as well — that is the only configuration where the Esri/OSM fallback is
actually exercised.

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

## Near-field effects

The sprites in `markers.js` are the **far field**. They hold their size on
screen from orbit down to the street, which is exactly what you want when the
question is "where in this metro is there a signal" — and exactly what you do
not want when the question is "which of these four roofs". A 48-pixel billboard
floating over a block of Oakhurst cannot point at a house.

So below **1,500 m above ground** a second layer comes up: `visuals/effects/`.
It draws the building itself — the real OSM footprint — a lot line under it
where a county surveyed one, a tint over the focused house, and a column of
light above it, and it hands back to the sprites on the way up. The markers are
untouched and still drawn at every altitude; this layer only adds.

It used to draw a **synthetic parcel** instead: the footprint's oriented
bounding box pushed out by guessed setbacks. That is gone from the render — see
[Geometry](#geometry-real-footprints-real-parcels-where-a-county-has-one).

### Four rules

1. **Draped, never drawn over.** Every ground primitive is a
   `GroundPolylinePrimitive` with `classificationType` CESIUM_3D_TILE, so the
   outline is projected onto Google's photogrammetry rather than drawn through
   it. As ordinary geometry a lot line disappears under a street tree and gets
   sliced by a porch roof. The side effect is that a tree overhanging the lot
   line wears the line — which is the correct reading, not an artefact.
2. **One clock, delivered as uniforms.** `createEffectClock` is read once per
   frame and written to every material as `time`. There is no `CallbackProperty`
   anywhere in this layer: that machinery makes Cesium re-evaluate a property
   every frame on the main thread, which is the cost the marker rewrite already
   established this product will not pay.
3. **Nothing is rebuilt after `build()`.** Geometry is created once. Motion,
   selection, dimming and distance fades are all uniform writes — at most seven
   floats and two booleans per property per frame, with no allocation (the two
   `Cesium.Color` objects per entry are built once and assigned by reference).
4. **Never colour the wrong house.** A row whose Overpass lookup missed has no
   footprint, so it draws nothing in this layer at all — it keeps the far-field
   beacon, which marks a coordinate without claiming to know which roof. Silence
   is honest. A confident gold outline around the neighbour's house is not, and
   neither is a box that only looks surveyed.

### Where each animation runs

The split is by whether an effect varies across the *geometry* or only over
*time*, because the CPU can supply one and not the other:

| | Runs on | Why |
|---|---|---|
| brightness, glow width, alpha | CPU, in `signalMotion.js` | pure, bounded, and swept at 1 ms resolution by the tests |
| travelling segment (LISTED), rising wave (TAX\_SALE) | GLSL, from the shared `time` uniform | needs a value per *fragment*, which no CPU-side scalar can give |

That split is deliberate: anything which must be *proven* bounded is JS, because
a unit suite cannot compile GLSL. The shaders only decide *where along the
geometry* something is, never how bright it is allowed to get.

### The motions

| Signal | Colour | Motion |
|---|---|---|
| `FORECLOSURE` | deep red | slow heartbeat — a strong beat, a weaker one, a long rest |
| `PREFORECLOSURE` | red-orange | two gentle pulses, then a pause longer than both |
| `TAX_SALE` | purple | a wave rising up the column, outline ramping with it |
| `DISTRESS` | amber | restrained uneven shimmer — two incommensurate rates, never a pulse |
| `LISTED_OPPORTUNITY` | cyan | a thin bright segment travelling around the parcel |

One colour per signal, at every altitude.

`SIGNAL_LOOK` in `propertyPulse.js` is the only palette; `EFFECT_COLORS`
derives from it with the alpha dropped. LISTED used to be blue and was changed
to cyan for both layers at once — blue vanishes against aerial imagery of a
shaded street the moment it is a line on the ground rather than a sprite. An
earlier cut overrode it in the near field only, which fixed the legibility and
broke something worse: a house changed colour as the camera dropped through
1,500 m, and since both layers are visible through the whole handover, the
sprite and the parcel outline beneath it stopped reading as the same house. A
test now fails if the two ever disagree again.

Every period is ≥ 2.2 s — the same no-strobe floor Phase 1 has held throughout.
`prefers-reduced-motion` freezes brightness and width at each type's midpoint
and sets `travelPerSec` and `wavePerSec` to zero, so there is a static glow and
no travelling segment at all.

The top pick and the focused house take a **gold** outline with a wider, softer
halo, breathing between 0.55 and 1.0 over 3 s. It never reaches zero: a gold
outline that blinks off reads as a bug, not as emphasis.

### Dim rules

Ordered, and the order is the product decision:

1. a house the shortlist left out is **quiet** — 25% alpha, no motion — even
   while something else is focused, because "not an answer to the question you
   asked" outranks "not the one you are looking at";
2. the focused house and the top pick are never quiet, the same exemption
   `markerAlphaFor` makes in the far field;
3. a **saved** house is held at 35% rather than 25%: not the answer to this
   question, but the user already said they wanted to find it again;
4. otherwise, focus brightens one parcel and dims every other to **35%**.

### The column

A `WallGeometry` prism over the footprint, 120 m tall, fading upward to nothing
— a wall rather than an extruded polygon, because a capped box reads as a solid
object sitting on the roof and the point is a shaft that runs out of substance.

Its alpha runs the *opposite* way to an ordinary distance fade: nearly gone at
HERO, strongest out near the layer's own ceiling. The column exists to answer
"which roof?" from across the neighbourhood, and at 150 m the answer is already
filling the frame — a light shaft in front of the house is then just something
in the way.

Three numbers in this layer were wrong on the first headed pass and all three
were invisible to the unit suite:

- **the cull radius.** 1,400 m, against a six-house CRUISE whose *slant* range
  to its own aim point is 1,462 m — so every parcel was culled in the one shot
  the layer exists for. Altitude is not range.
- **the range anchor.** Ranges were measured to `Cartesian3.fromDegrees(lng,
  lat)` at ellipsoid height, which in Decatur is 310 m below the house. Every
  distance fade behaved as though the camera were further away than it was.
- **single-face alpha.** A closed wall shows a near face and a far face at
  once, and an L-shaped roof shows four or six. At 0.42 each they stacked into
  a solid gold slab. One face now carries 0.16 at most.

### Camera height means height above ground

`positionCartographic.height` is above the WGS84 ellipsoid, and Decatur's ground
is ~310 m up — so the six-house establishing shot, 900 m above the houses,
reports 1,177 m. Comparing that raw number against the ceiling quietly turns a
1,500 m rule into an 1,190 m one, and gives every market a different rule
depending on its elevation. The layer subtracts `market.groundElevationM`, the
same datum `shots.js` measures its altitudes from. The market constant is used
rather than sampling the surface under the camera because `scene.sampleHeight`
is a render-thread query and this runs every frame.

## Geometry: real footprints, real parcels where a county has one

`scripts/fetch-footprints.mjs` asks OpenStreetMap, via Overpass, for the nearest
residential building within 120 m of each authored row, and writes
`mock/atlantaDecaturGeometry.js` (and `mock/sixHouseGeometry.js`) keyed by
property id. Each row's `lat`/`lng` is then snapped to its footprint centroid,
in place, touching nothing else in the dataset.

Two more fetchers enrich the same files, run by hand for the same reason — a
unit suite that depends on a third-party API is a unit suite that fails when
someone else's server is busy:

| script | adds | source |
|---|---|---|
| `fetch-footprints.mjs` | `building.footprint` | OpenStreetMap (ODbL) |
| `fetch-parcels.mjs` | `parcel` (real lot lines) | DeKalb / Fulton county GIS |
| `fetch-streets.mjs` | `street.bearingDeg` | OpenStreetMap (ODbL) |

### The synthetic parcel is gone from the render

Phase 1 shipped a **synthetic** parcel per row: the footprint's oriented
bounding box pushed out 9 m at the sides and 18 m front and back. On a headed
review that box was plainly the wrong object — a crooked gold rectangle lying
across the street and around a neighbour's house, drawn in the colour the
product uses to mean *this property*.

The near-field outline now traces the **real OSM building footprint**, and
`nearFieldEffects.js` allow-lists parcel sources: only `'dekalb-gis'` and
`'fulton-gis'` are ever drawn. A `'synthetic'` ring is still in the data and is
never rendered. A row with no footprint draws nothing in this layer at all — it
keeps the far-field beacon, which marks a coordinate without claiming to know
which roof.

### Real parcels

Both counties serve parcels over public, keyless ArcGIS REST:

```
DeKalb  https://dcgis.dekalbcountyga.gov/hosted/rest/services/Parcels/MapServer/0
Fulton  https://gismaps.fultoncountyga.gov/arcgispub2/rest/services/
          PropertyMapViewer/PropertyMapViewer/MapServer/11
```

The query is point-in-polygon at the row's **footprint centroid**, not at the
authored coordinate: an authored coordinate can sit in the street or in next
door's garden, which is exactly how you acquire a confident outline around the
wrong lot. Attribution is carried per block.

**Only geometry and the site address are kept.** These layers are cadastral and
serve the current owner's name and mailing address alongside the polygon. The rows here are
invented and every signal on them is fiction, so writing a real person's name
next to a fabricated Notice of Sale Under Power is not something the schema is
allowed to make possible. Owner and assessment fields are dropped at the parse
boundary; the ring, the public parcel id, the area and the parcel's own site
address are what land in the tree — the last of those solely to enforce the
fictional-address rule below. `sixHouse.test.mjs` and `siteAddress.test.mjs`
both fail if an owner field ever appears.

**A plausibility band does real work.** A cadastral layer will hand back a
subdivision common area, a right-of-way, a church or a school if the centroid
falls in one. On the first run `DEMO-SIX-004` resolved to a **5.67-acre parcel
classed E1 — Oakhurst Elementary School**. Lots outside 120 m² – 2 acres are
refused, and the row keeps its building outline alone.

That catch turned out to be treating a symptom. The reason the centroid landed
on school land is that **the footprint itself was a school building** — see
below.

### Editing a generated file is where the silent bugs live

Three scripts write `mock/*Geometry.js`. `fetch-footprints.mjs` generates the
whole file; the other two perform surgery on a file they did not write, each
owning one field. That has now produced two bugs in a row, and both were
**silent** — nothing threw, no test failed, and `smoke:six` passed through both:

1. `fetch-parcels.mjs` kept everything *before* `parcel:` and appended the
   entry's closing brace. Correct only while `parcel` was the last field — and
   it was, until `fetch-streets.mjs` began writing `street` after it. The next
   parcel run deleted **29 street bearings** from the Atlanta file and **all 6**
   from the six-house file. The globe just fell back to the long-wall convention
   and looked entirely plausible.
2. The field span included the trailing comma, so lifting a block out and
   writing it back produced `}),,` — a syntax error in a generated file that
   nothing notices until the next import.

Both fetchers now share `scripts/lib/geometryFile.mjs`, which bounds a field at
*both* ends and preserves everything after it, and `geometryFile.test.mjs` pins
the round trips: edit one field and every other field of every entry must come
back byte for byte, with the result still importable. That is the check that
would have caught either bug on the day it was written.

### The fictional-address rule

> **A mock signal is never attached to a real site address.**

Every row here is invented and every signal on it — the foreclosures, the tax
sales, the code-enforcement files, the delinquencies — is fiction. The footprints
and lot lines beneath them are real, because a demo that outlines nothing real
does not read as a demo of anything. That leaves exactly one thing that must
never line up: the **name**.

A row may stand on a real building. It may not also *call itself* by that
building's address. The moment an authored address equals the address the county
holds for the parcel the footprint sits on, the product stops saying "here is
roughly what this looks like" and starts saying "this specific house is in
foreclosure" about a house that is not. Addresses stay invented — plausible for
the neighbourhood, matching no parcel on the board.

The rule is enforced twice, because the two failure modes are different:

- **`fetch-parcels.mjs`** compares each row against the county's site address
  before writing, refuses the parcel on a match, prints the offending row and
  exits non-zero. That catches a *fetch* introducing a real address.
- **`siteAddress.test.mjs`** re-derives the same comparison from the data on
  disk on every `npm test`. That catches a later *hand-edit* of an authored
  address, which no fetcher would ever see.

The comparison is house number plus street, canonicalised — the two sides are
written by different hands, so `915 Mead Rd` and `915 Mead Road` have to compare
equal or the rule would pass by accident forever. Parsing anchors on the street
type rather than on commas, because an authored row reads
`915 Mead Rd, Decatur, GA 30030` while DeKalb returns
`1305 Oakview Road Decatur, GA 30030` with no comma before the city at all.

A **trailing** directional is dropped; a leading one is kept. `2799 Main St,
East Point` and `2799 Main Street East Point` differ only by a comma, and
reading that "East" as a quadrant made one address compare as two. Dropping it
can only make two streets look alike (`Main St NE` vs `Main St SW`), which fails
the rule *loudly* and gets looked at. Keeping it could let a genuine match
through in silence, and that is the failure that matters.

**This is why the county's site address is stored.** It is the one field kept
beyond the geometry, and it exists so the rule can be *checked* rather than
merely asserted — without it the test has nothing to compare against. It is
public record and it is the property's own address, a different category from
the owner's **name and mailing address**, which are dropped at the parse
boundary and never stored. It also adds no identifying power the file did not
already have: every record already carries the exact footprint polygon and the
county parcel id, either of which locates the property far more precisely than a
street address does. Nothing renders it.

At the last run all **32** rows carrying a surveyed parcel clear the rule.

### The residential-parcel check

`DEMO-SIX-004` is authored as a single-family row and matched OSM
`way/51282519`: `building=yes`, no `amenity`, no `shop`, an utterly ordinary
240 m² footprint. It is a building on the grounds of Oakhurst Elementary.
**No tag rule can catch that** — the tags are indistinguishable from a large
house. The county can: the parcel under it is classed `E1`.

So `fetch-footprints.mjs` now walks its candidates nearest-first and asks the
county what the land is before accepting one. The preference order is
three-valued, not two, and the third value is the point:

1. a candidate the county **confirms** is residential;
2. failing that, the best candidate whose land could not be determined — no
   parcel, or the county did not answer;
3. **never** one the county says is a school, a church or a shop.

Collapsing (2) into (1) silently re-admits the school the moment a county
server blinks; collapsing it into (3) drops every footprint in the market on a
network failure. A transport failure therefore degrades to the old tag-only
behaviour and says so in the log.

`R` is residential in both counties' class fields. Sampling ~1,000 parcels
around each market: DeKalb `CLASSDSCRP` R3 ×941, E1 ×48, C3 ×32, …; Fulton
`ClassCode` R3 ×1324, C3 ×56, E1 ×30, U3, I3, H3. `scripts/lib/countyParcels.mjs`
holds the rule and `countyParcels.test.mjs` pins it — `npm test` discovers
`scripts/` as well as `src/` for exactly this reason: a rule that decides
whether the globe outlines a house or a school is worth a test wherever it
lives.

Re-run, `DEMO-SIX-004` walked past **four E1 school buildings** and landed on
`way/51277800` — 142 m², 46 m away, on parcel `15 213 03 250`, class **R3**,
0.27 acres, fronting Oakview Road. Its coordinates, parcel and street bearing
all moved with it.

**`--only` no longer deletes the rows it was not asked about.** The renderer
writes the whole file from `records`, and `records` only ever held the selected
rows — so a targeted re-run used to emit a geometry file containing one entry
and silently drop every other footprint, real county parcel and street bearing
in it. Rows outside the selection are now spliced back in verbatim, and the
script refuses to write a partial dataset if any of them is missing.

Coverage at the last run: **26 of 29** Atlanta rows with a footprint, **6 of 6**
in the six-house scene.

### Street bearings

`fetch-streets.mjs` stores the compass bearing from each footprint centroid to
the nearest point on the nearest residential way — `residential`,
`living_street`, `unclassified`, `tertiary`, `secondary`, `primary`. `service`
is deliberately excluded: the alley behind a house is the nearest way
surprisingly often, and calling that the front puts the "front" camera in the
back garden.

The bearing is measured to the closest point **on** the way rather than to its
nearest node, because nodes on a straight street can be fifty metres apart and
using them would swing the derived front by tens of degrees depending on where
the mapper clicked.

Overpass answers a shared endpoint under load with `504`, and a run that gets
throttled halfway is normal — so a transport failure **carries the existing
block forward** rather than replacing a good bearing with a null. Rows that
never resolved simply have no `street` block and fall back to the long-wall
convention, which `orientation.js` reports as `source: 'long-axis'` so the
spoken line can hedge instead of asserting.

**Nothing is derived from Google's 3D tiles.** That tileset is licensed imagery,
not a data source; vectorising it would be a terms violation and the result
could not be committed. Overpass and the county portals, or nothing.

Three things `fetch-footprints.mjs` learned the hard way, all of which the two
newer fetchers inherited:

- **Overpass answers undici's default User-Agent with a bare `406 Not
  Acceptable`.** Not a rate limit, not a bad query — a refusal to serve an
  unidentified client. The first full run missed all 30 rows for that reason
  alone and reported them as "no residential building within 120 m", which is a
  transport failure wearing a data failure's clothes.
- **A run where every row misses refuses to write anything.** Thirty nulls is a
  broken client, not a market without houses in it.
- **A miss may add a row to the degrade list; it may never remove one from the
  surveyed list.**

The `building=yes` tier is accepted, but only after the obviously
non-residential tags are excluded: a `building=yes` carrying `amenity=townhall`
is the Decatur city hall, and the row nearest the Square would otherwise light
it up. There is a footprint size floor too — it began at 45 m² and let a 46 m²
outbuilding win a row whose house is 1,740 sqft.

## Lighting the house: outline, lot line, tint

Three layers of claim, in descending order of confidence:

| | geometry | weight |
|---|---|---|
| building outline | real OSM footprint | 2 px core, ~6 px glow |
| lot line | county parcel, where one exists | hairline at **40%** of the building's glow |
| building tint | extruded from the footprint, classified onto the tiles | rim 30% / fill 10% |

The outline profile is expressed in **pixels**, not in fractions of the baked
ribbon. `GroundPolylineGeometry` bakes its width at construction, so the geometry
is built once at the widest the design needs and the material carves the profile
out in pixels — which is what lets "2 px core" mean two actual pixels at any
range. The core does not breathe; only the glow around it does, because a line
whose *thickness* pulses reads as a rendering fault rather than as emphasis.

### The tint

The top pick and the focused house get a translucent gold volume extruded from
the footprint, ground to ground + 9 m, as a `ClassificationPrimitive` with
`classificationType` CESIUM_3D_TILE. It colours the actual photogrammetry of
that building and stops at its walls. **Verified headed: the classification
takes** — the tint lands on the focused roof and not on the neighbours or the
tree canopy — so the draped-fill fallback was not needed.

"Strongest at the edges" is built out of **geometry, not a shader**: the
classification path takes a per-instance colour, not a material, so there is no
fragment-varying gradient available. Two volumes do it instead — a fill over an
inset copy of the footprint at 10%, and a rim band (the footprint with that
inset punched out as a hole) at 30%. They share an edge and never overlap, so
neither alpha stacks on the other.

The inset is a scale about the centroid rather than a mitred polygon offset. A
mitred offset of a concave footprint can self-intersect, and an invalid hole is
a Cesium `DeveloperError` that stops the render loop; a uniform scale of a
simple polygon is always simple.

9 m is a little over two storeys. The volume has to *contain* the roof it
colours — one that stops at the eaves leaves the ridge untinted, which reads as
a bug — and going much higher starts catching the canopy overhanging the house.

## Any angle on command

"Show me the back", "from the street", "from the north-east", "closer",
"higher", "orbit". Every one is a **re-framing of HERO**, not a shot of its own,
which is what holds the house at the same place on screen while the camera
travels around it: same subject, same framing fractions, only the pose changes.
Two seconds, cubic in and out, the same easing every other flight uses.

**The front is the wall facing the street.** `orientation.js` takes the stored
street bearing and returns the outward normal of the footprint edge that faces
it — the direction you would be standing to look at the front door. Candidate
edges are those whose normal is within 75° of the street; past that an edge is a
side wall however close to the road its midpoint falls, which is what stops a
corner lot's long flank being read as the frontage. Among those, the edge whose
midpoint reaches furthest towards the street wins, and a longer wall breaks a
tie.

Left and right are **the viewer's**, standing in the street looking at the
front, because that is the only thing a person means by "the left side of the
house".

Without a street the long-wall convention takes over, and the session says so
out loud — "estimated from the building's long wall, no street mapped" — rather
than asserting a front it cannot know. The two perpendiculars to the long axis
are 180° apart and nothing in the geometry says which one is the garden.

Range and pitch are relative and clamped: 60–900 m, 12°–78°. Repeated presses
stop at the rails instead of running to zero or to orbit.

## Best-angle framing

HERO used to fly to a fixed heading of 35° for every house on the board. On an
open corner lot that is fine. On the other side of a mature oak — which in
Oakhurst is most of them — it lands the camera behind a tree and the house the
product just pointed at is a few pixels of roof through foliage.

So before the hero flight, **eight headings are scored** at HERO's own pitch and
range. Rays are cast from each candidate camera position to the footprint's
corners and its centroid against the loaded tiles; the score is the fraction
unoccluded. The centroid is in the sample set because a footprint's corners can
all be visible through gaps while the middle of the roof — the part that fills
the frame — is behind a canopy, and corners alone would score that angle
perfect.

Best score wins. **Ties go to the street**, because a house is meant to be seen
from the front. The tie epsilon is 0.2: with five sample points a score moves in
fifths, so anything smaller is one ray clipping a gutter and must not overrule
framing. Every angle scoring identically is reported as `all-equal` rather than
as a choice — that means the sweep measured nothing, usually because no tiles
were loaded to cast against, and the caller keeps the default heading.

The choice is **cached per property**: the trees do not move between one focus
and the next, and caching also keeps the camera stable, so returning to a house
puts it back where it was rather than somewhere new because a few more tiles had
loaded. `camera.angleChoices` exposes the whole sweep — every heading, its
score, which won, and why.

## Ring and scan wave

Two draped pulses, both drawn the same way: a **static** disc whose material
paints a moving annulus inside it. A ring that literally grew would mean
rebuilding an `EllipseGeometry` every frame, which is the per-frame geometry
work this layer exists to avoid. `st` is the disc's own bounding square, so
`length(st - 0.5) * 2` is the normalised distance from the centre and that is
the only value either shader needs.

- **the ring** loops every 4 s around the top pick's footprint, 0 → 30 m, fading
  as it goes. It fades *in* over the first 8% of the cycle too: a ring that
  appears at full strength and shrinks away reads as a flash at the footprint
  every four seconds rather than as something emanating from the house.
- **the scan** fires once, on `find_money` and on "show me the best one", and
  crosses the scene bounds in 1.6 s before the matches light. It is removed on
  the frame it finishes rather than left classifying tiles for the rest of the
  session.

Both ride the **same shared clock** the rest of `effects/` runs on, so a flight
that freezes the near field freezes these with it rather than leaving a ring
pulsing over a moving camera. `prefers-reduced-motion` parks the ring at a
static radius and drops the scan entirely — the whole point of a travelling wave
is the travel, so there is nothing honest to freeze it at.

`scanEnvelopeFor` rejects `null` **before** coercing it, because `Number(null)`
is `0` and a missing start stamp would otherwise fire a scan rather than report
that there is not one. That is the same trap `nearFieldActive` fell into with
camera height, found the same way — by a test.

## Drive Mode v1

The six-house scene, driven along real roads.

What it replaces: a "route" that was a list of eight houses sorted by score, a
camera that cut from one to the next every seven seconds, and a line read at
each stop. Nothing about it was a drive — no roads, no travel, nothing arriving.

### The route

`scripts/fetch-route.mjs` builds one road-following loop past all six houses,
once, and commits it to `mock/sixRoute.js`. **The app never calls a routing
service at runtime.**

- **Waypoints are the street-facing side**, not the roofs: each row's stored
  street bearing and distance put the waypoint on the kerb the house faces.
  Routing between roofs asks OSRM to find its way to the middle of a building
  and lets it pick whichever kerb it likes.
- **OSRM's `/trip`** solves the visiting order and closes the loop. `/route`
  would take the six in the order given and produce whatever zig-zag implied.
- **Never a straight line through a yard.** Every vertex is checked against
  OSM's own highway geometry from Overpass, and the script refuses to write if
  any sits more than 8 m from a road.

**1,360 m, 38 vertices, worst vertex 0.07 m from a road.** Passing order
006 → 002 → 004 → 005 → 003 → 001.

The verification caught its own bug first: the cheap per-segment reject compared
the point to the segment's *endpoints*, so a long straight road passing a metre
away was discarded as too far and the vertex reported as infinitely off-road.
The reject is a bounding box now.

### One architectural rule

Everything reads the **position source**, never the spline.

```
{ position, bearingDeg, speedMps, timestamp, accuracyM }
```

`PlaybackSource` generates those from the spline; `GpsSource` gets them from a
phone. `driveDemo.js` projects whatever arrives back onto the route and drives
activation, sides and narration off the projection. Reading the spline directly
would be shorter and would mean the GPS path exercised none of the same code.

`positionSource.test.mjs` asserts the consequence directly: the route fed
through `GpsSource` as fake fixes with ±6 m of noise at 9 m/s fires **the same
call-outs in the same order** as playback. Without that test, "pluggable" means
the GPS path compiles.

### The camera

A chase camera on a Catmull-Rom spline — which passes exactly through every
road vertex, where a B-spline would cut the corner and drive through the garden
on the inside of it. **55 m up, pitch −32**, heading low-pass filtered on the
*shortest signed delta* so that filtering 359 towards 1 does not spin the camera
the long way round through south. The filter coefficient comes from elapsed time
rather than per frame, so a turn takes the same wall-clock time at 30 fps as at
60.

Those two numbers are the second attempt. **38 m at −22 was right geometry and
the wrong neighbourhood**: Oakhurst is old and heavily canopied, its oaks top
out around 25–30 m, and a shallow camera at that height spends most of a
residential block looking *through* them. The first headed run's approach frames
read beautifully on the open stretches and its gold frame was tree tops with no
road visible at all. The trees are real and are not going to move, so the camera
clears them — 55 m is above the canopy and still low enough that one roof is
tellable from the next, and −32 is the downward angle that looks *over* a canopy
rather than into it while staying shallower than HERO's 45, so the frame is
still mostly road ahead with houses arriving into it. Steeper would buy more
canopy clearance and start reading as a plan view of the block you are already
on, which is the trade and the reason it stops at −32. `shots.test.mjs` pins
both bounds to those reasons.

Playback is 9 m/s, eased in over 2 s. "Slower" / "faster" scale it ×0.6 / ×1.5;
within 70 m of a house being explained it drops to 40% so the house is still on
screen when the sentence ends. **Playback speed is not a vehicle's speed** and
nothing in the product claims otherwise.

### Activation by distance ahead

Emphasis follows what you can see from here, and it ramps rather than switching
— a house that pops from nothing to a full outline at exactly 120 m reads as a
rendering glitch.

| ahead | what it is |
|---|---|
| > 200 m | a small beacon; something is there, that is all |
| 120 → 60 m | the outline fades in |
| 60 m → 0 | highlight and status motion at full |
| passed | fades to 25%, unless saved or selected |
| well behind | suspended — nothing drawn |

`selected` overrides all of it: the drive does not get to dim the house the user
just asked to look at. **"On your left" is computed from the travel bearing at
that moment**, never stored — on a loop the same house is on your left going one
way and your right coming back.

### Narration

Three rules, enforced in `narration.js` rather than left to the caller: one
call-out per property ever (a second lap does not re-announce), neighbours
within 40 m announced together, and a level the user owns — `full`, `quiet`
(urgent signals only), `off` (silent, but still tracking so "save that one"
works).

**"That one" never guesses.** When a call-out named two houses, a referring
command returns an *ambiguity* and the assistant asks which. Saving the wrong
house is a silent error the user only discovers later.

### Gold on request

"Show me the best match along this route" ranks by composite and gives the top
house the full gold treatment as it is approached. Without the request every
house keeps its signal colour — the gold treatment means "this is the answer",
and gilding a house nobody asked about asserts a ranking the user did not
request.

`smoke:drive` caught a real bug here. "Behind us" was decided from
`signedAheadM`, which on a loop deliberately reports anything more than half a
lap ahead as behind. The best match sits at 1,382 m on a 1,382 m loop, so asked
20 m in it read as 20 m *behind* rather than 1,362 m ahead — the drive announced
it as already missed, suppressed the approach call-out, and left the one house
the user asked about as the only one never mentioned. Whether it has been passed
is a fact the drive already knows: whether it has been announced this lap.

### Two silent bugs the headed check found

Both stopped the render loop; neither could fail a unit test.

1. **A temporal dead zone.** The drive's per-property weight was read in the
   visibility block and declared below it, so `nearFieldEffects` threw on the
   first frame of every drive and Cesium stopped rendering.
2. **A zero-length segment.** The route is a closed loop, so its last vertex
   repeats its first — and `loop: true` adds the closing segment itself. The
   duplicate gave `GroundPolylineGeometry` a segment whose direction cannot be
   normalised: `normalized result is not a number`, thrown from inside the
   render loop.

### A motion tile budget was tried and reverted

The first theory for Drive Mode's dropped frames was tile churn: a moving camera
never lets the streamer converge, so raising `maximumScreenSpaceError` while the
camera moves should trade detail for frame rate. It was built, tested and
measured.

**It does not help.** Across three A/B pairs at the 60 fps cap — the budget
raised versus pinned at its resting value — the runs with it enabled were no
better and noisier: dropped-frame percentages of 34.4 / 10.5 with it against
13.4 / 5.4 without, with within-condition variance larger than the difference
between conditions. Two of three pairs favoured leaving it off.

It was reverted rather than kept "just in case". It mutated a shared tileset
property from a feature that had no measured reason to, and unproven performance
machinery is a liability: the next person to see `sse 24` in a log has to work
out whether it matters.

The theory was wrong because the cost was somewhere else entirely.

### What was actually costing the frames

`scene.sampleHeight` is a **render-thread query**. `nearFieldEffects` documents
that and deliberately uses a market constant rather than call it per frame. The
chase camera called it on **every frame** through `destinationOf`, and so did
the hero orbit.

Measured at the 60 fps cap, with the call stubbed out:

| | p95 | dropped frames |
|---|---|---|
| `sampleHeight` per frame | 33.4 ms | 16–23% |
| `sampleHeight` skipped | **18.6 ms** | **0.8–3.1%** |

Both conditions reproduced across repeats. It was not tiles, it was this.

The fix is to sample sparingly rather than never: the drive re-samples after 20 m
of travel or 300 ms, whichever comes first, and eases the result rather than
stepping it, because tiles stream in underneath and a late sample can differ from
an early one by a metre or two — which as a step is a visible bob. The orbit
samples **once**, because its subject does not move and its ground is therefore a
constant.

After the fix, on a clean mid-drive window: **p95 31.3 ms and 5.2% dropped**,
identical across repeats, against 33.4 ms and 16–23% before.

### The probe must not charge its own stalls to the product

`page.screenshot()` blocks the compositor for hundreds of milliseconds — the
drive's worst frame was 2,266 ms and every one of those was a capture. At the
30 fps cap the budget was loose enough to hide it; at 60 fps it alone pushed the
drive's p95 over budget while a clean window of the same drive measured 31.3 ms.
Captures are now bracketed in page time and excluded from every frame window.

Measured after both fixes: **`smoke:drive` p95 18.6–18.7 ms** against a 37.3 ms
budget at the 60 fps cap, stable across three consecutive runs.

### The frame budget is counted in dropped vsyncs

```
budget = max(33, frameInterval × 2) × 1.12
```

Frame times on a vsync-locked renderer are quantised — at 60 fps a frame costs
16.7 or 33.3 or 50 ms and nothing in between — so a p95 is not really a duration.
It is a statement about how many vsyncs the 95th-percentile frame missed, and the
budget says one thing: **at the 95th percentile a frame may miss one vsync, and
may not miss two.**

One is acceptable because the windows being measured are the two flights that end
on geometry never before in view at that LOD. Google's photogrammetry is streamed,
not resident, and a renderer that never missed a vsync while arriving somewhere
new would be one that had stopped asking for new detail. Two is not acceptable:
50 ms at 60 fps reads as a stutter rather than as loading.

The tolerance has to apply to the **floor** as well as to the measured interval,
and originally did not. `max(33, frameInterval × 1.12)` puts the budget at exactly
33.0 ms at 60 fps — while a frame that drops one vsync at 60 fps costs 33.3 ms,
which always exceeds it. The check therefore demanded that fewer than 5% of frames
drop even a single vsync, which is not what "33 ms with two frames of slack" was
meant to say: `smoke:six` failed at 33.4 against 33.0 while rendering exactly as
designed, having passed at 34.2 against 37.3 the day before for no reason other
than the laptop being unplugged.

The 33 ms floor is kept for displays faster than 60 Hz. On a 120 Hz panel
`frameInterval × 2` is 16.7 ms, and holding the investor demo to that would be
asserting something about the hardware rather than about the product.

### `npm run smoke:drive`

Everything v1 asserted, plus:

- the drive is the **3D chase camera** and the Maps JavaScript API has not been
  loaded at all — a panorama mounted before anything asked for one means the
  lazy load has quietly stopped being lazy;
- **"from the street"** parks the drive and puts a real panorama on screen:
  exactly one layer at full opacity, a real panorama id, "From the street." said
  over it. Four facts, because each can be true alone — a director that claims
  `streetview` over a hidden host, a visible host with no panorama in it, a
  panorama with the drive still rolling underneath it, or the right picture with
  the wrong words;
- a **second panorama** cross-fades without the screen ever going blank, which
  is the only headed exercise the double buffer gets and the one failure mode it
  is uniquely capable of;
- **"how big is the lot"** puts the 3D scene on screen (pano at opacity 0),
  framing a house at HERO, with the near-field layer drawing the parcel — and
  says "Here's the lot.";
- **"keep going"** comes back to the road on the metre it left.

That last one is measured in three facts rather than one, because the obvious
check fails a drive that is working: the drive resumes and then *keeps driving*,
so at 4x a settle long enough for the cross-fade is 70 m of perfectly correct
progress read as drift. What is asserted instead is that the saved point is
where the question was asked, that the drive did not move **a single metre**
while the answer was on screen, and that coming back it is ahead of the saved
point by no more than the time since it resumed allows.

It writes `drive-streetview.png` alongside v1's three.

### `npm run smoke:six`

A fourth headed check, narrower than `smoke:demo` on purpose: it does not drive
the conversation, it measures the shots the near-field layer has to hold. It
fails unless all six outlines built off real footprints, the layer is active at
900 m, "show me the best one" lands on the gold house, there are no render
errors, and **p95 frame time is ≤ 33 ms** in both the settled cruise and the
flight to hero.

It then drives two any-angle moves — **"show me the back"** and **"from the
north-east"** — and asserts that the focused house's *footprint centroid* stays
inside the middle 30% of the frame through both. The footprint and not the
marker: the marker floats 14 m over the roof, so centring it sits the house
itself low in frame, which is exactly the error the framing tilts exist to
cancel. That check is what caught `HERO` framing the marker and leaving the
house at **69%** down the frame, against the command bar — see
`HERO.markerRiseShare`. 33 ms rather than `smoke:demo`'s 120 ms because that budget is
the whole question: building once and animating through uniforms is only worth
doing if the result holds 30 fps.

It writes `cruise-six.png`, `hero-six.png`, `hero-six-plus-4s.png`,
`hero-six-back.png` and `hero-six-northeast.png` to `/tmp/shots/`. The second
angle used to be "from the street"; that phrase now opens the Street View
panorama rather than placing a 3D camera at the kerb, so the pair moved to the
compass path — which the old one never covered.

**The budget is relative to the frame cap, not absolute.** 33 ms *is* 30 fps,
and `frameBudget.js` caps the investor viewer at exactly 30 fps whenever the
machine is on battery — which is the demo machine. A flat 33 ms budget is
therefore unachievable by construction on an unplugged laptop: the first run on
battery failed at 33.4 ms while rendering perfectly, with p50 33.3 and worst
34.3, the cap held to a tenth of a millisecond. The check now takes the larger
of 33 ms and the viewer's own frame interval plus 12%, and prints which applied.
At 60 fps the 33 ms figure binds with two frames of slack; at 30 fps it becomes
37 ms, which a held cap clears and a real stall does not.

Measured both ways: **17.9 / 18.3 ms** on mains at 60 fps, **33.8 / 33.8 ms** on
battery at 30 fps.

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
