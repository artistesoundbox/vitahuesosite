/* The interface: routing, rendering and controls.
 *
 * Playback lives in player.js and survives every route change, so the radio
 * keeps playing while you move between Home, Library and Releases.
 */
import { STATION, ALBUMS, GENRES, STATS, TRACKS } from './catalog.js';
import { PROGRAMS, SLEEP_CHOICES } from './config.js';
import { radio } from './player.js';
import {
  formatTime, formatDuration, localHourLabel, programAt,
  msUntilNextProgram, formatCountdown
} from './station.js';
import { createVisualizer } from './visualizer.js';
import { createCommunity } from './community.js';

const $ = (id) => document.getElementById(id);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ESC[c]);
const normalize = (value) => String(value || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');

const byId = new Map(TRACKS.map((t) => [t.id, t]));
const albumById = new Map(ALBUMS.map((a) => [a.id, a]));
const albumTracks = (albumId) => TRACKS.filter((t) => t.albumId === albumId);

const ROUTES = ['home', 'radio', 'library', 'releases', 'about', 'contact'];
const TITLES = {
  home: 'Vita Hueso Radio — 24/7 original music',
  radio: 'The Radio — Vita Hueso Radio',
  library: 'Music Library — Vita Hueso Radio',
  releases: 'Latest Releases — Vita Hueso Radio',
  about: 'About the Artist — Vita Hueso Radio',
  contact: 'Contact — Vita Hueso Radio'
};
const VIEWS = {};

/* ------------------------------------------------------------------ toast */

function toast(message) {
  const region = $('toasts');
  if (!region) return;
  const node = document.createElement('div');
  node.className = 'toast';
  node.textContent = message;
  region.appendChild(node);
  while (region.children.length > 3) region.firstElementChild.remove();
  setTimeout(() => {
    node.classList.add('is-out');
    setTimeout(() => node.remove(), 340);
  }, 3200);
}

const community = createCommunity({ toast });

/* ------------------------------------------------------------- formatting */

function setFill(input) {
  if (!input) return;
  const min = Number(input.min) || 0;
  const max = Number(input.max) || 100;
  const value = Number(input.value) || 0;
  const pct = max > min ? ((value - min) / (max - min)) * 100 : 0;
  input.style.setProperty('--fill', `${Math.min(100, Math.max(0, pct))}%`);
}

function setImg(img, src) {
  if (!img || !src) return;
  if (img.getAttribute('src') !== src) img.setAttribute('src', src);
}

function setUse(svg, id) {
  const use = svg?.querySelector('use');
  if (use) use.setAttribute('href', `#${id}`);
}

const isCC = (track) => /^CC/i.test(track.license || '');

/** "https://ccmixter.org/files/…" → "ccmixter.org" (credit links name their host). */
function sourceHost(url) {
  try { return new URL(url).host.replace(/^www\./, ''); } catch { return 'source'; }
}

/** Clipboard that cannot hang the form when permission is refused. */
async function copyText(text) {
  if (navigator.clipboard?.writeText) {
    try {
      return await Promise.race([
        navigator.clipboard.writeText(text).then(() => true),
        new Promise((resolve) => setTimeout(() => resolve(false), 1200))
      ]);
    } catch { /* fall through */ }
  }
  try {
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0';
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand('copy');
    area.remove();
    return ok;
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------- data lists */

function renderStats() {
  const hours = (STATS.totalSeconds / 3600).toFixed(1);
  const map = { originals: STATS.originals, hours, albums: ALBUMS.length, genres: GENRES.length };
  $$('[data-stat]').forEach((node) => {
    const key = node.dataset.stat;
    if (map[key] !== undefined) node.textContent = map[key];
  });
}

function albumDuration(albumId) {
  return albumTracks(albumId).reduce((sum, t) => sum + t.duration, 0);
}

function renderMiniAlbums() {
  const target = $('home-albums');
  if (!target) return;
  const latest = ALBUMS.filter((a) => !a.external).slice(-3).reverse();
  target.textContent = '';
  latest.forEach((album) => {
    const tracks = albumTracks(album.id);
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'mini-album';
    button.dataset.album = album.id;
    button.innerHTML = `
      <img src="${esc(album.cover)}" alt="${esc(album.title)} cover" loading="lazy" width="200" height="200" />
      <strong>${esc(album.title)}</strong>
      <span>${album.year} · ${tracks.length} tracks</span>`;
    button.addEventListener('click', () => playAlbum(album.id));
    target.appendChild(button);
  });
}

function scheduleCard(program, currentId, compact) {
  const card = document.createElement('button');
  card.type = 'button';
  card.className = 'show-card' + (program.id === currentId ? ' is-now' : '');
  card.style.textAlign = 'left';
  card.dataset.program = program.id;
  card.innerHTML = `
    ${program.id === currentId ? '<span class="show-now-tag">ON AIR</span>' : ''}
    <span class="show-time">${esc(localHourLabel(program.start))} – ${esc(localHourLabel(program.end))}</span>
    <span class="show-name">${esc(program.name)}</span>
    ${compact ? '' : `<span class="show-tag">${esc(program.tagline)}</span>`}
    <span class="show-genres">${program.genres.map((g) => `<span>${esc(g)}</span>`).join('')}</span>`;
  card.addEventListener('click', () => {
    if (radio.track) toast(`Now playing: ${radio.track.title}`);
    location.hash = 'radio';
  });
  return card;
}

function renderSchedules(currentId) {
  const current = currentId || programAt().id;
  const full = $('schedule');
  if (full) {
    full.textContent = '';
    PROGRAMS.forEach((p) => full.appendChild(scheduleCard(p, current, false)));
  }
  const compact = $('home-schedule');
  if (compact) {
    compact.textContent = '';
    PROGRAMS.forEach((p) => compact.appendChild(scheduleCard(p, current, true)));
  }
}

/* ---------------------------------------------------------------- library */

const libState = { query: '', genre: 'All', favorites: false, sort: 'default' };
let filteredTracks = TRACKS.slice();

function renderGenreChips() {
  const target = $('lib-genres');
  if (!target) return;
  const chips = ['All', ...GENRES];
  target.textContent = '';
  chips.forEach((genre) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'chip' + (libState.genre === genre ? ' is-on' : '');
    button.textContent = genre;
    button.setAttribute('aria-pressed', String(libState.genre === genre));
    button.addEventListener('click', () => {
      libState.genre = genre;
      renderGenreChips();
      renderLibrary();
    });
    target.appendChild(button);
  });
}

function sortTracks(list) {
  const out = list.slice();
  switch (libState.sort) {
    case 'title': return out.sort((a, b) => a.title.localeCompare(b.title));
    case 'album': return out.sort((a, b) => a.album.localeCompare(b.album) || a.trackNo - b.trackNo);
    case 'long': return out.sort((a, b) => b.duration - a.duration);
    case 'short': return out.sort((a, b) => a.duration - b.duration);
    default: return out;
  }
}

function trackCard(track) {
  const card = document.createElement('article');
  card.className = 'track-card';
  card.dataset.id = track.id;
  const current = radio.track?.id === track.id ? ' is-current' : '';
  if (current) card.classList.add('is-current');
  card.innerHTML = `
    <div class="track-art">
      <img src="${esc(track.art)}" alt="${esc(track.title)} artwork" loading="lazy" width="300" height="300" />
      <button class="track-play" type="button" data-play="${esc(track.id)}" aria-label="Play ${esc(track.title)}">
        <svg class="icon"><use href="#i-play"/></svg>
      </button>
    </div>
    <div class="track-body">
      <div class="track-name">${esc(track.title)}</div>
      <div class="track-meta">
        <span>${esc(track.album)}</span><span>·</span><span>${formatTime(track.duration)}</span>
        ${isCC(track) ? '<span class="tag-cc">CC BY</span>' : ''}
      </div>
      <div class="track-actions">
        <button class="icon-btn" type="button" data-fav="${esc(track.id)}" aria-label="Favorite ${esc(track.title)}" aria-pressed="false">
          <svg class="icon icon-heart"><use href="#i-heart"/></svg>
        </button>
        <button class="icon-btn" type="button" data-download="${esc(track.id)}" aria-label="Download ${esc(track.title)}">
          <svg class="icon"><use href="#i-download"/></svg>
        </button>
        <button class="icon-btn" type="button" data-share="${esc(track.id)}" aria-label="Share ${esc(track.title)}">
          <svg class="icon"><use href="#i-share"/></svg>
        </button>
        <span class="spacer"></span>
      </div>
    </div>`;
  return card;
}

function renderLibrary() {
  const grid = $('lib-grid');
  if (!grid) return;
  const q = normalize(libState.query);
  filteredTracks = TRACKS.filter((t) => {
    if (libState.genre !== 'All' && !t.genres.includes(libState.genre)) return false;
    if (libState.favorites && !radio.favorites.has(t.id)) return false;
    if (!q) return true;
    const haystack = normalize([t.title, t.album, t.artist, t.genres.join(' '), t.license].join(' '));
    return haystack.includes(q);
  });
  filteredTracks = sortTracks(filteredTracks);

  grid.textContent = '';
  const frag = document.createDocumentFragment();
  filteredTracks.forEach((t) => frag.appendChild(trackCard(t)));
  grid.appendChild(frag);

  const count = $('lib-count');
  if (count) count.textContent = `${filteredTracks.length} of ${TRACKS.length} tracks`;
  const empty = $('lib-empty');
  if (empty) empty.hidden = filteredTracks.length > 0;
  syncCardFavorites();
}

function syncCardFavorites() {
  $$('[data-fav]').forEach((button) => {
    const id = button.dataset.fav;
    const active = radio.favorites.has(id);
    button.setAttribute('aria-pressed', String(active));
    button.classList.toggle('is-fav', active);
    setUse(button.querySelector('svg'), active ? 'i-heart-fill' : 'i-heart');
  });
}

/* --------------------------------------------------------------- releases */

function renderAlbums() {
  const target = $('albums');
  if (!target) return;
  target.textContent = '';

  ALBUMS.forEach((album) => {
    const tracks = albumTracks(album.id);
    if (!tracks.length) return;
    const section = document.createElement('article');
    section.className = 'album-row glass';
    section.id = `album-${album.id}`;

    const listId = `tracklist-${album.id}`;
    section.innerHTML = `
      <figure class="album-cover">
        <img src="${esc(album.cover)}" alt="${esc(album.title)} cover artwork" loading="lazy" width="420" height="420" />
      </figure>
      <div class="album-body">
        <h2>${esc(album.title)}</h2>
        <p class="album-meta">
          <span>${album.year}</span><span>${tracks.length} tracks</span>
          <span>${formatDuration(albumDuration(album.id))}</span>
          ${album.external ? '<span class="tag-cc">CC BY</span>' : `<span>${esc(STATION.artist)}</span>`}
        </p>
        <p class="album-desc">${esc(album.description || '')}</p>
        <div class="album-actions">
          <button class="btn btn-primary btn-sm" type="button" data-album-play="${esc(album.id)}">
            <svg class="icon"><use href="#i-play"/></svg> Play record
          </button>
          <button class="btn btn-ghost btn-sm" type="button" data-album-link="${esc(listId)}">
            Tracklist <svg class="icon"><use href="#i-arrow"/></svg>
          </button>
        </div>
        <ul class="tracklist" id="${listId}">
          ${tracks.map((t, i) => `
            <li>
              <button type="button" data-play="${esc(t.id)}">
                <span class="num">${String(i + 1).padStart(2, '0')}</span>
                <span class="name">${esc(t.title)}</span>
                <span class="genre">${esc(t.genres.join(' · '))}</span>
                <time>${formatTime(t.duration)}</time>
              </button>
            </li>`).join('')}
        </ul>
      </div>`;

    section.addEventListener('click', (event) => {
      const play = event.target.closest('[data-play]');
      if (play) {
        const albumQueue = albumTracks(album.id);
        const index = albumQueue.findIndex((t) => t.id === play.dataset.play);
        playPersonal(albumQueue[index], albumQueue.slice(index + 1).concat(albumQueue.slice(0, index)));
        return;
      }
      const albumPlay = event.target.closest('[data-album-play]');
      if (albumPlay) { playAlbum(albumPlay.dataset.albumPlay); return; }
      const jump = event.target.closest('[data-album-link]');
      if (jump) {
        document.getElementById(jump.dataset.albumLink)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
    });

    target.appendChild(section);
  });
}

function renderGallery() {
  const target = $('gallery');
  if (!target) return;
  const seen = new Set();
  const items = [];
  TRACKS.forEach((t) => {
    if (seen.has(t.art)) return;
    seen.add(t.art);
    items.push({ art: t.art, caption: `${t.title} — ${t.album}` });
  });
  ALBUMS.forEach((a) => {
    if (seen.has(a.cover)) return;
    seen.add(a.cover);
    items.push({ art: a.cover, caption: `${a.title} — ${a.year}` });
  });

  target.textContent = '';
  items.forEach((item) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.innerHTML = `<img src="${esc(item.art)}" alt="${esc(item.caption)}" loading="lazy" width="260" height="260" />`;
    button.addEventListener('click', () => openLightbox(item.art, item.caption));
    target.appendChild(button);
  });
}

function openLightbox(src, caption) {
  const box = $('lightbox');
  const img = $('lightbox-img');
  const cap = $('lightbox-caption');
  if (!box || !img) return;
  img.src = src;
  img.alt = caption;
  if (cap) cap.textContent = caption;
  box.hidden = false;
  document.body.style.overflow = 'hidden';
  $('lightbox-close')?.focus({ preventScroll: true });
}

function closeLightbox() {
  const box = $('lightbox');
  if (!box) return;
  box.hidden = true;
  document.body.style.overflow = '';
}

/* ------------------------------------------------------------- about page */

function renderAbout() {
  const genres = $('about-genres');
  if (genres) {
    genres.textContent = '';
    GENRES.forEach((g) => {
      const li = document.createElement('li');
      li.textContent = g;
      genres.appendChild(li);
    });
  }

  const credits = $('about-credits');
  if (credits) {
    credits.textContent = '';
    const originals = document.createElement('p');
    originals.className = 'credit';
    originals.textContent = `Original catalogue — written and performed by ${STATION.artist}. All rights reserved.`;
    credits.appendChild(originals);

    TRACKS.filter(isCC).forEach((t) => {
      const div = document.createElement('div');
      div.className = 'credit';
      div.innerHTML = `<strong>${esc(t.title)}</strong> — ${esc(t.artist)}. Licensed
        <a href="${esc(t.licenseUrl)}" target="_blank" rel="noopener noreferrer">${esc(t.license)}</a>.
        Source: <a href="${esc(t.source)}" target="_blank" rel="noopener noreferrer">${esc(sourceHost(t.source))}</a>.`;
      credits.appendChild(div);
    });
  }

  const facts = $('about-facts');
  if (facts) {
    const rows = [
      ['Original tracks', STATS.originals],
      ['Guest songs', STATS.guest],
      ['Music on rotation', formatDuration(STATS.totalSeconds)],
      ['Records', ALBUMS.length],
      ['Broadcast', '24 / 7 / 365'],
      ['Signal', 'VH·SIGNAL']
    ];
    facts.innerHTML = rows.map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`).join('');
  }
}

/* ---------------------------------------------------------------- now playing */

const els = {};
let lastQueueKey = '';
let lastRecentKey = '';
let lastProgramId = '';
let lastArt = '';
let lastTrackId = '';

function cacheEls() {
  [
    'np-art', 'np-title', 'np-artist', 'np-album', 'np-year', 'np-genres', 'np-time', 'np-duration',
    'np-progress', 'np-mode', 'np-program', 'np-rejoin', 'np-fav', 'np-play', 'np-play-icon',
    'np-next', 'np-prev',
    'np-mute', 'np-mute-icon', 'np-volume', 'np-sleep', 'sleep-menu', 'np-mic', 'np-download',
    'np-share', 'np-credit', 'np-live-note', 'sleep-status',
    'home-art', 'home-title', 'home-artist', 'home-album', 'home-mode', 'home-program', 'home-play',
    'home-play-label', 'home-queue', 'home-next-program',
    'queue', 'queue-count', 'recent', 'schedule-next',
    'dock', 'dock-art', 'dock-title', 'dock-artist', 'dock-mode', 'dock-play', 'dock-play-icon',
    'dock-mute', 'dock-mute-icon', 'dock-fav', 'dock-bar', 'dock-eq', 'dock-open',
    'lib-search', 'lib-sort', 'lib-favorites', 'lib-count', 'lib-grid', 'lib-empty', 'lib-clear',
    'contact-form', 'contact-note', 'chat-input', 'chat-emoji', 'chat-emoji-panel', 'chat-count',
    'copy-embed', 'embed-code', 'lightbox', 'lightbox-img', 'lightbox-caption', 'lightbox-close',
    'btn-menu', 'nav', 'topbar'
  ].forEach((id) => { els[id] = $(id); });
}

function renderQueueList(listEl, tracks, options = {}) {
  if (!listEl) return;
  listEl.textContent = '';
  if (!tracks.length) {
    const li = document.createElement('li');
    li.className = 'queue-empty';
    li.textContent = options.empty || 'Nothing queued — the AutoDJ is thinking.';
    listEl.appendChild(li);
    return;
  }
  tracks.forEach((track) => {
    const li = document.createElement('li');
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'queue-item';
    button.innerHTML = `
      <img src="${esc(track.art)}" alt="" loading="lazy" width="40" height="40" />
      <span>
        <span class="q-title">${esc(track.title)}</span>
        <span class="q-sub">${track.ident ? 'Station ID' : `${esc(track.album)} · ${esc(track.genres[0] || '')}`}${track.guest ? ' · <span class="tag-cc">CC</span>' : ''}${track.ident ? ' · <span class="tag-cc">ID</span>' : ''}</span>
      </span>
      <time>${formatTime(track.duration)}</time>`;
    button.addEventListener('click', () => playPersonal(track, [track]));
    li.appendChild(button);
    listEl.appendChild(li);
  });
}

function updateProgress(position, duration) {
  const bar = els['np-progress'];
  const dur = Math.max(1, Number(duration) || 1);
  const pos = Math.min(dur, Math.max(0, Number(position) || 0));
  const live = radio.mode === 'live';
  els['np-time'].textContent = formatTime(pos);
  els['np-duration'].textContent = formatTime(dur);
  if (bar) {
    bar.disabled = live;
    if (live) {
      bar.max = '1000';
      bar.value = String(Math.round((pos / dur) * 1000));
    } else {
      bar.max = String(Math.round(dur));
      bar.value = String(Math.round(pos));
    }
    setFill(bar);
  }
  const dockBar = els['dock-bar'];
  if (dockBar) dockBar.style.width = `${Math.min(100, (pos / dur) * 100)}%`;
}

function updateState(state) {
  const track = state.track;
  if (!track) return;
  const live = state.mode === 'live';

  if (track.id !== lastTrackId) {
    lastTrackId = track.id;
    lastArt = '';
    els['np-title'].textContent = track.title;
    els['np-artist'].textContent = track.artist;
    els['np-album'].textContent = track.album;
    els['np-year'].textContent = track.year;
    els['home-title'].textContent = track.title;
    els['home-artist'].textContent = track.artist;
    els['home-album'].textContent = track.album;
    els['dock-title'].textContent = track.title;
    els['dock-artist'].textContent = `${track.artist} · ${track.album}`;
    els['np-genres'].innerHTML = track.genres.map((g) => `<span class="chip">${esc(g)}</span>`).join('');
    $$('.track-card').forEach((card) => card.classList.toggle('is-current', card.dataset.id === track.id));
  }

  if (track.art !== lastArt) {
    lastArt = track.art;
    setImg(els['np-art'], track.art);
    setImg(els['home-art'], track.art);
    setImg(els['dock-art'], track.art);
    els['np-art'].alt = `${track.title} artwork`;
  }

  const modeText = live ? 'LIVE' : 'PERSONAL';
  els['np-mode'].textContent = modeText;
  els['np-mode'].dataset.mode = state.mode;
  els['home-mode'].textContent = modeText;
  els['home-mode'].dataset.mode = state.mode;
  els['dock-mode'].textContent = modeText;
  els['dock'].dataset.mode = state.mode;
  els['np-rejoin'].classList.toggle('hidden', live);

  els['np-program'].textContent = state.program.name;
  els['home-program'].textContent = state.program.name;

  els['np-live-note'].textContent = live
    ? 'Live broadcast — position follows the station clock.'
    : 'Library playback — drag to seek, skip as you like.';

  const playing = state.playing;
  els['np-play'].setAttribute('aria-label', playing ? 'Pause' : 'Play');
  setUse(els['np-play-icon'], playing ? 'i-pause' : 'i-play');
  els['dock-play'].setAttribute('aria-label', playing ? 'Pause' : 'Play');
  setUse(els['dock-play-icon'], playing ? 'i-pause' : 'i-play');
  els['dock'].classList.toggle('is-playing', playing);

  els['np-fav'].setAttribute('aria-pressed', String(state.favorite));
  els['np-fav'].classList.toggle('is-fav', state.favorite);
  setUse(els['np-fav'].querySelector('svg'), state.favorite ? 'i-heart-fill' : 'i-heart');
  els['dock-fav'].setAttribute('aria-pressed', String(state.favorite));
  els['dock-fav'].classList.toggle('is-fav', state.favorite);
  setUse(els['dock-fav'].querySelector('svg'), state.favorite ? 'i-heart-fill' : 'i-heart');

  const muted = state.muted || state.volume === 0;
  setUse(els['np-mute-icon'], muted ? 'i-mute' : 'i-volume');
  setUse(els['dock-mute-icon'], muted ? 'i-mute' : 'i-volume');
  els['np-mute'].setAttribute('aria-pressed', String(state.muted));
  const vol = els['np-volume'];
  if (vol && document.activeElement !== vol) {
    vol.value = String(Math.round((state.muted ? 0 : state.volume) * 100));
    setFill(vol);
  }

  els['np-mic'].setAttribute('aria-pressed', String(state.micOn));
  els['np-mic'].classList.toggle('is-fav', state.micOn);

  els['home-play-label'].textContent = playing ? 'Pause broadcast' : 'Listen live';
  setUse(els['home-play'].querySelector('svg'), playing ? 'i-pause' : 'i-play');

  updateProgress(state.position, state.duration || track.duration);

  const until = state.nextProgram;
  els['home-next-program'].textContent = `Now: ${state.program.name} · next show in ${formatCountdown(until)}`;
  els['schedule-next'].textContent = `Next programme in ${formatCountdown(msUntilNextProgram())}`;

  if (els['sleep-status']) {
    if (state.sleepEndsAt) {
      const mins = Math.max(1, Math.ceil((state.sleepEndsAt - Date.now()) / 60000));
      els['sleep-status'].textContent = `Stops in ${mins} min`;
    } else {
      els['sleep-status'].textContent = 'Off';
    }
  }

  const credit = els['np-credit'];
  if (credit) {
    credit.textContent = '';
    if (isCC(track)) {
      const span = document.createElement('span');
      span.textContent = `Guest track · ${track.artist} · ${track.license} · `;
      const link = document.createElement('a');
      link.href = track.source;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.textContent = sourceHost(track.source);
      credit.append(span, link);
    } else if (track.ident) {
      credit.textContent = 'Station identification — Vita Hueso Radio';
    } else {
      credit.textContent = `Original recording · written & performed by ${track.artist}`;
    }
    if (state.micUrl) {
      const take = document.createElement('a');
      take.href = state.micUrl;
      take.download = 'vh-mic-take.webm';
      take.textContent = ' · Save mic take';
      credit.appendChild(take);
    }
  }

  const queueKey = state.queue.map((t) => t.id).join(',');
  if (queueKey !== lastQueueKey) {
    lastQueueKey = queueKey;
    renderQueueList(els['queue'], state.queue, { empty: 'The AutoDJ is choosing the next track.' });
    renderQueueList(els['home-queue'], state.queue.slice(0, 4));
    if (els['queue-count']) els['queue-count'].textContent = live ? 'AutoDJ · live' : 'Your queue';
  }

  const recentKey = state.recent.map((t) => t.id).join(',');
  if (recentKey !== lastRecentKey) {
    lastRecentKey = recentKey;
    renderQueueList(els['recent'], state.recent.filter((t) => t.id !== track.id).slice(0, 5), {
      empty: 'Your listening history will appear here.'
    });
  }

  if (state.program.id !== lastProgramId) {
    lastProgramId = state.program.id;
    lastQueueKey = '';
    lastRecentKey = '';
    renderSchedules(state.program.id);
  }

  if (track.id !== els['dock'].dataset.track) {
    els['dock'].dataset.track = track.id;
  }
}

/* ---------------------------------------------------------------- playback */

function playPersonal(track, queue = []) {
  if (!track) return;
  const list = queue.filter((t) => t && t.id !== track.id);
  radio.playTrack(track, { queue: list });
}

function playAlbum(albumId) {
  const list = albumTracks(albumId);
  if (!list.length) return;
  radio.playTrack(list[0], { queue: list.slice(1) });
  toast(`Playing ${albumById.get(albumId)?.title || 'record'}`);
}

function downloadTrack(track) {
  if (!track) return;
  const link = document.createElement('a');
  link.href = track.src;
  link.download = `${track.artist} - ${track.title}.mp3`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  toast(`Downloading “${track.title}”`);
}

async function shareTrack(track) {
  if (!track) return;
  const url = new URL(location.href);
  url.hash = 'radio';
  const data = {
    title: `${track.title} — ${track.artist}`,
    text: `Listening to “${track.title}” on Vita Hueso Radio`,
    url: url.toString()
  };
  if (navigator.share) {
    try { await navigator.share(data); return; } catch { /* cancelled */ }
  }
  try {
    await navigator.clipboard.writeText(`${data.text} — ${data.url}`);
    toast('Link copied to clipboard.');
  } catch {
    toast('Could not copy the link — share the page URL instead.');
  }
}

/* ---------------------------------------------------------------- bindings */

function bindPlayer() {
  els['np-play'].addEventListener('click', () => radio.toggle());
  els['dock-play'].addEventListener('click', () => radio.toggle());
  els['home-play'].addEventListener('click', () => {
    if (radio.playing) radio.pause();
    else radio.start();
  });

  els['np-next'].addEventListener('click', () => radio.next());
  els['dock-next']?.addEventListener('click', () => radio.next());
  els['np-prev'].addEventListener('click', () => radio.prev());
  els['np-rejoin'].addEventListener('click', () => radio.rejoinLive());
  els['dock-open'].addEventListener('click', () => { location.hash = 'radio'; });

  els['np-fav'].addEventListener('click', () => {
    const active = radio.toggleFavorite();
    toast(active ? 'Added to favorites.' : 'Removed from favorites.');
  });
  els['dock-fav'].addEventListener('click', () => radio.toggleFavorite());

  els['np-mute'].addEventListener('click', () => radio.toggleMute());
  els['dock-mute'].addEventListener('click', () => radio.toggleMute());

  els['np-volume'].addEventListener('input', (event) => radio.setVolume(Number(event.target.value) / 100));

  els['np-progress'].addEventListener('input', (event) => {
    if (radio.mode === 'live') return;
    radio.seek(Number(event.target.value));
  });

  els['np-download'].addEventListener('click', () => downloadTrack(radio.track));
  els['np-share'].addEventListener('click', () => shareTrack(radio.track));

  els['np-mic'].addEventListener('click', async () => {
    await radio.toggleMic();
  });

  const sleepMenu = els['sleep-menu'];
  els['np-sleep'].addEventListener('click', (event) => {
    event.stopPropagation();
    const open = sleepMenu.hidden;
    sleepMenu.hidden = !open;
    els['np-sleep'].setAttribute('aria-expanded', String(open));
  });

  SLEEP_CHOICES.forEach((minutes) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = `${minutes}m`;
    button.onclick = () => {
      radio.setSleep(minutes);
      sleepMenu.hidden = true;
      els['np-sleep'].setAttribute('aria-expanded', 'false');
    };
    $('sleep-options').appendChild(button);
  });

  const off = document.createElement('button');
  off.type = 'button';
  off.textContent = 'Off';
  off.onclick = () => {
    radio.setSleep(0);
    sleepMenu.hidden = true;
    els['np-sleep'].setAttribute('aria-expanded', 'false');
  };
  $('sleep-options').appendChild(off);

  document.addEventListener('click', (event) => {
    if (sleepMenu.hidden) return;
    if (event.target.closest('#sleep-menu, #np-sleep')) return;
    sleepMenu.hidden = true;
    els['np-sleep'].setAttribute('aria-expanded', 'false');
  });

  radio.addEventListener('state', (event) => updateState(event.detail));
  radio.addEventListener('time', (event) => updateProgress(event.detail.position, event.detail.duration));
  radio.addEventListener('notice', (event) => toast(event.detail));
  radio.addEventListener('favorite', () => {
    syncCardFavorites();
    if (libState.favorites) renderLibrary();
  });
  radio.addEventListener('trackchange', (event) => {
    const track = event.detail;
    document.title = `${track.title} · Vita Hueso Radio`;
  });
}

function bindLibrary() {
  const search = els['lib-search'];
  search?.addEventListener('input', () => {
    libState.query = search.value;
    renderLibrary();
  });

  els['lib-sort']?.addEventListener('change', (event) => {
    libState.sort = event.target.value;
    renderLibrary();
  });

  els['lib-favorites']?.addEventListener('change', (event) => {
    libState.favorites = event.target.checked;
    renderLibrary();
  });

  els['lib-clear']?.addEventListener('click', () => {
    libState.query = '';
    libState.genre = 'All';
    libState.favorites = false;
    libState.sort = 'default';
    if (search) search.value = '';
    if (els['lib-favorites']) els['lib-favorites'].checked = false;
    if (els['lib-sort']) els['lib-sort'].value = 'default';
    renderGenreChips();
    renderLibrary();
  });

  els['lib-grid']?.addEventListener('click', (event) => {
    const play = event.target.closest('[data-play]');
    if (play) {
      const track = byId.get(play.dataset.play);
      const index = filteredTracks.findIndex((t) => t.id === play.dataset.play);
      playPersonal(track, filteredTracks.slice(index + 1).concat(filteredTracks.slice(0, index)));
      return;
    }
    const fav = event.target.closest('[data-fav]');
    if (fav) {
      radio.toggleFavorite(byId.get(fav.dataset.fav));
      return;
    }
    const dl = event.target.closest('[data-download]');
    if (dl) {
      downloadTrack(byId.get(dl.dataset.download));
      return;
    }
    const share = event.target.closest('[data-share]');
    if (share) shareTrack(byId.get(share.dataset.share));
  });
}

/* The chat picker: a grid of emoji that drops into the message at the caret.
   Sending one on its own renders it large (see .chat-text.is-emoji), which is
   the room's no-asset "sticker" — nothing to download, nothing to moderate. */
const CHAT_EMOJI = [
  '\u{1F600}', '\u{1F604}', '\u{1F601}', '\u{1F60A}', '\u{1F609}', '\u{1F60D}', '\u{1F929}', '\u{1F60E}',
  '\u{1F973}', '\u{1F602}', '\u{1F923}', '\u{1F605}', '\u{1F643}', '\u{1F634}', '\u{1F914}', '\u{1F62E}',
  '\u{1F979}', '\u{1F62D}', '\u{1F624}', '\u{1F44F}', '\u{1F64C}', '\u{1F64F}', '\u{1F44D}', '\u{1F91D}',
  '\u{1F525}', '\u{2728}', '\u{1F4AB}', '\u{2B50}', '\u{1F389}', '\u{1F38A}', '\u{1F57A}', '\u{1F483}',
  '\u{1FA69}', '\u{1F3B6}', '\u{1F3B5}', '\u{1F3A7}', '\u{1F4FB}', '\u{1F496}', '\u{1F49C}', '\u{2764}',
  '\u{1F334}', '\u{1F30A}', '\u{1F379}', '\u{2615}', '\u{1F32E}', '\u{1F941}', '\u{1F3B8}'
];

function bindChatEmoji() {
  const button = els['chat-emoji'];
  const panel = els['chat-emoji-panel'];
  const input = els['chat-input'];
  if (!button || !panel || !input) return;

  CHAT_EMOJI.forEach((emoji) => {
    const item = document.createElement('button');
    item.type = 'button';
    item.textContent = emoji;
    item.setAttribute('aria-label', `Insert ${emoji}`);
    item.addEventListener('click', () => {
      const start = input.selectionStart ?? input.value.length;
      const end = input.selectionEnd ?? start;
      input.value = input.value.slice(0, start) + emoji + input.value.slice(end);
      const caret = start + emoji.length;
      input.focus({ preventScroll: true });
      try { input.setSelectionRange(caret, caret); } catch { /* ignore */ }
      if (els['chat-count']) els['chat-count'].textContent = String(input.value.length);
    });
    panel.appendChild(item);
  });

  const close = () => {
    panel.hidden = true;
    button.setAttribute('aria-expanded', 'false');
  };

  button.addEventListener('click', (event) => {
    event.stopPropagation();
    const opening = panel.hidden;
    panel.hidden = !opening;
    button.setAttribute('aria-expanded', String(opening));
    if (opening) panel.querySelector('button')?.focus({ preventScroll: true });
  });
  panel.addEventListener('click', (event) => event.stopPropagation());
  document.addEventListener('click', () => { if (!panel.hidden) close(); });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !panel.hidden) {
      close();
      button.focus({ preventScroll: true });
    }
  });
}

function bindForms() {
  const form = els['contact-form'];
  form?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const name = $('contact-name').value.trim();
    const email = $('contact-email').value.trim();
    const message = $('contact-message').value.trim();
    if (message.length < 4) {
      toast('Write a little more first.');
      return;
    }

    const body = `${message}\n\n— ${name || 'A listener'}${email ? ` (${email})` : ''}`;
    const subject = `Vita Hueso Radio — message from ${name || 'a listener'}`;

    const address = STATION.contactEmail;
    if (address) {
      const query = `subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
      const mailto = `mailto:${address}?${query}`;
      window.location.href = mailto;
      toast('Opening your mail app…');

      /* mailto silently does nothing on machines with no mail app (and on a
         lot of phones it opens the wrong account), so offer Gmail as well.
         The address itself is never printed on the page — it is read from
         config and put into the links only, so harvesters scraping the HTML
         get nothing. */
      const note = els['contact-note'];
      note.textContent = 'If your mail app did not open, ';
      const gmail = document.createElement('a');
      gmail.href = `https://mail.google.com/mail/?view=cm&fs=1&to=${encodeURIComponent(address)}&${query}`;
      gmail.target = '_blank';
      gmail.rel = 'noopener';
      gmail.textContent = 'send it straight from Gmail';
      note.append(gmail, '.');
      return;
    }

    const text = `${subject}\n\n${body}`;
    const copied = await copyText(text);
    if (copied) {
      els['contact-note'].textContent = 'Copied to your clipboard — paste it into a message on YouTube or GitHub.';
      toast('Message copied. Paste it into a DM or comment.');
      return;
    }

    // Clipboard refused (or timed out): show the finished message so it can
    // still be selected and sent.
    let box = document.getElementById('contact-copy');
    if (!box) {
      box = document.createElement('textarea');
      box.id = 'contact-copy';
      box.className = 'copy-box';
      box.readOnly = true;
      form.appendChild(box);
    }
    box.value = text;
    box.focus();
    box.select();
    els['contact-note'].textContent = 'Clipboard is blocked — your message is below. Select it and send it via YouTube or GitHub.';
    toast('Select the message below to copy it.');
  });

  els['copy-embed']?.addEventListener('click', async () => {
    const code = els['embed-code'].textContent;
    try {
      await navigator.clipboard.writeText(code);
      toast('Embed snippet copied.');
    } catch {
      toast('Select the snippet and copy it manually.');
    }
  });
}

