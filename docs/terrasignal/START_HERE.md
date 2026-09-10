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

1. The globe stays primary — dark-edge HUD, no GEV filter dashboard.
2. First-run hunt ritual: **Where are we hunting today?** Choose Atlanta/Decatur or stay on the globe. Returning visitors skip it (`terrasignal:first-hunt:v1`). Share links and `?welcome=0` suppress it; `?welcome=1` replays.
3. After you choose the hunt, the camera descends into Decatur. ≥25 DEMO/MOCK properties pulse by signal (unless `prefers-reduced-motion`).
4. Type or say the demo conversation (OpenAI optional for typed demo):

   - Find me money
   - Why?
   - Show me the deal
   - Assume rehab is twenty thousand higher
   - Save it

5. Bottom dock: **WORLD · DRIVE · MIC · SAVED**. The central MIC is the GEV voice control (Space is still push-to-talk). No dense filter chrome.

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
