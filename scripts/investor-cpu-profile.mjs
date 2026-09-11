#!/usr/bin/env node
/**
 * Why is the investor main thread wedged?
 *
 * Two questions the response probe cannot answer:
 *   1. Is the thread HARD-LOCKED (a synchronous loop that never yields) or
 *      STARVED (the message loop runs, but work is queued faster than it
 *      drains)? Answered by one evaluate with a very long timeout: a starved
 *      thread eventually replies, a locked one never does.
 *   2. What JS is actually running? Answered by the V8 sampling profiler over
 *      CDP, aggregated by self time.
 *
 * Read-only. No src/ file is modified.
 */
import { chromium } from 'playwright';
import { writeFileSync } from 'node:fs';

const URL_ARG = process.argv[2] || 'http://localhost:4173/?demo=1&welcome=1';
const OUT = process.argv[3] || '/tmp/investor-cpu-profile.log';
const SETTLE_MS = 12_000;
const LONG_EVAL_MS = 25_000;

function race(promise, ms, tag) {
  let timer;
  return Promise.race([
    promise.then((v) => ({ ok: true, value: v })).catch((e) => ({ ok: false, error: String(e?.message || e) })),
    new Promise((resolve) => { timer = setTimeout(() => resolve({ ok: false, timedOut: true, tag }), ms); }),
  ]).finally(() => clearTimeout(timer));
}

async function main() {
  const lines = [];
  const say = (s) => { lines.push(s); console.log(s); };

  const browser = await chromium.launch({ channel: 'chrome', headless: false });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  const client = await context.newCDPSession(page);

  await client.send('Profiler.enable');
  await client.send('Profiler.setSamplingInterval', { interval: 200 });
  await client.send('Profiler.start');

  const t0 = Date.now();
  await page.goto(URL_ARG, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  say(`navigated in ${Date.now() - t0}ms`);

  await new Promise((r) => setTimeout(r, SETTLE_MS));

  // Question 1 — locked or merely starved?
  say(`\nissuing one evaluate with a ${LONG_EVAL_MS}ms budget...`);
  const evalStart = Date.now();
  const answered = await race(
    page.evaluate(() => ({
      rrm: window.__godsEyeView?.viewer?.scene?.requestRenderMode ?? null,
      holds: window.__godsEyeView?.getRenderGovernorDiagnostics?.()?.holds ?? null,
      mode: window.__godsEyeView?.getRenderGovernorDiagnostics?.()?.mode ?? null,
      hasInvestor: Boolean(window.__terraSignal),
      primitives: window.__godsEyeView?.viewer?.scene?.primitives?.length ?? null,
      tileset: Boolean(window.__godsEyeView?.tileset),
    })),
    LONG_EVAL_MS,
    'evaluate',
  );
  const waited = Date.now() - evalStart;
  if (answered.timedOut) {
    say(`  NO REPLY after ${waited}ms → main thread is HARD-LOCKED (synchronous, never yields)`);
  } else if (answered.ok) {
    say(`  replied after ${waited}ms → thread is STARVED, not locked`);
    say(`  ${JSON.stringify(answered.value)}`);
  } else {
    say(`  evaluate errored after ${waited}ms: ${answered.error}`);
  }

  // Question 2 — what is on the stack?
  say('\nstopping profiler...');
  const stopped = await race(client.send('Profiler.stop'), 15_000, 'Profiler.stop');
  if (stopped.timedOut || !stopped.ok) {
    say(`  Profiler.stop did not return (${stopped.error || 'timeout'}) — `
      + 'the inspector shares the wedged main thread.');
  } else {
    const profile = stopped.value.profile;
    const byId = new Map(profile.nodes.map((n) => [n.id, n]));
    const self = new Map();
    for (const id of profile.samples || []) {
      const node = byId.get(id);
      if (!node) continue;
      const f = node.callFrame;
      const key = `${f.functionName || '(anonymous)'} @ ${String(f.url || '').split('/').slice(-1)[0]}:${f.lineNumber + 1}`;
      self.set(key, (self.get(key) || 0) + 1);
    }
    const total = (profile.samples || []).length;
    say(`\n-- CPU PROFILE: ${total} samples over ~${((profile.endTime - profile.startTime) / 1e6).toFixed(1)}s --`);
    say('  self%   samples  function');
    for (const [key, n] of [...self.entries()].sort((a, b) => b[1] - a[1]).slice(0, 25)) {
      say(`  ${((n / total) * 100).toFixed(1).padStart(5)}%  ${String(n).padStart(7)}  ${key}`);
    }
  }

  await browser.close();
  writeFileSync(OUT, lines.join('\n') + '\n');
  say(`\nsaved: ${OUT}`);
}

main().catch((e) => { console.error('profile failed:', e); process.exit(1); });
