import { SAVED_STORAGE_KEY } from './config.js';

function storage(store) {
  if (store) return store;
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

function nowIso() {
  return new Date().toISOString();
}

export function readSavedProperties(store) {
  try {
    const raw = storage(store)?.getItem(SAVED_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((row) => row && typeof row === 'object' && row.id)
      .map((row) => ({
        id: String(row.id),
        address: String(row.address || ''),
        savedAt: String(row.savedAt || nowIso()),
        note: String(row.note || ''),
        strategy: row.strategy ? String(row.strategy) : null,
      }));
  } catch {
    return [];
  }
}

export function writeSavedProperties(rows, store) {
  const next = Array.isArray(rows) ? rows : [];
  try {
    storage(store)?.setItem(SAVED_STORAGE_KEY, JSON.stringify(next));
  } catch {
    // private mode
  }
  return next;
}

export function isPropertySaved(id, store) {
  const key = String(id || '');
  return readSavedProperties(store).some((row) => row.id === key);
}

export function saveProperty(property, { note = '', strategy = null } = {}, store) {
  if (!property?.id) return { ok: false, error: 'No property to save' };
  const rows = readSavedProperties(store);
  const existing = rows.find((row) => row.id === property.id);
  if (existing) {
    existing.note = note || existing.note;
    existing.strategy = strategy || existing.strategy;
    existing.savedAt = nowIso();
    writeSavedProperties(rows, store);
    return { ok: true, action: 'save_property', id: property.id, alreadySaved: true, saved: rows };
  }
  rows.unshift({
    id: property.id,
    address: property.address,
    savedAt: nowIso(),
    note,
    strategy,
  });
  writeSavedProperties(rows, store);
  return { ok: true, action: 'save_property', id: property.id, alreadySaved: false, saved: rows };
}

export function removeSavedProperty(id, store) {
  const key = String(id || '');
  const rows = readSavedProperties(store).filter((row) => row.id !== key);
  writeSavedProperties(rows, store);
  return rows;
}
