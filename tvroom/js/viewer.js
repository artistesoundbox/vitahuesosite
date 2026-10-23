/**
 * The full-screen viewer.
 *
 * The room's <video> element is moved in here while the viewer is open, so
 * the picture never restarts when you go from the room to the big screen.
 * The channel drawer on the right holds iptv-org's whole list: search,
 * category and country filters, and a clear flag on the feeds a browser
 * cannot open (plain HTTP, DASH, transport streams) so those can go to VLC.
 */

import { openInVlc, copyStreamUrl } from './player.js';
import { ChannelHealth } from './channels.js';

const PAGE_SIZE = 90;
const IDLE_MS = 3200;

const $ = (id) => document.getElementById(id);

function initials(name) {
  const clean = (name || '?').replace(/[^\p{L}\p{N} ]/gu, '').trim();
  if (!clean) return 'TV';
  const parts = clean.split(/\s+/);
  const first = parts[0] ? parts[0][0] : 'T';
  const second = parts[1] ? parts[1][0] : parts[0] ? parts[0][1] || '' : 'V';
  return (first + second).toUpperCase();
}

export class Viewer {
  constructor({ player, loadCatalog, onOpen, onClose }) {
    this.player = player;
    this._fetchCatalog = loadCatalog;
    this.onOpen = onOpen || (() => {});
    this.onClose = onClose || (() => {});

    this.isOpen = false;
    this.catalog = null;
    this.catalogError = null;
    this.filtered = [];
    this.rendered = 0;
    this.pageSize = PAGE_SIZE;
    this.activeUrl = '';
    this._catalogPromise = null;
    this._filterTimer = 0;
    this._idleTimer = 0;
    this._mutedBefore = true;
    this._pendingUnsupported = null;
    this.health = new ChannelHealth();

    this.els = {
      viewer: $('viewer'),
      main: $('viewer-main'),
      frame: $('video-frame'),
      mount: $('video-mount'),
      top: $('viewer-top'),
      idle: $('viewer-idle'),
      error: $('viewer-error'),
      errorMsg: $('viewer-error-msg'),
      errorRetry: $('ve-retry'),
      errorNext: $('ve-next'),
      errorVlc: $('ve-vlc'),
      nowName: $('viewer-now-name'),
      nowMeta: $('viewer-now-meta'),
      close: $('viewer-close'),
      play: $('ch-play'),
      prev: $('ch-prev'),
      next: $('ch-next'),
      mute: $('ch-mute'),
      volume: $('ch-volume'),
      random: $('ch-random'),
      vlc: $('ch-vlc'),
      fullscreen: $('ch-fullscreen'),
      browser: $('browser'),
      browserTab: $('browser-tab'),
      browserClose: $('browser-close'),
      browserCount: $('browser-count'),
      search: $('ch-search'),
      group: $('ch-group'),
      country: $('ch-country'),
      playableOnly: $('ch-only-playable'),
      hideDead: $('ch-hide-dead'),
      resetDead: $('ch-reset-dead'),
      deadCount: $('dead-count'),
      list: $('chlist'),
      rows: $('chlist-rows'),
      status: $('chlist-status'),
      sentinel: $('chlist-sentinel'),
      reload: $('ch-reload'),
      toast: $('toast'),
      stage: $('stage-source'),
    };

    this._bindPlayer();
    this._bindUi();
    this._observeSentinel();
    this._syncVolume();
    this._syncDeadUi();
    this._toggleBrowser(true);
  }

  /* ── player → UI ─────────────────────────────────────────────────────── */