function bindChrome() {
  const menu = els['btn-menu'];
  const nav = $('nav');
  menu?.addEventListener('click', () => {
    const open = nav.classList.toggle('is-open');
    menu.setAttribute('aria-expanded', String(open));
  });
  $$('#nav a').forEach((link) => link.addEventListener('click', () => {
    nav.classList.remove('is-open');
    menu?.setAttribute('aria-expanded', 'false');
  }));

  $('lightbox-close')?.addEventListener('click', closeLightbox);
  els['lightbox']?.addEventListener('click', (event) => {
    if (event.target === els['lightbox']) closeLightbox();
  });

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      closeLightbox();
      if (nav?.classList.contains('is-open')) {
        nav.classList.remove('is-open');
        menu?.setAttribute('aria-expanded', 'false');
      }
    }
    const tag = (event.target.tagName || '').toLowerCase();
    const typing = tag === 'input' || tag === 'textarea' || tag === 'select' || event.target.isContentEditable;
    if (typing || event.ctrlKey || event.metaKey || event.altKey) return;
    if (event.key === '/') {
      event.preventDefault();
      location.hash = 'library';
      setTimeout(() => els['lib-search']?.focus(), 60);
      return;
    }
    if (event.code === 'Space' && !event.target.closest('button, a')) {
      event.preventDefault();
      radio.toggle();
    }
    if (event.key.toLowerCase() === 'm') radio.toggleMute();
    if (event.key.toLowerCase() === 'f') radio.toggleFavorite();
  });

  window.addEventListener('beforeunload', () => {
    /* nothing to flush: favorites/history/queue already persisted */
  });
}

