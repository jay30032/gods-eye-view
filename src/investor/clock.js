/**
 * The clock the demo runs on.
 *
 * Every "filed 29 days ago" and "auction in 26 days" in the product is
 * relative, so a mock dataset with fixed dates goes stale the moment the real
 * calendar moves past it. Investor demo mode therefore runs on a pinned date
 * unless someone asks for another one.
 *
 * Precedence: `?clock=YYYY-MM-DD` → `TERRASIGNAL_DEMO_CLOCK` → the demo default
 * when demo mode is on → the real clock.
 */
import { readInvestorConfig } from './config.js';

export const DEMO_CLOCK_DEFAULT = '2026-09-10';

export function parseClockDate(value) {
  const text = String(value || '').trim().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return null;
  const ms = Date.parse(`${text}T00:00:00Z`);
  return Number.isFinite(ms) ? new Date(ms) : null;
}

function search(options) {
  if (typeof options.search === 'string') return options.search;
  try {
    return globalThis.location?.search || '';
  } catch {
    return '';
  }
}

function queryParam(options, name) {
  try {
    return new URLSearchParams(search(options)).get(name);
  } catch {
    return null;
  }
}

/** `?demo=1` wins over the env flag, matching how the rest of the demo reads it. */
function demoModeOn(options) {
  if (typeof options.demoMode === 'boolean') return options.demoMode;
  const query = String(queryParam(options, 'demo') || '').trim().toLowerCase();
  if (query) return query !== '0' && query !== 'false' && query !== 'off';
  try {
    return readInvestorConfig().demoMode === true;
  } catch {
    return false;
  }
}

function envClock(options) {
  if (options.envClock != null) return options.envClock;
  try {
    return readInvestorConfig().demoClock;
  } catch {
    return '';
  }
}

/**
 * @param {{search?:string, envClock?:string, demoMode?:boolean, realNow?:number}} [options]
 *   Injection points for tests; production calls this with no arguments.
 * @returns {Date}
 */
export function demoNow(options = {}) {
  const fromQuery = parseClockDate(queryParam(options, 'clock'));
  if (fromQuery) return fromQuery;

  const fromEnv = parseClockDate(envClock(options));
  if (fromEnv) return fromEnv;

  if (demoModeOn(options)) return parseClockDate(DEMO_CLOCK_DEFAULT);

  return new Date(options.realNow ?? Date.now());
}
