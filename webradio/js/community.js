/* Listener count — how many devices are on the station right now.
 *
 * Transport: a free public ntfy.sh topic (no account, no key). Each open page
 * announces itself on a slow heartbeat and reads everybody else's, so the
 * number is devices that checked in recently rather than page views.
 *
 * Quota note: ntfy's free tier allows ~250 messages per visitor per day, so the
 * heartbeat is minutes apart, not seconds. A single listener at one message a
 * minute would exhaust the day in four hours. Tabs on the same device share a
 * client id and therefore count once.
 */
import { COMMUNITY } from './config.js';

const STORE = { client: 'vh.client' };
const COUNT_IDS = ['presence-count', 'radio-presence', 'room-count'];

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

  const state = {
    peers: new Map(),
    seen: new Set(),
    localMode: COMMUNITY.mode === 'local',
    started: false
  };

  let channel = null;
  let source = null;
  let presenceTimer = null;

  function paint() {
    for (const [id, at] of state.peers) {
      if (Date.now() - at > COMMUNITY.presenceTtlMs) state.peers.delete(id);
    }
    state.peers.set(clientId, Date.now());
    const n = state.peers.size;
    for (const id of COUNT_IDS) {
      const el = document.getElementById(id);
      if (el) el.textContent = String(n);
    }
    const chip = document.getElementById('listeners-chip');
    if (chip) {
      chip.classList.toggle('is-live', state.peers.size > 1);
      chip.title = n === 1 ? 'You are the only one listening right now' : `${n} devices listening right now`;
    }
  }

  function publish(envelope) {
    if (state.localMode || !navigator.onLine) return;
    const url = `${COMMUNITY.relayBase}/${encodeURIComponent(COMMUNITY.topic)}`;
    fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: JSON.stringify(envelope),
      keepalive: true
    }).then((response) => {
      /* Out of quota for the day: stop spending it and let the count fall back
         to this device instead of pretending people are here. */
      if (response.status === 429) state.localMode = true;
    }).catch(() => { state.localMode = true; });
  }

  function handle(env) {
    if (!env || typeof env !== 'object' || !env.id) return;
    if (state.seen.has(env.id)) return;
    state.seen.add(env.id);
    if (state.seen.size > 600) state.seen = new Set([...state.seen].slice(-300));

    const now = Date.now();
    if (env.type === 'presence' && env.client) {
      const stamp = Math.min(Number(env.at) || now, now);
      if (now - stamp < COMMUNITY.presenceTtlMs && env.client !== clientId) {
        state.peers.set(env.client, stamp);
      }
    }
    if (env.type === 'gone' && env.client) state.peers.delete(env.client);
    paint();
  }

  function announce() {
    const env = { id: makeId(), type: 'presence', client: clientId, at: Date.now() };
    try { channel?.postMessage(env); } catch { /* ignore */ }
    publish(env);
    paint();
  }

  function openRelay() {
    if (state.localMode || !('EventSource' in window)) return;
    try {
      // No `since=` replay: only live checks-ins count, so somebody who left
      // before this page opened is never shown as "listening".
      source = new EventSource(`${COMMUNITY.relayBase}/${encodeURIComponent(COMMUNITY.topic)}/sse`);
      source.onmessage = (event) => {
        let payload;
        try { payload = JSON.parse(event.data); } catch { return; }
        if (!payload || payload.event !== 'message' || !payload.message) return;
        try { handle(JSON.parse(payload.message)); } catch { /* not ours */ }
      };
      source.onerror = () => { /* the browser reconnects by itself */ };
    } catch { state.localMode = true; }
  }

  function start() {
    if (state.started) return;
    state.started = true;

    if ('BroadcastChannel' in window) {
      try {
        channel = new BroadcastChannel('vh-radio-presence');
        channel.onmessage = (event) => handle(event.data);
      } catch { channel = null; }
    }

    openRelay();
    // Stagger the first check-in so a crowd does not announce in lockstep.
    setTimeout(announce, 600 + Math.random() * 2400);
    presenceTimer = setInterval(announce, COMMUNITY.presenceEveryMs);

    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) {
        announce();
        if (!state.localMode && source && source.readyState === EventSource.CLOSED) openRelay();
      }
    });

    window.addEventListener('online', () => {
      if (state.localMode) {
        state.localMode = false;
        openRelay();
        announce();
      }
    });

    window.addEventListener('pagehide', () => {
      const gone = { id: makeId(), type: 'gone', client: clientId, at: Date.now() };
      try { channel?.postMessage(gone); } catch { /* ignore */ }
      publish(gone);
      clearInterval(presenceTimer);
      source?.close();
    });

    paint();
  }

  return { start };
}
