/**
 * The live player.
 *
 * One <video> element is reused for every channel. hls.js drives MSE where it
 * exists; Safari plays HLS natively. While the full-screen viewer is closed
 * the element sits in a hidden host and the room's television shows it as a
 * texture, so the picture in the room and the picture in the viewer are the
 * same decode — no double bandwidth.
 */

const HLS_MODULE = 'https://unpkg.com/hls.js@1.7.3/dist/hls.mjs';
const START_TIMEOUT = 17000;

let hlsPromise = null;
function loadHls() {
  if (!hlsPromise) {
    hlsPromise = import(HLS_MODULE)
      .then((mod) => mod.default || mod.Hls || null)
      .catch(() => null);
  }
  return hlsPromise;
}

function safeFileName(name) {
  return (name || 'channel')
    .normalize('NFKD')
    .replace(/[^\w.\- ]+/g, '')
    .trim()
    .replace(/\s+/g, '_')
    .slice(0, 60) || 'channel';
}

/** An M3U playlist for one channel, extended with any user-agent VLC needs. */
export function vlcPlaylistFor(channel) {
  const lines = ['#EXTM3U'];
  if (channel.userAgent) lines.push(`#EXTVLCOPT:http-user-agent=${channel.userAgent}`);
  const logo = channel.logo ? ` tvg-logo="${channel.logo.replace(/"/g, '')}"` : '';
  lines.push(`#EXTINF:-1${logo} group-title="${(channel.group || '').replace(/"/g, '')}",${channel.name}`);
  lines.push(channel.url);
  return `${lines.join('\n')}\n`;
}

/**
 * Hand the channel to a desktop player: the browser downloads a one-line
 * playlist, and the OS opens .m3u files in VLC (or whatever is registered).
 */