  _bindPlayer() {
    const { player } = this;

    player.on('channel', (channel) => {
      this.activeUrl = channel ? channel.url : '';
      this.els.error.hidden = true;
      this.els.idle.hidden = true;
      this._setNowPlaying(channel);
      this._markActiveRow();
    });

    player.on('state', (state) => {
      this.els.viewer.classList.toggle('is-playing', state === 'playing');
      if (state === 'playing') {
        this.els.error.hidden = true;
        this.els.idle.hidden = true;
        this._armIdle();
      } else if (state === 'loading') {
        this.els.idle.hidden = !!player.channel;
      }
    });

    player.on('error', ({ message }) => {
      // A channel that never produced a frame is dead for this browser: note
      // it so it stops turning up, but leave mid-playback drops alone.
      if (!player.playedSinceTune && player.channel) this._markDead(player.channel.url);
      this.showError(message || 'The stream could not be opened.', 'stream');
      this._showControls();
    });

    player.on('blocked', () => {
      this.showToast('Press play to start — this browser needs a tap first.');
      this._showControls();
    });

    player.on('volume', () => this._syncVolume());
  }

  _setNowPlaying(channel) {
    if (!channel) {
      this.els.nowName.textContent = 'No channel';
      this.els.nowMeta.textContent = '';
      return;
    }
    this.els.nowName.textContent = channel.name || 'Unknown channel';
    const meta = [channel.group, channel.countryName || channel.country, channel.quality ? `${channel.quality}p` : '']
      .filter(Boolean)
      .join(' · ');
    this.els.nowMeta.textContent = meta;
  }

  _syncVolume() {
    const { video } = this.player;
    const muted = video.muted || video.volume === 0;
    this.els.viewer.classList.toggle('is-muted', muted);
    this.els.volume.value = String(video.muted ? 0 : video.volume);
    this.els.mute.setAttribute('aria-pressed', muted ? 'true' : 'false');
  }

  /* ── UI wiring ───────────────────────────────────────────────────────── */

  _bindUi() {
    const { els, player } = this;

    els.close.addEventListener('click', () => this.close());
    els.browserClose.addEventListener('click', () => this._toggleBrowser(false));
    els.browserTab.addEventListener('click', () => this._toggleBrowser(true));

    els.play.addEventListener('click', () => {
      if (!player.channel) {
        this.showToast('Pick a channel first.');
        this._toggleBrowser(true);
        return;
      }
      player.toggle();
    });

    els.prev.addEventListener('click', () => this.zap(-1));
    els.next.addEventListener('click', () => this.zap(1));
    els.random.addEventListener('click', () => this.zapRandom());

    els.mute.addEventListener('click', () => {
      player.setMuted(!player.video.muted);
      if (!player.video.muted && player.video.volume === 0) player.setVolume(0.8);
    });

    els.volume.addEventListener('input', () => {
      player.setVolume(Number(els.volume.value));
      player.setMuted(Number(els.volume.value) === 0);
      this.els.volume.value = String(player.video.volume);
    });

    els.vlc.addEventListener('click', () => this._sendToVlc(player.channel));
    els.fullscreen.addEventListener('click', () => this._toggleFullscreen());

    els.errorRetry.addEventListener('click', () => {
      if (this._pendingUnsupported) {
        this._openAsVlc(this._pendingUnsupported);
        return;
      }
      if (player.channel) player.play(player.channel);
    });
    els.errorNext.addEventListener('click', () => {
      this.els.error.hidden = true;
      this._pendingUnsupported = null;
      this.zap(1);
    });
    els.errorVlc.addEventListener('click', () => {
      this._sendToVlc(this._pendingUnsupported || player.channel);
    });

    els.search.addEventListener('input', () => {
      clearTimeout(this._filterTimer);
      this._filterTimer = window.setTimeout(() => this._applyFilters(), 130);
    });
    els.group.addEventListener('change', () => this._applyFilters());
    els.country.addEventListener('change', () => this._applyFilters());
    els.playableOnly.addEventListener('change', () => this._applyFilters());
    els.hideDead.addEventListener('change', () => this._applyFilters());
    els.resetDead.addEventListener('click', () => {
      this.health.clear();
      this._syncDeadUi();
      this._applyFilters();
      this.showToast('Dead-channel marks cleared.');
    });
    els.reload.addEventListener('click', () => this._reloadCatalog());

    // Cropped channel names are worth reading in full
    els.rows.addEventListener('pointerover', (ev) => {
      const row = ev.target.closest && ev.target.closest('.ch');
      if (row) row.title = row.dataset.title || '';
    });

    els.rows.addEventListener('click', (ev) => {
      const row = ev.target.closest && ev.target.closest('.ch');
      if (!row) return;
      const channel = this.catalog && this.catalog.channels[Number(row.dataset.index)];
      if (channel) this.select(channel);
    });

    this.els.viewer.addEventListener('pointermove', () => this._showControls());
    this.els.viewer.addEventListener('pointerdown', () => this._showControls());

    document.addEventListener('keydown', (ev) => this._onKey(ev));

    // Double-clicking the picture goes full screen, like any player.
    els.frame.addEventListener('dblclick', () => this._toggleFullscreen());
  }

