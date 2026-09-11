# Investor globe hard-lock — diagnosis (2026-09-11)

**Status: diagnosed and proven. Fix NOT applied — `src/` is untouched.**

## Symptom

`http://localhost:4173/?demo=1&welcome=1` renders the HUD, the globe stays a
black disc with only the atmosphere ring, and the tab stops responding.
Classic mode is unaffected.

## Cause

`src/investor/ui/chrome.js` — `relocateVoiceControl()` installs a
`MutationObserver` on `document.body` with `{childList: true, subtree: true}`
whose callback (`placeVoiceInSlot`) ends with an unconditional:

```js
if (label) label.textContent = 'MIC';
```

Assigning `textContent` replaces the text node **even when the string is
unchanged**. That is a childList mutation inside the observed subtree, so the
observer re-fires itself forever.

Observer callbacks are **microtasks**, so the checkpoint never drains and the
event loop never reaches the task queue: no `requestAnimationFrame` (Cesium
stops rendering — the black disc is the last frame before the lock), no CDP
`Runtime.evaluate`, no `PerformanceObserver` delivery.

## Evidence

| | investor (keyed) | classic | investor (keyless) |
|---|---|---|---|
| `tile.googleapis.com` | 1 req, 200, 27 KB | 178 req, all 200, 9.4 MB | 1 req, 200, 27 KB |
| centre pixel non-black | NEVER | 3,045 ms | NEVER |
| responsive at 30s | no | yes | no |

`investor-mutation-trace.log` names the churn directly:
`target: SPAN.gev-mic-label, added: [#text], removed: [#text]`, with DOM
structure constant (30 body children) in every sample.

Keyless is identical to keyed — **not** a key, tile, or basemap-fallback issue.

## Proof

`scripts/investor-fix-experiment.mjs` rewrites that one line over the network
(no file changed) to `if (label && label.textContent !== 'MIC')`:

| | first paint | blocked samples | Google tiles |
|---|---|---|---|
| unpatched control | NEVER | 8/8 | 1 |
| guarded write | 2,936 ms | 0/8 | 105 |

## Reading these logs

Three things that look like missing data are findings, not gaps:

- **Zero long tasks** — `PerformanceObserver` delivery is itself starved.
- **Unreadable governor holds** — no hold leaked; the reader never ran.
- **One Google request** — that is the root `tileset.json`. Child tiles are
  requested from Cesium's update loop, which never runs again.

`Runtime.evaluate` and `Profiler.stop` both queue on the wedged thread. Only
`Debugger.pause` (a V8 interrupt, honoured at loop back-edges) can break in.

The `renderUntilGlobePaints` / `#ts-globe-error` watchdog in `ensureBasemap.js`
is designed to catch exactly this symptom but cannot fire — it shares the
starved thread.

## Proposed change

1. Guard the write: `if (label && label.textContent !== 'MIC') ...`
2. Narrow the observer off `document.body`, and/or add a re-entrancy guard so
   the callback cannot run against its own writes.
3. Check whether the 800 ms `relocateVoiceControl` timer in `session.js` is
   still needed.
4. Give `scripts/investor-probe.mjs` a pass/fail exit code — `npm test` was
   fully green while the page was hard-locked.

## Scripts

- `scripts/investor-probe.mjs <url> <log> <label>` — 30s headed probe: tile
  traffic, centre pixel, long tasks, governor holds, console.
- `scripts/investor-break-in.mjs` — `Debugger.pause` into a wedged thread.
- `scripts/investor-mutation-trace.mjs` — reads the MutationRecords at the pause.
- `scripts/investor-cpu-profile.mjs` — locked-vs-starved test + CPU profile.
- `scripts/investor-fix-experiment.mjs [on|off]` — A/B the fix in flight.

All require real Chrome (`channel: 'chrome'`, `headless: false`) — this does not
reproduce headless. Playwright is in `node_modules` but not in `package.json`.
