import { analyzePropertyDeal, bestStrategyFor, normalizeStrategy } from './deal/index.js';
import { findMoney } from './mock/search.js';
import { whyThisMatters } from './focus.js';

const MONEY = /find(?:\s+me)?\s+money|where(?:'s| is) the money|hunt|show me opportunities|top pick/i;
const WHY = /\bwhy\b|what(?:'s| is) special|explain|why this/i;
const DEAL = /show me the deal|the deal|underwrite|run the numbers|deal vision/i;
const REHAB_UP = /rehab.+(twenty|20)[ -]?thousand higher|assume rehab.+(higher|more)|rehab \+ ?20/i;
const SAVE = /\bsave (it|this|that)\b|bookmark|keep this/i;
const DRIVE = /start drive|drive demo|let'?s drive/i;
const STOP_DRIVE = /stop drive|end drive/i;

export function parseDemoIntent(text) {
  const raw = String(text || '').trim();
  if (!raw) return null;
  if (MONEY.test(raw)) return { intent: 'find_money' };
  if (REHAB_UP.test(raw)) return { intent: 'rehab_plus_20k' };
  if (DEAL.test(raw)) return { intent: 'show_deal' };
  if (WHY.test(raw)) return { intent: 'why' };
  if (SAVE.test(raw)) return { intent: 'save' };
  if (DRIVE.test(raw)) return { intent: 'start_drive' };
  if (STOP_DRIVE.test(raw)) return { intent: 'stop_drive' };
  return { intent: 'unknown', text: raw };
}

export function createConversationState() {
  return {
    focusedId: null,
    lastStrategy: null,
    rehabDelta: 0,
    lastSpoken: '',
  };
}

export function applyFindMoney(properties, state) {
  const hits = findMoney(properties, 5);
  const top = hits[0] || null;
  if (top) {
    state.focusedId = top.property.id;
    state.lastStrategy = top.bestStrategy;
    state.rehabDelta = 0;
  }
  return {
    ok: Boolean(top),
    action: 'rank_mock_properties',
    spoken: top
      ? `Top mock pick is ${top.property.address}. Composite ${top.score}. ${top.property.why}`
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

function formatMoney(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 'zero';
  return `$${Math.round(n).toLocaleString('en-US')}`;
}

export function speakAnalysis(property, strategy, analysis) {
  const name = normalizeStrategy(strategy) || strategy;
  if (name === 'flip') {
    return `${property.address.split(',')[0]} flip: profit ${formatMoney(analysis.profit)}, ROI ${(analysis.roi * 100).toFixed(1)} percent.`;
  }
  if (name === 'rental') {
    return `${property.address.split(',')[0]} rental: ${formatMoney(analysis.cashFlowMonthly)} a month, cap ${(analysis.capRate * 100).toFixed(1)} percent.`;
  }
  if (name === 'brrrr') {
    return `${property.address.split(',')[0]} BRRRR: cash left in ${formatMoney(analysis.cashLeftIn)}, monthly ${formatMoney(analysis.cashFlowMonthly)}.`;
  }
  if (name === 'wholesale') {
    return `${property.address.split(',')[0]} wholesale: assignment ${formatMoney(analysis.assignmentFee)}, spread ${formatMoney(analysis.spread)}.`;
  }
  return whyThisMatters(property, analysis);
}
