/**
 * First-word latency, measured from the Realtime event stream.
 *
 * A turn starts when the user finishes — `input_audio_buffer.speech_stopped`
 * for a spoken turn, the moment `response.create` is sent for a typed one,
 * the moment the brief is requested for a proactive one — and its first
 * audible word is the first audio of a response that belongs to it: the
 * transport's `output_audio_buffer.started`, or the first
 * `response.output_audio_transcript.delta`, whichever lands first. Both carry
 * a response id, and only a response created inside the turn counts — the
 * previous turn's audio draining late must not be read as this turn's first
 * word, and `output_audio_buffer.started` alone cannot tell the two apart
 * because the buffer only "starts" when it was empty. The difference is what
 * the user hears as the pause.
 *
 * For a spoken turn the server has already waited `silence_duration_ms`
 * before it says speech stopped, so the pause the user *feels* is that much
 * longer; `fromLastWordMs` adds it back.
 *
 * Pure: fed events with a clock, returns numbers.
 */

export const TURN_KINDS = Object.freeze(['speech', 'text', 'brief']);

/**
 * @param {{now?:Function, silenceMs?:number, targetMs?:number}} [options]
 */
export function createTurnMetrics({ now = () => Date.now(), silenceMs = 0, targetMs = 800 } = {}) {
  const turns = [];
  let open = null;

  function begin(kind, meta = {}) {
    const at = now();
    open = {
      kind: TURN_KINDS.includes(kind) ? kind : 'text',
      startedAt: at,
      firstAudioAt: null,
      doneAt: null,
      responseIds: [],
      ...meta,
    };
    return open;
  }

  function firstAudio(responseId = null) {
    if (!open || open.firstAudioAt !== null) return null;
    if (responseId && open.responseIds.length && !open.responseIds.includes(responseId)) return null;
    open.firstAudioAt = now();
    open.firstWordMs = open.firstAudioAt - open.startedAt;
    open.fromLastWordMs = open.firstWordMs + (open.kind === 'speech' ? silenceMs : 0);
    return open;
  }

  function done() {
    if (!open) return null;
    open.doneAt = now();
    const finished = open;
    turns.push(finished);
    if (turns.length > 200) turns.shift();
    open = null;
    return finished;
  }

  function percentile(values, q) {
    if (!values.length) return null;
    const sorted = values.slice().sort((a, b) => a - b);
    return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
  }

  return {
    begin,
    firstAudio,
    done,
    /** Fold a server event in. Returns what changed, if anything. */
    observe(type, payload = {}) {
      const responseId = payload?.response_id || payload?.response?.id || null;
      if (type === 'input_audio_buffer.speech_stopped') return begin('speech');
      if (type === 'response.created') {
        if (open && responseId) open.responseIds.push(responseId);
        return null;
      }
      if (type === 'output_audio_buffer.started' || type === 'response.output_audio_transcript.delta'
        || type === 'response.audio_transcript.delta') {
        return firstAudio(responseId);
      }
      if (type === 'response.done') return done();
      return null;
    },
    get open() { return open ? { ...open } : null; },
    get turns() { return turns.slice(); },
    summary() {
      const heard = turns.filter((t) => Number.isFinite(t.firstWordMs));
      const values = heard.map((t) => t.firstWordMs);
      const spoken = heard.filter((t) => t.kind === 'speech').map((t) => t.fromLastWordMs);
      return {
        targetMs,
        silenceMs,
        turns: turns.length,
        heard: heard.length,
        lastMs: values.length ? values[values.length - 1] : null,
        p50Ms: percentile(values, 0.5),
        p95Ms: percentile(values, 0.95),
        worstMs: values.length ? Math.max(...values) : null,
        spokenP50FromLastWordMs: percentile(spoken, 0.5),
        withinTarget: values.length ? values.filter((v) => v <= targetMs).length : 0,
      };
    },
  };
}
