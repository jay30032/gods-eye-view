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
    handleIntent: (text) => ({ ok: true, spoken: text }),
    drive: {
      next: () => ({ ok: true, action: 'start_drive_demo', command: 'next' }),
      skip: () => ({ ok: true, command: 'skip' }),
      why: () => ({ ok: true, action: 'explain_property' }),
      stop: () => ({ ok: true, action: 'stop_drive_demo' }),
    },
  };
}

test('all Phase 1 investor voice tools are registered and unique', () => {
  assert.equal(INVESTOR_VOICE_TOOL_NAMES.length, 14);
  assert.equal(new Set(INVESTOR_VOICE_TOOL_NAMES).size, 14);
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
