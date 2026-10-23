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
import { getLiveState, programAt, msUntilNextProgram, setLiveSource } from './station.js';
import { isBlocked } from './blocklist.js';
import { worldTrack } from './world.js';
import { LOUDNESS } from './loudness.js';

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
const dBtoGain = (db) => (Number.isFinite(Number(db)) ? Math.pow(10, Number(db) / 20) : 1);

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
    /* `volume` is the listener's level. What actually reaches the element is
       that level times the track's loudness trim (see applyVolume). */
    this.volume = clamp01(read(KEYS.volume, 0.8));
    this.audio.volume = this.volume;
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

    /* World feed. `worldJoinedAt` is when this stream was tuned in, so the
       player can show how long the city has been on. `failedWorld` remembers
       stations that did not answer and skips them for the rest of the visit. */
    this.worldJoinedAt = 0;
    this.failedWorld = new Set();
    this.worldTimer = null;

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
      if (this.track.world) this.worldJoinedAt = Date.now() - (this.live.offset || 0) * 1000;
    }

    this.bindAudio();
    this.bindMediaSession();

    this.pollTimer = setInterval(() => this.poll(), 500);
    this.applyVolume();
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

    /* Chrome/Safari can fire a stale `ended` for the source that a new
       assignment just aborted. Only a real end (ended === true AND the src of
       the track we think we are playing) may advance the broadcast. */
    a.addEventListener('ended', () => {
      if (!a.ended) return;
      if (a.getAttribute('src') !== this.srcFor(this.track)) return;
      this.handleEnded();
    });

    a.addEventListener('error', () => {
      if (!a.getAttribute('src')) return;
      /* A dead station is routine on the open directory: skip the city, not
         the whole broadcast. */
      if (this.track?.world) {
        this.worldFailed();
        return;
      }
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
    const art = this.artFor(t);
    const type = art.startsWith('data:image/svg') || art.endsWith('.svg') ? 'image/svg+xml' : 'image/jpeg';
    try {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: t.title,
        artist: t.artist,
        album: t.album,
        artwork: [{ src: art, sizes: '512x512', type }]
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
    const world = !!this.track?.world;
    this.dispatchEvent(new CustomEvent('time', {
      detail: {
        position: world ? this.position() : (this.audio.currentTime || 0),
        duration: world
          ? (this.mode === 'live' ? (this.track?.duration || 0) : 0)
          : (this.track?.duration || 0)
      }
    }));
  }

  notice(message) {
    this.dispatchEvent(new CustomEvent('notice', { detail: message }));
  }

  handleEnded() {
    /* A live stream has no end; if one closes its socket, treat it as a drop. */
    if (this.track?.world) {
      this.worldFailed();
      return;
    }
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
        /* Only re-sync to the clock when the segment we are holding has
           actually ended: after a dead station we may already be playing an
           upcoming city, and yanking it back would loop on the dead one. */
        if (!this.entry || (state.entry.key !== this.entry.key && this.entry.endMs <= Date.now())) {
          this.playLive(state.entry, state.offset);
        } else if (this.track?.world) {
          /* No drift correction on a live stream: the encoder is the clock. */
          this.emitTime();
        } else if (this.entry.key === state.entry.key && Math.abs(this.audio.currentTime - state.offset) > 12) {
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
    if (this.mode !== 'live' && this.track) {
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
    if (entry?.track?.world) {
      this.playWorld(entry.track, entry, offset);
      return;
    }
    this.clearWorldTimer();
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

  /* ------------------------------------------------------------ world feed */

  /** Play a live station. With an `entry` it is on the clock; without, hand-tuned. */
  playWorld(track, entry = null, offset = 0) {
    if (!track) return;
    const a = this.audio;
    this.clearWorldTimer();
    this.mode = entry ? 'live' : 'world';
    this.entry = entry || null;
    this.track = track;
    this.started = true;
    this.loading = true;
    this.error = '';
    this.pendingSeek = null;
    this.worldJoinedAt = Date.now() - Math.max(0, offset) * 1000;

    const src = this.srcFor(track);
    if (a.getAttribute('src') !== src) a.src = src;

    this.onTrackChange();
    a.play().then(() => {
      this.loading = false;
      this.emitState();
    }).catch((err) => this.playFailed(err));

    /* A stream that never starts is common enough to plan for: 12 seconds and
       the city is skipped instead of the player sitting on "connecting". */
    this.worldTimer = setTimeout(() => {
      this.worldTimer = null;
      if (!this.playing) this.worldFailed();
    }, 12000);
  }

  clearWorldTimer() {
    if (this.worldTimer) clearTimeout(this.worldTimer);
    this.worldTimer = null;
  }

  /** A station did not answer: remember it and move the broadcast on. */
  worldFailed() {
    this.clearWorldTimer();
    const station = this.track?.station;
    this.loading = false;
    this.playing = false;
    if (station) {
      this.failedWorld.add(station.id);
      this.notice(`${station.name} is off the air — moving on.`);
    }

    if (this.mode !== 'live') {
      this.rejoinLive();
      return;
    }

    const state = getLiveState();
    if (!state) return;
    const from = this.entry && state.entry?.key === this.entry.key
      ? state.queue
      : [state.entry, ...(state.queue || [])];
    const next = from.find((e) => e && !(e.track.world && this.failedWorld.has(e.track.station.id)));
    if (next) {
      this.playLive(next, Math.max(0, (Date.now() - next.startMs) / 1000));
      return;
    }
    this.pause();
    this.notice('The world feed is unreachable right now. Try again in a moment.');
  }

  /**
   * Switch programming (world feed ↔ studio) without leaving the page. The
   * clock keeps running underneath, so the new feed picks up at the offset it
   * would have been at anyway; a paused player stays paused.
   */
  setFeed(source) {
    setLiveSource(source);
    const state = getLiveState();
    if (!state) return false;
    this.live = state;
    if (this.mode === 'personal') return true;   // the clock changes underneath
    if (!this.started) {
      this.entry = state.entry;
      this.track = state.entry.track;
      this.emitState();
      return true;
    }
    if (this.playing) {
      this.playLive(state.entry, state.offset);
      return true;
    }
    /* Paused: show what the new feed is playing, and wait for play. */
    this.mode = 'live';
    this.entry = state.entry;
    this.track = state.entry.track;
    this.emitState();
    return true;
  }

  /** Hand-tune a station; the clock resumes with "Rejoin live". */
  tuneWorld(station) {
    if (!station) return;
    this.failedWorld.delete(station.id);
    this.playWorld(worldTrack(station, 0), null, 0);
    this.notice(`Off the clock — tuned to ${station.name}, ${station.place}.`);
  }

  /** Skip to another city without leaving the world feed. */
  tuneNext() {
    const state = getLiveState(Date.now(), 10);
    const currentId = this.track?.station?.id;
    const pool = [
      ...(state?.entry?.track?.world && state.entry.track.id !== this.track?.id ? [state.entry] : []),
      ...(state?.queue || [])
    ].filter((e) => e.track?.world);
    const next = pool.find((e) => e.track.station.id !== currentId && !this.failedWorld.has(e.track.station.id))
      || pool.find((e) => e.track.station.id !== currentId);
    if (!next) {
      this.rejoinLive();
      return;
    }
    this.playWorld(next.track, null, 0);
    this.notice(`Off the clock — ${next.track.station.name}. Rejoin live any time.`);
  }

  playTrack(track, options = {}) {
    if (track?.world) {
      this.playWorld(track, null, 0);
      return;
    }
    this.clearWorldTimer();
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
    /* A blocked autoplay is not a dead station: stop the watchdog so the city
       is not skipped while the listener has simply not tapped play yet. */
    this.clearWorldTimer();
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
    if (this.track?.world) {
      this.tuneNext();
      return;
    }
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
    if (this.mode !== 'personal') {
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
    if (this.mode !== 'personal' || this.track?.world) return;
    try { this.audio.currentTime = Math.max(0, Number(seconds) || 0); } catch { /* ignore */ }
    this.emitTime();
  }

  /* --------------------------------------------------------------- levels */

  /** The loudness trim for a track or live station, as a linear gain. */
  gainFor(track = this.track) {
    if (!track) return 1;
    const db = track.world
      ? LOUDNESS.stations?.[track.station?.id]
      : LOUDNESS.tracks?.[track.id];
    return dBtoGain(db);
  }

  /** The single place the output level is written. */
  applyVolume() {
    const duck = this.mic?.on ? 0.25 : 1;
    this.audio.volume = clamp01(this.volume * this.gainFor() * duck);
  }

  setVolume(value) {
    this.volume = clamp01(value);
    this.audio.muted = false;
    this.muted = false;
    this.applyVolume();
    write(KEYS.volume, this.volume);
    write(KEYS.muted, false);
    this.emitState();
  }

  adjustVolume(delta) {
    this.setVolume(this.volume + delta);
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
    /* Off the clock but still on a live station, "up next" is the schedule —
       the cities and studio sets the broadcast will reach. */
    if (this.mode === 'live' || this.track?.world) {
      const state = getLiveState(Date.now(), Math.max(count, 6));
      return (state?.queue || []).slice(0, count).map((e) => e.track);
    }
    return this.personalQueue.slice(0, count);
  }

  onTrackChange() {
    if (!this.track) return;
    /* Every track and station carries its own trim, so the handoff between a
       live stream and a studio song stays at one level. */
    this.applyVolume();
    /* Live stations are not library history — "recently played" stays songs. */
    if (!this.track.world) {
      const h = this.history.filter((x) => x.id !== this.track.id);
      h.unshift({ id: this.track.id, at: Date.now() });
      this.history = h.slice(0, 40);
      write(KEYS.history, this.history);
    }
    this.updateSession();
    this.emitState();
    this.dispatchEvent(new CustomEvent('trackchange', { detail: this.track }));
  }

  preloadNext() {
    const next = this.upNext(1)[0];
    if (!next || next.world) return;
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
        url: ''
      };
      this.applyVolume();
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
    this.mic = { on: false, stream: null, ctx: null, recorder: null, chunks: [], url: mic.url || '' };
    this.applyVolume();
    this.notice('Mic closed.');
    this.emitState();
  }

  /* -------------------------------------------------------------- snapshot */

  position() {
    /* A live stream reports 0 or Infinity as currentTime, so its position is
       simply how long this city has been tuned in. */
    if (this.track?.world) return Math.max(0, (Date.now() - this.worldJoinedAt) / 1000);
    if (this.audio.currentTime > 0 && (this.playing || this.started)) return this.audio.currentTime;
    return this.mode === 'live' ? (this.live?.offset || 0) : 0;
  }

  snapshot() {
    const state = getLiveState();
    const program = state?.entry.program || programAt();
    const world = !!this.track?.world;
    return {
      mode: this.mode,
      started: this.started,
      playing: this.playing,
      loading: this.loading,
      error: this.error,
      track: this.track,
      position: this.position(),
      duration: world
        ? (this.mode === 'live' ? (this.track?.duration || 0) : 0)
        : (this.track?.duration || 0),
      world,
      station: world ? this.track.station : null,
      volume: this.volume,
      muted: this.muted,
      favorite: world ? false : this.isFavorite(this.track),
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
