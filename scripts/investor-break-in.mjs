#!/usr/bin/env node
/**
 * Break into the wedged investor main thread and print the stack.
 *
 * Profiler.stop and Runtime.evaluate both queue on the main thread's message
 * loop, so a synchronous infinite loop starves them. Debugger.pause is
 * different: it sets a V8 interrupt that is checked at loop back-edges and
 * function entries, so it can stop a spinning loop that nothing else can reach.
 *
 * Read-only. No src/ file is modified.
 */
import { chromium } from 'playwright';
import { writeFileSync } from 'node:fs';

const URL_ARG = process.argv[2] || 'http://localhost:4173/?demo=1&welcome=1';
const OUT = process.argv[3] || '/tmp/investor-break-in.log';
const SETTLE_MS = Number(process.argv[4] || 9000);

async function main() {
  const lines = [];
  const say = (s) => { lines.push(s); console.log(s); };

  const browser = await chromium.launch({ channel: 'chrome', headless: false });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  const client = await context.newCDPSession(page);

  const paused = new Promise((resolve) => {
    client.on('Debugger.paused', (event) => resolve(event));
  });

  await client.send('Debugger.enable');
  await client.send('Debugger.setAsyncCallStackDepth', { maxDepth: 32 });

  await page.goto(URL_ARG, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  say(`navigated; letting it wedge for ${SETTLE_MS}ms`);
  await new Promise((r) => setTimeout(r, SETTLE_MS));

  say('sending Debugger.pause (V8 interrupt)...');
  client.send('Debugger.pause').catch((e) => say(`  pause send error: ${e.message}`));

  const event = await Promise.race([
    paused,
    new Promise((r) => setTimeout(() => r(null), 20_000)),
  ]);

  if (!event) {
    say('  never paused — not a JS loop (native/GPU stall?)');
  } else {
    say(`\n-- PAUSED (${event.reason}) — main-thread stack, innermost first --\n`);
    const scripts = new Map();
    for (const [i, frame] of (event.callFrames || []).entries()) {
      const loc = frame.location || {};
      let url = scripts.get(loc.scriptId);
      if (url === undefined) {
        try {
          const src = await client.send('Debugger.getScriptSource', { scriptId: loc.scriptId });
          url = src.scriptSource ? '' : '';
        } catch { url = ''; }
        scripts.set(loc.scriptId, url);
      }
      say(`  #${String(i).padStart(2)}  ${(frame.functionName || '(anonymous)').padEnd(38)} `
        + `${(frame.url || '<inline>').replace(/^https?:\/\/[^/]+/, '')}:${(loc.lineNumber ?? 0) + 1}:${(loc.columnNumber ?? 0) + 1}`);
      if (i >= 24) { say('  ... (truncated)'); break; }
    }

    // The innermost frame's source line is usually the whole story.
    const top = (event.callFrames || [])[0];
    if (top) {
      try {
        const src = await client.send('Debugger.getScriptSource', { scriptId: top.location.scriptId });
        const srcLines = src.scriptSource.split('\n');
        const n = top.location.lineNumber;
        say('\n-- source around the innermost frame --');
        for (let i = Math.max(0, n - 6); i <= Math.min(srcLines.length - 1, n + 6); i += 1) {
          say(`  ${i === n ? '>>' : '  '} ${String(i + 1).padStart(5)}  ${srcLines[i]}`);
        }
      } catch (e) {
        say(`  (could not fetch source: ${e.message})`);
      }
    }
  }

  try { await client.send('Debugger.resume'); } catch { /* already gone */ }
  await browser.close();
  writeFileSync(OUT, lines.join('\n') + '\n');
  say(`\nsaved: ${OUT}`);
}

main().catch((e) => { console.error('break-in failed:', e); process.exit(1); });
