/**
 * Trade tile detail for frame rate while the drive camera is moving.
 *
 * A stationary camera and a moving one ask Google's tileset completely
 * different questions. Standing still, the view is fixed and the tileset
 * converges: it streams what is in frame once and then has nothing to do.
 * Driving, the frustum sweeps a new block every few seconds at 9 m/s — and four
 * times that in the headed check — so the set of tiles that satisfy the screen
 * space error is changing continuously and the streamer never converges at all.
 *
 * Measured on the six-house route, with `targetFrameRate` lifted so the number
 * is the work and not the cap: **stationary p95 33.9 ms, driving p95 66.7 ms**.
 * 66.7 is exactly two vsync intervals — it is not a slow frame, it is a *missed*
 * one, and it is missed while the camera is moving, which is when a dropped
 * frame is most visible.
 *
 * So while the camera moves, `maximumScreenSpaceError` goes up: fewer, coarser
 * tiles, less streaming, frames land. 500 ms after motion stops it goes back,
 * and the detail returns for the thing the user has actually stopped to look
 * at. That is the right way round — detail at rest is what matters, because
 * resting is when you are looking.
 *
 * ## Why it restores on silence rather than on an event
 *
 * There is no "the camera stopped" event to subscribe to. Pausing, entering
 * Property Mode and ending the drive all stop the fixes, and each would need
 * its own hook. Instead `touch()` is called on every fix and re-arms a 500 ms
 * timer: motion keeps the budget raised simply by continuing, and *any* reason
 * the fixes stop restores it. One rule covers every case, including ones not
 * thought of yet.
 */

/** Screen space error while the camera is moving. Higher is coarser. */
export const MOTION_SSE = 24;
/** How long after the last movement the detail comes back. */
export const RESTORE_DELAY_MS = 500;

/**
 * @param {{getTileset:Function, timers?:object}} deps `getTileset` is a function
 *   so the drive does not have to hold a reference to a tileset that may not
 *   exist yet — the keyless path has none at all.
 */
export function createMotionTileBudget({ getTileset, timers = globalThis } = {}) {
  /** The value to go back to. Captured once, on the first raise. */
  let baseline = null;
  let raised = false;
  let restoreTimer = null;

  function tileset() {
    try {
      const value = typeof getTileset === 'function' ? getTileset() : null;
      return value && Number.isFinite(value.maximumScreenSpaceError) ? value : null;
    } catch {
      return null;
    }
  }

  function clearTimer() {
    if (restoreTimer === null) return;
    try { timers.clearTimeout?.(restoreTimer); } catch { /* already gone */ }
    restoreTimer = null;
  }

  function raise() {
    const target = tileset();
    if (!target || raised) return false;
    // Capture the baseline on the FIRST raise, not at construction: the
    // tileset may not exist when the drive is built, and whatever it is set to
    // at the moment the drive starts is what "at rest" means for this session.
    if (baseline === null) baseline = target.maximumScreenSpaceError;
    // Never make it FINER. If something has already set a coarser budget — a
    // slow machine, a future quality setting — motion is not the moment to
    // start asking for more detail than it wanted.
    const next = Math.max(baseline, MOTION_SSE);
    if (next === target.maximumScreenSpaceError) {
      raised = true;
      return false;
    }
    target.maximumScreenSpaceError = next;
    raised = true;
    return true;
  }

  function restore() {
    clearTimer();
    const target = tileset();
    if (!raised) return false;
    raised = false;
    if (!target || baseline === null) return false;
    target.maximumScreenSpaceError = baseline;
    return true;
  }

  return {
    get raised() { return raised; },
    get baseline() { return baseline; },
    get motionSse() { return MOTION_SSE; },

    /**
     * The camera moved. Raises the budget if it is not already raised, and
     * pushes the restore back by another {@link RESTORE_DELAY_MS}.
     */
    touch() {
      raise();
      clearTimer();
      restoreTimer = timers.setTimeout?.(() => {
        restoreTimer = null;
        restore();
      }, RESTORE_DELAY_MS) ?? null;
      return raised;
    },

    /** The drive ended. Put the detail back now rather than in half a second. */
    release() {
      return restore();
    },

    destroy() {
      clearTimer();
      restore();
      baseline = null;
    },
  };
}
