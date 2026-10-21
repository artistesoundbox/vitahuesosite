/* Listener room — chat (text and emoji) plus presence.
 *
 * Transport: a free public ntfy.sh topic (no account, no key). If it is
 * unreachable, everything degrades to this device: tabs still talk to each
 * other over BroadcastChannel, messages persist locally, and the UI says
 * "Local only" instead of pretending.
 *
 * No user text is ever written as HTML — messages are built as text nodes.
 */
import { COMMUNITY } from './config.js';

const STORE = {
  client: 'vh.client',
  name: 'vh.name',
  chat: 'vh.chat'
};

const MAX_CHAT = 60;

/* Emoji-only messages are the room's "cartoons": they render big instead of
   looking like a tiny word in a paragraph. */
const EMOJI_ONLY = /^[\p{Extended_Pictographic}\p{Emoji_Component}\uFE0F\u200D\s]{1,12}$/u;
const isEmojiOnly = (text) => EMOJI_ONLY.test(text) && /\p{Extended_Pictographic}/u.test(text);

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

const escapeText = (s) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, COMMUNITY.maxLength);

export function createCommunity({ toast }) {
  const $ = (id) => document.getElementById(id);
  const els = {
    panel: $('community'),
    scrim: $('panel-scrim'),
    close: $('community-close'),
    chatLog: $('chat-log'),
    chatForm: $('chat-form'),
    chatInput: $('chat-input'),
    chatName: $('chat-name'),
    chatCount: $('chat-count'),
    chatHint: $('chat-hint'),
    relayBadge: $('relay-badge'),
    counts: [$('presence-count'), $('radio-presence'), $('room-count'), $('community-count')],
    roomMode: $('room-mode'),
    chatPane: $('chat-pane')
  };

  const clientId = (() => {
    let id = read(STORE.client, '');
    if (!id) { id = makeId(); write(STORE.client, id); }
    return id;
  })();

  const state = {
    peers: new Map(),
    messages: read(STORE.chat, []),
    seen: new Set(),
    localMode: COMMUNITY.mode === 'local',
    relay: 'connecting',
    started: false,
    panelOpen: false
  };

  let channel = null;
  let source = null;
  let presenceTimer = null;

  /* ------------------------------------------------------------ transport */

  function setRelay(status, note) {
    state.relay = status;
    if (!els.relayBadge) return;
    els.relayBadge.classList.remove('is-live', 'is-local');
    if (status === 'live') {
      els.relayBadge.textContent = 'Live relay';
      els.relayBadge.classList.add('is-live');
      els.relayBadge.title = 'Connected to the public listener relay';
    } else if (status === 'local') {
      els.relayBadge.textContent = 'Local only';
      els.relayBadge.classList.add('is-local');
      els.relayBadge.title = note || 'Relay unavailable — messages stay on this device';
    } else {
      els.relayBadge.textContent = 'Connecting…';
    }
    if (els.roomMode) els.roomMode.textContent = status === 'live' ? 'Live room' : 'This device';
    if (status === 'local' && els.chatHint && note) els.chatHint.textContent = note;
  }

  function publish(envelope) {
    if (state.localMode || !navigator.onLine) return;
    const url = `${COMMUNITY.relayBase}/${encodeURIComponent(COMMUNITY.topic)}`;
    fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: JSON.stringify(envelope),
      keepalive: true
    }).catch(() => {
      state.localMode = true;
      setRelay('local', 'Relay unreachable — messages now stay on this device.');
    });
  }

  function openRelay() {
    if (state.localMode) {
      setRelay('local', COMMUNITY.mode === 'local'
        ? 'Local preview — messages stay on this device. Set mode to "auto" in js/config.js for the public relay.'
        : 'Relay unreachable — messages stay on this device.');
      return;
    }
    if (!('EventSource' in window)) {
      state.localMode = true;
      setRelay('local', 'This browser cannot subscribe to the relay. Messages stay on this device.');
      return;
    }
    try {
      const url = `${COMMUNITY.relayBase}/${encodeURIComponent(COMMUNITY.topic)}/sse?since=2m`;
      source = new EventSource(url);
      source.onopen = () => setRelay('live');
      source.onerror = () => {
        if (state.relay === 'live') setRelay('connecting');
      };
      source.onmessage = (event) => {
        let payload;
        try { payload = JSON.parse(event.data); } catch { return; }
        if (!payload || payload.event !== 'message' || !payload.message) return;
        try { handleEnvelope(JSON.parse(payload.message)); } catch { /* not ours */ }
      };
    } catch {
      state.localMode = true;
      setRelay('local', 'Relay unavailable — messages stay on this device.');
    }
  }

  function handleEnvelope(env, fromChannel = false) {
    if (!env || typeof env !== 'object' || !env.id) return;
    if (state.seen.has(env.id)) return;
    state.seen.add(env.id);
    if (state.seen.size > 600) state.seen = new Set([...state.seen].slice(-300));

    const now = Date.now();
    if (env.type === 'presence' && env.client) state.peers.set(env.client, now);
    if (env.type === 'gone' && env.client) state.peers.delete(env.client);

    if (env.type === 'chat') {
      const msg = {
        id: env.id,
        client: env.client,
        name: escapeText(env.name) || 'Listener',
        text: escapeText(env.text),
        at: Number(env.at) || now
      };
      if (!msg.text) return;
      // The relay replays the last couple of minutes on connect; the log is
      // persisted, so ignore anything already on screen.
      if (state.messages.some((m) => m.id === msg.id)) return;
      state.messages = [...state.messages, msg].slice(-MAX_CHAT);
      write(STORE.chat, state.messages);
      appendMessage(msg);
    }

    updateCounts();
  }

  function broadcast(env) {
    if (!channel) return;
    try { channel.postMessage(env); } catch { /* ignore */ }
  }

  /* --------------------------------------------------------------- counts */

  function alivePeers() {
    const cutoff = Date.now() - COMMUNITY.presenceTtlMs;
    for (const [id, at] of state.peers) {
      if (at < cutoff) state.peers.delete(id);
    }
    state.peers.set(clientId, Date.now());
    return state.peers.size;
  }

  function updateCounts() {
    const n = alivePeers();
    els.counts.forEach((el) => { if (el) el.textContent = String(n); });
  }

  function announcePresence() {
    const env = {
      id: makeId(),
      type: 'presence',
      client: clientId,
      name: currentName(),
      at: Date.now()
    };
    // Presence is private-ish housekeeping: local tabs always get it, the
    // relay gets it only while connected.
    broadcast(env);
    publish(env);
    updateCounts();
  }

  /* ----------------------------------------------------------------- chat */

  function currentName() {
    const typed = els.chatName?.value.trim();
    if (typed) {
      write(STORE.name, typed);
      return escapeText(typed).slice(0, 24);
    }
    return read(STORE.name, '') || `Guest ${clientId.slice(-3)}`;
  }

  function appendMessage(msg) {
    if (!els.chatLog) return;
    els.chatLog.querySelector('.is-placeholder')?.remove();
    const li = document.createElement('li');
    li.className = 'chat-msg' + (msg.client === clientId ? ' is-me' : '') + (msg.system ? ' is-system' : '');
    li.dataset.id = msg.id;

    if (!msg.system) {
      const avatar = document.createElement('span');
      avatar.className = 'chat-avatar';
      avatar.textContent = (msg.name || '?').slice(0, 1).toUpperCase();
      li.appendChild(avatar);
    }

    const body = document.createElement('div');
    body.className = 'chat-body';

    if (!msg.system) {
      const who = document.createElement('div');
      who.className = 'chat-who';
      const strong = document.createElement('b');
      strong.textContent = msg.name;
      const time = document.createElement('time');
      time.dateTime = new Date(msg.at).toISOString();
      time.textContent = new Date(msg.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      who.append(strong, time);
      body.appendChild(who);
    }

    const text = document.createElement('p');
    text.className = 'chat-text' + (!msg.system && isEmojiOnly(msg.text) ? ' is-emoji' : '');
    text.textContent = msg.text;
    body.appendChild(text);
    li.appendChild(body);

    els.chatLog.appendChild(li);
    while (els.chatLog.children.length > MAX_CHAT) els.chatLog.firstElementChild.remove();
    els.chatLog.scrollTop = els.chatLog.scrollHeight;
  }

  function renderChat() {
    if (!els.chatLog) return;
    els.chatLog.textContent = '';
    if (!state.messages.length) {
      const li = document.createElement('li');
      li.className = 'chat-msg is-system is-placeholder';
      const p = document.createElement('p');
      p.className = 'chat-text';
      p.textContent = 'The room is quiet. Be the first voice on the signal.';
      li.appendChild(p);
      els.chatLog.appendChild(li);
      return;
    }
    state.messages.slice(-MAX_CHAT).forEach(appendMessage);
  }

  function sendChat(text) {
    const clean = escapeText(text);
    if (!clean) return;
    const env = {
      id: makeId(),
      type: 'chat',
      client: clientId,
      name: currentName(),
      text: clean,
      at: Date.now()
    };
    handleEnvelope(env);
    broadcast(env);
    publish(env);
    if (els.chatInput) {
      els.chatInput.value = '';
      if (els.chatCount) els.chatCount.textContent = '0';
    }
  }

  /* ----------------------------------------------------------------- panel */

  function openPanel() {
    if (!els.panel) return;
    els.panel.hidden = false;
    els.scrim.hidden = false;
    state.panelOpen = true;
    document.body.style.overflow = 'hidden';
    renderChat();
    els.chatInput?.focus({ preventScroll: true });
  }

  function closePanel() {
    if (!els.panel) return;
    els.panel.hidden = true;
    els.scrim.hidden = true;
    state.panelOpen = false;
    document.body.style.overflow = '';
    document.getElementById('btn-listeners')?.focus({ preventScroll: true });
  }

  /* ----------------------------------------------------------------- init */

  function init() {
    if (state.started) return;
    state.started = true;

    if ('BroadcastChannel' in window) {
      try {
        channel = new BroadcastChannel('vh-radio-room');
        channel.onmessage = (event) => handleEnvelope(event.data, true);
      } catch { channel = null; }
    }

    if (els.chatName) {
      els.chatName.value = read(STORE.name, '');
      els.chatName.addEventListener('change', () => write(STORE.name, currentName()));
    }

    els.chatInput?.addEventListener('input', () => {
      if (els.chatCount) els.chatCount.textContent = String(els.chatInput.value.length);
    });

    els.chatForm?.addEventListener('submit', (event) => {
      event.preventDefault();
      sendChat(els.chatInput.value);
      els.chatInput.focus();
    });

    els.close?.addEventListener('click', closePanel);
    els.scrim?.addEventListener('click', closePanel);

    ['btn-listeners', 'radio-chat', 'radio-chat-2'].forEach((id) => {
      document.getElementById(id)?.addEventListener('click', () => openPanel());
    });

    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && state.panelOpen) closePanel();
    });

    renderChat();
    updateCounts();
    openRelay();

    // stagger the first presence ping so a crowd does not announce in lockstep
    setTimeout(() => announcePresence(), 400 + Math.random() * 2200);
    presenceTimer = setInterval(announcePresence, 25000);

    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) {
        announcePresence();
        if (state.relay !== 'live' && !state.localMode && source && source.readyState === EventSource.CLOSED) openRelay();
      }
    });

    window.addEventListener('online', () => {
      if (state.localMode) {
        state.localMode = false;
        setRelay('connecting');
        openRelay();
      }
    });

    window.addEventListener('pagehide', () => {
      broadcast({ id: makeId(), type: 'gone', client: clientId, at: Date.now() });
      clearInterval(presenceTimer);
      source?.close();
    });
  }

  return { init, openPanel, closePanel, currentName };
}
