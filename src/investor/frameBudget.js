/**
 * Investor demo frame budget — keep a laptop GPU (Air / battery) usable.
 * Classic GEV keeps its own 60 fps cap in main.js.
 */

export const INVESTOR_DEMO_FPS = 30;
export const INVESTOR_PLUGGED_FPS = 60;

/**
 * @param {{ saveData?: boolean, charging?: boolean|null, reducedMotion?: boolean }} [hints]
 * @returns {number}
 */
export function resolveInvestorTargetFrameRate({
  saveData = false,
  charging = null,
  reducedMotion = false,
} = {}) {
  if (reducedMotion || saveData) return INVESTOR_DEMO_FPS;
  if (charging === false) return INVESTOR_DEMO_FPS;
  if (charging === true) return INVESTOR_PLUGGED_FPS;
  // Unknown power state: assume a laptop / Air, not a plugged workstation.
  return INVESTOR_DEMO_FPS;
}

export function applyInvestorFrameBudget(viewer, hints = {}) {
  const fps = resolveInvestorTargetFrameRate(hints);
  if (viewer) viewer.targetFrameRate = fps;
  return fps;
}

export async function applyInvestorFrameBudgetFromNavigator(
  viewer,
  navigatorRef = globalThis.navigator,
  matchMedia = globalThis.matchMedia,
) {
  const saveData = Boolean(navigatorRef?.connection?.saveData);
  let reducedMotion = false;
  try {
    reducedMotion = Boolean(matchMedia?.('(prefers-reduced-motion: reduce)')?.matches);
  } catch {
    reducedMotion = false;
  }
  let charging = null;
  try {
    const battery = await navigatorRef?.getBattery?.();
    if (battery && typeof battery.charging === 'boolean') charging = battery.charging;
  } catch {
    charging = null;
  }
  return applyInvestorFrameBudget(viewer, { saveData, charging, reducedMotion });
}
