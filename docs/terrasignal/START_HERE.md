# Start here — TerraSignal Investor demo

## 5-minute demo script

No OpenAI key. No mic. Mock data only.

```bash
cp .env.example .env   # investor + PROPERTY_PROVIDER=mock already
npm ci                 # once
npm run dev
```

Open:

**http://localhost:4173/?demo=1&welcome=1**

Demo mode pins the clock to **2026-09-10** so every "filed N days ago" and "auction in N days" stays put. Override with `?clock=YYYY-MM-DD` or `TERRASIGNAL_DEMO_CLOCK`.

Vite listens on **4173**. No `CESIUM_ION_TOKEN` or `GOOGLE_MAPS_API_KEY` is required: the keyless path tries Esri World Imagery, falls back to OSM on any failure (with a toast), then keeps `requestRender` until the first painted frame (`tilesLoaded` / non-black center pixel / 10s error). A 4s `investor-first-paint` hold prevents idle `requestRenderMode` before tiles are requested — it is not a forever 60 fps loop. Investor demo caps at **30 fps** on battery/unknown power. Classic GEV (`?product=classic`) stays on its 60 fps idle governor.

The left **5-minute demo** rail shows the next step. Press **Send this phrase** (or type it in the command bar and hit SEND). **Play** auto-advances. The **DEMO** chip toggles the rail if you opened the app without `?demo=1`.

### Exact phrases (case-insensitive; periods optional)

1. Hunt card: **Where are we hunting today?** → click **Atlanta / Decatur** (or press Next on the rail). Camera descends into the market. Houses pulse by signal.
2. `Find me money`
   - Opportunity Vision ON
   - Ranks the mock neighborhood
   - Exactly **4** strong candidates activate
   - Best turns **gold** (head of the composite ranking, not a field on the row)
   - Camera focuses that house
3. `Why?` — why-this-matters for the focused house, including the first-Tuesday auction date and countdown
4. `Show me the deal` — Deal Vision on the globe (FLIP / RENT / BRRRR / WHOLESALE)
5. `Assume rehab is twenty thousand higher` — deterministic +$20k; numbers update
6. `Save it` — `localStorage` + SAVED sheet + saved-ring feedback

## Talk to it

The five phrases above are the scripted demo. The command bar and the mic
understand a good deal more — same parser either way, so anything typed can be
spoken. Unrecognised input answers with the nearest phrase it does know.

**Hunt**

- `find me money`
- `find foreclosures under 250k in dekalb`
- `show me tax sales`
- `top 3 rentals in decatur`
- `best brrrr`
- `any foreclosures in grant park`

**Focus**

- `show me 214 sycamore`
- `number two` · `the second one`
- `next` · `previous`
- `the gold one`

**Underwrite**

- `show me the deal`
- `run it as a rental`
- `what about brrrr`
- `compare` — all four paths side by side
- `why not wholesale` — why that path is a pass, with the numbers that decided it

**What-if**

- `assume rehab is twenty thousand higher`
- `rehab is 60` · `what if i pay 110` · `offer 195,000`
- `rent 2800` · `rate 6.5` · `hold 9 months`
- `rehab 20 percent higher`
- `reset the numbers`

**Save and navigate**

- `save it` · `save it with note call the agent tuesday`
- `unsave` · `show saved`
- `zoom out` · `vision off` · `help`

What-ifs change the focused deal and the globe caption only. The score and the
ranking stay on the listed numbers, so the board keeps meaning the same thing —
the card shows a **Custom numbers** chip with a Reset while any are in play.

DRIVE is a separate simulated route (not GPS). It must not be required for the sequence above. WORLD recenters the market.

Classic GEV chrome: `TERRASIGNAL_PRODUCT=classic` or `?product=classic`.

### Headed-only checks (need WebGL)

This agent VM cannot initialize Cesium WebGL. On a GPU machine, also confirm:

- Globe appears under the calm investor HUD (no TOP SECRET / filter dashboard). Black void + Cesium/Esri credits without Earth is a failure; after Atlanta/Decatur a gray ellipsoid without imagery must show `#ts-globe-error`
- After Atlanta/Decatur, semantic pulses use the render governor only (FORECLOSURE heartbeat, TAX_SALE vertical, DISTRESS shimmer, LISTED ring, gold halo on the ranked top pick)
- `prefers-reduced-motion: reduce` freezes motion
- Clicking a pulse focuses that mock house
- OpenSky / FIRMS / cables / news stay off

## Honest limits

All addresses and numbers are invented. `PROPERTY_PROVIDER` must stay `mock` in Phase 1. Do not use this for investment decisions.
