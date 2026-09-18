import test from 'node:test';
import assert from 'node:assert/strict';
import { INVESTOR_VOICE_TOOL_NAMES, isInvestorVoiceTool, runInvestorVoiceTool } from './voiceTools.js';
import { createMockPropertyProvider } from './mock/provider.js';
import { createConversationState } from './conversation.js';

function fakeSession() {
  const provider = createMockPropertyProvider();
  const properties = provider.list();
  const conversation = createConversationState();
  let focused = properties[0];
  conversation.focusedId = focused.id;
  conversation.lastStrategy = 'flip';
  return {
    provider,
    properties,
    conversation,
    get focused() { return focused; },
    getById: (id) => provider.getById(id),
    focus(id) {
      focused = provider.getById(id);
      conversation.focusedId = id;
      return { ok: true, action: 'focus_property', id };
    },
    setOpportunityVision: (enabled) => ({ ok: true, action: 'set_opportunity_vision', enabled }),
    search: () => [{ property: focused, score: 92, primary: focused.signals[0], bestStrategy: 'flip' }],
    rank: () => [{ property: focused, score: 92, primary: focused.signals[0], bestStrategy: 'flip' }],
    showDealVision: (strategy) => ({ ok: true, action: 'show_deal_vision', strategy }),
    analyze: (strategy) => ({ ok: true, action: `run_${strategy}_analysis`, strategy, analysis: { profit: 1 } }),
    save: (id) => ({ ok: true, action: 'save_property', id }),
    showSaved: () => ({ ok: true, action: 'show_saved_properties', saved: [] }),
    handleIntent: (text) => ({ ok: true, spoken: text, strategy: 'flip' }),
    facts: (id) => ({ id, strategies: { flip: { profit: 1 }, rental: { cashFlowMonthly: 2 } }, verdicts: { flip: 'strong', rental: 'thin' }, overridesInUse: {} }),
    rankFacts: ({ all }) => ({ scope: all ? 'board' : 'shortlist', count: 1, rows: [{ rank: 1 }] }),
    compareFacts: ({ withPrevious, strategy }) => (withPrevious ? { strategy: strategy || 'flip', a: {}, b: {} } : { ok: false, error: 'nothing' }),
    drive: {
      next: () => ({ ok: true, action: 'start_drive_demo', command: 'next' }),
      skip: () => ({ ok: true, command: 'skip' }),
      why: () => ({ ok: true, action: 'explain_property' }),
      stop: () => ({ ok: true, action: 'stop_drive_demo' }),
    },
  };
}

test('all Phase 1 investor voice tools are registered and unique', () => {
  assert.equal(INVESTOR_VOICE_TOOL_NAMES.length, 21);
  assert.equal(new Set(INVESTOR_VOICE_TOOL_NAMES).size, 21);
  for (const added of ['investor_command', 'compare_strategies', 'explain_strategy']) {
    assert.ok(INVESTOR_VOICE_TOOL_NAMES.includes(added), added);
  }
  for (const name of INVESTOR_VOICE_TOOL_NAMES) {
    assert.equal(isInvestorVoiceTool(name), true);
  }
});

test('investor tools fail closed without a session and run against a session', () => {
  assert.equal(runInvestorVoiceTool('focus_property', { propertyId: 'DEMO-ATL-001' }).ok, false);
  const session = fakeSession();
  assert.equal(runInvestorVoiceTool('set_opportunity_vision', { enabled: true }, { investorSession: session }).ok, true);
  assert.equal(runInvestorVoiceTool('focus_property', { propertyId: 'DEMO-ATL-001' }, { investorSession: session }).id, 'DEMO-ATL-001');
  assert.equal(runInvestorVoiceTool('explain_property', {}, { investorSession: session }).ok, true);
  assert.equal(runInvestorVoiceTool('run_flip_analysis', {}, { investorSession: session }).ok, true);
  assert.equal(runInvestorVoiceTool('save_property', {}, { investorSession: session }).ok, true);
});

test('the question tools: facts for the focused or named house, what-ifs, ranking, comparison', () => {
  const session = fakeSession();
  const ctx = { investorSession: session };
  const facts = runInvestorVoiceTool('property_facts', {}, ctx);
  assert.equal(facts.ok, true);
  assert.equal(facts.id, session.focused.id);
  assert.ok(facts.strategies.flip && facts.strategies.rental);
  const rentalOnly = runInvestorVoiceTool('property_facts', { strategy: 'rent' }, ctx);
  assert.deepEqual(Object.keys(rentalOnly.strategies), ['rental']);
  const whatIf = runInvestorVoiceTool('what_if', { text: 'what if rent is 3000' }, ctx);
  assert.equal(whatIf.ok, true);
  assert.equal(whatIf.action, 'what_if');
  assert.equal(whatIf.strategy, 'flip');
  assert.deepEqual(whatIf.facts, { profit: 1 });
  assert.equal(runInvestorVoiceTool('what_if', {}, ctx).ok, false);
  assert.equal(runInvestorVoiceTool('rank_shortlist', {}, ctx).scope, 'shortlist');
  assert.equal(runInvestorVoiceTool('rank_shortlist', { all: true }, ctx).scope, 'board');
  assert.equal(runInvestorVoiceTool('compare_properties', { withPrevious: true, strategy: 'rental' }, ctx).strategy, 'rental');
  assert.equal(runInvestorVoiceTool('compare_properties', {}, ctx).ok, false);
});
