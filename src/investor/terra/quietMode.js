/**
 * Quiet mode: the assistant answers in text only.
 *
 * For the places you cannot talk — a viewing with the seller in the next
 * room, a train. The session stays up and still listens; what changes is the
 * reply: the Realtime session is switched to text output, the audio element
 * is muted as a belt-and-braces, the reply streams into the status strip,
 * and the orb shows a muted state. The choice persists per browser.
 *
 * Pure: the routing and the persistence, with storage injected.
 */

export const QUIET_STORAGE_KEY = 'terrasignal:quiet:v1';

export function readQuietPref(storage = globalThis.localStorage) {
  try {
    return storage?.getItem?.(QUIET_STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

export function writeQuietPref(enabled, storage = globalThis.localStorage) {
  try { storage?.setItem?.(QUIET_STORAGE_KEY, enabled ? '1' : '0'); } catch { /* private mode */ }
  return Boolean(enabled);
}

/** The session.update that flips the model between speaking and writing. */
export function sessionUpdateFor(quiet) {
  return {
    type: 'session.update',
    session: { type: 'realtime', output_modalities: [quiet ? 'text' : 'audio'] },
  };
}

/**
 * Where a typed or spoken message goes, and how the reply comes back.
 *
 * With the assistant available it always goes through the session — same
 * state item, same tools, same wording as speech — and quiet only decides
 * the modality of the reply. With no assistant (no key) the parser answers
 * directly and the narrator writes the line, which is the product before
 * there was a voice.
 */
export function replyRoute({ available = false, quiet = false } = {}) {
  if (!available) return { via: 'parser', modality: 'text', audio: false };
  return { via: 'assistant', modality: quiet ? 'text' : 'audio', audio: !quiet };
}

/** Server events that carry the reply as it is produced, by modality. */
export const REPLY_DELTA_EVENTS = Object.freeze({
  audio: ['response.output_audio_transcript.delta', 'response.audio_transcript.delta'],
  text: ['response.output_text.delta', 'response.text.delta'],
});

export const REPLY_DONE_EVENTS = Object.freeze({
  audio: ['response.output_audio_transcript.done', 'response.audio_transcript.done'],
  text: ['response.output_text.done', 'response.text.done'],
});

/** `{ kind: 'delta'|'done', modality }` for a reply event, or null. */
export function classifyReplyEvent(type) {
  for (const modality of ['audio', 'text']) {
    if (REPLY_DELTA_EVENTS[modality].includes(type)) return { kind: 'delta', modality };
    if (REPLY_DONE_EVENTS[modality].includes(type)) return { kind: 'done', modality };
  }
  return null;
}

/**
 * The strip shows the reply as it is produced: one line, the tail of the
 * text so the newest words are always visible.
 */
export function stripLineFor(text, { maxChars = 160 } = {}) {
  const clean = String(text || '').replace(/\s+/g, ' ').trim();
  if (clean.length <= maxChars) return clean;
  return `…${clean.slice(clean.length - maxChars + 1)}`;
}
