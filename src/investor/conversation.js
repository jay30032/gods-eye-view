import {
  analyzePropertyDeal,
  bestStrategyFor,
  normalizeStrategy,
  DEAL_ASSUMPTIONS,
} from './deal/index.js';
import { FIND_MONEY_LIMIT, findMoney, searchMockProperties } from './mock/search.js';
import { compositeScore, primarySignal, signalLabel } from './mock/schema.js';
import { strategyHeadline } from './scoring.js';
import { formatUsd, whyThisMatters } from './focus.js';
import { parseCommand } from './nlp/parse.js';

export { FIND_MONEY_LIMIT };

export const ACCEPTANCE_PHRASES = Object.freeze([
  'Find me money',
  'Why?',
  'Show me the deal',
  'Assume rehab is twenty thousand higher',
  'Save it',
]);

/** What a what-if is allowed to do before the model stops being believable. */
export const WHAT_IF_BOUNDS = Object.freeze({
  rate: { min: 0, max: 0.20, label: 'Rate', kind: 'percent' },
  ltv: { min: 0, max: 0.95, label: 'LTV', kind: 'percent' },
  downPayment: { min: 0, max: 0.95, label: 'Down payment', kind: 'percent' },
  hold: { min: 1, max: 36, label: 'Hold', kind: 'months' },
});

/** What-if fields that replace a figure on the deal block itself. */
const DEAL_FIELDS = Object.freeze(['purchase', 'arv', 'rent', 'rehab']);

/** What-if fields that change an assumption, and the assumption they set. */
const ASSUMPTION_FIELDS = Object.freeze({
  rate: 'mortgageAnnualRate',
  ltv: 'brrrrLtv',
  hold: 'flipHoldMonths',
  downPayment: 'downPaymentRate',
});

const FIELD_LABELS = Object.freeze({
  purchase: 'Purchase',
  arv: 'ARV',
  rent: 'Rent',
  rehab: 'Rehab',
  rate: 'Rate',
  ltv: 'LTV',
  hold: 'Hold',
  downPayment: 'Down payment',
});

const SIGNAL_NOUNS = Object.freeze({
  FORECLOSURE: 'foreclosures',
  PREFORECLOSURE: 'delinquencies',
  TAX_SALE: 'tax sales',
  DISTRESS: 'distressed houses',
  LISTED_OPPORTUNITY: 'listings',
});

const STRATEGY_NOUNS = Object.freeze({
  flip: 'flip candidates',
  rental: 'rentals',
  brrrr: 'BRRRR candidates',
  wholesale: 'wholesale candidates',
});

const STRATEGY_NAMES = Object.freeze({
  flip: 'Flip',
  rental: 'Rental',
  brrrr: 'BRRRR',
  wholesale: 'Wholesale',
});

