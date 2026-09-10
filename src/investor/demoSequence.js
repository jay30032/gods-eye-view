import { readInvestorConfig } from './config.js';
import { ACCEPTANCE_PHRASES } from './conversation.js';

export const DEMO_STEPS = Object.freeze([
  Object.freeze({
    id: 'hunt',
    kind: 'hunt',
    title: '1 · Hunt',
    copy: 'Where are we hunting today? Choose Atlanta / Decatur to descend.',
    cta: 'Atlanta / Decatur',
    phrase: null,
  }),
  Object.freeze({
    id: 'money',
    kind: 'intent',
    title: '2 · Find the money',
    copy: 'Turns Opportunity Vision on, activates four strong candidates, golds the best, and flies there.',
    phrase: ACCEPTANCE_PHRASES[0],
  }),
  Object.freeze({
    id: 'why',
    kind: 'intent',
    title: '3 · Why this matters',
    copy: 'Explains the focused house from the signal first — not a 70-field dump.',
    phrase: ACCEPTANCE_PHRASES[1],
  }),
  Object.freeze({
    id: 'deal',
    kind: 'intent',
    title: '4 · Show the deal',
    copy: 'Deal Vision stays on the globe (FLIP / RENT / BRRRR / WHOLESALE).',
    phrase: ACCEPTANCE_PHRASES[2],
  }),
  Object.freeze({
    id: 'rehab',
    kind: 'intent',
    title: '5 · Stress rehab',
    copy: 'Deterministic +$20k rehab. Deal Vision numbers update in place.',
    phrase: ACCEPTANCE_PHRASES[3],
  }),
  Object.freeze({
    id: 'save',
    kind: 'intent',
    title: '6 · Save it',
    copy: 'Writes localStorage and opens SAVED with a saved-ring on the house.',
    phrase: ACCEPTANCE_PHRASES[4],
  }),
]);

export function readDemoMode(location = globalThis.location) {
  let query = '';
  try {
    query = new URLSearchParams(location?.search || '').get('demo');
  } catch {
    query = '';
  }
  const raw = String(query || '').trim().toLowerCase();
  if (raw === 'auto' || raw === 'play') return { enabled: true, auto: true, source: 'query' };
  if (raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on') {
    return { enabled: true, auto: false, source: 'query' };
  }
  if (raw === '0' || raw === 'false' || raw === 'off') {
    return { enabled: false, auto: false, source: 'query' };
  }
  try {
    if (readInvestorConfig().demoMode && raw === '') {
      return { enabled: false, auto: false, source: 'env' };
    }
  } catch {
    // Node tests without Vite env
  }
  return { enabled: false, auto: false, source: 'none' };
}

export function demoForcesHunt(location = globalThis.location) {
  const demo = readDemoMode(location);
  if (!demo.enabled) return false;
  try {
    if (new URLSearchParams(location?.search || '').get('welcome') === '0') return false;
  } catch {
    // ignore
  }
  return true;
}
