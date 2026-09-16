import { readSavedProperties } from '../saved.js';
import { prefersReducedMotion } from '../visuals/reducedMotionPolicy.js';
import { springIn, springOut } from './motion.js';

let leaving = null;

export function renderSavedSheet({ open = true, resolveProperty } = {}) {
  const root = document.getElementById('ts-saved-sheet');
  if (!root) return;
  if (!open) { hideSavedSheet(); return; }
  if (leaving) { leaving.cancelled = true; leaving = null; }
  const rows = readSavedProperties();
  const fresh = root.hidden;
  root.hidden = false;
  if (!rows.length) {
    root.innerHTML = `
      <header><strong>Saved</strong><button type="button" data-ts-saved-close>Close</button></header>
      <p class="ts-empty">Nothing saved yet. Focus a pick and say save it.</p>
    `;
  } else {
    root.innerHTML = `
      <header><strong>Saved</strong><button type="button" data-ts-saved-close>Close</button></header>
      <ul>
        ${rows.map((row) => {
          const property = resolveProperty?.(row.id);
          return `
            <li>
              <button type="button" data-ts-saved-id="${row.id}">
                <strong>${row.address}</strong>
                <span>${property ? property.neighborhood : 'MOCK'} · ${row.strategy || 'saved'}</span>
              </button>
            </li>
          `;
        }).join('')}
      </ul>
    `;
  }
  // The sheet lives lower right; it rises from the bottom edge on a spring.
  if (fresh) springIn(root, { dx: 0, dy: 24, reduced: prefersReducedMotion() });
}

export function hideSavedSheet() {
  const root = document.getElementById('ts-saved-sheet');
  if (!root || root.hidden || leaving) return;
  const token = { cancelled: false };
  leaving = token;
  const finish = () => {
    if (token.cancelled) return;
    leaving = null;
    root.hidden = true;
    try { for (const animation of root.getAnimations?.() || []) animation.cancel(); } catch { /* fine */ }
  };
  if (prefersReducedMotion()) { finish(); return; }
  springOut(root, { dx: 0, dy: 24 }).then(finish);
}
