/**
 * TerraSignal Investor — product flags.
 *
 * Mock-first Phase 1. Live property providers are never selected here.
 * Investor mode is the default for this fork; set TERRASIGNAL_PRODUCT=classic
 * to restore the upstream God's Eye View chrome and live-feed path.
 */

const TRUE = new Set(['1', 'true', 'yes', 'on']);
const FALSE = new Set(['0', 'false', 'no', 'off']);

function readEnv(name, fallback = '') {
  try {
    const meta = import.meta?.env;
    if (meta && Object.hasOwn(meta, name) && meta[name] != null && meta[name] !== '') {
      return String(meta[name]);
    }
  } catch {
    // Node unit tests and locked-down runtimes have no Vite env.
  }
  try {
    if (typeof process !== 'undefined' && process.env && process.env[name] != null) {
      return String(process.env[name]);
    }
  } catch {
    // browser
  }
  return fallback;
}

function readBool(name, defaultValue) {
  const raw = readEnv(name, '').trim().toLowerCase();
  if (!raw) return defaultValue;
  if (TRUE.has(raw)) return true;
  if (FALSE.has(raw)) return false;
  return defaultValue;
}

function readQueryProduct() {
  try {
    const params = new URLSearchParams(globalThis.location?.search || '');
    const value = String(params.get('product') || '').trim().toLowerCase();
    if (value === 'classic' || value === 'gev' || value === 'gods-eye-view') return 'classic';
    if (value === 'investor' || value === 'terrasignal') return 'investor';
  } catch {
    // no window
  }
  return null;
}

/**
 * @returns {'investor'|'classic'}
 */
export function resolveProductMode() {
  const query = readQueryProduct();
  if (query) return query;
  const raw = readEnv('TERRASIGNAL_PRODUCT', 'investor').trim().toLowerCase();
  if (raw === 'classic' || raw === 'gev' || raw === 'gods-eye-view') return 'classic';
  return 'investor';
}

export function isInvestorProduct() {
  return resolveProductMode() === 'investor';
}

export function readInvestorConfig() {
  const product = resolveProductMode();
  const investor = product === 'investor';
  return Object.freeze({
    product,
    investor,
    demoMode: readBool('TERRASIGNAL_DEMO_MODE', true),
    defaultMarket: (readEnv('TERRASIGNAL_DEFAULT_MARKET', 'atlanta') || 'atlanta').trim().toLowerCase(),
    propertyProvider: (readEnv('PROPERTY_PROVIDER', 'mock') || 'mock').trim().toLowerCase(),
    opportunityVisionDefault: readBool('TERRASIGNAL_OPPORTUNITY_VISION', true),
    disableLiveFeeds: readBool('TERRASIGNAL_DISABLE_LIVE_FEEDS', investor),
    tagline: 'See what others miss.',
    productName: 'TerraSignal Investor',
    brandKicker: 'TERRASIGNAL',
  });
}

export const INVESTOR_LAYER_DENYLIST = Object.freeze([
  'flights',
  'military',
  'earthquakes',
  'satellites',
  'rocket-launches',
  'traffic',
  'cctv',
  'radio',
  'bikeshare',
  'ais-live-vessels',
  'local-datacenters',
  'local-dams',
  'telegeography-submarine-cables',
  'local-firms',
  'military-installations',
  'military-awareness',
]);

export const SAVED_STORAGE_KEY = 'terrasignal:saved-properties:v1';
export const VISION_STORAGE_KEY = 'terrasignal:opportunity-vision:v1';
export const DEAL_VISION_STORAGE_KEY = 'terrasignal:deal-vision:v1';
