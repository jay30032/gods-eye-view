/**
 * The assistant as a presence.
 *
 * `gevRealtime.js` owns the WebRTC session, the tools and the cost meter; this
 * rides on it and turns a command channel into someone in the room:
 *
 *   - **always listening.** One session, opened on the first tap of the orb,
 *     server-side voice activity detection, no push-to-talk. A second tap
 *     pauses the mic; the session stays up so resuming is instant.
 *   - **situational.** Before every turn a snapshot of the app's state goes in
 *     front of the model as one system item, replacing the last.
 *   - **proactive.** The app raises events; `speakPolicy` decides which become
 *     a brief; the brief is a `response.create` with the event named.
 *   - **interruptible.** The user talking over the assistant mutes its audio
 *     on the client the same millisecond, asks the server to clear what it
 *     had queued, and lets any half-assembled card finish silently.
 *   - **measured.** First-word latency per turn, from the event stream.
 *
 * With no API key the session never opens and the orb opens the typed bar,
 * which is exactly the product before this file existed.
 */
import {
  ASSISTANT_NAME,
  ASSISTANT_TURN_DETECTION,
  FIRST_WORD_TARGET_MS,
  SNAPSHOT_ITEM_PREFIX,
} from './identity.js';
import { createSpeakPolicy } from './speakPolicy.js';
import { buildSnapshot, snapshotText } from './snapshot.js';
import { createTurnMetrics } from './turnMetrics.js';

export const AVAILABILITY_URL = '/api/realtime/available';
export const TOKEN_QUERY = 'persona=terra';

/** What the strip says the first time the mic is asked for. */
export const MIC_EXPLANATION = `${ASSISTANT_NAME} listens through your mic so you can just talk — allow it once.`;

/** What each app event asks the assistant to do. */
export const EVENT_BRIEFS = Object.freeze({
  descent_settled: 'The descent has settled on the market. Say how many houses and signals there are and when and where the nearest auction is, then ask if they want the best one. At most 25 words, the question included.',
  find_money_complete: 'The hunt is complete and the camera is on the gold pick. Name it, the money in it and its play in one breath, then the next step as a question.',
  house_focused: 'A house is now in focus with its card open. Say the figure that decides its play and whether it works, then the next step as a question.',
  drive_approach: 'The drive is approaching a signal. Say what is coming up and on which side, in one breath.',
  xray: 'The x-ray just fired on the house in focus. One short clause on what the see-through shows, then stop.',
  save_done: 'The save just landed. Confirm in four words or fewer.',
});

/** After a tool ran: the snapshot before this is the new state; caption it. */
export function followupInstructions(result) {
  const outcome = result?.ok === false
    ? `The action did not run (${String(result?.error || result?.spoken || 'no reason given').slice(0, 120)}). Say so in a few words.`
    : 'The action ran and the state item just before this is the new state.';
  return `${outcome} No bridge now — straight to the answer, one breath, in plain sentences: if the state item shows camera.change, open with a short clause on where we are now; then the money and the deadline, the play in plain words and whether it works, and the next step as a short question — 25 words in all unless the investor asked to walk the numbers, figures exactly as the state gives them, no hedges. Do not read the tool result's spoken caption word for word. Do not repeat yourself.`;
}

/** How the model is asked for a brief: the event, then the rules it already has. */
export function briefInstructions(type) {
  const ask = EVENT_BRIEFS[type] || `The app raised "${type}". Brief it in one breath.`;
  return `event: ${type}. The app has already acted — do NOT call any tool and do not bridge, just speak. ${ask} Read the state item just before this. Numbers exact. One breath. Do not repeat a house you spoke about in the last minute.`;
}

/**
 * Fold transcript lines into exchanges: one user line, one assistant line.
 * A brief is an exchange whose user side is the event.
 */
export function foldExchanges(lines, limit = 3) {
  const out = [];
  for (const line of lines || []) {
    if (line.role === 'user' || line.role === 'event') {
      out.push({ user: line.role === 'event' ? `(event: ${line.text})` : line.text, [ASSISTANT_NAME.toLowerCase()]: '' });
      continue;
    }
    if (line.role !== 'assistant') continue;
    const last = out[out.length - 1];
    if (last && !last[ASSISTANT_NAME.toLowerCase()]) last[ASSISTANT_NAME.toLowerCase()] = line.text;
    else out.push({ user: '', [ASSISTANT_NAME.toLowerCase()]: line.text });
  }
  return out.slice(-limit);
}

