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

Vite listens on **4173**. Optional Cesium ion / Google 3D keys make the globe photoreal; they are not required for the typed sequence.

The left **5-minute demo** rail shows the next step. Press **Send this phrase** (or type it in the command bar and hit SEND). **Play** auto-advances. The **DEMO** chip toggles the rail if you opened the app without `?demo=1`.

### Exact phrases (case-insensitive; periods optional)

1. Hunt card: **Where are we hunting today?** → click **Atlanta / Decatur** (or press Next on the rail). Camera descends into the market. Houses pulse by signal.
2. `Find me money`
   - Opportunity Vision ON
   - Ranks the mock neighborhood
   - Exactly **4** strong candidates activate
   - Best turns **gold** (TOP_PICK)
   - Camera focuses that house
3. `Why?` — why-this-matters for the focused house
4. `Show me the deal` — Deal Vision on the globe (FLIP / RENT / BRRRR / WHOLESALE)
5. `Assume rehab is twenty thousand higher` — deterministic +$20k; numbers update
6. `Save it` — `localStorage` + SAVED sheet + saved-ring feedback

DRIVE is a separate simulated route (not GPS). It must not be required for the sequence above. WORLD recenters the market.

Classic GEV chrome: `TERRASIGNAL_PRODUCT=classic` or `?product=classic`.

### Headed-only checks (need WebGL)

This agent VM cannot initialize Cesium WebGL. On a GPU machine, also confirm:

- Globe appears under the calm investor HUD (no TOP SECRET / filter dashboard)
- After Atlanta/Decatur, semantic pulses use the render governor only (FORECLOSURE heartbeat, TAX_SALE vertical, DISTRESS shimmer, LISTED ring, TOP_PICK gold)
- `prefers-reduced-motion: reduce` freezes motion
- Clicking a pulse focuses that mock house
- OpenSky / FIRMS / cables / news stay off

## Honest limits

All addresses and numbers are invented. `PROPERTY_PROVIDER` must stay `mock` in Phase 1. Do not use this for investment decisions.
