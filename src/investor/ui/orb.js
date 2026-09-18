/**
 * The mic orb: the assistant's one face.
 *
 * Four states — idle, listening, thinking, speaking — shown as light, not
 * text: the ring's colour and motion change and no label does. State comes
 * from three sources and the loudest wins:
 *
 *   - the voice control (GEV's realtime session) reports listening, thinking
 *     (connecting / executing) and speaking (its speaker is the AI);
 *   - the narrator reports speaking while a line is being read;
 *   - the session reports thinking between a command arriving and its answer.
 *
 * The voice control is observed for its `data-status` / `data-speaker`
 * attributes only, and this module never writes to that node — the orb's own
 * state lives on the slot — so there is nothing for the observer to react to
 * that it caused itself.
 */

export const ORB_STATES = Object.freeze(['idle', 'listening', 'thinking', 'speaking']);

/** Priority when sources disagree: the user talking beats everything. */
const PRIORITY = Object.freeze({ listening: 3, speaking: 2, thinking: 1, idle: 0 });

/** What the voice control's attributes mean for the orb. */
export function orbStateFromVoice({ status, speaker, paused = false } = {}) {
  // A paused mic is a session that is up but not listening: the light goes out.
  if (paused && speaker !== 'ai') return 'idle';
  if (speaker === 'ai') return 'speaking';
  if (status === 'listening') return speaker === 'user' ? 'listening' : 'listening';
  if (status === 'connecting' || status === 'executing') return 'thinking';
  return 'idle';
}

/** The state the orb shows, given every source's claim. */
export function resolveOrbState(sources) {
  let best = 'idle';
  for (const state of Object.values(sources || {})) {
    if (!state || !PRIORITY[state] && state !== 'idle') continue;
    if ((PRIORITY[state] ?? 0) > (PRIORITY[best] ?? 0)) best = state;
  }
  return best;
}

/**
 * @param {{slot?:Function, target?:EventTarget, MutationObserverCtor?:Function}} deps
 */
export function createOrb({
  slot = () => globalThis.document?.getElementById?.('ts-ai-slot') || null,
  target = globalThis,
  MutationObserverCtor = globalThis.MutationObserver,
} = {}) {
  const sources = { voice: 'idle', narrator: 'idle', session: 'idle' };
  let observer = null;
  let observed = null;
  let shown = null;

  function paint() {
    const el = slot();
    const next = resolveOrbState(sources);
    if (!el) return next;
    if (shown !== next) {
      shown = next;
      if (el.dataset) el.dataset.tsOrb = next;
      else el.setAttribute?.('data-ts-orb', next);
    }
    return next;
  }

  function readVoice(node) {
    const status = node?.dataset?.status ?? node?.getAttribute?.('data-status') ?? 'idle';
    const speaker = node?.dataset?.speaker ?? node?.getAttribute?.('data-speaker') ?? 'idle';
    const paused = Boolean(node?.dataset?.paused ?? node?.getAttribute?.('data-paused'));
    sources.voice = orbStateFromVoice({ status, speaker, paused });
    paint();
  }

  function watchVoice(node) {
    if (!node || node === observed) return false;
    observer?.disconnect?.();
    observer = null;
    observed = node;
    readVoice(node);
    if (typeof MutationObserverCtor !== 'function') return true;
    observer = new MutationObserverCtor(() => readVoice(node));
    observer.observe(node, { attributes: true, attributeFilter: ['data-status', 'data-speaker', 'data-paused'] });
    return true;
  }

  const onPlaced = (event) => watchVoice(event?.detail?.node || globalThis.document?.getElementById?.('gev-voice-control'));
  target?.addEventListener?.('terrasignal:voice-placed', onPlaced);
  const existing = globalThis.document?.getElementById?.('gev-voice-control');
  if (existing) watchVoice(existing);
  paint();

  return {
    get state() { return resolveOrbState(sources); },
    get sources() { return { ...sources }; },
    /** One source's claim. Unknown states read as idle. */
    set(source, state) {
      if (!(source in sources)) return this.state;
      sources[source] = ORB_STATES.includes(state) ? state : 'idle';
      return paint();
    },
    watchVoice,
    destroy() {
      target?.removeEventListener?.('terrasignal:voice-placed', onPlaced);
      observer?.disconnect?.();
      observer = null;
    },
  };
}
