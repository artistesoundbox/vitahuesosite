// Synthesised combat sound effects plus the provided music tracks.
// No external audio files are required for the effects themselves.

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

  shoot() { this.noise(0.16, 4200, 0.42); this.blip(180, 0.09, 'square', 0.16, 60); }
  enemyShoot() { this.noise(0.14, 2600, 0.2); this.blip(140, 0.08, 'triangle', 0.08, 50); }
  kick() { this.blip(120, 0.22, 'sawtooth', 0.26, 40); this.noise(0.18, 900, 0.3); }
  impact() { this.noise(0.12, 1400, 0.28); this.blip(220, 0.1, 'square', 0.12, 80); }

  /** The scream of someone who has just met the boot. */
  scream() {
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
  pickup() { this.blip(660, 0.08, 'sine', 0.2); setTimeout(() => this.blip(990, 0.12, 'sine', 0.18), 80); }
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
