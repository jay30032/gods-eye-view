/**
 * Keep the Cesium globe the visual hero under investor chrome.
 * No Cesium import — safe for Node contract tests.
 */

export const INVESTOR_SCENE_BLOCKERS = Object.freeze([
  '#scope-mask',
  '#world-overlay-root',
  '#celestial-ring-overlay',
  '.celestial-ring-overlay',
]);

export function showInvestorGlobeError(message, documentRef = globalThis.document) {
  if (!documentRef?.body) return null;
  let el = documentRef.getElementById('ts-globe-error');
  if (!el) {
    el = documentRef.createElement('aside');
    el.id = 'ts-globe-error';
    el.setAttribute('role', 'alert');
    documentRef.body.appendChild(el);
  }
  const text = String(message || 'WebGL failed to initialize.');
  el.hidden = false;
  el.innerHTML = `
    <strong>The globe could not start</strong>
    <p>${text}</p>
    <p>TerraSignal needs a browser with working WebGL. Enable hardware acceleration or try another machine. Chrome overlays stay; Earth is the product.</p>
  `;
  return el;
}

export function hideInvestorGlobeError(documentRef = globalThis.document) {
  const el = documentRef?.getElementById?.('ts-globe-error');
  if (el) el.hidden = true;
}

/**
 * CSS contract: investor chrome must not paint an opaque full-bleed plate
 * over #cesiumContainer.
 */
export function investorGlobeCssContract(cssText) {
  const css = String(cssText || '');
  const shellRule = css.match(/#terrasignal-shell\s*\{([^}]+)\}/);
  const vignetteRule = css.match(/#ts-vignette\s*\{([^}]+)\}/);
  const loadingRule = css.match(/html\.terrasignal-investor #loading-screen\s*\{([^}]+)\}/);
  const shellBody = shellRule?.[1] || '';
  const vignetteBody = vignetteRule?.[1] || '';
  const loadingBody = loadingRule?.[1] || '';

  const opaqueBackground = /background\s*:\s*(?!none|transparent)[^;]*(#|rgb|hsl|var\(--bg)/i;
  return {
    shellHasNoOpaqueFill: !opaqueBackground.test(shellBody),
    vignetteIsInsetShadowNotFill: /box-shadow\s*:/.test(vignetteBody) && !opaqueBackground.test(vignetteBody),
    loadingScreenTransparent: /background\s*:\s*transparent/.test(loadingBody),
    hidesScopeMask: /html\.terrasignal-investor #scope-mask/.test(css),
    hidesWorldOverlay: /html\.terrasignal-investor #world-overlay-root/.test(css),
  };
}

export function cesiumCanvasIsLive(container) {
  const canvas = container?.querySelector?.('canvas');
  if (!canvas) return false;
  const width = Number(canvas.width || canvas.clientWidth || 0);
  const height = Number(canvas.height || canvas.clientHeight || 0);
  return width > 8 && height > 8;
}
