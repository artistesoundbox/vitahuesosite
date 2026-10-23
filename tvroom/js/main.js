/**
 * Boot the TV room: load the model, put a live channel on the television,
 * and connect the room HUD to the full-screen viewer.
 */

import { LivePlayer } from './player.js';
import { TvRoom } from './room.js';
import { Viewer } from './viewer.js';
import { loadCatalog } from './channels.js';

const $ = (id) => document.getElementById(id);

/**
 * The feed the room wakes up on. Each one is HTTPS with CORS open, so it
 * plays in the browser without a proxy. If one is down the next is tried,
 * and once anything plays the room stops falling forward on its own.
 */
const FEATURED = [
  {
    name: 'NASA TV',
    group: 'Science',
    country: 'US',
    countryName: 'United States',
    url: 'https://ntv1.akamaized.net/hls/live/2014075/NASA-NTV1-HLS/master.m3u8',
    playable: true,
  },
  {
    name: 'France 24 English',
    group: 'News',
    country: 'FR',
    countryName: 'France',
    url: 'https://static.france24.com/live/F24_EN_LO_HLS/live_web.m3u8',
    playable: true,
  },
  {
    name: 'DW English',
    group: 'News',
    country: 'DE',
    countryName: 'Germany',
    url: 'https://dwamdstream102.akamaized.net/hls/live/2015525/dwstream102/index.m3u8',
    playable: true,
  },
  {
    name: 'Bloomberg TV',
    group: 'Business',
    country: 'US',
    countryName: 'United States',
    url: 'https://www.bloomberg.com/media-manifest/streams/us.m3u8',
    playable: true,
  },
  {
    name: 'Red Bull TV',
    group: 'Sports',
    country: 'AT',
    countryName: 'Austria',
    url: 'https://rbmn-live.akamaized.net/hls/live/590964/BoRB-AT/master.m3u8',
    playable: true,
  },
];

const bootStatus = $('boot-status');
const bootBar = $('boot-bar-fill');
const soundToggle = $('sound-toggle');
const soundLabel = soundToggle.querySelector('.hud-btn-label');
const hud = $('hud');
const canvas = $('room-canvas');
const stage = $('stage-source');
const nowName = $('room-now');
const nowMeta = $('room-now-meta');

const player = new LivePlayer();

let room = null;
let roomReady = false;

/* ── HUD ──────────────────────────────────────────────────────────────── */

function setRoomNow(channel) {
  if (!channel) {
    nowName.textContent = 'No signal';
    nowMeta.textContent = 'press View TV to pick a channel';
    return;
  }
  nowName.textContent = channel.name || 'Live';
  nowMeta.textContent = [channel.group, channel.country || channel.countryName, 'iptv-org live']
    .filter(Boolean)
    .join(' · ');
}

function syncSound() {
  const muted = player.muted;
  soundToggle.setAttribute('aria-pressed', muted ? 'false' : 'true');
  soundLabel.textContent = muted ? 'Sound off' : 'Sound on';
  soundToggle.title = muted ? 'Turn the room TV sound on' : 'Mute the room TV';
}

soundToggle.addEventListener('click', () => {
  const next = !player.muted;
  player.setMuted(next);
  if (!next && player.volume === 0) player.setVolume(0.8);
  syncSound();
});

player.on('channel', (channel) => setRoomNow(channel));
player.on('volume', syncSound);
player.on('state', (state) => {
  if (room) room.setSignal(state === 'playing' ? 'live' : 'offline');
  if (state === 'playing' || state === 'loading') {
    setRoomNow(player.channel);
  } else if (state === 'error') {
    nowName.textContent = 'No signal';
    nowMeta.textContent = 'the feed dropped · press View TV';
  }
  syncSound();
});

/* ── Viewer ───────────────────────────────────────────────────────────── */

const viewer = new Viewer({
  player,
  loadCatalog: (onProgress) => loadCatalog(onProgress),
  onOpen: () => {
    // The person is driving now: stop the room's automatic feed rotation.
    fallbackActive = false;
    hud.classList.add('is-dimmed');
  },
  onClose: () => {
    hud.classList.remove('is-dimmed');
    syncSound();
    setRoomNow(player.channel);
  },
});

player.mount(stage);

$('open-viewer').addEventListener('click', () => viewer.open());

$('random-channel').addEventListener('click', () => {
  if (viewer.catalog) {
    viewer.zap(1);
  } else {
    const next = FEATURED[Math.floor(Math.random() * FEATURED.length)];
    player.play(next);
  }
  viewer.showToast('Zapping…');
});

/* ── Start ────────────────────────────────────────────────────────────── */

let fallbackIndex = 0;
let fallbackActive = true;

function playFeatured() {
  if (fallbackIndex >= FEATURED.length) {
    fallbackActive = false;
    if (room) room.setSignal('offline');
    nowName.textContent = 'No signal';
    nowMeta.textContent = 'press View TV to pick a channel';
    return;
  }
  const channel = FEATURED[fallbackIndex];
  fallbackIndex += 1;
  player.play(channel);
}

player.on('state', (state) => {
  if (state === 'playing') fallbackActive = false;
});

player.on('error', () => {
  if (!fallbackActive) return;
  // The room tries the next featured feed before giving up on a picture.
  setTimeout(playFeatured, 600);
});

async function boot() {
  syncSound();

  try {
    room = new TvRoom({
      canvas,
      video: player.video,
      onOpenViewer: () => viewer.open(),
    });
  } catch (err) {
    console.error('[tvroom] no WebGL', err);
    bootStatus.textContent = 'This browser cannot render the room — opening the TV directly…';
    player.mount(stage);
    player.play(FEATURED[0]);
    hud.hidden = false;
    canvas.style.display = 'none';
    viewer.open();
    document.body.classList.remove('is-booting');
    return;
  }

  // The picture starts warming up while the model downloads.
  playFeatured();

  try {
    await room.load(new URL('tvroom.glb', document.baseURI).href, (fraction) => {
      const pct = Math.max(0.05, Math.min(1, fraction));
      bootBar.style.width = `${(pct * 100).toFixed(1)}%`;
      if (pct > 0.35) bootStatus.textContent = 'Warming up the room…';
    });
    bootBar.style.width = '100%';
    bootStatus.textContent = 'On air';
    roomReady = true;
  } catch (err) {
    console.error('[tvroom] room failed to load', err);
    bootStatus.textContent = 'The room could not load. The TV still works.';
    setTimeout(() => {
      document.body.classList.remove('is-booting');
      hud.hidden = false;
      viewer.open();
    }, 1400);
    return;
  }

  player.mount(stage);
  room.setSignal(player.state === 'playing' ? 'live' : 'offline');
  await new Promise((resolve) => setTimeout(resolve, 180));
  document.body.classList.add('is-ready');
  document.body.classList.remove('is-booting');
  hud.hidden = false;
  setRoomNow(player.channel);
  syncSound();

  if (!player.channel) {
    nowName.textContent = 'No signal';
    nowMeta.textContent = 'press View TV to pick a channel';
  }
}

document.addEventListener('keydown', (ev) => {
  if (viewer.isOpen) return;
  const tag = (ev.target && ev.target.tagName) || '';
  if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
  if (ev.key === 'v' || ev.key === 'V') {
    viewer.open();
    ev.preventDefault();
  }
});

// A small handle for debugging from the console (and for the odd spot-check
// with the browser tools). Nothing else depends on it.
window.__tvroom = { player, viewer, get room() { return room; } };

boot();