export function normalizeDemoUtterance(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/[.!?]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * The session's entry point for anything typed or spoken. A thin wrapper over
 * the NLP parser so the five acceptance phrases and every new command come back
 * in one shape.
 */
export function parseDemoIntent(text) {
  return parseCommand(text);
}

export function createConversationState() {
  return {
    focusedId: null,
    lastStrategy: null,
    rehabDelta: 0,
    lastSpoken: '',
    rankedIds: [],
    candidateIds: [],
    cursor: -1,
    topPickId: null,
    visionOn: false,
    savedId: null,
    dealVisible: false,
    dealOverrides: {},
    assumptionOverrides: {},
  };
}

/** True when the focused deal is no longer running on listed numbers. */
export function hasCustomNumbers(state) {
  return Boolean(
    Object.keys(state?.dealOverrides || {}).length
    || Object.keys(state?.assumptionOverrides || {}).length
    || Number(state?.rehabDelta || 0),
  );
}

/** Everything a re-run needs to reproduce the user's current what-ifs. */
export function overridesFor(state) {
  return {
    dealOverrides: { ...(state?.dealOverrides || {}) },
    rehabDelta: Number(state?.rehabDelta || 0),
    assumptionOverrides: { ...(state?.assumptionOverrides || {}) },
  };
}

function shortAddress(property) {
  return String(property?.address || 'this property').split(',')[0];
}

function analyze(property, strategy, state) {
  return analyzePropertyDeal(property, strategy, overridesFor(state));
}

function activeList(state) {
  return state.candidateIds?.length ? state.candidateIds : state.rankedIds;
}

function rememberRanking(properties, state) {
  if (state.rankedIds?.length) return;
  state.rankedIds = searchMockProperties(properties, { limit: properties.length })
    .map((row) => row.property.id);
}

/**
 * Place slots are alternatives, not a conjunction — the user named one place,
 * and "East Point" happens to be both a city and a neighborhood.
 */
function matchesPlace(property, slots) {
  const checks = [];
  if (slots.county) checks.push(property.county === slots.county);
  if (slots.city) checks.push(property.city === slots.city);
  if (slots.neighborhood) checks.push(property.neighborhood === slots.neighborhood);
  return checks.length === 0 || checks.some(Boolean);
}

function matchesSlots(property, slots) {
  if (!matchesPlace(property, slots)) return false;
  if (slots.signalType && !(property.signals || []).some((s) => s.type === slots.signalType)) return false;
  if (slots.maxPurchase != null && Number(property.deal?.purchase || 0) > slots.maxPurchase) return false;
  if (slots.minScore != null && compositeScore(property) < slots.minScore) return false;
  return true;
}

function placeWords(slots) {
  const where = slots.neighborhood || slots.city
    || (slots.county ? `${slots.county === 'dekalb' ? 'DeKalb' : 'Fulton'} County` : null);
  return where ? ` in ${where}` : '';
}

function hitNoun(slots, count) {
  if (slots.signalType) {
    const noun = SIGNAL_NOUNS[slots.signalType] || 'signals';
    return count === 1 ? noun.replace(/(ie)?s$/, (m) => (m === 'ies' ? 'y' : '')) : noun;
  }
  if (slots.strategy) return STRATEGY_NOUNS[slots.strategy] || 'candidates';
  return count === 1 ? 'strong mock candidate' : 'strong mock candidates';
}

/**
 * Hunt the board. With no slots this is the demo's "Find me money"; with slots
 * it is a filtered search that still ends on one gold pick.
 */
export function applyFindMoney(properties, state, slots = {}) {
  const limit = Math.max(1, Number(slots.limit) || FIND_MONEY_LIMIT);
  const filtered = properties.filter((property) => matchesSlots(property, slots));
  const strategy = normalizeStrategy(slots.strategy) || null;

  let hits;
  if (strategy) {
    hits = searchMockProperties(filtered, { strategy, limit });
  } else if (filtered.length === properties.length) {
    // No filters — this is the demo's shortlist, qualified by score or clock.
    hits = findMoney(filtered, limit);
  } else {
    hits = searchMockProperties(filtered, { strategy: 'composite', limit });
  }

  if (!hits.length) {
    return {
      ok: false,
      action: 'rank_mock_properties',
      candidateCount: 0,
      candidateIds: state.candidateIds.slice(),
      spoken: 'Nothing matches that in Atlanta / Decatur. '
        + 'Try dropping the price cap or the neighborhood.',
      results: [],
    };
  }

  const top = hits[0];
  rememberRanking(properties, state);
  state.candidateIds = hits.map((hit) => hit.property.id);
  state.cursor = 0;
  state.topPickId = top.property.id;
  state.visionOn = true;
  state.dealVisible = false;
  state.savedId = null;
  state.focusedId = top.property.id;
  state.lastStrategy = strategy || top.bestStrategy;
  state.dealOverrides = {};
  state.assumptionOverrides = {};
  state.rehabDelta = 0;

  return {
    ok: true,
    action: 'rank_mock_properties',
    visionOn: true,
    candidateCount: hits.length,
    candidateIds: state.candidateIds.slice(),
    topPickId: state.topPickId,
    filters: { ...slots },
    spoken: `Opportunity Vision on. ${hits.length} ${hitNoun(slots, hits.length)}${placeWords(slots)}. `
      + `Gold pick is ${shortAddress(top.property)}, composite ${compositeScore(top.property)}.`,
    focusId: top.property.id,
    results: hits.map((hit) => ({
      id: hit.property.id,
      address: hit.property.address,
      score: hit.score,
      signal: hit.primary?.type || null,
      strategy: hit.bestStrategy,
    })),
  };
}

/**
 * Move the focus: by name, by position in the shortlist, or by stepping
 * through it. A new house starts on listed numbers — the what-ifs belonged to
 * the last one — but keeps financing assumptions, which are the user's terms.
 */
export function applyFocus(properties, state, slots = {}) {
  rememberRanking(properties, state);
  const list = activeList(state);
  const byId = (id) => properties.find((row) => row.id === id) || null;
  let property = null;

  if (slots.step === 'top' && state.topPickId) {
    property = byId(state.topPickId);
    state.cursor = Math.max(0, list.indexOf(state.topPickId));
  } else if (slots.step === 'next' || slots.step === 'previous') {
    if (!list.length) {
      return { ok: false, action: 'focus_property', spoken: 'Nothing is ranked yet. Ask me to find the money first.' };
    }
    const delta = slots.step === 'next' ? 1 : -1;
    const from = state.cursor >= 0 ? state.cursor : (slots.step === 'next' ? -1 : 0);
    // Wrapping keeps a short shortlist browsable without dead ends.
    state.cursor = ((from + delta) % list.length + list.length) % list.length;
    property = byId(list[state.cursor]);
  } else if (Number.isFinite(slots.ordinal)) {
    const index = Number(slots.ordinal) - 1;
    if (index < 0 || index >= list.length) {
      return {
        ok: false,
        action: 'focus_property',
        spoken: `There are only ${list.length} on the board right now.`,
      };
    }
    state.cursor = index;
    property = byId(list[index]);
  } else if (slots.query) {
    const hit = searchMockProperties(properties, { query: slots.query, limit: 1 })[0];
    property = hit?.property || null;
    if (property) state.cursor = Math.max(0, list.indexOf(property.id));
  }

  if (!property) {
    return {
      ok: false,
      action: 'focus_property',
      spoken: slots.query
        ? `I don't have ${slots.query} in the mock inventory.`
        : 'Nothing to focus yet.',
    };
  }

  const changed = property.id !== state.focusedId;
  state.focusedId = property.id;
  if (changed) {
    // The last house's what-ifs do not describe this one.
    state.dealOverrides = {};
    state.rehabDelta = 0;
    state.dealVisible = false;
  }
  state.lastStrategy = bestStrategyFor(property);

  const signal = primarySignal(property);
  return {
    ok: true,
    action: 'focus_property',
    id: property.id,
    address: property.address,
    cursor: state.cursor,
    spoken: `${shortAddress(property)}. ${signalLabel(signal?.type)}, `
      + `composite ${compositeScore(property)}, best path ${String(state.lastStrategy).toUpperCase()}.`,
  };
}

export function applyWhy(property, state) {
  if (!property) {
    return { ok: false, action: 'explain_property', spoken: 'Nothing is focused yet. Ask me to find the money first.' };
  }
  state.focusedId = property.id;
  const strategy = bestStrategyFor(property);
  let analysis = null;
  try {
    analysis = analyze(property, strategy, state);
  } catch {
    // Why still reads without a headline rather than failing the turn.
  }
  const why = whyThisMatters(property, analysis);
  return {
    ok: true,
    action: 'explain_property',
    id: property.id,
    strategy,
    spoken: why,
    why,
    drivers: Array.isArray(property.drivers) ? property.drivers.slice() : [],
    signal: property.signals,
    scores: property.opportunityScore,
  };
}

function pct(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '0%';
  if (n >= 10) return 'infinite';
  // Round before testing for a whole number: 1.1 * 100 is 110.00000000000001,
  // which is not an integer and would print as "110.0%".
  const shown = Math.round(n * 1000) / 10;
  return Number.isInteger(shown) ? `${shown}%` : `${shown.toFixed(1)}%`;
}

/**
 * One sentence on why a strategy landed where it did, naming the numbers that
 * decided it and the threshold they cleared or missed.
 */
export function explainStrategyVerdict(analysis, assumptions = DEAL_ASSUMPTIONS) {
  if (!analysis) return '';
  const a = analysis.assumptions || assumptions;
  const name = STRATEGY_NAMES[analysis.strategy] || analysis.strategy;
  const verdict = analysis.verdict;
  const lead = `${name} is ${verdict === 'pass' ? 'a pass' : verdict}`;

  if (analysis.strategy === 'flip') {
    const core = `${formatUsd(analysis.profit)} profit on ${formatUsd(analysis.cashIn)} cash in, `
      + `${pct(analysis.margin)} margin`;
    if (verdict === 'strong') {
      return `${lead}: ${core} — clears the ${formatUsd(a.flipStrongProfit)} and `
        + `${pct(a.flipStrongMargin)} bars.`;
    }
    if (verdict === 'thin') {
      const miss = analysis.profit < a.flipStrongProfit
        ? `profit is under ${formatUsd(a.flipStrongProfit)}`
        : `the margin is under ${pct(a.flipStrongMargin)}`;
      return `${lead}: ${core} — over the ${formatUsd(a.flipThinProfit)} floor, but ${miss}.`;
    }
    return `${lead}: ${core} — under the ${formatUsd(a.flipThinProfit)} floor.`;
  }

  if (analysis.strategy === 'rental') {
    const core = `${formatUsd(analysis.cashFlowMonthly)} a month, ${pct(analysis.coc)} cash-on-cash, `
      + `DSCR ${Number(analysis.dscr).toFixed(2)}`;
    if (verdict === 'strong') {
      return `${lead}: ${core} — clears ${pct(a.rentalStrongCoc)} and ${a.rentalStrongDscr} DSCR.`;
    }
    if (verdict === 'thin') {
      const miss = analysis.coc < a.rentalStrongCoc
        ? `the cash-on-cash is under ${pct(a.rentalStrongCoc)}`
        : `DSCR is under ${a.rentalStrongDscr}`;
      return `${lead}: ${core} — ${miss}.`;
    }
    return `${lead}: ${core} — it does not cash flow.`;
  }

  if (analysis.strategy === 'brrrr') {
    const capital = analysis.cashLeftIn > 0
      ? `${formatUsd(analysis.cashLeftIn)} left in`
      : `${formatUsd(analysis.cashOut)} back out`;
    const core = `${capital}, ${formatUsd(analysis.cashFlowMonthly)} a month`;
    if (verdict === 'strong') {
      return `${lead}: ${core} — inside the ${formatUsd(a.brrrrStrongCashLeftIn)} cap and `
        + `over ${formatUsd(a.brrrrStrongCashFlow)} a month.`;
    }
    if (verdict === 'thin') {
      const miss = analysis.cashLeftIn > a.brrrrStrongCashLeftIn
        ? `it leaves more than ${formatUsd(a.brrrrStrongCashLeftIn)} in`
        : `cash flow is under ${formatUsd(a.brrrrStrongCashFlow)} a month`;
      return `${lead}: ${core} — it cash flows, but ${miss}.`;
    }
    return `${lead}: ${core} — it does not cash flow.`;
  }

  if (analysis.strategy === 'wholesale') {
    if (analysis.spread <= 0) {
      return `${lead}: MAO ${formatUsd(analysis.mao)} is under the ${formatUsd(analysis.purchase)} `
        + 'contract, so there is no spread to assign.';
    }
    const core = `MAO ${formatUsd(analysis.mao)} against a ${formatUsd(analysis.purchase)} contract `
      + `leaves a ${formatUsd(analysis.spread)} spread`;
    if (verdict === 'strong') {
      return `${lead}: ${core}, and the ${formatUsd(analysis.assignmentFee)} fee clears the `
        + `${formatUsd(a.wholesaleStrongFee)} bar.`;
    }
    if (verdict === 'thin') {
      return `${lead}: ${core}, and the ${formatUsd(analysis.assignmentFee)} fee is over the `
        + `${formatUsd(a.wholesaleThinFee)} floor but under ${formatUsd(a.wholesaleStrongFee)}.`;
    }
    return `${lead}: ${core}, and the ${formatUsd(analysis.assignmentFee)} fee is under the `
      + `${formatUsd(a.wholesaleThinFee)} floor.`;
  }
  return lead;
}

/** "Why not wholesale" — justify one strategy's verdict on the focused house. */
export function applyWhyStrategy(property, state, strategy) {
  if (!property) {
    return { ok: false, action: 'explain_strategy', spoken: 'Focus a property first.' };
  }
  const name = normalizeStrategy(strategy);
  if (!name) return applyWhy(property, state);
  const analysis = analyze(property, name, state);
  return {
    ok: true,
    action: 'explain_strategy',
    id: property.id,
    strategy: name,
    analysis,
    verdict: analysis.verdict,
    spoken: explainStrategyVerdict(analysis),
  };
}

/** All four paths side by side, so the winner is a comparison, not a claim. */
export function applyCompare(property, state) {
  if (!property) {
    return { ok: false, action: 'compare_strategies', spoken: 'Focus a property first.' };
  }
  const analyses = {};
  const rows = [];
  let best = null;
  for (const key of ['flip', 'rental', 'brrrr', 'wholesale']) {
    const analysis = analyze(property, key, state);
    analyses[key] = analysis;
    const headline = analysis.verdict === 'pass' ? '' : ` ${strategyHeadline(analysis, { short: true })}`;
    rows.push({
      strategy: key,
      verdict: analysis.verdict,
      headline: strategyHeadline(analysis, { short: true }),
      text: `${STRATEGY_NAMES[key]} ${analysis.verdict}${headline}`,
    });
    const score = Number(property.opportunityScore?.[key]) || 0;
    if (!best || score > best.score) best = { key, score };
  }
  state.dealVisible = true;
  return {
    ok: true,
    action: 'compare_strategies',
    id: property.id,
    analyses,
    rows,
    best: best.key,
    spoken: `${rows.map((row) => row.text).join(' · ')}. ${STRATEGY_NAMES[best.key]} wins.`,
  };
}

export function applyShowDeal(property, state, slots = {}) {
  if (!property) {
    return { ok: false, action: 'show_deal_vision', spoken: 'Focus a property first.' };
  }
  const strategy = normalizeStrategy(slots.strategy)
    || state.lastStrategy
    || bestStrategyFor(property);
  state.lastStrategy = strategy;
  state.dealVisible = true;
  const analysis = analyze(property, strategy, state);
  return {
    ok: true,
    action: 'show_deal_vision',
    id: property.id,
    strategy,
    analysis,
    spoken: speakAnalysis(property, strategy, analysis),
  };
}

function currentFieldValue(property, state, field) {
  if (Object.hasOwn(ASSUMPTION_FIELDS, field)) {
    const key = ASSUMPTION_FIELDS[field];
    const override = state.assumptionOverrides?.[key];
    return Number.isFinite(override) ? override : DEAL_ASSUMPTIONS[key];
  }
  const override = state.dealOverrides?.[field];
  if (Number.isFinite(override)) {
    return field === 'rehab' ? override + Number(state.rehabDelta || 0) : override;
  }
  const listed = Number(property?.deal?.[field] || 0);
  return field === 'rehab' ? listed + Number(state.rehabDelta || 0) : listed;
}

function fieldValueWords(field, value) {
  if (field === 'rent') return `${formatUsd(value)}/mo`;
  if (field === 'hold') return `${value} months`;
  if (Object.hasOwn(ASSUMPTION_FIELDS, field) && field !== 'hold') return pct(value);
  // Money reads as $62k, the way it gets said out loud.
  const n = Number(value);
  return Math.abs(n) >= 10000 ? `$${Math.round(n / 1000)}k` : formatUsd(n);
}

function boundsRefusal(field, value) {
  const bound = WHAT_IF_BOUNDS[field];
  if (!bound) return null;
  if (value >= bound.min && value <= bound.max) return null;
  const shown = bound.kind === 'percent' ? pct(value) : `${value} months`;
  const min = bound.kind === 'percent' ? pct(bound.min) : `${bound.min} month`;
  const max = bound.kind === 'percent' ? pct(bound.max) : `${bound.max} months`;
  return `${bound.label} of ${shown} is outside what I model — keep it between ${min} and ${max}.`;
}

/**
 * Change one number and re-underwrite. The spoken reply leads with the new
 * figure, then says whether the verdict moved — a number that changes nothing
 * is worth saying out loud too.
 */
export function applyWhatIf(property, state, slots = {}) {
  if (!property) {
    return { ok: false, action: 'run_analysis', spoken: 'Focus a property first, then we can change the numbers.' };
  }
  const field = String(slots.field || '');
  const op = String(slots.op || 'set');
  const raw = Number(slots.value);
  if (!field || !Number.isFinite(raw)) {
    return { ok: false, action: 'run_analysis', spoken: "I didn't catch which number to change." };
  }

  const strategy = state.lastStrategy || bestStrategyFor(property);
  const before = analyze(property, strategy, state);
  const current = currentFieldValue(property, state, field);

  let next;
  if (op === 'plus') next = current + raw;
  else if (op === 'minus') next = current - raw;
  else if (op === 'scale') next = current * (1 + raw / 100);
  else next = raw;
  if (field === 'hold') next = Math.round(next);

  const refusal = boundsRefusal(field, next);
  if (refusal) {
    return {
      ok: false, action: 'run_analysis', id: property.id, field, spoken: refusal,
    };
  }

  if (Object.hasOwn(ASSUMPTION_FIELDS, field)) {
    state.assumptionOverrides = { ...state.assumptionOverrides, [ASSUMPTION_FIELDS[field]]: next };
  } else if (field === 'rehab' && (op === 'plus' || op === 'minus')) {
    // Keep the demo's additive rehab bump exactly as it was: a delta on top of
    // whatever rehab is listed, applied before the contingency.
    state.rehabDelta = Number(state.rehabDelta || 0) + (op === 'plus' ? raw : -raw);
  } else if (DEAL_FIELDS.includes(field)) {
    const base = field === 'rehab' ? next - Number(state.rehabDelta || 0) : next;
    state.dealOverrides = { ...state.dealOverrides, [field]: base };
  } else {
    return { ok: false, action: 'run_analysis', spoken: `I don't model ${field}.` };
  }

  state.dealVisible = true;
  const after = analyze(property, strategy, state);
  const lead = field === 'rehab'
    ? `Rehab is now ${fieldValueWords(field, currentFieldValue(property, state, field))}.`
    : `${FIELD_LABELS[field] || field} at ${fieldValueWords(field, next)}.`;

  const moved = before.verdict !== after.verdict;
  const tail = moved
    ? `That moves ${strategy} from ${before.verdict} to ${after.verdict} — ${strategyHeadline(after)}.`
    : `Still a ${after.verdict} ${strategy} — ${strategyHeadline(after)}.`;

  return {
    ok: true,
    action: `run_${strategy}_analysis`,
    id: property.id,
    field,
    op,
    value: next,
    strategy,
    analysis: after,
    verdictChanged: moved,
    previousVerdict: before.verdict,
    spoken: `${lead} ${tail}`,
  };
}

/** The demo's "+20k" beat, kept as its own entry point for the voice tool. */
export function applyRehabDelta(property, state, delta = 20000) {
  return applyWhatIf(property, state, { field: 'rehab', op: delta < 0 ? 'minus' : 'plus', value: Math.abs(delta) });
}

export function applyReset(state) {
  state.dealOverrides = {};
  state.assumptionOverrides = {};
  state.rehabDelta = 0;
  return {
    ok: true,
    action: 'reset_assumptions',
    spoken: 'Numbers reset to defaults.',
  };
}

export function applySave(property, state, saver, note = '') {
  if (!property) {
    return { ok: false, action: 'save_property', spoken: 'Nothing to save.' };
  }
  const result = typeof saver === 'function'
    ? saver(property, { strategy: state.lastStrategy, note })
    : { ok: true, id: property.id, saved: [{ id: property.id, address: property.address }] };
  if (result.ok) state.savedId = property.id;
  return {
    ...result,
    action: 'save_property',
    note,
    spoken: result.ok
      ? `Saved ${shortAddress(property)}${note ? ` — "${note}"` : ''}.`
      : (result.error || 'Nothing to save.'),
  };
}

export function applyUnsave(property, state, remover) {
  if (!property) {
    return { ok: false, action: 'unsave_property', spoken: 'Nothing to remove.' };
  }
  if (typeof remover === 'function') remover(property.id);
  if (state.savedId === property.id) state.savedId = null;
  return {
    ok: true,
    action: 'unsave_property',
    id: property.id,
    spoken: `Removed ${shortAddress(property)} from saved.`,
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
  const shown = n * 100;
  // Single-digit yields need the decimal to stay honest; 4.8% is not 5%.
  return Math.abs(shown) < 10 ? `${shown.toFixed(1)}%` : `${Math.round(shown)}%`;
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

/** What the prompt says once the descent lands — the next thing to try. */
export const FIRST_HINT = 'Try: Find me money';

/** One line the AI prompt can show when someone asks what they can say. */
export const HELP_LINE = 'Try: find foreclosures under 250k in dekalb · show me the deal · '
  + 'why not wholesale · what if i pay 110 · compare · save it';