/**
 * @param {object} deps
 * @param {object} deps.session the investor session
 * @param {object} [deps.controller] the GevRealtimeController
 * @param {Function} [deps.gather] returns the live state the snapshot is built from
 * @param {Function} [deps.onInterrupt] the card finishes silently
 * @param {Function} [deps.openTyped] the no-key fallback
 * @param {Function} [deps.strip] write one line to the status strip
 */
export function createTerra({
  session,
  controller = null,
  gather = () => ({}),
  onInterrupt = null,
  openTyped = null,
  strip = null,
  fetchImpl = globalThis.fetch?.bind(globalThis) || null,
  permissions = globalThis.navigator?.permissions || null,
  now = () => (globalThis.performance?.now?.() ?? Date.now()),
  parseIntent = null,
} = {}) {
  const policy = createSpeakPolicy({ now });
  const metrics = createTurnMetrics({
    now,
    silenceMs: ASSISTANT_TURN_DETECTION.silence_duration_ms,
    targetMs: FIRST_WORD_TARGET_MS,
  });
  /** {role:'user'|'assistant'|'event'|'tool', text, at} */
  const transcript = [];
  const toolCalls = [];
  const interruptions = [];
  const events = [];
  let available = null;
  let paused = false;
  let started = false;
  let unsubscribe = null;
  let lastSnapshotText = '';
  let lastSnapshotAt = -Infinity;
  let muted = false;
  /** True between the first and last audio frame of a response. */
  let audioPlaying = false;
  let controllerRef = controller;
  /** The event a queued brief is about, consumed by the snapshot that precedes it. */
  let briefEvent = null;
  /** The shot the model last saw, so a snapshot can say the view changed. */
  let lastShot = null;
  let lastFocusedId = null;

  const ctl = () => controllerRef || globalThis.__gevVoiceCommands || null;
  const live = () => {
    const c = ctl();
    return Boolean(c && c.isActive?.() && c.dc?.readyState === 'open');
  };

  function log(role, text, extra = {}) {
    const entry = { role, text: String(text || ''), at: Math.round(now()), ...extra };
    transcript.push(entry);
    if (transcript.length > 400) transcript.shift();
    return entry;
  }

  /**
   * The view the model should be told about: a shot that differs from the
   * one in the last snapshot it was sent, or the same shot on a different
   * house (a hop from one HERO to the next is a move).
   */
  function cameraChange(state) {
    const shot = state.camera?.shot || null;
    const focusedId = state.focused?.id || null;
    if (lastShot === null) return null;
    if (shot === lastShot && focusedId === lastFocusedId) return null;
    return { from: lastShot, to: shot, ...(state.camera?.flying ? { flying: true } : {}) };
  }

  function snapshot(event = null, { commit = false } = {}) {
    const state = gather() || {};
    const change = cameraChange(state);
    const built = buildSnapshot({
      ...state,
      camera: { ...(state.camera || {}), ...(change ? { change } : {}) },
      exchanges: foldExchanges(transcript),
      listening: live() && !paused,
      event,
    });
    if (commit) {
      lastShot = state.camera?.shot || null;
      lastFocusedId = state.focused?.id || null;
    }
    return built;
  }

  /**
   * Put fresh state in front of the model. Debounced by content: the same
   * state twice in a row inside 250 ms is one item, not two.
   */
  function refreshSnapshot(event = null) {
    const c = ctl();
    if (!c || !live()) return false;
    const text = snapshotText(snapshot(event, { commit: true }));
    const t = now();
    if (text === lastSnapshotText && t - lastSnapshotAt < 250) return false;
    lastSnapshotText = text;
    lastSnapshotAt = t;
    return c.setContextItem(text, SNAPSHOT_ITEM_PREFIX);
  }

  function setMuted(next) {
    const c = ctl();
    const el = c?.audioElement || null;
    muted = Boolean(next);
    if (el) el.muted = muted;
  }

  /** The user is talking over the assistant. */
  function interrupt() {
    const c = ctl();
    // A live stream element is never "paused", so playing is tracked from the
    // transport's own audio-buffer events rather than read off the element.
    const wasSpeaking = Boolean(c?.responseActive) || audioPlaying;
    if (!wasSpeaking) return null;
    const at = now();
    setMuted(true);
    c?.sendRealtimeEvent?.({ type: 'output_audio_buffer.clear' }, 'client.output_audio_buffer.clear');
    try { onInterrupt?.(); } catch { /* the card can always finish later */ }
    const record = { at: Math.round(at), stoppedMs: Math.round(now() - at) };
    interruptions.push(record);
    if (interruptions.length > 50) interruptions.shift();
    return record;
  }

  function onServerEvent(payload) {
    const type = payload?.type;
    if (type === 'session.created') {
      // The data channel is open and the model is on the line.
      if (!paused) strip?.(`${ASSISTANT_NAME} is listening.`);
      // Joining a settled market view is the same moment as the descent
      // settling: brief the board once, then wait to be spoken to.
      const state = gather() || {};
      if (state.camera?.shot === 'CRUISE' && !state.camera?.flying) emit('descent_settled');
      return;
    }
    if (type === 'input_audio_buffer.speech_started') {
      // The user's turn outranks any brief still waiting for its snapshot.
      briefEvent = null;
      interrupt();
      refreshSnapshot();
      return;
    }
    if (type === 'input_audio_buffer.speech_stopped' || type === 'response.created') {
      metrics.observe(type, payload);
      return;
    }
    if (type === 'response.output_audio_transcript.delta' || type === 'response.audio_transcript.delta') {
      metrics.observe(type, payload);
      return;
    }
    if (type === 'output_audio_buffer.started') {
      audioPlaying = true;
      setMuted(false);
      metrics.observe(type, payload);
      return;
    }
    if (type === 'output_audio_buffer.stopped' || type === 'output_audio_buffer.cleared') {
      audioPlaying = false;
      setMuted(false);
      return;
    }
    if (type === 'conversation.item.input_audio_transcription.completed') {
      const text = String(payload.transcript || '').trim();
      if (text) log('user', text, { itemId: payload.item_id || null });
      return;
    }
    if (type === 'response.output_audio_transcript.done' || type === 'response.audio_transcript.done') {
      const text = String(payload.transcript || '').trim();
      if (text) log('assistant', text, { responseId: payload.response_id || null });
      return;
    }
    if (type === 'response.function_call_arguments.done') {
      let args = {};
      try { args = JSON.parse(payload.arguments || '{}'); } catch { args = {}; }
      const intent = payload.name === 'investor_command' && typeof parseIntent === 'function'
        ? (parseIntent(args.text)?.intent || null)
        : (payload.name === 'rank_mock_properties' && (args.findMoney || args.intent === 'money') ? 'find_money' : null);
      const call = { name: payload.name, args, intent, at: Math.round(now()), responseId: payload.response_id || null };
      toolCalls.push(call);
      if (toolCalls.length > 100) toolCalls.shift();
      log('tool', `${payload.name}(${JSON.stringify(args)})${intent ? ` → ${intent}` : ''}`);
      return;
    }
    if (type === 'response.done') {
      const output = payload.response?.output || [];
      const calledTool = output.some((item) => item?.type === 'function_call');
      const c = ctl();
      // A response that only called a tool is half a turn; the follow-up that
      // speaks is the same turn as far as the user's wait is concerned.
      if (calledTool || c?.pendingResponseInstructions) return;
      const turn = metrics.observe(type, payload);
      if (turn && turn.kind !== 'brief') {
        const focusedId = gather()?.focused?.id || null;
        if (focusedId) policy.noteSpoken(focusedId);
      }
    }
  }

  function attach() {
    const c = ctl();
    if (!c || unsubscribe) return;
    controllerRef = c;
    unsubscribe = c.onServerEvent?.(onServerEvent) || null;
    c.tokenQuery = TOKEN_QUERY;
    c.alwaysOn = true;
    c.followupInstructions = followupInstructions;
    c.beforeResponseCreate = ({ kind }) => {
      if (kind === 'user_text' && !metrics.open) metrics.begin('text');
      // The brief's snapshot names its event; every other turn's does not.
      const event = kind === 'followup' ? briefEvent : null;
      briefEvent = null;
      refreshSnapshot(event);
    };
  }

  async function probe() {
    if (available !== null) return available;
    try {
      const response = await fetchImpl?.(AVAILABILITY_URL, { cache: 'no-store' });
      const data = await response?.json?.().catch(() => null);
      available = Boolean(response?.ok && data?.available);
    } catch {
      available = false;
    }
    return available;
  }

  async function micGranted() {
    try {
      const status = await permissions?.query?.({ name: 'microphone' });
      return status?.state === 'granted';
    } catch {
      return false;
    }
  }

  async function start() {
    const ok = await probe();
    if (!ok) {
      openTyped?.();
      return { ok: false, reason: 'no api key', typed: true };
    }
    const c = ctl();
    if (!c) {
      openTyped?.();
      return { ok: false, reason: 'no voice controller', typed: true };
    }
    attach();
    if (live()) {
      if (paused) resume();
      return { ok: true, already: true };
    }
    if (!(await micGranted())) strip?.(MIC_EXPLANATION);
    started = true;
    paused = false;
    delete c.ui?.root?.dataset?.paused;
    await c.start({ pushToTalk: false });
    if (c.status === 'error') {
      started = false;
      openTyped?.();
      return { ok: false, reason: 'voice error', typed: true };
    }
    return { ok: true };
  }

  function pause() {
    const c = ctl();
    if (!c || !live()) return { ok: false, reason: 'not listening' };
    paused = true;
    c.setMicrophoneEnabled(false);
    if (c.ui?.root?.dataset) c.ui.root.dataset.paused = '1';
    strip?.(`${ASSISTANT_NAME} paused. Tap the orb to listen again.`);
    return { ok: true, action: 'listen_off', paused: true, spoken: `${ASSISTANT_NAME} paused.` };
  }

  function resume() {
    const c = ctl();
    if (!c || !live()) return start();
    paused = false;
    c.setMicrophoneEnabled(true);
    if (c.ui?.root?.dataset) delete c.ui.root.dataset.paused;
    strip?.(`${ASSISTANT_NAME} is listening.`);
    return { ok: true, action: 'listen_on', paused: false, spoken: `${ASSISTANT_NAME} is listening.` };
  }

  function stop() {
    const c = ctl();
    started = false;
    paused = false;
    audioPlaying = false;
    setMuted(false);
    c?.stop?.();
    return { ok: true };
  }

  async function toggle() {
    if (!live()) return start();
    return paused ? resume() : pause();
  }

  /**
   * An app event. The policy decides; a yes becomes a brief.
   * @param {string} type
   * @param {{propertyId?:string}} [detail]
   */
  function emit(type, detail = {}) {
    const state = gather() || {};
    const decision = policy.decide(
      { type, propertyId: detail.propertyId || null },
      { flying: state.camera?.flying, level: state.level },
    );
    const record = { type, propertyId: detail.propertyId || null, ...decision, live: live(), paused, sent: false };
    events.push(record);
    if (events.length > 100) events.shift();
    if (!decision.speak || !live() || paused) return record;
    const c = ctl();
    log('event', type);
    briefEvent = type;
    metrics.begin('brief', { event: type });
    // The controller refreshes the snapshot (with the event) just before the
    // response.create it sends — now, or once the response in flight ends.
    c.queueResponseCreate(briefInstructions(type));
    record.sent = true;
    return record;
  }

  /** Text through the same session the voice uses. */
  function sendText(text) {
    const c = ctl();
    if (!c || !live()) return false;
    log('user', text, { typed: true });
    c.sendTextCommand(text);
    return true;
  }

  return {
    name: ASSISTANT_NAME,
    get available() { return available; },
    get live() { return live(); },
    get paused() { return paused; },
    get started() { return started; },
    get muted() { return muted; },
    get speaking() { return audioPlaying; },
    get transcript() { return transcript.slice(); },
    get toolCalls() { return toolCalls.slice(); },
    get interruptions() { return interruptions.slice(); },
    get events() { return events.slice(); },
    get metrics() { return metrics.summary(); },
    get turns() { return metrics.turns; },
    get policy() { return policy; },
    snapshot,
    refreshSnapshot,
    probe,
    start,
    pause,
    resume,
    stop,
    toggle,
    emit,
    sendText,
    interrupt,
    attach,
    destroy() { unsubscribe?.(); unsubscribe = null; },
  };
}
