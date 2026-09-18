import test from 'node:test';
import assert from 'node:assert/strict';
import { createTurnMetrics } from './turnMetrics.js';

test('a spoken turn measures speech_stopped to the first audio frame, plus the VAD silence for the felt pause', () => {
  let t = 0;
  const metrics = createTurnMetrics({ now: () => t, silenceMs: 350, targetMs: 800 });
  t = 1000; metrics.observe('input_audio_buffer.speech_stopped');
  t = 1420; metrics.observe('output_audio_buffer.started');
  t = 3000; const turn = metrics.observe('response.done');
  assert.equal(turn.kind, 'speech');
  assert.equal(turn.firstWordMs, 420);
  assert.equal(turn.fromLastWordMs, 770);
  const summary = metrics.summary();
  assert.equal(summary.heard, 1);
  assert.equal(summary.lastMs, 420);
  assert.equal(summary.spokenP50FromLastWordMs, 770);
  assert.equal(summary.withinTarget, 1);
});

test('typed and proactive turns start when the client asks for the response', () => {
  let t = 0;
  const metrics = createTurnMetrics({ now: () => t });
  t = 10; metrics.begin('text');
  t = 900; metrics.observe('output_audio_buffer.started');
  t = 2000; metrics.observe('response.done');
  t = 2100; metrics.begin('brief', { event: 'descent_settled' });
  t = 2500; metrics.observe('output_audio_buffer.started');
  // A second audio start inside the same turn is not a new first word.
  t = 2700; assert.equal(metrics.observe('output_audio_buffer.started'), null);
  t = 4000; metrics.observe('response.done');
  const turns = metrics.turns;
  assert.deepEqual(turns.map((x) => x.firstWordMs), [890, 400]);
  assert.equal(turns[1].event, 'descent_settled');
  assert.equal(turns[1].fromLastWordMs, 400);
  const summary = metrics.summary();
  assert.equal(summary.p50Ms, 890);
  assert.equal(summary.worstMs, 890);
  assert.equal(summary.withinTarget, 1);
});

test('a turn with no audio (a tool-only response) is counted but not heard', () => {
  const metrics = createTurnMetrics({ now: () => 0 });
  metrics.begin('text');
  metrics.observe('response.done');
  assert.equal(metrics.summary().turns, 1);
  assert.equal(metrics.summary().heard, 0);
  assert.equal(metrics.summary().lastMs, null);
  assert.equal(metrics.observe('response.done'), null);
});

test("audio from the previous turn draining late is not this turn's first word", () => {
  let t = 0;
  const metrics = createTurnMetrics({ now: () => t });
  t = 0; metrics.begin('text');
  t = 100; metrics.observe('response.created', { response: { id: 'r1' } });
  t = 900; metrics.observe('response.output_audio_transcript.delta', { response_id: 'r1' });
  t = 1500; metrics.observe('response.done', { response: { id: 'r1' } });
  t = 2000; metrics.observe('input_audio_buffer.speech_stopped');
  t = 2010; metrics.observe('response.created', { response: { id: 'r2' } });
  // The buffer for r1 was still draining and only now reports it started.
  t = 2100; assert.equal(metrics.observe('output_audio_buffer.started', { response_id: 'r1' }), null);
  t = 2600; metrics.observe('response.output_audio_transcript.delta', { response_id: 'r2' });
  t = 3000; metrics.observe('response.done', { response: { id: 'r2' } });
  assert.deepEqual(metrics.turns.map((x) => x.firstWordMs), [900, 600]);
  assert.deepEqual(metrics.turns[1].responseIds, ['r2']);
});
