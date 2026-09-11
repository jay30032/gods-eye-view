import { analyzePropertyDeal, bestStrategyFor, normalizeStrategy } from './deal/index.js';
import { FIND_MONEY_LIMIT, findMoney } from './mock/search.js';
import { whyThisMatters } from './focus.js';

export { FIND_MONEY_LIMIT };

export const ACCEPTANCE_PHRASES = Object.freeze([
  'Find me money',
  'Why?',
  'Show me the deal',
  'Assume rehab is twenty thousand higher',
  'Save it',
]);

const EXACT_INTENTS = Object.freeze({
  'find me money': 'find_money',
  'find money': 'find_money',
  "where's the money": 'find_money',
  'where is the money': 'find_money',
  'show me opportunities': 'find_money',
  why: 'why',
  'why this': 'why',
  'why this matters': 'why',
  "what's special": 'why',
  'what is special': 'why',
  explain: 'why',
  'show me the deal': 'show_deal',
  'show the deal': 'show_deal',
  'the deal': 'show_deal',
  underwrite: 'show_deal',
  'run the numbers': 'show_deal',
  'deal vision': 'show_deal',
  'assume rehab is twenty thousand higher': 'rehab_plus_20k',
  'assume rehab is 20 thousand higher': 'rehab_plus_20k',
  'assume rehab is 20000 higher': 'rehab_plus_20k',
  'rehab is twenty thousand higher': 'rehab_plus_20k',
  'rehab +20k': 'rehab_plus_20k',
  'save it': 'save',
  'save this': 'save',
  'save that': 'save',
  bookmark: 'save',
  'keep this': 'save',
  'start drive': 'start_drive',
  'drive demo': 'start_drive',
  "let's drive": 'start_drive',
  'stop drive': 'stop_drive',
  'end drive': 'stop_drive',
});

