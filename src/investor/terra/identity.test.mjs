import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ASSISTANT_NAME,
  ASSISTANT_SPEED,
  ASSISTANT_TOOL_NAMES,
  ASSISTANT_TURN_DETECTION,
  ASSISTANT_VOICE,
  FIRST_WORD_TARGET_MS,
  buildAssistantInstructions,
  buildAssistantSessionConfig,
} from './identity.js';

test('the name is one constant and the instructions use it', () => {
  assert.equal(typeof ASSISTANT_NAME, 'string');
  assert.ok(buildAssistantInstructions().startsWith(`You are ${ASSISTANT_NAME},`));
  assert.ok(buildAssistantInstructions({ name: 'Ada' }).startsWith('You are Ada,'));
});

test('the voice is locked to cedar and never read from the environment', () => {
  assert.equal(ASSISTANT_VOICE, 'cedar');
  const previous = process.env.OPENAI_REALTIME_VOICE;
  process.env.OPENAI_REALTIME_VOICE = 'alloy';
  try {
    assert.equal(buildAssistantSessionConfig({ model: 'm' }).audio.output.voice, 'cedar');
  } finally {
    if (previous === undefined) delete process.env.OPENAI_REALTIME_VOICE;
    else process.env.OPENAI_REALTIME_VOICE = previous;
  }
  assert.ok(ASSISTANT_SPEED > 0.25 && ASSISTANT_SPEED <= 1.5);
});

test('server VAD with barge-in, and a silence window under the first-word target', () => {
  assert.equal(ASSISTANT_TURN_DETECTION.type, 'server_vad');
  assert.equal(ASSISTANT_TURN_DETECTION.interrupt_response, true);
  assert.equal(ASSISTANT_TURN_DETECTION.create_response, true);
  assert.ok(ASSISTANT_TURN_DETECTION.silence_duration_ms < FIRST_WORD_TARGET_MS);
  assert.equal(FIRST_WORD_TARGET_MS, 800);
});

test('the style rules are all present', () => {
  const text = buildAssistantInstructions();
  for (const rule of ['one breath', 'Open with the figure that decides it', 'No filler', '"sure"', '"great"',
    'Do not repeat what is already on screen', 'opens with a short clause', 'repeat exactly',
    'ACT FIRST', 'Never answer a board question from the snapshot alone', 'camera.change', 'SOUND LIKE THIS', 'a brief NEVER calls a tool']) {
    assert.ok(text.toLowerCase().includes(rule.toLowerCase()), rule);
  }
});

test('the session keeps only investor tools and carries transcription', () => {
  const tools = [
    { type: 'function', name: 'fly_to_location' },
    { type: 'function', name: 'investor_command' },
    { type: 'function', name: 'save_property' },
    { type: 'function', name: 'control_radio' },
  ];
  const config = buildAssistantSessionConfig({ model: 'gpt-realtime-2', tools });
  assert.deepEqual(config.tools.map((t) => t.name), ['investor_command', 'save_property']);
  assert.equal(config.model, 'gpt-realtime-2');
  assert.equal(config.audio.input.transcription.model, 'gpt-4o-mini-transcribe');
  assert.deepEqual(config.audio.input.turn_detection, { ...ASSISTANT_TURN_DETECTION });
  assert.equal(ASSISTANT_TOOL_NAMES.length, 17);
  assert.equal(new Set(ASSISTANT_TOOL_NAMES).size, 17);
});
