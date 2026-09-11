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