/* ------------------------------------------------------------------ router */

function showRoute(name) {
  const route = ROUTES.includes(name) ? name : 'home';
  Object.entries(VIEWS).forEach(([key, view]) => {
    view.hidden = key !== route;
  });
  $$('#nav a, .footer-nav a').forEach((link) => {
    const target = (link.getAttribute('href') || '').replace('#', '');
    if (ROUTES.includes(target)) link.classList.toggle('is-active', target === route);
  });
  document.body.dataset.view = route;
  document.title = TITLES[route] || TITLES.home;
  window.scrollTo({ top: 0, behavior: 'auto' });
}

function renderRoute() {
  const hash = decodeURIComponent(location.hash.replace(/^#/, '')) || 'home';
  showRoute(hash.split('?')[0]);
}

/* -------------------------------------------------------------------- init */

/**
 * Continue the broadcast across the portal → station navigation.
 *
 * Browsers destroy the <audio> element with the document, so no static site
 * can keep one stream running through a real page change. The site dock
 * (site-radio.js) therefore leaves a hand-off note; here we rejoin the SAME
 * live position at once, so the song that was playing keeps playing instead
 * of stopping at the door. If the browser blocks autoplay after a navigation,
 * the ordinary "tap play once" path takes over.
 */
function resumeFromSiteHandoff() {
  /* The dock writes the note to localStorage (shared across tabs) so opening
     the station in a new tab continues the same song; sessionStorage is still
     read as a fallback for a page cached before that change. */
  const take = (store) => {
    try {
      const raw = store.getItem('vh.radio.handoff');
      if (raw) store.removeItem('vh.radio.handoff');
      return raw;
    } catch { return null; }
  };
  let note = null;
  const raw = take(localStorage) || take(sessionStorage);
  try { note = raw ? JSON.parse(raw) : null; } catch { note = null; }
  if (!note || !note.playing) return;
  if (Date.now() - Number(note.at || 0) > 120000) return;   // stale tab, not a hand-off

  /* If the visitor had skipped off the live clock, continue THAT track where
     it was — arriving on the station should never change the song. Live
     listeners rejoin the broadcast instead, which is the same track anyway. */
  const track = note.trackId ? TRACKS.find((t) => t.id === note.trackId) : null;

  /* Continue what the visitor was actually hearing whenever it differs from
     what this page's clock says is live. That happens after a skip, and it
     also covers a stale cached catalogue on the old page (different reel =
     different "now"); arriving must never change the song under them. */
  const liveNow = radio.track;      // set from the live reel at module load
  const sameAsLive = track && liveNow && liveNow.id === track.id;

  if (track && !sameAsLive) {
    radio.playTrack(track);
    const elapsed = Math.max(0, (Date.now() - Number(note.at || Date.now())) / 1000);
    const offset = Math.max(0, Number(note.offset) || 0) + Math.min(5, elapsed);
    if (offset > 1) {
      const audio = radio.audio;
      const seek = () => { try { audio.currentTime = offset; } catch { /* ignore */ } };
      if (audio.readyState >= 1) seek();
      else audio.addEventListener('loadedmetadata', seek, { once: true });
    }
  } else {
    radio.start();
  }

  /* Browsers may still refuse sound on a freshly loaded document. Rather than
     leaving the visitor on a silent, paused player, say what happened and make
     the one required tap unmissable. */
  setTimeout(() => {
    if (radio.playing) return;
    showResumePrompt();
  }, 1400);
}

function showResumePrompt() {
  if (document.getElementById('resume-prompt')) return;
  const pill = document.createElement('button');
  pill.id = 'resume-prompt';
  pill.type = 'button';
  pill.textContent = '▶  Tap to keep the radio going';
  pill.style.cssText = [
    'position:fixed', 'left:50%', 'bottom:96px', 'transform:translateX(-50%)', 'z-index:9997',
    'padding:11px 20px', 'border-radius:999px', 'cursor:pointer',
    'border:1px solid rgba(110,231,255,0.65)', 'color:#03121b',
    'background:linear-gradient(140deg,#d7f6ff,#6ee7ff 45%,#38b6ff)',
    'font:700 12px/1 "Segoe UI",system-ui,sans-serif', 'letter-spacing:0.1em',
    'text-transform:uppercase', 'box-shadow:0 10px 30px rgba(56,182,255,0.4)'
  ].join(';');
  const dismiss = () => pill.remove();
  pill.addEventListener('click', () => {
    radio.start();
    dismiss();
  });
  radio.addEventListener('state', (event) => {
    if (event.detail.playing) dismiss();
  });
  setTimeout(dismiss, 15000);
  document.body.appendChild(pill);
}

function init() {
  cacheEls();
  ROUTES.forEach((route) => {
    VIEWS[route] = $(`view-${route}`);
  });

  renderStats();
  renderGenreChips();
  renderLibrary();
  renderMiniAlbums();
  renderSchedules();
  renderAlbums();
  renderGallery();
  renderAbout();
  bindPlayer();
  bindLibrary();
  bindForms();
  bindChatEmoji();
  bindChrome();

  const year = $('year');
  if (year) year.textContent = String(new Date().getFullYear());

  community.init();

  createVisualizer($('viz-hero'), () => ({ track: radio.track, playing: radio.playing }), { bars: 72 });
  createVisualizer($('viz-radio'), () => ({ track: radio.track, playing: radio.playing }), { bars: 48 });

  window.addEventListener('hashchange', renderRoute);
  renderRoute();
  updateState(radio.snapshot());

  // keep the "next programme" countdown honest
  setInterval(() => {
    if (document.hidden) return;
    const target = $('home-next-program');
    if (target) target.textContent = `Now: ${programAt().name} · next show in ${formatCountdown(msUntilNextProgram())}`;
    const schedule = $('schedule-next');
    if (schedule) schedule.textContent = `Next programme in ${formatCountdown(msUntilNextProgram())}`;
  }, 30000);

  resumeFromSiteHandoff();

  if ('serviceWorker' in navigator && location.protocol === 'https:') {
    navigator.serviceWorker.register('sw.js').catch(() => { /* offline cache is optional */ });
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
