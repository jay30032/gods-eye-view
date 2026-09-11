/**
 * One radius per entity per frame, for both ellipse axes.
 *
 * Cesium reads `semiMajorAxis` and `semiMinorAxis` as two *separate* property
 * reads within the same frame. The investor rings computed each axis in its own
 * CallbackProperty from `Date.now()`, so the millisecond could tick between the
 * two reads — and on the rising half of a breathe cycle that returns a LARGER
 * minor than major. Cesium then throws
 *
 *   DeveloperError: semiMajorAxis must be greater than or equal to the semiMinorAxis
 *
 * which stops the render loop and leaves a dead globe behind an error dialog.
 * Measured on the shipped code: roughly one inversion per 4,000 read pairs per
 * entity — rare per read, inevitable over a few minutes of a 30-entity board.
 *
 * Two defences, because the animation clock and the frame clock are different
 * things and only one of them is under our control:
 *
 *   1. the value is memoised on the `JulianDate` Cesium passes in, so every
 *      read inside one frame returns the identical number;
 *   2. the minor axis is clamped to the major that was handed out, so even if a
 *      caller supplies no usable frame stamp the pair can never invert.
 *
 * Never key this on `Date.now()`. That is the bug.
 */

/** Cesium also rejects a non-positive axis, so the floor is a real constraint. */
export const MIN_AXIS_M = 0.5;

function positive(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > MIN_AXIS_M ? n : MIN_AXIS_M;
}

/**
 * A fixed circle. The value is computed once and shared, so the two axes cannot
 * drift apart if someone later edits one of them.
 *
 * @param {number} value radius in metres
 */
export function staticAxes(value) {
  const radius = positive(value);
  return { semiMajorAxis: radius, semiMinorAxis: radius };
}

/**
 * @param {object} Cesium the Cesium namespace (CallbackProperty)
 * @param {() => number} compute radius in metres; called at most once per frame
 * @returns {{semiMajorAxis: object, semiMinorAxis: object, _frameValue: Function}}
 */
export function ellipseAxes(Cesium, compute) {
  let day = NaN;
  let secs = NaN;
  let cached = null;
  let lastMajor = null;

  function frameValue(time) {
    const d = Number(time?.dayNumber);
    const s = Number(time?.secondsOfDay);
    const stamped = Number.isFinite(d) && Number.isFinite(s);
    if (!stamped || cached === null || d !== day || s !== secs) {
      day = stamped ? d : NaN;
      secs = stamped ? s : NaN;
      cached = positive(compute());
    }
    return cached;
  }

  return {
    semiMajorAxis: new Cesium.CallbackProperty((time) => {
      lastMajor = frameValue(time);
      return lastMajor;
    }, false),
    semiMinorAxis: new Cesium.CallbackProperty((time) => {
      const value = frameValue(time);
      // Belt and braces: whatever happened above, never exceed the major axis.
      return lastMajor === null ? value : Math.min(value, lastMajor);
    }, false),
    // Exposed for tests that need to drive the memo directly.
    _frameValue: frameValue,
  };
}
