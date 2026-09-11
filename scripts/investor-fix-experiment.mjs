#!/usr/bin/env node
/**
 * Prove the diagnosis without editing any file.
 *
 * Hypothesis: relocateVoiceControl() installs a MutationObserver on
 * document.body {childList, subtree} whose callback unconditionally assigns
 * label.textContent = 'MIC'. Assigning textContent replaces the text node even
 * when the string is unchanged, which is itself a childList mutation on the
 * observed subtree — so the callback re-triggers itself forever. Observer
 * callbacks are microtasks, so the loop never yields to the task queue: no
 * rAF, no render, no CDP evaluate.
 *
 * Test: intercept the module over the network and make that one write
 * conditional. If the page then paints and stays responsive, the cycle is the
 * cause. src/ is untouched; this only rewrites the response in flight.
 */
import { chromium } from 'playwright';

const URL_ARG = process.argv[2] || 'http://localhost:4173/?demo=1&welcome=1';
const PATCH = process.argv[3] !== 'off';
const DURATION_MS = 20_000;

const ORIGINAL = "if (label) label.textContent = 'MIC';";
const PATCHED = "if (label && label.textContent !== 'MIC') label.textContent = 'MIC';";

async function main() {
  const browser = await chromium.launch({ channel: 'chrome', headless: false });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();

  let patchedOk = null;
  if (PATCH) {
    await page.route('**/src/investor/ui/chrome.js*', async (route) => {
      const response = await route.fetch();
      const body = await response.text();
      if (!body.includes(ORIGINAL)) {
        patchedOk = false;
        return route.fulfill({ response, body });
      }
      patchedOk = true;
      return route.fulfill({
        response,
        body: body.replace(ORIGINAL, PATCHED),
        headers: { ...response.headers(), 'content-type': 'application/javascript' },
      });
    });
  }

  let googleTiles = 0;
  page.on('response', (r) => {
    if (r.url().includes('tile.googleapis.com')) googleTiles += 1;
  });

  const t0 = Date.now();
  await page.goto(URL_ARG, { waitUntil: 'domcontentloaded', timeout: 30_000 });

  const samples = [];
  for (let i = 0; i < 8; i += 1) {
    await new Promise((r) => setTimeout(r, 2500));
    let timer;
    const timeout = new Promise((res) => { timer = setTimeout(() => res({ blocked: true }), 2000); });
    const probe = page.evaluate(() => {
      const viewer = window.__godsEyeView?.viewer;
      const canvas = viewer?.scene?.canvas;
      const gl = viewer?.scene?.context?._gl;
      let rgba = null;
      if (gl && canvas?.width > 1) {
        const px = new Uint8Array(4);
        try {
          gl.readPixels(canvas.width >> 1, canvas.height >> 1, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
          rgba = [px[0], px[1], px[2], px[3]];
        } catch { /* context lost */ }
      }
      return {
        rgba,
        investor: Boolean(window.__terraSignal),
        primitives: viewer?.scene?.primitives?.length ?? null,
        holds: window.__godsEyeView?.getRenderGovernorDiagnostics?.()?.holds ?? null,
      };
    }).catch((e) => ({ err: String(e.message).slice(0, 60) }));

    const out = await Promise.race([probe, timeout]).finally(() => clearTimeout(timer));
    const painted = out.rgba && out.rgba[3] >= 8 && (out.rgba[0] + out.rgba[1] + out.rgba[2]) > 24;
    samples.push({ t: Date.now() - t0, ...out, painted });
    console.log(`  ${String(Date.now() - t0).padStart(6)}ms  `
      + (out.blocked ? 'BLOCKED'
        : `${painted ? 'PAINTED' : 'black  '} rgba=${out.rgba ? out.rgba.join(',') : 'n/a'} `
          + `investor=${out.investor} primitives=${out.primitives} holds=[${(out.holds || []).join(',')}]`));
  }

  const blocked = samples.filter((s) => s.blocked).length;
  const firstPaint = samples.find((s) => s.painted);
  console.log(`\n=== ${PATCH ? 'PATCHED (textContent write guarded)' : 'UNPATCHED (control)'} ===`);
  console.log(`  module patch applied : ${PATCH ? patchedOk : 'n/a'}`);
  console.log(`  blocked samples      : ${blocked}/${samples.length}`);
  console.log(`  first painted        : ${firstPaint ? `${firstPaint.t}ms` : 'NEVER'}`);
  console.log(`  google tile responses: ${googleTiles}`);

  await browser.close();
}

main().catch((e) => { console.error(e); process.exit(1); });
