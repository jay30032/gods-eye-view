import { readSavedProperties } from '../saved.js';

export function renderSavedSheet({ open = true, resolveProperty } = {}) {
  const root = document.getElementById('ts-saved-sheet');
  if (!root) return;
  const rows = readSavedProperties();
  root.hidden = !open;
  if (!open) return;
  if (!rows.length) {
    root.innerHTML = `
      <header><strong>Saved</strong><button type="button" data-ts-saved-close>Close</button></header>
      <p class="ts-empty">Nothing saved yet. Focus a pick and say save it.</p>
    `;
    return;
  }
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

export function hideSavedSheet() {
  const root = document.getElementById('ts-saved-sheet');
  if (root) root.hidden = true;
}
