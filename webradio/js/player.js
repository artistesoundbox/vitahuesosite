/* The radio engine.
 *
 * One persistent <audio> element for the whole site. Two ways to listen:
 *
 *  LIVE      — synced to the deterministic station reel in station.js. Pause and
 *              come back, and you land where the station is now.
 *  PERSONAL  — free play: pick anything from the library, skip as you like.
 *              "Rejoin live" puts you back on the broadcast.
 *
 * Native media playback only: no Web Audio rerouting for the music, so mobile
 * lock-screen playback keeps working. Mic monitoring uses its own graph.
 */
import { TRACKS } from './catalog.js';
import { getLiveState, programAt, msUntilNextProgram } from './station.js';
import { isBlocked } from './blocklist.js';

const KEYS = {
  volume: 'vh.volume',
  muted: 'vh.muted',
  favorites: 'vh.favorites',
  history: 'vh.history'
};

function read(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw === null ? fallback : JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function write(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch { /* private mode — in-memory only */ }
}

const clamp01 = (n) => Math.min(1, Math.max(0, Number(n) || 0));

function shuffle(list) {
  const a = list.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export class Radio extends EventTarget {
  constructor() {
    super();

    this.audio = new Audio();
    this.audio.preload = 'auto';
    this.audio.setAttribute('playsinline', '');

    // Pages outside webradio/ (the main site) prefix catalogue paths with the
    // station folder; inside webradio/ the base stays empty.
    this.base = '';
    this.audio.volume = clamp01(read(KEYS.volume, 0.8));
    this.muted = !!read(KEYS.muted, false);
    this.audio.muted = this.muted;

    this.mode = 'live';
    this.started = false;
    this.playing = false;
    this.loading = false;
    this.track = null;
    this.entry = null;
    this.live = getLiveState();
    this.pendingSeek = null;
    this.error = '';
    this.failCount = 0;

    this.favorites = new Set(read(KEYS.favorites, []));
    this.history = read(KEYS.history, []);
    this.personalQueue = [];
    this.personalPast = [];

    this.sleepEndsAt = 0;
    this.sleepTimer = null;

    this.mic = { on: false, stream: null, ctx: null, recorder: null, chunks: [], url: '', volume: null };

    this.preload = new Audio();
    this.preload.preload = 'metadata';
    this.preload.muted = true;

    // One speaker per browser: if another instance (main page, widget, second
    // tab) starts playing, this one steps aside instead of echoing it. It also
    // stays aside: `yielded` stops the auto-resume paths (pageshow, the dock's
    // one-tap resume) from snatching the floor back and making the volume
    // ping-pong between tabs. Any explicit play/pause clears it.
    this.instanceId = Math.random().toString(36).slice(2, 10);
    this.yielded = false;
    this.transport = null;
    try {
      this.transport = new BroadcastChannel('vh-radio-transport');
      this.transport.onmessage = (event) => {
        const data = event.data;
        if (!data || data.from === this.instanceId) return;
        if (data.type !== 'playing') return;
        this.yielded = true;
        if (!this.audio.paused) this.audio.pause();
      };
    } catch { this.transport = null; }

    if (this.live) {
      this.track = this.live.entry.track;
      this.entry = this.live.entry;
    }

    this.bindAudio();
    this.bindMediaSession();

    this.pollTimer = setInterval(() => this.poll(), 500);
    this.emitState();
  }

  /* ---------------------------------------------------------------- events */

  bindAudio() {
    const a = this.audio;

    a.addEventListener('play', () => {
      this.playing = true;
      this.loading = false;
      this.error = '';
      this.setSessionState();
      this.emitState();
      try { this.transport?.postMessage({ type: 'playing', from: this.instanceId }); } catch { /* ignore */ }
    });

    a.addEventListener('pause', () => {
      this.playing = false;
      this.setSessionState();
      this.emitState();
    });

    a.addEventListener('waiting', () => {
      this.loading = true;
      this.emitState();
    });

    a.addEventListener('playing', () => {
      this.loading = false;
      this.emitState();
    });

    a.addEventListener('canplay', () => {
      this.loading = false;
      this.failCount = 0;
      this.emitState();
    });

    a.addEventListener('ended', () => this.handleEnded());

    a.addEventListener('error', () => {
      if (!a.getAttribute('src')) return;
      this.loading = false;
      this.error = 'This track could not be loaded.';
      this.emitState();
      this.dispatchEvent(new CustomEvent('notice', { detail: 'Track unavailable — moving on.' }));
      if (this.failCount++ < 3) setTimeout(() => this.advance(), 800);
    });

    a.addEventListener('timeupdate', () => this.emitTime());
  }

  bindMediaSession() {
    if (!('mediaSession' in navigator)) return;
    const session = navigator.mediaSession;
    const set = (name, handler) => {
      try { session.setActionHandler(name, handler); } catch { /* unsupported */ }
    };
    set('play', () => this.start());
    set('pause', () => this.pause());
    set('nexttrack', () => this.next());
    set('previoustrack', () => this.prev());
    set('stop', () => this.pause());
  }

  updateSession() {
    if (!('mediaSession' in navigator) || !this.track) return;
    const t = this.track;
    try {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: t.title,
        artist: t.artist,
        album: t.album,
        artwork: [
          { src: this.artFor(t), sizes: '512x512', type: t.art.endsWith('.svg') ? 'image/svg+xml' : 'image/jpeg' }
        ]
      });
      this.setSessionState();
    } catch { /* old browser */ }
  }

  setSessionState() {
    if (!('mediaSession' in navigator)) return;
    try { navigator.mediaSession.playbackState = this.playing ? 'playing' : 'paused'; } catch { /* ignore */ }
  }

  emitState() {
    this.dispatchEvent(new CustomEvent('state', { detail: this.snapshot() }));
  }

  emitTime() {
    this.dispatchEvent(new CustomEvent('time', {
      detail: { position: this.audio.currentTime || 0, duration: this.track?.duration || 0 }
    }));
  }

  notice(message) {
    this.dispatchEvent(new CustomEvent('notice', { detail: message }));
  }

  handleEnded() {
    if (this.mode === 'personal') {
      this.next();
      return;
    }
    const state = getLiveState();
    if (!state) return;
    this.playLive(state.entry, state.offset);
  }

  /** Move on without abandoning the live timeline. */
  advance() {
    if (this.mode === 'personal') {
      this.next();
      return;
    }
    const state = getLiveState();
    if (!state) return;
    const nextEntry = state.entry.key === this.entry?.key ? state.queue[0] : state.entry;
    if (nextEntry) this.playLive(nextEntry, nextEntry === state.entry ? state.offset : 0);
  }

  /* ---------------------------------------------------------------- clock */

  poll() {
    const state = getLiveState();
    if (!state) return;
    this.live = state;

    if (this.mode === 'live') {
      if (!this.started) {
        this.entry = state.entry;
        this.track = state.entry.track;
      } else if (this.playing) {
        if (!this.entry || state.entry.key !== this.entry.key) {
          this.playLive(state.entry, state.offset);
        } else if (Math.abs(this.audio.currentTime - state.offset) > 12) {
          try { this.audio.currentTime = state.offset; } catch { /* not seekable yet */ }
        }
      }
    }
    this.emitState();
  }

  /* ---------------------------------------------------------------- control */

  start() {
    this.yielded = false;   // an explicit play here takes the floor back
    this.started = true;
    if (this.mode === 'personal' && this.track) {
      this.audio.play().catch((err) => this.playFailed(err));
      return;
    }
    const state = getLiveState();
    if (!state) return;
    this.playLive(state.entry, state.offset);
  }

  toggle() {
    if (this.playing) this.pause();
    else this.start();
  }

  pause() {
    this.audio.pause();
    this.playing = false;
    this.yielded = false;
    this.emitState();
  }

  playLive(entry, offset = 0) {
    const a = this.audio;

    // Joining in the final second of a track would look like a failed play:
    // roll straight into whatever the station is starting next.
    if (entry && offset >= entry.track.duration - 1.2) {
      const state = getLiveState();
      const upcoming = state?.queue?.[0];
      if (upcoming) {
        entry = upcoming;
        offset = Math.max(0, (Date.now() - upcoming.startMs) / 1000);
      }
    }

    this.mode = 'live';
    this.entry = entry;
    this.track = entry.track;
    this.started = true;
    this.loading = true;
    this.error = '';
    this.pendingSeek = Math.max(0, offset);

    const applySeek = () => {
      if (this.pendingSeek == null) return;
      try { a.currentTime = this.pendingSeek; } catch { /* ignore */ }
      this.pendingSeek = null;
    };

    if (a.getAttribute('src') !== this.srcFor(entry.track)) {
      a.src = this.srcFor(entry.track);
      a.addEventListener('loadedmetadata', applySeek, { once: true });
    } else if (a.readyState >= 1) {
      applySeek();
    } else {
      a.addEventListener('loadedmetadata', applySeek, { once: true });
    }

    this.onTrackChange();
    a.play().then(() => {
      this.loading = false;
      this.emitState();
    }).catch((err) => this.playFailed(err));
    this.preloadNext();
  }

  playTrack(track, options = {}) {
    const a = this.audio;
    this.mode = 'personal';
    this.entry = null;
    this.track = track;
    this.started = true;
    this.loading = true;
    this.error = '';
    this.pendingSeek = 0;

    if (options.queue && options.queue.length) this.personalQueue = options.queue.slice();
    else if (!this.personalQueue.length) this.personalQueue = this.buildQueue(track);

    a.src = this.srcFor(track);
    const applySeek = () => {
      if (this.pendingSeek == null) return;
      try { a.currentTime = this.pendingSeek; } catch { /* ignore */ }
      this.pendingSeek = null;
    };
    a.addEventListener('loadedmetadata', applySeek, { once: true });

    this.onTrackChange();
    a.play().then(() => {
      this.loading = false;
      this.emitState();
    }).catch((err) => this.playFailed(err));
    this.preloadNext();
  }

  playFailed(err) {
    this.loading = false;
    this.playing = false;
    if (err && err.name === 'NotAllowedError') {
      this.notice('Tap play once to start the radio.');
    } else {
      this.error = 'Playback was interrupted.';
      this.notice('Playback could not start. Try again.');
    }
    this.emitState();
  }

  next() {
    if (this.mode === 'live') {
      this.skipLive();
      return;
    }
    this.advancePersonal(1);
  }

  skipLive() {
    const current = this.track || getLiveState()?.entry.track;
    this.mode = 'personal';
    this.entry = null;
    if (!this.personalQueue.length) this.personalQueue = this.buildQueue(current);
    this.notice('You are off the live timeline — rejoin any time.');
    this.advancePersonal(1);
  }

  prev() {
    if (this.mode === 'live') {
      this.rejoinLive();
      this.notice('Back on the live broadcast.');
      return;
    }
    const previous = this.personalPast.pop();
    if (!previous) {
      this.rejoinLive();
      return;
    }
    if (this.track) this.personalQueue.unshift(this.track);
    this.playTrack(previous);
  }

  advancePersonal(direction) {
    if (!this.personalQueue.length) {
      this.personalQueue = this.buildQueue(this.track);
    }
    const next = this.personalQueue.shift();
    if (!next) { this.rejoinLive(); return; }
    if (this.track) this.personalPast.push(this.track);
    this.playTrack(next, { queue: this.personalQueue });
  }

  rejoinLive() {
    const state = getLiveState();
    if (!state) return;
    this.personalQueue = [];
    this.personalPast = [];
    this.playLive(state.entry, state.offset);
  }

  seek(seconds) {
    if (this.mode === 'live') return;
    try { this.audio.currentTime = Math.max(0, Number(seconds) || 0); } catch { /* ignore */ }
    this.emitTime();
  }

  setVolume(value) {
    const v = clamp01(value);
    this.audio.volume = v;
    this.audio.muted = false;
    this.muted = false;
    write(KEYS.volume, v);
    write(KEYS.muted, false);
    this.emitState();
  }

  adjustVolume(delta) {
    this.setVolume(this.audio.volume + delta);
  }

  toggleMute() {
    this.muted = !this.muted;
    this.audio.muted = this.muted;
    write(KEYS.muted, this.muted);
    this.emitState();
  }

  toggleFavorite(track = this.track) {
    if (!track) return false;
    const id = track.id;
    const active = !this.favorites.has(id);
    if (active) this.favorites.add(id);
    else this.favorites.delete(id);
    write(KEYS.favorites, [...this.favorites]);
    this.dispatchEvent(new CustomEvent('favorite', { detail: { id, active } }));
    this.emitState();
    return active;
  }

  isFavorite(track) {
    return !!(track && this.favorites.has(track.id));
  }

  /* ------------------------------------------------------------ asset base */

  /** Prefix catalogue paths when the player is embedded outside webradio/. */
  setBase(base) {
    this.base = base ? String(base).replace(/\/?$/, '/') : '';
  }

  resolve(path) {
    if (!path) return path;
    if (/^(https?:)?\/\//i.test(path) || path.startsWith('/')) return path;
    return this.base + path;
  }

  srcFor(track) {
    return track ? this.resolve(track.src) : '';
  }

  artFor(track) {
    return track ? this.resolve(track.art) : '';
  }

  /* ---------------------------------------------------------------- queue */

  buildQueue(seed, size = 40) {
    const seedGenres = new Set(seed?.genres || []);
    const recent = new Set(this.history.slice(0, 8).map((h) => h.id));
    if (seed) recent.add(seed.id);

    /* Disliked songs never enter a personal queue either — the blocklist is a
       playlist rule, not just a live-reel filter. */
    const scored = TRACKS
      .filter((t) => !recent.has(t.id) && !isBlocked(t.id))
      .map((t) => ({
        track: t,
        score: t.genres.filter((g) => seedGenres.has(g)).length * 2 + Math.random() * 3
      }))
      .sort((a, b) => b.score - a.score)
      .map((s) => s.track);

    const rest = shuffle(TRACKS.filter((t) => !scored.includes(t) && !isBlocked(t.id)));
    return [...scored, ...rest].slice(0, size);
  }

  upNext(count = 5) {
    if (this.mode === 'live') {
      const state = getLiveState(Date.now(), Math.max(count, 6));
      return (state?.queue || []).slice(0, count).map((e) => e.track);
    }
    return this.personalQueue.slice(0, count);
  }

  onTrackChange() {
    if (!this.track) return;
    const h = this.history.filter((x) => x.id !== this.track.id);
    h.unshift({ id: this.track.id, at: Date.now() });
    this.history = h.slice(0, 40);
    write(KEYS.history, this.history);
    this.updateSession();
    this.emitState();
    this.dispatchEvent(new CustomEvent('trackchange', { detail: this.track }));
  }

  preloadNext() {
    const next = this.upNext(1)[0];
    if (!next) return;
    try {
      if (this.preload.getAttribute('src') !== this.srcFor(next)) this.preload.src = this.srcFor(next);
    } catch { /* ignore */ }
  }

  recentlyPlayed(count = 6) {
    return this.history
      .slice(0, count + 1)
      .map((h) => TRACKS.find((t) => t.id === h.id))
      .filter(Boolean);
  }

  /* ---------------------------------------------------------------- sleep */

  setSleep(minutes) {
    clearTimeout(this.sleepTimer);
    this.sleepTimer = null;
    this.sleepEndsAt = 0;

    if (!minutes) {
      this.notice('Sleep timer off.');
      this.emitState();
      return;
    }

    this.sleepEndsAt = Date.now() + minutes * 60000;
    this.sleepTimer = setTimeout(() => {
      this.pause();
      this.sleepEndsAt = 0;
      this.notice('Sleep timer ended. Goodnight.');
      this.emitState();
    }, minutes * 60000);
    this.notice(`Sleep timer set — ${minutes} minutes.`);
    this.emitState();
  }

  /* ------------------------------------------------------------------ mic */

  async toggleMic() {
    if (this.mic.on) {
      this.stopMic();
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
      });
      const Ctx = window.AudioContext || window.webkitAudioContext;
      const ctx = new Ctx();
      await ctx.resume();
      const source = ctx.createMediaStreamSource(stream);
      const gain = ctx.createGain();
      gain.gain.value = 0.9;
      source.connect(gain).connect(ctx.destination);

      let recorder = null;
      const chunks = [];
      if (window.MediaRecorder) {
        try {
          recorder = new MediaRecorder(stream);
          recorder.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
          recorder.start();
        } catch { recorder = null; }
      }

      this.mic = {
        on: true,
        stream,
        ctx,
        gain,
        recorder,
        chunks,
        url: '',
        volume: this.audio.volume
      };
      this.audio.volume = Math.max(0.04, this.audio.volume * 0.25);
      this.notice('Mic open — headphones recommended to avoid feedback.');
      this.emitState();
    } catch (err) {
      this.notice('Microphone unavailable: ' + (err?.message || 'permission denied'));
    }
  }

  stopMic() {
    const mic = this.mic;
    if (!mic.on) return;
    try { mic.recorder?.stop(); } catch { /* ignore */ }
    if (mic.recorder) {
      mic.recorder.onstop = () => {
        try {
          const blob = new Blob(mic.chunks, { type: mic.recorder.mimeType || 'audio/webm' });
          this.mic.url = URL.createObjectURL(blob);
          this.emitState();
        } catch { /* ignore */ }
      };
    }
    mic.stream?.getTracks().forEach((t) => t.stop());
    try { mic.ctx?.close(); } catch { /* ignore */ }
    if (mic.volume != null) this.audio.volume = mic.volume;
    this.mic = { on: false, stream: null, ctx: null, recorder: null, chunks: [], url: mic.url || '', volume: null };
    this.notice('Mic closed.');
    this.emitState();
  }

  /* -------------------------------------------------------------- snapshot */

  position() {
    if (this.audio.currentTime > 0 && (this.playing || this.started)) return this.audio.currentTime;
    return this.mode === 'live' ? (this.live?.offset || 0) : 0;
  }

  snapshot() {
    const state = getLiveState();
    const program = state?.entry.program || programAt();
    return {
      mode: this.mode,
      started: this.started,
      playing: this.playing,
      loading: this.loading,
      error: this.error,
      track: this.track,
      position: this.position(),
      duration: this.track?.duration || 0,
      volume: this.audio.volume,
      muted: this.muted,
      favorite: this.isFavorite(this.track),
      queue: this.upNext(6),
      recent: this.recentlyPlayed(6),
      favorites: [...this.favorites],
      program,
      nextProgram: msUntilNextProgram(),
      sleepEndsAt: this.sleepEndsAt,
      micOn: this.mic.on,
      micUrl: this.mic.url
    };
  }
}

export const radio = new Radio();

/* Debug handle — handy in the console, harmless in production. */
if (typeof window !== 'undefined') window.__vhRadio = radio;
