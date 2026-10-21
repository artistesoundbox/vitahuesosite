/* Songs this device never wants to hear again.
 *
 * The dislike button writes here. The list lives in localStorage (per browser,
 * per device) and the station re-derives its reel without those tracks, so a
 * blocked song disappears from the live clock and from every personal skip.
 *
 * Deliberately local: the broadcast is a shared timeline, and one listener
 * hiding a song must not change what everyone else hears. The list is also the
 * admin's auditioning ledger — block the duds while listening, then hand the
 * list over when it is time to prune the catalogue for real.
 *
 * Safe to import from Node (tools/, the rotation checker): nothing touches
 * `window` until a function is actually called.
 */

const KEY = 'vh.blocked';
const listeners = new Set();
let cache = null;

function store() {
  try { return typeof window !== 'undefined' ? window.localStorage : null; } catch { return null; }
}

export function blockedIds() {
  if (cache) return cache;
  cache = new Set();
  try {
    const raw = store()?.getItem(KEY);
    const list = raw ? JSON.parse(raw) : [];
    if (Array.isArray(list)) list.forEach((id) => { if (typeof id === 'string' && id) cache.add(id); });
  } catch { /* private mode: keep it in memory for this page */ }
  return cache;
}

export function isBlocked(id) {
  return !!id && blockedIds().has(id);
}

export function setBlocked(id, on) {
  if (!id) return false;
  const ids = blockedIds();
  if (on) ids.add(id);
  else ids.delete(id);
  try { store()?.setItem(KEY, JSON.stringify([...ids])); } catch { /* ignore */ }
  listeners.forEach((fn) => { try { fn(id, on); } catch { /* ignore */ } });
  return on;
}

export function toggleBlocked(id) {
  return setBlocked(id, !isBlocked(id));
}

export function clearBlocked() {
  cache = new Set();
  try { store()?.removeItem(KEY); } catch { /* ignore */ }
  listeners.forEach((fn) => { try { fn(null, false); } catch { /* ignore */ } });
}

/** Subscribe to changes. Returns an unsubscribe function. */
export function onBlockChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
