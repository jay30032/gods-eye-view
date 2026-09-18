import { bestStrategyFor, normalizeStrategy } from './deal/index.js';
import { whyThisMatters } from './focus.js';
import { isPropertySaved } from './saved.js';
import { ASSISTANT_TOOL_NAMES } from './terra/identity.js';

export function explainProperty(property) {
  if (!property) return { ok: false, error: 'No property' };
  return {
    ok: true,
    action: 'explain_property',
    id: property.id,
    address: property.address,
    scores: property.opportunityScore,
    composite: property.composite,
    bestStrategy: property.bestStrategy,
    signals: property.signals,
    value: property.estimatedValue,
    equity: property.estimatedEquityPct,
    why: whyThisMatters(property),
    drivers: Array.isArray(property.drivers) ? property.drivers.slice() : [],
    saved: isPropertySaved(property.id),
  };
}

/** The one list: the assistant's session is minted from the same names. */
export const INVESTOR_VOICE_TOOL_NAMES = ASSISTANT_TOOL_NAMES;

export function isInvestorVoiceTool(name) {
  return INVESTOR_VOICE_TOOL_NAMES.includes(name);
}

function sessionFrom(context) {
  return context?.investorSession
    || globalThis.__terraSignal
    || globalThis.__godsEyeView?.investor
    || null;
}

function resolveProperty(session, args) {
  const id = String(args?.propertyId || args?.id || '').trim();
  if (id) return session.getById(id);
  return session.focused;
}