  _onKey(ev) {
    if (!this.isOpen) return;
    const tag = (ev.target && ev.target.tagName) || '';
    if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') {
      if (ev.key === 'Escape') ev.target.blur();
      return;
    }

    switch (ev.key) {
      case 'Escape':
        if (document.fullscreenElement) return;
        this.close();
        ev.preventDefault();
        break;
      case ' ':
        this.player.toggle();
        this._showControls();
        ev.preventDefault();
        break;
      case 'ArrowRight':
        this.zap(1);
        ev.preventDefault();
        break;
      case 'ArrowLeft':
        this.zap(-1);
        ev.preventDefault();
        break;
      case 'c':
      case 'C':
        this._toggleBrowser(this.els.viewer.classList.contains('browser-closed'));
        break;
      case 'f':
      case 'F':
        this._toggleFullscreen();
        break;
      case 'm':
      case 'M':
        this.player.setMuted(!this.player.video.muted);
        break;
      default:
        break;
    }
  }

  _showControls() {
    this.els.viewer.classList.remove('is-idle');
    this._armIdle();
  }

  _armIdle() {
    clearTimeout(this._idleTimer);
    if (this.player.state !== 'playing') return;
    this._idleTimer = window.setTimeout(() => {
      if (this.player.state === 'playing' && this.isOpen) {
        this.els.viewer.classList.add('is-idle');
      }
    }, IDLE_MS);
  }

  _toggleFullscreen() {
    if (document.fullscreenElement) {
      document.exitFullscreen().catch(() => {});
    } else if (this.els.viewer.requestFullscreen) {
      this.els.viewer.requestFullscreen().catch(() => {});
    }
  }

  /* ── open / close ────────────────────────────────────────────────────── */

  open(channel) {
    if (this.isOpen) {
      if (channel) this.select(channel);
      return;
    }
    this.isOpen = true;
    this.els.viewer.hidden = false;
    this.els.viewer.classList.remove('is-idle');
    document.body.classList.add('viewer-open');

    // Take over playback: the same <video>, now on the big screen, with sound.
    this._mutedBefore = this.player.muted;
    this.player.mount(this.els.mount);
    this.player.setMuted(false);
    if (this.player.video.volume === 0) this.player.setVolume(0.8);
    this._syncVolume();

    this.els.error.hidden = true;
    this.els.idle.hidden = !!this.player.channel;
    this._setNowPlaying(this.player.channel);

    // The list is open by default: picking a channel is why you came.
    this._toggleBrowser(!channel);
    this._showControls();
    this.onOpen();

    if (channel) {
      this.select(channel);
    } else {
      this._ensureCatalog().then((catalog) => {
        if (catalog) this._revealActive();
      });
    }

    if (this.player.channel && this.player.video.paused) this.player.toggle();
  }

  close() {
    if (!this.isOpen) return;
    this.isOpen = false;
    clearTimeout(this._idleTimer);
    this.els.viewer.hidden = true;
    this.els.viewer.classList.remove('is-idle');
    document.body.classList.remove('viewer-open');
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    this.player.mount(this.els.stage);
    this.player.setMuted(this._mutedBefore);
    this._syncVolume();
    this.onClose(this.player.channel);
  }

  select(channel) {
    if (!channel) return;
    if (!channel.playable) {
      this._openAsVlc(channel);
      return;
    }
    this.els.error.hidden = true;
    this._pendingUnsupported = null;
    this.els.idle.hidden = true;
    this.player.play(channel);
    if (window.innerWidth <= 860) this._toggleBrowser(false);
  }

  _openAsVlc(channel) {
    this._pendingUnsupported = channel;
    const why =
      channel.ext === 'mpd'
        ? 'This channel streams DASH, which browsers cannot play.'
        : channel.ext === 'ts' || channel.ext === 'flv'
          ? 'This channel is a raw transport stream, not HLS.'
          : 'This channel is plain HTTP, which the browser blocks on an HTTPS page.';
    this.showError(`${why} VLC plays it — press Open in VLC to download the playlist.`, 'unsupported');
    this.showToast(`${channel.name} — this one needs VLC`);
  }

  showError(message, kind = 'stream') {
    const { els } = this;
    els.idle.hidden = true;
    els.error.hidden = false;
    els.errorMsg.textContent = message;
    const unsupported = kind === 'unsupported';
    els.errorRetry.hidden = unsupported;
    els.errorRetry.textContent = 'Try again';
    els.errorVlc.hidden = false;
    if (!unsupported) this._pendingUnsupported = null;
  }

  showToast(message) {
    const el = this.els.toast;
    el.textContent = message;
    el.hidden = false;
    requestAnimationFrame(() => el.classList.add('is-visible'));
    clearTimeout(this._toastTimer);
    this._toastTimer = window.setTimeout(() => {
      el.classList.remove('is-visible');
      this._toastTimer = window.setTimeout(() => {
        el.hidden = true;
      }, 260);
    }, 3400);
  }

  _sendToVlc(channel) {
    if (!channel) {
      this.showToast('Nothing playing to send to VLC.');
      return;
    }
    if (openInVlc(channel)) {
      this.showToast(`Downloaded ${channel.name} as an .m3u — open it with VLC.`);
    } else {
      copyStreamUrl(channel).then((ok) => {
        this.showToast(ok ? 'Stream URL copied.' : 'Could not build the VLC playlist.');
      });
    }
  }

  /* ── channel list ────────────────────────────────────────────────────── */

  async _ensureCatalog() {
    if (this.catalog) return this.catalog;
    if (this._catalogPromise) return this._catalogPromise;

    this._setStatus('Downloading the iptv-org playlist…');
    this._catalogPromise = this._fetchCatalog()
      .then((catalog) => {
        this.catalog = catalog;
        this.catalogError = null;
        this._populateFilters();
        this._applyFilters();
        this.els.browserCount.textContent = `${catalog.channels.length.toLocaleString()} channels`;
        this.els.search.placeholder = `Search ${catalog.channels.length.toLocaleString()} channels…`;
        return catalog;
      })
      .catch((err) => {
        console.error('[tvroom] catalogue failed', err);
        this.catalogError = err;
        this._setStatus(`The channel list could not load (${err.message}). iptv-org may be unreachable — try “Reload list”.`);
        return null;
      })
      .finally(() => {
        this._catalogPromise = null;
      });

    return this._catalogPromise;
  }

  _reloadCatalog() {
    this.catalog = null;
    this.catalogError = null;
    this._catalogPromise = null;
    this.filtered = [];
    this.rendered = 0;
    this.els.rows.textContent = '';
    this._setStatus('Reloading the channel list…');
    this._ensureCatalog().then(() => this._revealActive());
  }

  _setStatus(text) {
    this.els.status.textContent = text;
    this.els.status.hidden = !text;
  }

  _populateFilters() {
    const { catalog } = this;
    const groupSelect = this.els.group;
    const countrySelect = this.els.country;

    groupSelect.length = 1;
    for (const [group, count] of catalog.groups) {
      const option = document.createElement('option');
      option.value = group;
      option.textContent = `${group} (${count.toLocaleString()})`;
      groupSelect.appendChild(option);
    }

    countrySelect.length = 1;
    const nameOf = (code) => {
      try {
        return new Intl.DisplayNames(['en'], { type: 'region' }).of(code) || code;
      } catch {
        return code;
      }
    };
    for (const [code, count] of catalog.countries) {
      const option = document.createElement('option');
      option.value = code;
      option.textContent = `${nameOf(code)} (${count.toLocaleString()})`;
      countrySelect.appendChild(option);
    }
  }

  _applyFilters() {
    if (!this.catalog) return;
    const query = this.els.search.value;
    const group = this.els.group.value;
    const country = this.els.country.value;
    const playableOnly = this.els.playableOnly.checked;
    const hideDead = this.els.hideDead.checked;

    this.filtered = this.catalog.filter({
      query,
      group,
      country,
      playableOnly,
      hideDead,
      isDead: (url) => this.health.isDead(url),
    });
    this._syncDeadUi();
    this.rendered = 0;
    this.els.rows.textContent = '';
    this.els.list.scrollTop = 0;

    this.els.browserCount.textContent = `${this.filtered.length.toLocaleString()} of ${this.catalog.channels.length.toLocaleString()}`;

    if (!this.filtered.length) {
      this._setStatus('No channels match those filters. Try clearing the search.');
      return;
    }
    this._setStatus('');
    this._renderPage();
  }

  _renderPage() {
    if (this.rendered >= this.filtered.length) return;
    const end = Math.min(this.filtered.length, this.rendered + this.pageSize);
    const frag = document.createDocumentFragment();

    for (let i = this.rendered; i < end; i += 1) {
      frag.appendChild(this._buildRow(this.filtered[i]));
    }

    this.els.rows.appendChild(frag);
    this.rendered = end;
    if (this.rendered >= this.filtered.length) this._setStatus(this.rendered ? '' : 'No channels here.');
  }

  _buildRow(channel) {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'ch';
    row.dataset.index = String(channel.index);
    row.dataset.url = channel.url;
    row.dataset.title = `${channel.name}${channel.group ? ` — ${channel.group}` : ''}\n${channel.url}`;
    row.setAttribute('role', 'option');
    if (channel.url === this.activeUrl) row.classList.add('is-active');

    const logo = document.createElement('span');
    logo.className = 'ch-logo';
    logo.textContent = initials(channel.name);
    if (channel.logo) {
      const img = document.createElement('img');
      img.loading = 'lazy';
      img.decoding = 'async';
      img.referrerPolicy = 'no-referrer';
      img.alt = '';
      img.src = channel.logo;
      img.addEventListener('error', () => {
        img.remove();
        logo.textContent = initials(channel.name);
      });
      logo.textContent = '';
      logo.appendChild(img);
    }

    const body = document.createElement('span');
    body.className = 'ch-body';
    const name = document.createElement('span');
    name.className = 'ch-name';
    name.textContent = channel.name;
    const meta = document.createElement('span');
    meta.className = 'ch-meta';
    meta.textContent = [
      channel.group,
      channel.country || '',
      channel.quality ? `${channel.quality}p` : '',
    ]
      .filter(Boolean)
      .join(' · ');
    body.append(name, meta);

    row.append(logo, body);

    if (this.health.isDead(channel.url)) {
      row.classList.add('is-dead');
      const badge = document.createElement('span');
      badge.className = 'ch-flag ch-flag-dead';
      badge.textContent = 'Dead';
      badge.title = 'This feed failed in this browser — reset the marks in the footer to try again';
      row.appendChild(badge);
    } else if (!channel.playable) {
      const badge = document.createElement('span');
      badge.className = 'ch-flag';
      badge.textContent = 'VLC';
      badge.title = 'This feed needs a desktop player';
      row.appendChild(badge);
    } else if (channel.url === this.activeUrl) {
      const now = document.createElement('span');
      now.className = 'ch-now';
      now.textContent = 'On air';
      row.appendChild(now);
    }

    return row;
  }

  _markActiveRow() {
    const rows = this.els.rows.querySelectorAll('.ch');
    for (const row of rows) {
      const active = row.dataset.url === this.activeUrl;
      row.classList.toggle('is-active', active);
      const existing = row.querySelector('.ch-now');
      if (active && !existing && !row.querySelector('.ch-flag')) {
        const now = document.createElement('span');
        now.className = 'ch-now';
        now.textContent = 'On air';
        row.appendChild(now);
      } else if (!active && existing) {
        existing.remove();
      }
    }
  }

  _revealActive() {
    if (!this.activeUrl || !this.filtered.length) return;
    const idx = this.filtered.findIndex((ch) => ch.url === this.activeUrl);
    // Only scroll to the playing channel when it is close enough that doing
    // so does not build thousands of rows. Beyond that the search box is the
    // better way to find it.
    if (idx < 0 || idx > this.rendered + 240) return;
    const target = Math.min(this.filtered.length, Math.max(idx + 12, this.rendered));
    while (this.rendered < target) this._renderPage();
    const row = this.els.rows.querySelector(`.ch[data-url="${CSS.escape(this.activeUrl)}"]`);
    if (row && typeof row.scrollIntoView === 'function') {
      row.scrollIntoView({ block: 'nearest' });
    }
  }

  _observeSentinel() {
    this._sentinelObserver = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting && this.filtered.length) this._renderPage();
        }
      },
      { root: this.els.list, rootMargin: '600px 0px' }
    );
    this._sentinelObserver.observe(this.els.sentinel);
  }

  _toggleBrowser(open) {
    if (window.__tvroomDebug) console.trace('[tvroom] browser toggle', open);
    this.els.viewer.classList.toggle('browser-closed', !open);
    if (open) this._showControls();
  }

  /* ── zapping ─────────────────────────────────────────────────────────── */

  _zapPool() {
    if (!this.filtered.length) return [];
    const alive = this.filtered.filter((ch) => ch.playable && !this.health.isDead(ch.url));
    if (alive.length) return alive;
    const playable = this.filtered.filter((ch) => ch.playable);
    return playable.length ? playable : this.filtered;
  }

  _markDead(url) {
    if (this.health.markDead(url)) this._syncDeadUi();
    const row = this.els.rows.querySelector(`.ch[data-url="${CSS.escape(url)}"]`);
    if (row) {
      row.classList.add('is-dead');
      const existing = row.querySelector('.ch-flag');
      if (existing) existing.remove();
      const badge = document.createElement('span');
      badge.className = 'ch-flag ch-flag-dead';
      badge.textContent = 'Dead';
      row.appendChild(badge);
      if (this.els.hideDead.checked) row.remove();
    }
  }

  _syncDeadUi() {
    const count = this.health.size;
    this.els.deadCount.textContent = String(count);
    this.els.resetDead.hidden = count === 0;
  }

  zap(direction) {
    const pool = this._zapPool();
    if (!pool.length) {
      this.showToast('The channel list is still loading.');
      return;
    }
    const current = this.player.channel;
    let idx = current ? pool.findIndex((ch) => ch.url === current.url) : -1;
    if (idx === -1) idx = direction > 0 ? -1 : 0;
    const next = pool[(idx + direction + pool.length) % pool.length];
    this.select(next);
  }

  zapRandom() {
    const pool = this._zapPool();
    if (!pool.length) {
      this.showToast('The channel list is still loading.');
      return;
    }
    let pick = pool[Math.floor(Math.random() * pool.length)];
    if (pool.length > 1 && this.player.channel && pick.url === this.player.channel.url) {
      pick = pool[(pool.indexOf(pick) + 1) % pool.length];
    }
    this.select(pick);
  }

  /** Used by the room's Zap button while the viewer is closed. */
  zapFromRoom() {
    if (!this.catalog) {
      this._ensureCatalog().then((catalog) => {
        if (catalog) this.zap(1);
      });
      return;
    }
    this.zap(1);
  }
}
