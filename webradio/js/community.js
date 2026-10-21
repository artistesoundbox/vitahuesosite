/* Listener room — chat, presence and song requests.
 *
 * Transport: a free public ntfy.sh topic (no account, no key). If it is
 * unreachable, everything degrades to this device: tabs still talk to each
 * other over BroadcastChannel, messages persist locally, and the UI says
 * "Local only" instead of pretending.
 *
 * No user text is ever written as HTML — messages are built as text nodes.
 */
import { COMMUNITY } from './config.js';
import { TRACKS } from './catalog.js';

const STORE = {
  client: 'vh.client',
  name: 'vh.name',
  chat: 'vh.chat',
  requests: 'vh.requests'
};

const MAX_CHAT = 60;
const MAX_REQUESTS = 25;

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
    tabChat: $('tab-chat'),
    tabRequests: $('tab-requests'),
    chatPane: $('chat-pane'),
    requestPane: $('request-pane'),
    roomRequestForm: $('room-request-form'),
    roomRequestTrack: $('room-request-track'),
    roomRequestNote: $('room-request-note'),
    roomRequestList: $('room-request-list'),
    contactRequestList: $('request-list'),
    trackOptions: [$('track-options'), $('track-options-2')]
  };

  const clientId = (() => {
    let id = read(STORE.client, '');
    if (!id) { id = makeId(); write(STORE.client, id); }
    return id;
  })();

  const state = {
    peers: new Map(),
    messages: read(STORE.chat, []),
    requests: read(STORE.requests, []),
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
    if (env.client) state.peers.set(env.client, now);
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
      state.messages = [...state.messages, msg].slice(-MAX_CHAT);
      write(STORE.chat, state.messages);
      appendMessage(msg);
      if (!state.panelOpen && !fromChannel && msg.client !== clientId) {
        // keep the counter warm but do not nag
      }
    }

    if (env.type === 'request') {
      const request = {
        id: env.id,
        client: env.client,
        name: escapeText(env.name) || 'Listener',
        track: escapeText(env.track),
        note: escapeText(env.note),
        at: Number(env.at) || now
      };
      if (!request.track) return;
      const exists = state.requests.some((r) => r.id === request.id);
      if (!exists) {
        state.requests = [request, ...state.requests].slice(0, MAX_REQUESTS);
        write(STORE.requests, state.requests);
        renderRequests();
      }
      appendMessage({
        id: `${request.id}-sys`,
        client: 'system',
        name: 'Request',
        text: `${request.name} asked for “${request.track}”${request.note ? ` — ${request.note}` : ''}`,
        at: request.at,
        system: true
      });
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
    text.className = 'chat-text';
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

  /* ------------------------------------------------------------- requests */

  function requestSong(track, note) {
    const cleanTrack = escapeText(track);
    if (!cleanTrack) return false;
    const env = {
      id: makeId(),
      type: 'request',
      client: clientId,
      name: currentName(),
      track: cleanTrack,
      note: escapeText(note),
      at: Date.now()
    };
    handleEnvelope(env);
    broadcast(env);
    publish(env);
    toast(`Request sent — “${cleanTrack}”`);
    return true;
  }

  function renderRequests() {
    const lists = [els.roomRequestList, els.contactRequestList].filter(Boolean);
    lists.forEach((list) => {
      list.textContent = '';
      state.requests.slice(0, 12).forEach((r) => {
        const li = document.createElement('li');
        const span = document.createElement('span');
        span.textContent = r.track;
        const meta = document.createElement('span');
        meta.className = 'rq-note';
        meta.textContent = r.note ? `${r.name} · ${r.note}` : r.name;
        li.append(span, meta);
        list.appendChild(li);
      });
      if (!state.requests.length) {
        const li = document.createElement('li');
        li.className = 'rq-note';
        li.textContent = 'No requests yet — the AutoDJ is choosing.';
        list.appendChild(li);
      }
    });
  }

  /* ----------------------------------------------------------------- tabs */

  function selectTab(which) {
    const chat = which === 'chat';
    els.tabChat?.classList.toggle('is-active', chat);
    els.tabRequests?.classList.toggle('is-active', !chat);
    els.tabChat?.setAttribute('aria-selected', String(chat));
    els.tabRequests?.setAttribute('aria-selected', String(!chat));
    if (els.chatPane) els.chatPane.hidden = !chat;
    if (els.requestPane) els.requestPane.hidden = chat;
    if (chat) els.chatInput?.focus({ preventScroll: true });
  }

  function openPanel(which = 'chat') {
    if (!els.panel) return;
    els.panel.hidden = false;
    els.scrim.hidden = false;
    state.panelOpen = true;
    document.body.style.overflow = 'hidden';
    selectTab(which);
    renderChat();
    renderRequests();
    els.close?.focus({ preventScroll: true });
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

    els.roomRequestForm?.addEventListener('submit', (event) => {
      event.preventDefault();
      if (requestSong(els.roomRequestTrack.value, els.roomRequestNote.value)) {
        els.roomRequestForm.reset();
      }
    });

    els.tabChat?.addEventListener('click', () => selectTab('chat'));
    els.tabRequests?.addEventListener('click', () => selectTab('requests'));
    els.close?.addEventListener('click', closePanel);
    els.scrim?.addEventListener('click', closePanel);

    ['btn-listeners', 'radio-chat', 'radio-chat-2'].forEach((id) => {
      document.getElementById(id)?.addEventListener('click', () => openPanel('chat'));
    });

    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && state.panelOpen) closePanel();
    });

    if (els.trackOptions) {
      els.trackOptions.filter(Boolean).forEach((datalist) => {
        const frag = document.createDocumentFragment();
        TRACKS.forEach((t) => {
          const option = document.createElement('option');
          option.value = t.title;
          frag.appendChild(option);
        });
        datalist.appendChild(frag);
      });
    }

    renderChat();
    renderRequests();
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

  return { init, openPanel, closePanel, requestSong, currentName };
}