export function runInvestorVoiceTool(name, rawArgs = {}, context = {}) {
  const session = sessionFrom(context);
  if (!session) {
    return { ok: false, action: name, error: 'TerraSignal Investor session is not running' };
  }
  const args = rawArgs && typeof rawArgs === 'object' ? rawArgs : {};

  // The preferred path: hand the sentence straight to the same parser the
  // typed bar uses, so voice and typing can never drift apart.
  if (name === 'investor_command') {
    const text = String(args.text || '').trim();
    if (!text) return { ok: false, action: name, error: 'investor_command needs text' };
    return session.handleIntent(text);
  }

  if (name === 'compare_strategies') {
    const property = resolveProperty(session, args);
    if (property && property.id !== session.focused?.id) session.focus(property.id, { fly: false });
    return session.handleIntent('compare');
  }

  if (name === 'explain_strategy') {
    const property = resolveProperty(session, args);
    if (property && property.id !== session.focused?.id) session.focus(property.id, { fly: false });
    const strategy = normalizeStrategy(args.strategy);
    return session.handleIntent(strategy ? `why not ${strategy}` : 'why');
  }

  if (name === 'set_opportunity_vision') {
    return session.setOpportunityVision(args.enabled !== false);
  }

  if (name === 'search_mock_properties') {
    const results = session.search({
      query: args.query,
      signalType: args.signalType,
      county: args.county,
      maxPurchase: args.maxPurchase,
      minScore: args.minScore,
      strategy: args.strategy || 'composite',
      limit: args.limit || 8,
    });
    return {
      ok: true,
      action: name,
      count: results.length,
      results: results.map((row) => ({
        id: row.property.id,
        address: row.property.address,
        score: row.score,
        signal: row.primary?.type || null,
        strategy: row.bestStrategy,
      })),
    };
  }

  if (name === 'rank_mock_properties') {
    if (String(args.intent || '').toLowerCase() === 'money' || args.findMoney) {
      return session.handleIntent('Find me money');
    }
    const results = session.rank({
      strategy: args.strategy || 'composite',
      limit: args.limit || 5,
    });
    if (results[0] && args.focus !== false) session.focus(results[0].property.id);
    return {
      ok: true,
      action: name,
      count: results.length,
      results: results.map((row) => ({
        id: row.property.id,
        address: row.property.address,
        score: row.score,
        signal: row.primary?.type || null,
        strategy: row.bestStrategy,
      })),
      spoken: results[0] ? `Top pick ${results[0].property.address}.` : 'No mock ranks.',
    };
  }

  if (name === 'focus_property') {
    const property = resolveProperty(session, args);
    if (!property) return { ok: false, action: name, error: 'Unknown mock property' };
    return session.focus(property.id);
  }

  if (name === 'explain_property') {
    const property = resolveProperty(session, args) || session.focused;
    if (!property) return session.handleIntent('Why?');
    const result = explainProperty(property);
    session.focus(property.id, { fly: false });
    return { ...result, spoken: result.why };
  }

  if (name === 'show_deal_vision') {
    return session.showDealVision(args.strategy || args.mode);
  }

  if (name.startsWith('run_') && name.endsWith('_analysis')) {
    const strategy = normalizeStrategy(args.strategy) || name.slice(4, -9);
    if (args.rehabDelta) session.conversation.rehabDelta = Number(args.rehabDelta) || session.conversation.rehabDelta;
    if (args.assumeRehabHigher) {
      return session.handleIntent('Assume rehab is twenty thousand higher');
    }
    const property = resolveProperty(session, args);
    if (property && property.id !== session.focused?.id) session.focus(property.id, { fly: false });
    // What-ifs from the model persist on the conversation, exactly as a typed
    // one would, so a follow-up question re-runs against the same numbers.
    if (args.dealOverrides && typeof args.dealOverrides === 'object') {
      session.conversation.dealOverrides = {
        ...session.conversation.dealOverrides,
        ...args.dealOverrides,
      };
    }
    if (args.assumptionOverrides && typeof args.assumptionOverrides === 'object') {
      session.conversation.assumptionOverrides = {
        ...session.conversation.assumptionOverrides,
        ...args.assumptionOverrides,
      };
    }
    const result = session.analyze(strategy, {});
    return { ...result, spoken: result.ok ? `${strategy} analysis ready.` : result.error };
  }

  if (name === 'save_property') {
    const property = resolveProperty(session, args) || session.focused;
    return session.save(property?.id, { note: args.note, strategy: args.strategy });
  }

  if (name === 'show_saved_properties') {
    return session.showSaved();
  }

  if (name === 'property_facts') {
    const property = args.query ? session.search({ query: args.query, limit: 1 })[0]?.property : resolveProperty(session, args);
    if (!property) return { ok: false, action: name, error: 'No property in focus — say "show me the best one" or name a house.' };
    const facts = session.facts(property.id);
    const strategy = normalizeStrategy(args.strategy);
    if (strategy && facts?.strategies) {
      return { ok: true, action: name, ...facts, strategies: { [strategy]: facts.strategies[strategy] }, verdicts: { [strategy]: facts.verdicts[strategy] } };
    }
    return { ok: true, action: name, ...facts };
  }

  if (name === 'what_if') {
    const text = String(args.text || '').trim();
    if (!text) return { ok: false, action: name, error: 'what_if needs the words' };
    const result = session.handleIntent(text);
    const property = session.focused;
    const strategy = result?.strategy || session.conversation.lastStrategy || (property ? bestStrategyFor(property) : null);
    const facts = property ? session.facts(property.id) : null;
    return {
      ...result,
      action: name,
      strategy,
      facts: facts && strategy ? facts.strategies[strategy] : null,
      overridesInUse: facts?.overridesInUse || null,
    };
  }

  if (name === 'rank_shortlist') {
    return { ok: true, action: name, ...session.rankFacts({ all: Boolean(args.all) }) };
  }

  if (name === 'compare_properties') {
    const result = session.compareFacts({
      a: args.propertyA, b: args.propertyB, withPrevious: Boolean(args.withPrevious), strategy: args.strategy,
    });
    return result?.ok === false ? { ...result, action: name } : { ok: true, action: name, ...result };
  }

  if (name === 'start_drive_demo') {
    return session.handleIntent('start drive');
  }

  if (name === 'stop_drive_demo') {
    if (args.command === 'next') return session.drive.next();
    if (args.command === 'skip') return session.drive.skip();
    if (args.command === 'why') return session.drive.why();
    return session.drive.stop();
  }

  return { ok: false, action: name, error: `Unhandled investor tool: ${name}` };
}
