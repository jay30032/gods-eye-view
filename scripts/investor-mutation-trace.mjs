#!/usr/bin/env node
/**
 * Name the element that is churning the DOM.
 *
 * The break-in paused at the entry of worldOverlay's MutationObserver callback,
 * which only sets flags — so it is the victim of an unbounded mutation loop,
 * not its cause. While paused we can run Debugger.evaluateOnCallFrame inside
 * that frame and read the actual MutationRecords, which name the node being
 * added and removed over and over.
 *
 * Read-only. No src/ file is modified.
 */
import { chromium } from 'playwright';
import { writeFileSync } from 'node:fs';

const URL_ARG = process.argv[2] || 'http://localhost:4173/?demo=1&welcome=1';
const OUT = process.argv[3] || '/tmp/investor-mutation-trace.log';
const SETTLE_MS = 9000;
const ROUNDS = 3;

const SUMMARIZE = `(() => {
  const label = (n) => {
    if (!n) return 'null';
    const id = n.id ? '#' + n.id : '';
    const cls = n.className && typeof n.className === 'string'
      ? '.' + n.className.trim().split(/\\s+/).slice(0, 3).join('.')
      : '';
    return (n.nodeName || '?') + id + cls;
  };
  try {
    const rs = (typeof records !== 'undefined' && records) ? Array.from(records) : [];
    return JSON.stringify({
      count: rs.length,
      sample: rs.slice(0, 8).map((r) => ({
        type: r.type,
        target: label(r.target),
        added: Array.from(r.addedNodes || []).slice(0, 4).map(label),
        removed: Array.from(r.removedNodes || []).slice(0, 4).map(label),
      })),
    });
  } catch (e) { return JSON.stringify({ error: String(e) }); }
})()`;

async function main() {
  const lines = [];
  const say = (s) => { lines.push(s); console.log(s); };

  const browser = await chromium.launch({ channel: 'chrome', headless: false });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  const client = await context.newCDPSession(page);

  await client.send('Debugger.enable');
  await page.goto(URL_ARG, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  say(`navigated; wedging for ${SETTLE_MS}ms\n`);
  await new Promise((r) => setTimeout(r, SETTLE_MS));

  for (let round = 1; round <= ROUNDS; round += 1) {
    const paused = new Promise((resolve) => client.once('Debugger.paused', resolve));
    client.send('Debugger.pause').catch(() => {});
    const event = await Promise.race([paused, new Promise((r) => setTimeout(() => r(null), 15_000))]);
    if (!event) { say(`round ${round}: never paused`); break; }

    const top = event.callFrames?.[0];
    say(`round ${round}: paused in ${top?.functionName || '(anonymous)'} `
      + `${(top?.url || '<inline>').replace(/^https?:\/\/[^/]+/, '')}:${(top?.location?.lineNumber ?? 0) + 1}`);
    say(`  stack: ${(event.callFrames || []).slice(0, 6).map((f) => f.functionName || '(anon)').join(' <- ')}`);

    if (top) {
      try {
        const res = await client.send('Debugger.evaluateOnCallFrame', {
          callFrameId: top.callFrameId,
          expression: SUMMARIZE,
          returnByValue: true,
        });
        say(`  records: ${res.result?.value || JSON.stringify(res.result)}`);
      } catch (e) {
        say(`  (evaluateOnCallFrame failed: ${e.message})`);
      }
      // How big is the churn? Count the suspicious nodes document-wide.
      try {
        const res = await client.send('Debugger.evaluateOnCallFrame', {
          callFrameId: top.callFrameId,
          expression: `JSON.stringify({
            bodyChildren: document.body.children.length,
            canvases: document.querySelectorAll('canvas').length,
            cesiumWidgets: document.querySelectorAll('.cesium-widget').length,
            creditEls: document.querySelectorAll('.cesium-widget-credits, .cesium-credit-lightbox, .cesium-credit-expand-link').length,
            tsShell: document.querySelectorAll('#terrasignal-shell').length,
            tsFocus: document.querySelectorAll('#ts-focus-card').length,
            tsDemo: document.querySelectorAll('#ts-demo-script').length
          })`,
          returnByValue: true,
        });
        say(`  dom: ${res.result?.value}`);
      } catch (e) {
        say(`  (dom probe failed: ${e.message})`);
      }
    }

    await client.send('Debugger.resume').catch(() => {});
    await new Promise((r) => setTimeout(r, 1200));
    say('');
  }

  await browser.close();
  writeFileSync(OUT, lines.join('\n') + '\n');
  say(`saved: ${OUT}`);
}

main().catch((e) => { console.error('trace failed:', e); process.exit(1); });