export function normalizeDemoUtterance(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[“”]/g, '"')
    .replace(/['’]/g, "'")
    .replace(/[.!?]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function parseDemoIntent(text) {
  const raw = String(text || '').trim();
  if (!raw) return null;
  const normalized = normalizeDemoUtterance(raw);
  const exact = EXACT_INTENTS[normalized];
  if (exact) return { intent: exact, phrase: raw, normalized };

  if (/find(?:\s+me)?\s+money|where(?:'s| is) the money|show me opportunities/.test(normalized)) {
    return { intent: 'find_money', phrase: raw, normalized };
  }
  if (/rehab.+(twenty|20)[ -]?thousand higher|assume rehab.+(higher|more)|rehab \+ ?20/.test(normalized)) {
    return { intent: 'rehab_plus_20k', phrase: raw, normalized };
  }
  if (/show me the deal|the deal|underwrite|run the numbers|deal vision/.test(normalized)) {
    return { intent: 'show_deal', phrase: raw, normalized };
  }
  if (/\bwhy\b|what(?:'s| is) special|explain|why this/.test(normalized)) {
    return { intent: 'why', phrase: raw, normalized };
  }
  if (/\bsave (it|this|that)\b|bookmark|keep this/.test(normalized)) {
    return { intent: 'save', phrase: raw, normalized };
  }
  if (/start drive|drive demo|let'?s drive/.test(normalized)) {
    return { intent: 'start_drive', phrase: raw, normalized };
  }
  if (/stop drive|end drive/.test(normalized)) {
    return { intent: 'stop_drive', phrase: raw, normalized };
  }
  return { intent: 'unknown', text: raw, normalized };
}

export function createConversationState() {
  return {
    focusedId: null,
    lastStrategy: null,
    rehabDelta: 0,
    lastSpoken: '',
    candidateIds: [],
    topPickId: null,
    visionOn: false,
    savedId: null,
    dealVisible: false,
  };
}

export function applyFindMoney(properties, state, { limit = FIND_MONEY_LIMIT } = {}) {
  const hits = findMoney(properties, limit);
  const top = hits[0] || null;
  state.candidateIds = hits.map((hit) => hit.property.id);
  state.topPickId = top?.property.id || null;
  state.visionOn = true;
  state.rehabDelta = 0;
  state.dealVisible = false;
  state.savedId = null;
  if (top) {
    state.focusedId = top.property.id;
    state.lastStrategy = top.bestStrategy;
  }
  return {
    ok: Boolean(top),
    action: 'rank_mock_properties',
    visionOn: true,
    candidateCount: hits.length,
    candidateIds: state.candidateIds.slice(),
    topPickId: state.topPickId,
    spoken: top
      ? `Opportunity Vision on. ${hits.length} strong mock candidates. Gold pick is ${top.property.address.split(',')[0]}. Composite ${top.score}.`
      : 'No mock opportunities in this market.',
    focusId: top?.property.id || null,
    results: hits.map((hit) => ({
      id: hit.property.id,
      address: hit.property.address,
      score: hit.score,
      signal: hit.primary?.type || null,
      strategy: hit.bestStrategy,
    })),
  };
}

export function applyWhy(property, state) {
  if (!property) {
    return { ok: false, action: 'explain_property', spoken: 'Nothing is focused yet. Ask me to find the money first.' };
  }
  state.focusedId = property.id;
  return {
    ok: true,
    action: 'explain_property',
    id: property.id,
    spoken: whyThisMatters(property),
    why: property.why,
    signal: property.signals,
    scores: property.opportunityScore,
  };
}

export function applyShowDeal(property, state) {
  if (!property) {
    return { ok: false, action: 'show_deal_vision', spoken: 'Focus a property first.' };
  }
  const strategy = state.lastStrategy || bestStrategyFor(property);
  state.lastStrategy = strategy;
  state.dealVisible = true;
  const analysis = analyzePropertyDeal(property, strategy, { rehabDelta: state.rehabDelta });
  return {
    ok: true,
    action: 'show_deal_vision',
    id: property.id,
    strategy,
    analysis,
    spoken: speakAnalysis(property, strategy, analysis),
  };
}

export function applyRehabDelta(property, state, delta = 20000) {
  if (!property) {
    return { ok: false, action: 'run_flip_analysis', spoken: 'Focus a property first, then we can change rehab.' };
  }
  state.rehabDelta = Number(state.rehabDelta || 0) + Number(delta || 0);
  state.dealVisible = true;
  const strategy = state.lastStrategy || bestStrategyFor(property);
  const analysis = analyzePropertyDeal(property, strategy, { rehabDelta: state.rehabDelta });
  return {
    ok: true,
    action: `run_${strategy}_analysis`,
    id: property.id,
    strategy,
    rehabDelta: state.rehabDelta,
    analysis,
    spoken: `Rehab is now ${formatMoney((property.deal?.rehab || 0) + state.rehabDelta)}. ${speakAnalysis(property, strategy, analysis)}`,
  };
}

export function applySave(property, state, saver) {
  if (!property) {
    return { ok: false, action: 'save_property', spoken: 'Nothing to save.' };
  }
  const result = typeof saver === 'function'
    ? saver(property, { strategy: state.lastStrategy, note: '' })
    : { ok: true, id: property.id, saved: [{ id: property.id, address: property.address }] };
  if (result.ok) state.savedId = property.id;
  return {
    ...result,
    action: 'save_property',
    spoken: result.ok ? `Saved ${property.address.split(',')[0]}.` : (result.error || 'Nothing to save.'),
  };
}

function formatMoney(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 'zero';
  const rounded = Math.round(n);
  return `${rounded < 0 ? '-' : ''}$${Math.abs(rounded).toLocaleString('en-US')}`;
}

/** Compact spoken money: $61k above ten grand, exact dollars below it. */
function speakMoney(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '$0';
  if (Math.abs(n) >= 10000) {
    const k = Math.round(n / 1000);
    return `${k < 0 ? '-' : ''}$${Math.abs(k)}k`;
  }
  return formatMoney(n);
}

function speakPct(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '0%';
  const pct = n * 100;
  // Single-digit yields need the decimal to stay honest; 4.8% is not 5%.
  return Math.abs(pct) < 10 ? `${pct.toFixed(1)}%` : `${Math.round(pct)}%`;
}

function speakDscr(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n.toFixed(2) : '0.00';
}

function verdictWord(verdict) {
  const key = String(verdict || '').trim().toLowerCase();
  if (key === 'strong') return 'Strong';
  if (key === 'thin') return 'Thin';
  return 'Pass';
}

function shortAddress(property) {
  return String(property?.address || 'this property').split(',')[0];
}

/**
 * One sentence per strategy, leading with the verdict and the numbers an
 * investor decides on — not a recital of every field on the analysis.
 */
export function speakAnalysis(property, strategy, analysis) {
  const name = normalizeStrategy(strategy) || strategy;
  const where = shortAddress(property);
  const verdict = verdictWord(analysis?.verdict);

  if (name === 'flip') {
    return `${verdict} flip on ${where}: ${speakMoney(analysis.profit)} profit on `
      + `${speakMoney(analysis.cashIn)} cash in, ${speakPct(analysis.roi)} cash-on-cash `
      + `over ${analysis.holdMonths} months.`;
  }
  if (name === 'rental') {
    return `${verdict} rental on ${where}: ${formatMoney(analysis.cashFlowMonthly)} a month, `
      + `${speakPct(analysis.coc)} cash-on-cash, ${speakDscr(analysis.dscr)} DSCR.`;
  }
  if (name === 'brrrr') {
    const capital = analysis.cashLeftIn > 0
      ? `${speakMoney(analysis.cashLeftIn)} left in`
      : `${speakMoney(analysis.cashOut)} back out`;
    const returnText = analysis.infiniteReturn ? 'infinite cash-on-cash' : `${speakPct(analysis.coc)} cash-on-cash`;
    return `${verdict} BRRRR on ${where}: ${capital}, ${formatMoney(analysis.cashFlowMonthly)} a month, `
      + `${returnText}.`;
  }
  if (name === 'wholesale') {
    if (!analysis.viable) {
      return `${verdict} wholesale on ${where}: no spread — the 70% offer is `
        + `${speakMoney(analysis.mao)} against a ${speakMoney(analysis.purchase)} contract.`;
    }
    return `${verdict} wholesale on ${where}: ${speakMoney(analysis.assignmentFee)} assignment fee `
      + `on a ${speakMoney(analysis.spread)} spread.`;
  }
  return whyThisMatters(property, analysis);
}
