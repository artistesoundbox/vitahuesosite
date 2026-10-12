// Synthesised combat sound effects plus the provided music tracks and the boot's
// own recorded takes. Every sample is optional: the synthesis stands in for one
// that is missing, so the game never depends on a file being there.

/**
 * Two-track dynamic music.
 *
 * The supplied tracks are used as beds: the first plays through the lulls
 * between waves, the second takes over when there are attackers alive, and the
 * two crossfade rather than cutting.
 */
class MusicDirector {
  constructor(owner) {
    this.owner = owner;
    this.beds = [];
    this.mode = 'calm';
    this.stopped = true;
  }

  start(urls) {
    const list = (urls || []).filter(Boolean);
    if (!list.length) return;
    this.stop();
    this.beds = list.map((url) => {
      const el = new Audio(url);
      el.loop = true;
      el.volume = 0;
      el.preload = 'auto';
      el.muted = this.owner.muted;
      el.play().catch(() => {});
      return el;
    });
    this.mode = 'calm';
    this.stopped = false;
    this.beds[0].volume = this.owner.musicVolume * 0.6;
  }

  setMode(mode) { this.mode = mode; }

  /** Ramp each bed toward its target volume. Cheap enough to call per frame. */
  update(dt) {
    if (this.stopped) return;
    const base = this.owner.musicVolume;
    const combat = this.mode === 'combat';
    for (let i = 0; i < this.beds.length; i++) {
      const el = this.beds[i];
      const target = this.beds.length > 1
        ? (combat ? (i === 1 ? base : 0) : (i === 0 ? base : 0))
        : base;
      const step = dt * base * 1.8;
      if (el.volume < target) el.volume = Math.min(target, el.volume + step);
      else if (el.volume > target) el.volume = Math.max(target, el.volume - step);
    }
  }

  setMuted(muted) {
    for (const el of this.beds) el.muted = muted;
  }

  stop() {
    for (const el of this.beds) {
      try { el.pause(); } catch { /* nothing to do */ }
    }
    this.beds = [];
    this.stopped = true;
  }
}

export class GameAudio {
  constructor() {
    this.ctx = null;
    this.music = new MusicDirector(this);
    this.master = null;
    this.musicVolume = 0.32;
    this.sfxVolume = 0.5;
    this.muted = false;
    // Decoded sample files, by name, and the names that have already been asked
    // for — so a restart does not refetch, and a file that will not decode is not
    // retried on every wave.
    this.samples = Object.create(null);
    this.sampleTried = new Set();
    // The seed for the variation below. Its own generator, never the shared
    // `Math.random`: a sound that takes a draw from the fight's stream is a design
    // change dressed as a sound, and the campaign would no longer be the same run.
    this._seed = 0x9e3779b9;
  }

  /** A cheap xorshift, for take and pitch variation only. */
  rand() {
    let s = this._seed;
    s ^= s << 13; s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5; s >>>= 0;
    this._seed = s;
    return s / 4294967296;
  }

  resume() {
    if (!this.ctx) {
      const Ctor = window.AudioContext || window.webkitAudioContext;
      if (!Ctor) return;
      this.ctx = new Ctor();
      this.master = this.ctx.createGain();
      this.master.gain.value = this.muted ? 0 : 1;
      this.master.connect(this.ctx.destination);
    }
    if (this.ctx.state === 'suspended') this.ctx.resume();
  }

  setMuted(muted) {
    this.muted = muted;
    if (this.master) this.master.gain.value = muted ? 0 : 1;
    this.music.setMuted(muted);
  }

