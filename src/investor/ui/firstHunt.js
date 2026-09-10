/**
 * Investor first-run ritual — GEV mission-launcher shape, hunt copy.
 *
 * Show policy (same precedence idea as src/firstRunExperience.js):
 *   share link never sees it
 *   ?welcome=0 suppresses, ?welcome=1 replays
 *   "Don't show again" is the only durable suppress
 *   any other close is session-only
 * It does NOT auto-timeout. The globe stays up until the visitor chooses.
 */

export const HUNT_STORAGE_KEY = 'terrasignal:first-hunt:v1';
export const HUNT_SESSION_KEY = 'terrasignal:first-hunt-session:v1';

function readStore(kind, store, key) {
  try {
    const target = store || (kind === 'session'
      ? globalThis.sessionStorage
      : globalThis.localStorage);
    return target?.getItem?.(key) || null;
  } catch {
    return null;
  }
}

function writeStore(kind, store, key, value) {
  try {
    const target = store || (kind === 'session'
      ? globalThis.sessionStorage
      : globalThis.localStorage);
    target?.setItem?.(key, value);
    return true;
  } catch {
    return false;
  }
}

export function shouldShowFirstHunt({
  hasShareState = false,
  storage,
  sessionStorageRef,
  location = globalThis.location,
} = {}) {
  if (hasShareState) return false;
  let welcome = null;
  try {
    welcome = new URLSearchParams(location?.search || '').get('welcome');
  } catch {
    welcome = null;
  }
  if (welcome === '0') return false;
  if (welcome === '1') return true;
  if (readStore('local', storage, HUNT_STORAGE_KEY) === 'suppressed') return false;
  if (readStore('session', sessionStorageRef, HUNT_SESSION_KEY) === 'dismissed') return false;
  return true;
}

export function rememberHuntSessionDismissed(sessionStorageRef) {
  writeStore('session', sessionStorageRef, HUNT_SESSION_KEY, 'dismissed');
}

export function setHuntSuppressed(suppressed, storage) {
  if (!suppressed) {
    try {
      (storage || globalThis.localStorage)?.removeItem?.(HUNT_STORAGE_KEY);
      return true;
    } catch {
      return false;
    }
  }
  return writeStore('local', storage, HUNT_STORAGE_KEY, 'suppressed');
}

/**
 * Wire the hunt card. Returns { show, dismiss, begin }.
 * begin() is also how WORLD / voice "find me money" can start the market
 * if the visitor skipped the card.
 */
export function initFirstHunt({
  root,
  onBegin,
  storage,
  sessionStorageRef,
  location,
  hasShareState = false,
} = {}) {
  if (!root) return null;

  if (root._tsHunt) {
    if (onBegin) root._tsHunt.onBegin = onBegin;
    return root._tsHunt;
  }

  let currentBegin = onBegin;
  const show = shouldShowFirstHunt({ hasShareState, storage, sessionStorageRef, location });
  const dismiss = ({ persistSession = true } = {}) => {
    root.hidden = true;
    root.classList.remove('visible');
    if (persistSession) rememberHuntSessionDismissed(sessionStorageRef);
  };

  const begin = async (choice = 'atlanta') => {
    dismiss();
    await currentBegin?.(choice);
  };

  root.querySelector('[data-ts-begin-hunt]')?.addEventListener('click', () => {
    const box = root.querySelector('[data-ts-hunt-suppress]');
    if (box?.checked) setHuntSuppressed(true, storage);
    void begin('atlanta');
  });
  root.querySelector('[data-ts-hunt-explore]')?.addEventListener('click', () => {
    dismiss();
  });

  const onKey = (event) => {
    if (event.key !== 'Escape' || root.hidden) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    dismiss();
  };
  document.addEventListener('keydown', onKey, true);

  if (show) {
    root.hidden = false;
    root.classList.add('visible');
  } else {
    root.hidden = true;
  }

  const api = {
    show,
    dismiss,
    begin,
    set onBegin(fn) { currentBegin = fn; },
    destroy() {
      document.removeEventListener('keydown', onKey, true);
      delete root._tsHunt;
    },
  };
  root._tsHunt = api;
  return api;
}
