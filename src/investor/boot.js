/**
 * Cesium-free investor paint. Loaded from index.html before main.js so the
 * hunt ritual can appear while the globe graph is still downloading.
 */
import { isInvestorProduct, readInvestorConfig } from './config.js';
import { applyInvestorChrome } from './ui/chrome.js';

export function bootInvestorChrome() {
  if (!isInvestorProduct()) return false;
  applyInvestorChrome(readInvestorConfig());
  document.getElementById('loading-screen')?.classList.add('hidden');
  return true;
}

bootInvestorChrome();