  noiseBuffer(duration = 0.4) {
    const rate = this.ctx.sampleRate;
    const len = Math.max(1, Math.floor(rate * duration));
    const buf = this.ctx.createBuffer(1, len, rate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
    return buf;
  }

  blip(freq, duration, type = 'square', gain = 0.2, slideTo = null) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t);
    if (slideTo) osc.frequency.exponentialRampToValueAtTime(slideTo, t + duration);
    g.gain.setValueAtTime(gain * this.sfxVolume, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + duration);
    osc.connect(g).connect(this.master);
    osc.start(t);
    osc.stop(t + duration + 0.02);
  }

  noise(duration, filterFreq, gain = 0.35, q = 1) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const src = this.ctx.createBufferSource();
    src.buffer = this.noiseBuffer(duration);
    const filter = this.ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = filterFreq;
    filter.Q.value = q;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(gain * this.sfxVolume, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + duration);
    src.connect(filter).connect(g).connect(this.master);
    src.start(t);
    src.stop(t + duration + 0.02);
  }

  /**
   * Fetch and decode the sample files, as [name, url] pairs. These arrive
   * asynchronously while the match is already playable, so anything asked for
   * before its file lands falls back to the synthesis.
   */
  loadSamples(entries) {
    if (!this.ctx) return;
    for (const [name, url] of entries) {
      if (this.sampleTried.has(name)) continue;
      this.sampleTried.add(name);
      fetch(url)
        .then((res) => {
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          return res.arrayBuffer();
        })
        .then((data) => this.ctx.decodeAudioData(data))
        .then((buffer) => { this.samples[name] = buffer; })
        .catch(() => { /* the synthesised version stands in */ });
    }
  }

  /**
   * Play a loaded sample through the same master gain as the synthesis, so mute
   * and the effects volume apply to it. `rate` shifts the take's pitch, which is
   * what keeps a sound played on every kick from sounding like one file on repeat.
   * Returns whether it played at all.
   */
  sample(name, gain = 0.7, rate = 1) {
    const buffer = this.samples[name];
    if (!this.ctx || !buffer) return false;
    const t = this.ctx.currentTime;
    const src = this.ctx.createBufferSource();
    src.buffer = buffer;
    src.playbackRate.value = rate;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(gain * this.sfxVolume, t);
    src.connect(g).connect(this.master);
    src.start(t);
    return true;
  }

  shoot() { this.noise(0.16, 4200, 0.42); this.blip(180, 0.09, 'square', 0.16, 60); }
  enemyShoot() { this.noise(0.14, 2600, 0.2); this.blip(140, 0.08, 'triangle', 0.08, 50); }
  kick() { this.blip(120, 0.22, 'sawtooth', 0.26, 40); this.noise(0.18, 900, 0.3); }
  /**
   * The boot meeting something, laid over the swing on every kick whether it lands
   * or whiffs — the synthesis is already the feel of the kick, this is the sound of
   * it. Nothing to fall back to: `kick()` is the fallback.
   */
  /**
   * A boot take: the named recording played through the tier's voice — its playback
   * rate and gain — with a little variation on top, so a wave of kicks is not one
   * file on repeat. `spread` of 0 plays it true, which is what the sting for taking
   * somebody off the field wants. Nothing is synthesised when the file is missing:
   * there is no `bootpower` the synthesis could stand in for, and the swing already
   * has `kick()` behind it.
   */
  bootTake(name, voice, spread = 0.08) {
    const jitter = 1 + (this.rand() * 2 - 1) * spread;
    return this.sample(name, voice.gain, voice.rate * jitter);
  }
  impact() { this.noise(0.12, 1400, 0.28); this.blip(220, 0.1, 'square', 0.12, 80); }

  /**
   * The scream of someone who has just met the boot: one of the recorded takes if
   * it has loaded, the synthesis if neither has. Two takes picked at random, each
   * pitched a little off the file, so a wave of kicks does not play the same yelp
   * over and over. Nothing is laid under the take: `blip` and `noise` fill their
   * buffers out of `Math.random`, which is the fight's own stream, and the boot is
   * already sounding its swing over this.
   */
  scream() {
    const take = this.rand() < 0.5 ? 'ouch' : 'oua';
    if (this.sample(take, 0.85, 0.94 + this.rand() * 0.12)) return;
    this.blip(760, 0.5, 'sawtooth', 0.2, 170);
    setTimeout(() => this.blip(560, 0.42, 'square', 0.14, 130), 80);
    setTimeout(() => this.blip(380, 0.34, 'triangle', 0.1, 90), 170);
    this.noise(0.34, 1500, 0.16);
  }

  wounded() { this.blip(420, 0.14, 'square', 0.1, 300); }
  // A bullet downing: a slow slump, no boot scream.
  downed() { this.blip(150, 0.5, 'sawtooth', 0.13, 62); this.noise(0.3, 520, 0.16); }
  // The hidden line breaking cover and coming on.
  flush() { this.blip(240, 0.35, 'sawtooth', 0.12, 460); this.blip(180, 0.5, 'triangle', 0.09, 300); }
  hurt() { this.noise(0.2, 700, 0.3); this.blip(90, 0.25, 'sine', 0.2, 50); }
  reload() { this.blip(520, 0.06, 'square', 0.12); setTimeout(() => this.blip(320, 0.08, 'square', 0.12), 220); }
  pickup(type = 'ammo') {
    const base = { ammo: 660, health: 540, reload: 740, charge: 460, rapid: 820, armor: 600 }[type] || 660;
    this.blip(base, 0.08, 'sine', 0.2);
    setTimeout(() => this.blip(base * 1.5, 0.12, 'sine', 0.18), 80);
  }

  // Rifle-style target tune: a short click as the aim takes hold.
  lock() { this.blip(880, 0.05, 'square', 0.09, 1180); }
  // The meter topping out, and the kick that spends it.
  chargeReady() { [520, 660, 880].forEach((f, i) => setTimeout(() => this.blip(f, 0.16, 'triangle', 0.16), i * 85)); }
  chargedKick() {
    this.noise(0.42, 700, 0.4);
    this.blip(88, 0.5, 'sawtooth', 0.32, 30);
    setTimeout(() => this.blip(150, 0.3, 'square', 0.2, 58), 60);
  }
  tierUp() { [440, 587, 740, 880].forEach((f, i) => setTimeout(() => this.blip(f, 0.18, 'triangle', 0.22), i * 110)); }
  waveStart() { [330, 392, 494].forEach((f, i) => setTimeout(() => this.blip(f, 0.3, 'sawtooth', 0.15), i * 140)); }
  gameOver() { [392, 330, 262, 196].forEach((f, i) => setTimeout(() => this.blip(f, 0.5, 'triangle', 0.22), i * 200)); }
  victory() { [523, 659, 784, 1046].forEach((f, i) => setTimeout(() => this.blip(f, 0.45, 'triangle', 0.24), i * 180)); }

  /** Start the dynamic music beds (calm, then combat). */
  playMusic(urls) {
    try { this.music.start(urls); } catch { /* music is optional */ }
  }

  /** Choose the bed from the current threat level. */
  setMusicMode(mode) { this.music.setMode(mode); }

  updateMusic(dt) { this.music.update(dt); }

  stopMusic() { this.music.stop(); }
}
