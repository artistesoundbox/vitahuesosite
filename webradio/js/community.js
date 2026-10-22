/* Listener count — how many devices are on the station right now.
 *
 * Transport: Supabase Realtime presence. Each open page joins one presence
 * channel under a random per-browser id, and Supabase tells every member who
 * else is present and when they leave (including a tab that is closed without
 * warning), so the number moves within seconds instead of minutes.
 *
 * The anon/publishable key used here is meant to live in the browser: it can
 * only join a public presence channel, it cannot read or write any table. If
 * the project is not configured yet, or the SDK cannot be loaded, the count
 * falls back to this device alone rather than showing a made-up number.
 */
import { COMMUNITY } from './config.js';

const STORE = { client: 'vh.client' };
const COUNT_IDS = ['presence-count', 'radio-presence', 'room-count'];
const SDK_URL = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';

function read(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch { return fallback; }
}

function write(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* ignore */ }
}

function makeId() {
  if (window.crypto?.randomUUID) return crypto.randomUUID().slice(0, 12);
  return Math.random().toString(36).slice(2, 12);
}

export function createCommunity() {
  const clientId = (() => {
    let id = read(STORE.client, '');
    if (!id) { id = makeId(); write(STORE.client, id); }
    return id;
  })();

  const realtime = COMMUNITY.realtime || {};
  let channel = null;
  let client = null;
  let staged = false;

  function paint(n) {
    const total = Math.max(1, Number(n) || 0);
    for (const id of COUNT_IDS) {
      const el = document.getElementById(id);
      if (el) el.textContent = String(total);
    }
    const chip = document.getElementById('listeners-chip');
    if (chip) {
      chip.classList.toggle('is-live', total > 1);
      chip.title = total === 1
        ? 'You are the only one listening right now'
        : `${total} devices listening right now`;
    }
  }

  /* Presence state: one entry per tracked key (our id), each holding the metas
     of every open connection using it. Counting keys counts devices, not tabs. */
  function sync() {
    if (!channel) return;
    try {
      const state = channel.presenceState() || {};
      paint(Object.keys(state).length);
    } catch { /* channel not ready */ }
  }

  async function connect() {
    if (!realtime.url || !realtime.anonKey) {
      // Not configured yet — be honest instead of inventing a number.
      paint(1);
      return;
    }
    try {
      const sdk = await import(/* @vite-ignore */ SDK_URL);
      client = sdk.createClient(realtime.url, realtime.anonKey, {
        auth: { persistSession: false, autoRefreshToken: false }
      });
      channel = client.channel(realtime.channel || 'vh-radio-listeners', {
        config: { presence: { key: clientId } }
      });
      channel.on('presence', { event: 'sync' }, sync);
      channel.on('presence', { event: 'join' }, sync);
      channel.on('presence', { event: 'leave' }, sync);
      channel.subscribe((status) => {
        if (status !== 'SUBSCRIBED' || staged) return;
        staged = true;
        channel.track({ at: Date.now() }).then(sync).catch(() => {});
      });
    } catch {
      // Offline, blocked CDN or a bad key: still show this listener.
      paint(1);
    }
  }

  function start() {
    paint(1);
    connect();

    /* A phone that comes back from the lock screen can lose the socket without
       the SDK noticing immediately; nudge it when the page is visible again. */
    document.addEventListener('visibilitychange', () => {
      if (document.hidden || !channel || !staged) return;
      channel.track({ at: Date.now() }).then(sync).catch(() => {});
    });

    window.addEventListener('online', () => {
      if (!channel || !staged) connect();
    });
  }

  return { start };
}