export function openInVlc(channel) {
  if (!channel) return false;
  const blob = new Blob([vlcPlaylistFor(channel)], { type: 'audio/x-mpegurl' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${safeFileName(channel.name)}.m3u`;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
  return true;
}

export async function copyStreamUrl(channel) {
  if (!channel) return false;
  try {
    await navigator.clipboard.writeText(channel.url);
    return true;
  } catch {
    return false;
  }
}

function describeFailure(detail) {
  const text = String(detail || '');
  if (/427|404|410|manifestLoadError|levelLoadError/i.test(text)) {
    return 'The stream is offline, geo-locked, or refusing this browser (missing CORS headers).';
  }
  if (/time?out/i.test(text)) {
    return 'The stream took too long to answer.';
  }
  if (/MEDIA_ERROR|bufferAppendError|bufferStalledError/i.test(text)) {
    return 'The stream sent a format this browser could not decode.';
  }
  if (/network/i.test(text)) {
    return 'The network dropped this stream.';
  }
  return text || 'The stream could not be opened.';
}

export class LivePlayer {
  constructor() {
    const video = document.createElement('video');
    video.playsInline = true;
    video.setAttribute('playsinline', '');
    video.setAttribute('webkit-playsinline', '');
    video.autoplay = true;
    video.preload = 'auto';
    video.muted = true;
    video.volume = 0.85;
    // Needed so the frames can be uploaded to WebGL as a texture.
    video.crossOrigin = 'anonymous';
    this.video = video;

    this.channel = null;
    this.state = 'idle';
    this.volume = 0.85;

    this._muted = true;
    this._hls = null;
    this._watchdog = 0;
    this._recoveries = 0;
    this._host = null;
    this._listeners = new Map();
    this._token = 0;
    // True only while we expect the current source to be playing. Stops the
    // pause/error events of the source we just tore down from failing the
    // channel we just tuned to.
    this._wantPlaying = false;

    video.addEventListener('playing', () => {
      this._wantPlaying = true;
      this._clearWatchdog();
      this._recoveries = 0;
      this._setState('playing');
    });
    video.addEventListener('pause', () => {
      if (!this._wantPlaying) return;
      this._wantPlaying = false;
      if (this.state === 'playing' || this.state === 'loading') this._setState('paused');
    });
    video.addEventListener('error', () => {
      if (!this._wantPlaying) return;
      const err = video.error;
      if (!err) return;
      this._fail(err.message || `Video error ${err.code}`);
    });
    video.addEventListener('volumechange', () => {
      this.volume = video.volume;
      this._emit('volume', { muted: video.muted, volume: video.volume });
    });
  }

  /** @param {'playing'|'paused'|'loading'|'error'|'idle'} state */
  _setState(state) {
    if (this.state === state) return;
    this.state = state;
    this._emit('state', state);
  }

  _emit(type, payload) {
    const set = this._listeners.get(type);
    if (!set) return;
    for (const fn of [...set]) {
      try {
        fn(payload);
      } catch (err) {
        console.error('[tvroom] listener failed', err);
      }
    }
  }

  on(type, fn) {
    if (!this._listeners.has(type)) this._listeners.set(type, new Set());
    this._listeners.get(type).add(fn);
    return () => this._listeners.get(type).delete(fn);
  }

  _startWatchdog() {
    this._clearWatchdog();
    this._watchdog = window.setTimeout(() => {
      if (this.state !== 'playing') {
        this._fail('The stream did not start in time. Feeds come and go — try another channel or VLC.');
      }
    }, START_TIMEOUT);
  }

  _clearWatchdog() {
    if (this._watchdog) {
      clearTimeout(this._watchdog);
      this._watchdog = 0;
    }
  }

  _teardown() {
    this._wantPlaying = false;
    this._clearWatchdog();
    if (this._hls) {
      try {
        this._hls.destroy();
      } catch {
        /* already gone */
      }
      this._hls = null;
    }
    this.video.pause();
    this.video.removeAttribute('src');
    try {
      this.video.load();
    } catch {
      /* nothing to reset */
    }
  }

  _fail(message) {
    this._clearWatchdog();
    this._setState('error');
    this._emit('error', { message, channel: this.channel });
  }

  async _attemptAutoplay() {
    this._wantPlaying = true;
    try {
      await this.video.play();
    } catch (err) {
      if (err && err.name === 'NotAllowedError') {
        this._setState('paused');
        this._emit('blocked');
        return;
      }
      this._fail(describeFailure(err && err.message));
    }
  }

  _onHlsError(data, Hls) {
    if (!data || !data.fatal) return;
    const type = data.type;
    if (type === Hls.ErrorTypes.NETWORK_ERROR && this._recoveries < 1) {
      this._recoveries += 1;
      try {
        this._hls.startLoad();
        return;
      } catch {
        /* fall through */
      }
    }
    if (type === Hls.ErrorTypes.MEDIA_ERROR && this._recoveries < 1) {
      this._recoveries += 1;
      try {
        this._hls.recoverMediaError();
        return;
      } catch {
        /* fall through */
      }
    }
    this._fail(describeFailure(data.details || type));
  }

  /**
   * Tune to a channel. Always resolved; failures arrive through the 'error'
   * event so the UI can offer retry, next channel or VLC.
   */
  async play(channel) {
    if (!channel) return;
    const token = ++this._token;
    this.channel = channel;
    this._recoveries = 0;
    this._teardown();
    this._setState('loading');
    this._emit('channel', channel);

    const Hls = await loadHls();
    if (token !== this._token) return;

    const nativeHls = this.video.canPlayType('application/vnd.apple.mpegurl') !== '';

    if (Hls && Hls.isSupported()) {
      const hls = new Hls({
        enableWorker: true,
        lowLatencyMode: false,
        backBufferLength: 30,
        maxBufferLength: 22,
        manifestLoadingTimeOut: 15000,
        manifestLoadingMaxRetry: 1,
        fragLoadingTimeOut: 20000,
        fragLoadingMaxRetry: 3,
      });
      this._hls = hls;
      hls.on(Hls.Events.ERROR, (_evt, data) => this._onHlsError(data, Hls));
      hls.on(Hls.Events.MANIFEST_PARSED, () => {
        if (token === this._token) this._attemptAutoplay();
      });
      hls.loadSource(channel.url);
      hls.attachMedia(this.video);
    } else if (nativeHls) {
      this.video.src = channel.url;
      this._attemptAutoplay();
    } else {
      this._fail('This browser has no HLS support. Open the channel in VLC instead.');
      return;
    }

    this._startWatchdog();
  }

  toggle() {
    if (!this.channel) return;
    if (this.state === 'error') {
      this.play(this.channel);
      return;
    }
    if (this.video.paused) {
      this._attemptAutoplay();
    } else {
      this._wantPlaying = false;
      this.video.pause();
    }
  }

  retry() {
    if (this.channel) this.play(this.channel);
  }

  setMuted(muted) {
    this._muted = muted;
    this.video.muted = muted;
  }

  get muted() {
    return this.video.muted;
  }

  setVolume(value) {
    const v = Math.max(0, Math.min(1, Number(value) || 0));
    this.volume = v;
    this.video.volume = v;
    if (v > 0 && this.video.muted) this.setMuted(false);
  }

  /** Move the video element into a container (or the hidden room host). */
  mount(host) {
    if (!host) return;
    this._host = host;
    if (this.video.parentElement !== host) host.appendChild(this.video);
  }

  get host() {
    return this._host;
  }
}
