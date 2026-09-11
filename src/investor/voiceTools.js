import { normalizeStrategy } from './deal/index.js';
import { whyThisMatters } from './focus.js';
import { isPropertySaved } from './saved.js';

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

export const INVESTOR_VOICE_TOOL_NAMES = Object.freeze([
  'set_opportunity_vision',
  'search_mock_properties',
  'focus_property',
  'rank_mock_properties',
  'explain_property',
  'show_deal_vision',
  'run_flip_analysis',
  'run_rental_analysis',
  'run_brrrr_analysis',
  'run_wholesale_analysis',
  'save_property',
  'show_saved_properties',
  'start_drive_demo',
  'stop_drive_demo',
]);

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

  if (name === 'set_opportunity_vision') {
    return session.setOpportunityVision(args.enabled !== false);
  }

  if (name === 'search_mock_properties') {
    const results = session.search({
      query: args.query,
      signalType: args.signalType,
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
    const result = session.analyze(strategy, args);
    return { ...result, spoken: result.ok ? `${strategy} analysis ready.` : result.error };
  }

  if (name === 'save_property') {
    const property = resolveProperty(session, args) || session.focused;
    return session.save(property?.id, { note: args.note, strategy: args.strategy });
  }

  if (name === 'show_saved_properties') {
    return session.showSaved();
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
