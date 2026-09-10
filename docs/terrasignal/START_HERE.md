# Start here — TerraSignal Investor demo

## Run

```bash
cp .env.example .env   # already defaults to investor + mock
npm ci
npm run dev
```

Open `http://localhost:4173`. Optional Cesium ion or Google 3D keys improve the globe; they are not required for the mock hunt.

Classic God's Eye View chrome: `TERRASIGNAL_PRODUCT=classic` or `?product=classic`.

## First 60 seconds

1. The globe opens, then descends into Atlanta / Decatur.
2. ≥25 DEMO/MOCK properties animate by signal (unless `prefers-reduced-motion`).
3. The AI line asks **Where are we hunting today?**
4. Type or say the demo conversation (OpenAI optional for typed demo):

   - Find me money
   - Why?
   - Show me the deal
   - Assume rehab is twenty thousand higher
   - Save it

5. Bottom nav: **WORLD** recenters the market, **DRIVE** runs the simulated route, **SAVED** opens local bookmarks, **AI** is the mic (and the text line).

## Screenshots to capture

- Globe descent into Decatur with Opportunity Vision on
- Focus card on `DEMO-ATL-001` (Sycamore / foreclosure top pick)
- Deal Vision after “Show me the deal”
- Same card after “rehab is twenty thousand higher”
- Saved sheet
- Drive demo announcing a strong signal only
- Reduced-motion: static colors, no pulse

## Honest limits

All addresses and numbers are invented. `PROPERTY_PROVIDER` must stay `mock` in Phase 1. Do not use this for investment decisions.
