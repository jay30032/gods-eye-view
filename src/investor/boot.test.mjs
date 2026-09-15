import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

test('investor boot stays Cesium-free and is the first module in index.html', () => {
  const boot = readFileSync(join(here, 'boot.js'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '');
  const html = readFileSync(join(here, '../../index.html'), 'utf8');
  assert.doesNotMatch(boot, /from ['"]cesium['"]|import\s*\*\s*as\s*Cesium/i);
  const bootIdx = html.indexOf('src="/src/investor/boot.js"');
  const mainIdx = html.indexOf('src="/src/main.js"');
  assert.equal(bootIdx > 0 && bootIdx < mainIdx, true);
  assert.match(html, /id="terrasignal-shell"/);
  assert.match(html, /Where are we hunting today\?/);
  assert.match(html, /data-ts-nav="world"/);
  assert.match(html, /id="ts-demo-script"/);
  assert.match(html, /id="ts-demo-chip"/);
});

test('the static shell in index.html carries every chip the JS shell does', () => {
  /**
   * There are two copies of this markup and only one of them ever runs.
   *
   * `index.html` ships the shell statically so the investor chrome is on screen
   * before any module evaluates, and `ensureInvestorShell` **returns early when
   * it finds one** — so a control added only to the JS template is a control
   * that exists in the bundle, passes every import, and is not in the DOM. That
   * is exactly how the (since removed) TREES chip shipped invisible: the source
   * had it, the built bundle had it, and the page did not.
   */
  const html = readFileSync(join(here, '../../index.html'), 'utf8');
  const chrome = readFileSync(join(here, 'ui/chrome.js'), 'utf8');
  const idsIn = (source) => [...source.matchAll(/id="(ts-[a-z-]+)"/g)]
    .map((match) => match[1]);
  const shellStart = chrome.indexOf('shell.innerHTML');
  const shellEnd = chrome.indexOf('document.body.appendChild(shell)');
  const jsIds = new Set(idsIn(chrome.slice(shellStart, shellEnd)));
  const htmlIds = new Set(idsIn(html));
  const missing = [...jsIds].filter((id) => !htmlIds.has(id));
  assert.deepEqual(missing, [], `in the JS shell but not in index.html: ${missing.join(', ')}`);
});
