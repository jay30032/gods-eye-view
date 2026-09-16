import test from 'node:test';
import assert from 'node:assert/strict';
import {
  EVENT_BRIEFS,
  MIC_EXPLANATION,
  TOKEN_QUERY,
  briefInstructions,
  createTerra,
  foldExchanges,
} from './presence.js';
import { ASSISTANT_NAME, SNAPSHOT_ITEM_PREFIX } from './identity.js';
import { parseCommand } from '../nlp/parse.js';

/** A controller with the four seams the presence uses and nothing else. */
function fakeController({ open = true } = {}) {
  const listeners = new Set();
  const sent = [];
  const audio = { muted: false, paused: false };
  const c = {
    status: open ? 'listening' : 'idle',
    dc: { readyState: open ? 'open' : 'closed' },
    ui: { root: { dataset: {} }, button: {} },
    responseActive: false,
    pendingResponseInstructions: null,
    tokenQuery: '',
    alwaysOn: false,
    beforeResponseCreate: null,
    audioElement: audio,
    contextItems: [],
    queued: [],
    micEnabled: true,
    isActive() { return this.status !== 'idle' && this.status !== 'error'; },
    onServerEvent(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    setContextItem(text, prefix) { this.contextItems.push({ text, prefix }); return true; },
    sendRealtimeEvent(message) { sent.push(message); return true; },
    queueResponseCreate(instructions) {
      this.beforeResponseCreate?.({ kind: 'followup', instructions }, this);
      this.queued.push(instructions);
    },
    sendTextCommand(text) {
      sent.push({ type: 'conversation.item.create', text });
      this.beforeResponseCreate?.({ kind: 'user_text' }, this);
      sent.push({ type: 'response.create' });
    },
    setMicrophoneEnabled(on) { this.micEnabled = on; },
    async start() { this.status = 'listening'; this.dc.readyState = 'open'; },
    stop() { this.status = 'idle'; this.dc.readyState = 'closed'; },
    /** Test seam: a server event arrives. */
    receive(payload) { for (const fn of listeners) fn(payload, this); },
    sent,
  };
  return c;
}

function harness({ open = true, flying = false, level = 'full', focusedId = 'A' } = {}) {
  let t = 0;
  const controller = fakeController({ open });
  const strip = [];
  const interrupts = [];
  let typed = 0;
  const terra = createTerra({
    session: {},
    controller,
    now: () => t,
    parseIntent: parseCommand,
    strip: (line) => strip.push(line),
    openTyped: () => { typed += 1; },
    onInterrupt: () => interrupts.push(t),
    fetchImpl: async () => ({ ok: true, json: async () => ({ available: true }) }),
    permissions: { query: async () => ({ state: 'granted' }) },
    gather: () => ({
      market: { id: 'atlanta', name: 'Atlanta / Decatur' },
      camera: { shot: 'CRUISE', flying },
      level,
      focused: focusedId ? { id: focusedId, address: '621 Third Ave, Decatur', signals: [] } : null,
      properties: [],
    }),
  });
  terra.attach();
  return { terra, controller, strip, interrupts, typed: () => typed, tick: (ms) => { t += ms; } };
}

test('attaching sets the persona token query and always-on, and every turn gets a fresh snapshot first', () => {
  const { terra, controller } = harness();
  assert.equal(controller.tokenQuery, TOKEN_QUERY);
  assert.equal(controller.alwaysOn, true);
  assert.equal(typeof controller.beforeResponseCreate, 'function');
  // The user starts talking: the snapshot goes in before their words land.
  controller.receive({ type: 'input_audio_buffer.speech_started' });
  assert.equal(controller.contextItems.length, 1);
  assert.equal(controller.contextItems[0].prefix, SNAPSHOT_ITEM_PREFIX);
  const parsed = JSON.parse(controller.contextItems[0].text);
  assert.equal(parsed.assistant, ASSISTANT_NAME);
  assert.equal(parsed.camera.view, 'over the market');
  assert.equal(parsed.focused.address, '621 Third Ave');
  // A typed command refreshes before its response.create.
  terra.sendText('why');
  assert.equal(controller.contextItems.length, 2);
  assert.equal(terra.transcript.at(-1).text, 'why');
});

test('an app event becomes a brief only when the policy says so', () => {
  const { terra, controller } = harness();
  const first = terra.emit('descent_settled');
  assert.equal(first.sent, true);
  assert.equal(controller.queued.length, 1);
  assert.ok(controller.queued[0].startsWith('event: descent_settled.'));
  assert.ok(controller.queued[0].includes(EVENT_BRIEFS.descent_settled));
  const withEvent = JSON.parse(controller.contextItems.at(-1).text);
  assert.equal(withEvent.event, 'descent_settled');

  assert.equal(terra.emit('find_money_complete', { propertyId: 'A' }).sent, true);
  const repeat = terra.emit('house_focused', { propertyId: 'A' });
  assert.equal(repeat.sent, false);
  assert.match(repeat.reason, /same property/);
  assert.equal(controller.queued.length, 2);
});

test('no brief in flight, under quiet, under off, or while paused', () => {
  const flying = harness({ flying: true });
  assert.equal(flying.terra.emit('house_focused', { propertyId: 'B' }).reason, 'in flight');
  const quiet = harness({ level: 'quiet' });
  assert.equal(quiet.terra.emit('descent_settled').reason, 'narration quiet');
  const off = harness({ level: 'off' });
  assert.equal(off.terra.emit('save_done', { propertyId: 'C' }).reason, 'narration off');
  const paused = harness();
  paused.terra.pause();
  assert.equal(paused.controller.micEnabled, false);
  assert.equal(paused.controller.ui.root.dataset.paused, '1');
  const held = paused.terra.emit('descent_settled');
  assert.equal(held.speak, true);
  assert.equal(held.sent, false);
  paused.terra.resume();
  assert.equal(paused.controller.micEnabled, true);
  assert.equal('paused' in paused.controller.ui.root.dataset, false);
});

test('talking over the assistant mutes its audio at once, clears the server buffer and finishes the card', () => {
  const { terra, controller, interrupts } = harness();
  controller.responseActive = true;
  controller.receive({ type: 'input_audio_buffer.speech_started' });
  assert.equal(controller.audioElement.muted, true);
  assert.ok(controller.sent.some((m) => m.type === 'output_audio_buffer.clear'));
  assert.equal(interrupts.length, 1);
  assert.equal(terra.interruptions.length, 1);
  assert.ok(terra.interruptions[0].stoppedMs <= 200);
  // The next audio frame unmutes.
  controller.receive({ type: 'output_audio_buffer.started' });
  assert.equal(controller.audioElement.muted, false);
  // Audio still draining after response.done is still interrupted…
  controller.responseActive = false;
  controller.receive({ type: 'input_audio_buffer.speech_started' });
  assert.equal(interrupts.length, 2);
  // …but once the last frame has played, talking is not an interruption.
  controller.receive({ type: 'output_audio_buffer.stopped' });
  controller.receive({ type: 'input_audio_buffer.speech_started' });
  assert.equal(interrupts.length, 2);
});

test('first-word latency is measured from speech_stopped to the first audio frame, across a tool call', () => {
  const { terra, controller, tick } = harness();
  controller.receive({ type: 'input_audio_buffer.speech_stopped' });
  tick(120);
  controller.receive({ type: 'response.function_call_arguments.done', name: 'investor_command', arguments: JSON.stringify({ text: "what's the best one" }) });
  controller.receive({ type: 'response.done', response: { output: [{ type: 'function_call' }] } });
  tick(400);
  controller.receive({ type: 'output_audio_buffer.started' });
  tick(1500);
  controller.receive({ type: 'response.output_audio_transcript.done', transcript: 'Six houses, five signals.' });
  controller.receive({ type: 'response.done', response: { output: [{ type: 'message' }] } });
  assert.equal(terra.toolCalls.length, 1);
  assert.equal(terra.toolCalls[0].intent, 'find_money');
  assert.equal(terra.metrics.lastMs, 520);
  assert.equal(terra.metrics.spokenP50FromLastWordMs, 870);
  assert.equal(terra.turns.length, 1);
  // A direct answer about the focused house counts as having briefed it.
  assert.equal(terra.emit('house_focused', { propertyId: 'A' }).sent, false);
  assert.deepEqual(foldExchanges(terra.transcript), [{ user: '', terra: 'Six houses, five signals.' }]);
});

test('the snapshot names a view change once, then falls silent about a still camera', () => {
  let shot = 'CRUISE';
  const controller = fakeController();
  const terra = createTerra({
    session: {},
    controller,
    gather: () => ({ camera: { shot }, properties: [] }),
  });
  terra.attach();
  controller.receive({ type: 'input_audio_buffer.speech_started' });
  assert.equal(JSON.parse(controller.contextItems.at(-1).text).camera.change, undefined);
  shot = 'HERO';
  controller.receive({ type: 'input_audio_buffer.speech_started' });
  assert.deepEqual(JSON.parse(controller.contextItems.at(-1).text).camera.change, { from: 'over the market', to: 'at the house' });
  controller.receive({ type: 'input_audio_buffer.speech_started' });
  assert.equal(JSON.parse(controller.contextItems.at(-1).text).camera.change, undefined);
});

test('joining a settled market briefs the board once', () => {
  const { terra, controller } = harness();
  controller.receive({ type: 'session.created' });
  assert.equal(controller.queued.length, 1);
  assert.ok(controller.queued[0].startsWith('event: descent_settled.'));
  assert.equal(terra.events.at(-1).sent, true);
});

test('the transcript folds into exchanges, newest three', () => {
  const lines = [
    { role: 'user', text: 'find me money' },
    { role: 'assistant', text: 'Four candidates.' },
    { role: 'event', text: 'house_focused' },
    { role: 'assistant', text: 'Flip is strong.' },
    { role: 'user', text: 'why' },
    { role: 'assistant', text: 'Because.' },
    { role: 'user', text: 'save it' },
    { role: 'tool', text: 'ignored' },
  ];
  const folded = foldExchanges(lines);
  assert.equal(folded.length, 3);
  assert.deepEqual(folded[0], { user: '(event: house_focused)', terra: 'Flip is strong.' });
  assert.deepEqual(folded[2], { user: 'save it', terra: '' });
  assert.ok(briefInstructions('nonsense').includes('nonsense'));
});

test('with no API key the orb opens the typed bar and nothing else changes', async () => {
  const controller = fakeController({ open: false });
  let typed = 0;
  const terra = createTerra({
    session: {},
    controller,
    fetchImpl: async () => ({ ok: true, json: async () => ({ available: false }) }),
    openTyped: () => { typed += 1; },
  });
  const result = await terra.toggle();
  assert.equal(result.typed, true);
  assert.equal(typed, 1);
  assert.equal(terra.available, false);
  assert.equal(terra.live, false);
  assert.equal(terra.emit('descent_settled').sent, false);
});

test('the first start explains the mic once when permission is not yet granted', async () => {
  const controller = fakeController({ open: false });
  const strip = [];
  const terra = createTerra({
    session: {},
    controller,
    strip: (line) => strip.push(line),
    fetchImpl: async () => ({ ok: true, json: async () => ({ available: true }) }),
    permissions: { query: async () => ({ state: 'prompt' }) },
  });
  const result = await terra.start();
  assert.equal(result.ok, true);
  assert.equal(strip[0], MIC_EXPLANATION);
  controller.receive({ type: 'session.created' });
  assert.equal(strip.at(-1), `${ASSISTANT_NAME} is listening.`);
  assert.equal(terra.live, true);
  // A second start is a no-op.
  assert.equal((await terra.start()).already, true);
});
