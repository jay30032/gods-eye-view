import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

test('investor boot stays Cesium-free and is the first module in index.html', () => {
  const boot = readFileSync(join(here, 'boot.js'), 'utf8');
  const html = readFileSync(join(here, '../../index.html'), 'utf8');
  assert.doesNotMatch(boot, /cesium/i);
  const bootIdx = html.indexOf('src="/src/investor/boot.js"');
  const mainIdx = html.indexOf('src="/src/main.js"');
  assert.equal(bootIdx > 0 && bootIdx < mainIdx, true);
});
