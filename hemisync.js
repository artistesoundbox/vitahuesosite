/*
 * Vitamina Hueso @ Manteca Studios — Hemisync / chakra tone panel (left side).
 *
 * Self-contained sibling of spotify.js: injects its own DOM + styles,
 * mounted on the game page by tools/patch-web-export.mjs after every export.
 *
 *   - Seven chakra rows using the classic solfeggio frequencies
 *     (396/417/528/639/741/852/963 Hz), generated live with Web Audio.
 *   - Optional binaural beat (Alpha/Theta/Delta): a second oscillator in the
 *     RIGHT ear offset a few Hz from the left one — headphones required.
 *   - Volume slider; tones fade in/out to avoid clicks.
 *   - "MUTE GAME MUSIC" runs the same bridge the Spotify widget uses
 *     (window.vhGameMusic), so players can drift on chakra tones alone.
 *
 * Init: initHemisyncPanel() — called by the patcher's mount snippet.
 */
(function () {
  'use strict';

  var CHAKRAS = [
    { hz: 396, name: 'Root',       color: '#e5484d',
      desc: 'Grounding and safety. Eases worry about money, home, belonging.' },
    { hz: 417, name: 'Sacral',     color: '#f07d2e',
      desc: 'Creativity and flow. Loosens old patterns, invites play and desire.' },
    { hz: 528, name: 'Solar Plexus', color: '#e8c93e',
      desc: 'Confidence and willpower. Steadies the stomach-knot of stress.' },
    { hz: 639, name: 'Heart',      color: '#46c46e',
      desc: 'Connection and forgiveness. Softens grief, opens us to others.' },
    { hz: 741, name: 'Throat',     color: '#3ea6e8',
      desc: 'Expression and truth. Helps say what needs saying, cleanly.' },
    { hz: 852, name: 'Third Eye',  color: '#6a5be0',
      desc: 'Intuition and clarity. Clears mental fog, invites insight.' },
    { hz: 963, name: 'Crown',      color: '#b45be0',
      desc: 'Stillness and oneness. The quiet at the top of the breath.' },
  ];
  var BEATS = [
    { label: 'No binaural', hz: 0 },
    { label: 'Alpha · 10 Hz', hz: 10 },
    { label: 'Theta · 6 Hz', hz: 6 },
    { label: 'Delta · 3 Hz', hz: 3 },
  ];
  var KEY_VOL = 'vh_hemisync_vol';
  var KEY_BEAT = 'vh_hemisync_beat';

  /* Nature soundscapes — synthesized live from noise buffers, no files.
     Layerable: any combination can play under (or without) a tone. */
  var NATURE = [
    { id: 'rain',     label: 'Rain' },
    { id: 'ocean',    label: 'Ocean waves' },
    { id: 'stream',   label: 'Forest stream' },
    { id: 'wind',     label: 'Wind' },
    { id: 'fire',     label: 'Campfire' },
    { id: 'crickets', label: 'Night crickets' },
  ];
  var KEY_NVOL = 'vh_hemisync_nvol';
  var nature = {};        // id -> handle { stop(fadeSec) }
  var natMaster = null;

  /* Meditation drones — sustained harmonic beds, synthesized live.
     Layerable like nature; all ride the ambience volume. */
  var DRONES = [
    { id: 'om',      label: 'Om · 136.1 Hz' },
    { id: 'tanpura', label: 'Tanpura' },
    { id: 'earth',   label: 'Deep Earth' },
    { id: 'choir',   label: 'Aether Choir' },
    { id: 'crystal', label: 'Crystal Bowl' },
    { id: 'void',    label: 'The Void' }
  ];
  /* Standalone binaural beats — pure left/right tone pairs offset by the
     target brainwave rate. One at a time (competing beats fight each
     other); headphones required — the beat exists only between the ears. */
  var BEATS2 = [
    { id: 'delta', label: 'Delta · 3 Hz — sleep',       beat: 3 },
    { id: 'theta', label: 'Theta · 6 Hz — meditate',    beat: 6 },
    { id: 'alpha', label: 'Alpha · 10 Hz — calm focus', beat: 10 },
    { id: 'beta',  label: 'Beta · 18 Hz — alert',       beat: 18 },
    { id: 'gamma', label: 'Gamma · 40 Hz — insight',    beat: 40 }
  ];
  var BEAT2_CARRIER = 110;   // Hz in both ears; the offset makes the beat
  var drones = {};
  var beat2 = null, beat2Handle = null;

  var ctx = null;
  var master = null;
  var oscL = null, oscR = null, panL = null, panR = null;
  var activeIdx = -1;
  var gameMuted = false;
  var els = {};

  function css(el, rules) { for (var k in rules) el.style[k] = rules[k]; return el; }
  function load(k, d) { try { var v = localStorage.getItem(k); return v === null ? d : v; } catch (e) { return d; } }
  function save(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* private mode */ } }

  /* Give the keyboard back to the game. Clicking any widget steals focus
     from the Godot canvas, and in web exports the canvas only hears keys
     while focused — ESC/movement went dead until the player clicked the
     game again (the "couldn't go back to the game" bug). After one-shot
     widget actions we blur the control and refocus the canvas, if one
     exists (plain pages have none — the call is a harmless no-op). */
  function backToGame() {
    var c = document.querySelector('canvas');
    if (c && c.focus) { try { c.focus(); } catch (e) { /* not focusable */ } }
  }
  function blurSoon(el) {
    setTimeout(function () {
      if (el && el.blur) { try { el.blur(); } catch (e) { /* ignore */ } }
      backToGame();
    }, 0);
  }

  /* ---------- audio engine ---------- */

  function ensureCtx() {
    if (!ctx) {
      var AC = window.AudioContext || window.webkitAudioContext;
      ctx = new AC();
      master = ctx.createGain();
      master.gain.value = volValue();
      master.connect(ctx.destination);
    }
    if (ctx.state === 'suspended') ctx.resume();
    return ctx;
  }

  function volValue() { return parseInt(els.vol.value, 10) / 100 * 0.22; }

  function startTone(idx) {
    ensureCtx();
    stopTone(true);
    var f = CHAKRAS[idx].hz;
    var beat = BEATS[parseInt(els.beat.value, 10)].hz;

    oscL = ctx.createOscillator();
    oscL.type = 'sine';
    oscL.frequency.value = f;
    panL = ctx.createStereoPanner ? ctx.createStereoPanner() : ctx.createGain();
    if (panL.pan) panL.pan.value = beat > 0 ? -1 : 0;
    oscL.connect(panL).connect(master);

    if (beat > 0) {
      oscR = ctx.createOscillator();
      oscR.type = 'sine';
      oscR.frequency.value = f + beat;
      panR = ctx.createStereoPanner();
      panR.pan.value = 1;
      oscR.connect(panR).connect(master);
    }

    // fade in over 0.8 s (clickless)
    var t = ctx.currentTime;
    master.gain.cancelScheduledValues(t);
    master.gain.setValueAtTime(0.0001, t);
    master.gain.exponentialRampToValueAtTime(Math.max(volValue(), 0.0002), t + 0.8);

    oscL.start();
    if (oscR) oscR.start();
    activeIdx = idx;
    markRows();
    updateDot();
    armTimer();
  }

  function stopTone(fadeSec) {
    if (activeIdx === -1) return;
    var idx = activeIdx;
    activeIdx = -1;
    markRows();
    updateDot();
    // true = instant cut (retune), undefined = normal 0.5 s, number = custom
    var fs = (fadeSec === true) ? 0 : (typeof fadeSec === 'number' ? fadeSec : 0.5);
    if (!ctx) return;
    var t = ctx.currentTime;
    if (fs <= 0) {
      master.gain.cancelScheduledValues(t);
      master.gain.setValueAtTime(0.0001, t);
    } else {
      // fade out, then hard-stop the oscillators
      master.gain.cancelScheduledValues(t);
      master.gain.setValueAtTime(Math.max(master.gain.value, 0.0002), t);
      master.gain.exponentialRampToValueAtTime(0.0001, t + fs);
    }
    var l = oscL, r = oscR;
    oscL = null; oscR = null;
    setTimeout(function () {
      try { if (l) l.stop(); if (r) r.stop(); } catch (e) { /* already stopped */ }
    }, fs * 1000 + 60);
  }

  function retune() {
    // beat selection changed while a tone plays: rebuild the pair
    if (activeIdx !== -1) startTone(activeIdx);
  }

  /* ---------- nature sounds (all synthesized, no files) ---------- */

  function updateDot() {
    if (!els || !els.tabDot) return;
    var any = activeIdx !== -1 || Object.keys(nature).length > 0 ||
              Object.keys(drones).length > 0 || !!beat2;
    els.tabDot.style.display = any ? 'block' : 'none';
  }

  function natVol() {
    var v = parseInt(els.nvol ? els.nvol.value : '55', 10) / 100;
    return v * 0.5;
  }

  var _white = null, _brown = null;
  function white() {
    if (_white) return _white;
    var len = ctx.sampleRate * 2;
    var b = ctx.createBuffer(1, len, ctx.sampleRate);
    var d = b.getChannelData(0);
    for (var i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    _white = b; return b;
  }
  function brown() {
    if (_brown) return _brown;
    var len = ctx.sampleRate * 2;
    var b = ctx.createBuffer(1, len, ctx.sampleRate);
    var d = b.getChannelData(0);
    var last = 0;
    for (var i = 0; i < len; i++) {
      var w = Math.random() * 2 - 1;
      last = (last + 0.02 * w) / 1.02;
      d[i] = last * 3.5;
    }
    _brown = b; return b;
  }
  function loopSrc(buf, out) {
    var s = ctx.createBufferSource();
    s.buffer = buf; s.loop = true;
    s.connect(out); s.start();
    return s;
  }
  /* slow modulation into any AudioParam */
  function lfoOn(hz, depth, param) {
    var o = ctx.createOscillator();
    o.frequency.value = hz;
    var g = ctx.createGain();
    g.gain.value = depth;
    o.connect(g); g.connect(param);
    o.start();
    return [o, g];
  }
  /* one filtered noise hit — droplet, crackle */
  function burst(buf, out, opts) {
    var s = ctx.createBufferSource();
    s.buffer = buf;
    var f = ctx.createBiquadFilter();
    f.type = 'bandpass';
    f.frequency.value = opts.f;
    f.Q.value = opts.q || 1;
    var g = ctx.createGain();
    var t = ctx.currentTime;
    var d = opts.dur;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(opts.g, t + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, t + d);
    s.connect(f); f.connect(g); g.connect(out);
    s.start(t, Math.random() * 1.5, d + 0.05);
    s.stop(t + d + 0.06);
  }

  function natureSound(id) {
    var out = ctx.createGain();
    out.gain.value = 1;
    out.connect(natMaster);
    var nodes = [], timers = [], alive = true;
    function stopTimers() { timers.forEach(clearTimeout); timers = []; }
    /* schedule fn now, then again at random intervals until stopped */
    function again(fn, min, max) {
      if (!alive) return;
      fn();
      timers.push(setTimeout(function () { again(fn, min, max); },
        min + Math.random() * (max - min)));
    }

    if (id === 'rain') {
      var lp = ctx.createBiquadFilter(); lp.type = 'lowpass';
      lp.frequency.value = 1400; lp.Q.value = 0.4;
      var g = ctx.createGain(); g.gain.value = 0.45;
      loopSrc(white(), lp); lp.connect(g); g.connect(out);
      nodes.push(lp, g);
      again(function () {
        burst(white(), out, { f: 3200 + Math.random() * 2600, q: 2.5,
          g: 0.02 + Math.random() * 0.05, dur: 0.03 + Math.random() * 0.04 });
      }, 90, 500);
    } else if (id === 'ocean') {
      var lp2 = ctx.createBiquadFilter(); lp2.type = 'lowpass';
      lp2.frequency.value = 420; lp2.Q.value = 0.5;
      var g2 = ctx.createGain(); g2.gain.value = 0.55;
      loopSrc(brown(), lp2); lp2.connect(g2); g2.connect(out);
      nodes.push(lp2, g2);
      var swell = lfoOn(0.07, 0.4, g2.gain);         // the wave (~14 s swell)
      var sway = lfoOn(0.023, 160, lp2.frequency);   // color drift
      nodes.push(swell[0], swell[1], sway[0], sway[1]);
    } else if (id === 'stream') {
      var bp = ctx.createBiquadFilter(); bp.type = 'bandpass';
      bp.frequency.value = 1600; bp.Q.value = 0.7;
      var g3 = ctx.createGain(); g3.gain.value = 0.4;
      loopSrc(white(), bp); bp.connect(g3); g3.connect(out);
      nodes.push(bp, g3);
      var wob = lfoOn(1.6, 420, bp.frequency);       // babbling wobble
      var wob2 = lfoOn(0.31, 180, bp.frequency);
      nodes.push(wob[0], wob[1], wob2[0], wob2[1]);
    } else if (id === 'wind') {
      var lp3 = ctx.createBiquadFilter(); lp3.type = 'lowpass';
      lp3.frequency.value = 480; lp3.Q.value = 0.6;
      var g4 = ctx.createGain(); g4.gain.value = 0.5;
      loopSrc(brown(), lp3); lp3.connect(g4); g4.connect(out);
      nodes.push(lp3, g4);
      var gust = lfoOn(0.06, 0.3, g4.gain);
      var howl = lfoOn(0.11, 240, lp3.frequency);
      nodes.push(gust[0], gust[1], howl[0], howl[1]);
    } else if (id === 'fire') {
      var lp4 = ctx.createBiquadFilter(); lp4.type = 'lowpass';
      lp4.frequency.value = 320;
      var g5 = ctx.createGain(); g5.gain.value = 0.5;
      loopSrc(brown(), lp4); lp4.connect(g5); g5.connect(out);
      nodes.push(lp4, g5);
      again(function () {
        burst(white(), out, { f: 1400 + Math.random() * 3200, q: 1.2,
          g: 0.05 + Math.random() * 0.22, dur: 0.015 + Math.random() * 0.03 });
      }, 70, 420);
    } else if (id === 'crickets') {
      var lp5 = ctx.createBiquadFilter(); lp5.type = 'lowpass';
      lp5.frequency.value = 180;
      var g6 = ctx.createGain(); g6.gain.value = 0.12;
      loopSrc(brown(), lp5); lp5.connect(g6); g6.connect(out);
      nodes.push(lp5, g6);
      again(function () {
        var f = 4100 + Math.random() * 400;
        var pulses = 3 + (Math.random() < 0.35 ? 1 : 0);
        for (var p = 0; p < pulses; p++) {
          timers.push(setTimeout(function () {
            if (!alive) return;
            var o = ctx.createOscillator();
            o.type = 'sine'; o.frequency.value = f;
            var cg = ctx.createGain();
            var t = ctx.currentTime;
            cg.gain.setValueAtTime(0.0001, t);
            cg.gain.exponentialRampToValueAtTime(0.04 + Math.random() * 0.02, t + 0.006);
            cg.gain.exponentialRampToValueAtTime(0.0001, t + 0.03);
            o.connect(cg); cg.connect(out);
            o.start(); o.stop(t + 0.05);
          }, p * 62));
        }
      }, 500, 1600);
    }

    return {
      stop: function (fadeSec) {
        alive = false;
        stopTimers();
        var fs = typeof fadeSec === 'number' ? fadeSec : 0.25;
        var t = ctx.currentTime;
        out.gain.cancelScheduledValues(t);
        out.gain.setValueAtTime(Math.max(out.gain.value, 0.0002), t);
        out.gain.exponentialRampToValueAtTime(0.0001, t + fs);
        setTimeout(function () {
          nodes.forEach(function (n) { try { n.disconnect(); } catch (e) {} });
          try { out.disconnect(); } catch (e) {}
        }, fs * 1000 + 80);
      }
    };
  }

  function natureToggle(id) {
    ensureCtx();
    if (nature[id]) {
      nature[id].stop();
      delete nature[id];
    } else {
      if (!natMaster) {
        natMaster = ctx.createGain();
        natMaster.gain.value = natVol();
        natMaster.connect(ctx.destination);
      }
      nature[id] = natureSound(id);
    }
    if (els.natChips) markAmbience();
    updateDot();
    armTimer();
  }

  function markAmbience() {
    function mark(list, isActive) {
      (list || []).forEach(function (ch) {
        var on = isActive(ch.id);
        ch.el.style.borderColor = on ? 'rgba(70,196,110,.8)' : 'rgba(120,180,255,.35)';
        ch.el.style.background = on ? 'rgba(16,40,24,.6)' : 'rgba(8,14,24,.6)';
        ch.el.style.boxShadow = on ? '0 0 12px rgba(70,196,110,.35)' : 'none';
      });
    }
    mark(els.natChips, function (id) { return !!nature[id]; });
    mark(els.droneChips, function (id) { return !!drones[id]; });
    mark(els.beatChips, function (id) { return beat2 === id; });
  }

  /* ---------- meditation drones (synthesized, layerable) ---------- */

  function droneSound(id) {
    var out = ctx.createGain();
    out.gain.value = 1;
    out.connect(natMaster);
    var nodes = [], oscs = [];
    function voice(type, freq, g, detuneCents, dest) {
      var o = ctx.createOscillator();
      o.type = type; o.frequency.value = freq;
      if (detuneCents) o.detune.value = detuneCents;
      var vg = ctx.createGain(); vg.gain.value = g;
      o.connect(vg); vg.connect(dest || out);
      o.start();
      nodes.push(vg); oscs.push(o);
      return vg;
    }
    function bed(cut, g) {
      var f = ctx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = cut;
      var ng = ctx.createGain(); ng.gain.value = g;
      loopSrc(brown(), f); f.connect(ng); ng.connect(out);
      nodes.push(f); nodes.push(ng);
      return f;
    }
    function lfo(hz, depth, param) {
      var p = lfoOn(hz, depth, param);
      oscs.push(p[0]); nodes.push(p[1]);
    }

    if (id === 'om') {
      /* the classic 136.1 Hz Om tuning + fifth + octave, chorus-widened,
         breathing slowly like group chant */
      var lp = ctx.createBiquadFilter(); lp.type = 'lowpass';
      lp.frequency.value = 900; lp.connect(out); nodes.push(lp);
      voice('sine', 136.1, 0.42, 0, lp);
      voice('sine', 136.1, 0.34, 4, lp);
      voice('sine', 204.15, 0.22, -3, lp);
      voice('sine', 272.2, 0.14, 2, lp);
      lfo(0.05, 0.12, out.gain);
    } else if (id === 'tanpura') {
      /* sawtooth drone with jawari shimmer — the buzzing overtone bloom */
      var lp2 = ctx.createBiquadFilter(); lp2.type = 'lowpass';
      lp2.frequency.value = 1100; lp2.connect(out); nodes.push(lp2);
      voice('sawtooth', 110, 0.14, 0, lp2);
      voice('sawtooth', 110, 0.12, 5, lp2);
      voice('sawtooth', 165, 0.09, -4, lp2);
      voice('sawtooth', 220, 0.07, 3, lp2);
      var shim = voice('sine', 330, 0.05, 0, lp2);
      lfo(1.1, 0.035, shim.gain);
      lfo(0.07, 220, lp2.frequency);
    } else if (id === 'earth') {
      /* sub-bass planet hum with a rock-deep noise bed */
      voice('sine', 55, 0.5);
      voice('sine', 27.5, 0.3);
      bed(90, 0.22);
      lfo(0.03, 0.18, out.gain);
    } else if (id === 'choir') {
      /* an aetheric held chord — four voices adrift off perfect tuning */
      var lp3 = ctx.createBiquadFilter(); lp3.type = 'lowpass';
      lp3.frequency.value = 1500; lp3.connect(out); nodes.push(lp3);
      [220, 277.18, 329.63, 440].forEach(function (f, i) {
        voice('sine', f, 0.2, (i % 2 ? 3 : -3) + i, lp3);
      });
      lfo(0.02, 0.12, out.gain);
      lfo(0.05, 120, lp3.frequency);
    } else if (id === 'crystal') {
      /* singing-bowl glass: 528 against 529.5 makes a soft internal beat */
      voice('sine', 528, 0.3);
      voice('sine', 529.5, 0.2);
      voice('sine', 1056, 0.07);
      voice('sine', 1584, 0.025);
      lfo(0.08, 0.18, out.gain);
    } else if (id === 'void') {
      /* the bottom of space: 40 Hz plus the faintest moving pressure */
      voice('sine', 40, 0.5);
      voice('sine', 80.3, 0.18);
      bed(60, 0.12);
      lfo(0.015, 0.22, out.gain);
    }

    return {
      stop: function (fadeSec) {
        var fs = typeof fadeSec === 'number' ? fadeSec : 0.4;
        var t = ctx.currentTime;
        out.gain.cancelScheduledValues(t);
        out.gain.setValueAtTime(Math.max(out.gain.value, 0.0002), t);
        out.gain.exponentialRampToValueAtTime(0.0001, t + fs);
        setTimeout(function () {
          oscs.forEach(function (o) { try { o.stop(); } catch (e) { /* done */ } });
          nodes.forEach(function (n) { try { n.disconnect(); } catch (e) { /* gone */ } });
          try { out.disconnect(); } catch (e) { /* gone */ }
        }, fs * 1000 + 80);
      }
    };
  }

  function droneToggle(id) {
    ensureCtx();
    if (drones[id]) {
      drones[id].stop();
      delete drones[id];
    } else {
      if (!natMaster) {
        natMaster = ctx.createGain();
        natMaster.gain.value = natVol();
        natMaster.connect(ctx.destination);
      }
      drones[id] = droneSound(id);
    }
    markAmbience(); updateDot(); armTimer();
  }

  /* ---------- standalone binaural beats (one at a time) ---------- */

  function stopBeat2(fade) {
    if (beat2Handle) {
      var h = beat2Handle;
      beat2Handle = null;
      h.stop(fade);
    }
    beat2 = null;
  }

  function beat2Toggle(id) {
    ensureCtx();
    if (beat2 === id) { stopBeat2(0.3); markAmbience(); updateDot(); return; }
    stopBeat2(0.15);
    if (!natMaster) {
      natMaster = ctx.createGain();
      natMaster.gain.value = natVol();
      natMaster.connect(ctx.destination);
    }
    var spec = null;
    BEATS2.forEach(function (b) { if (b.id === id) spec = b; });
    if (!spec) return;
    var fade = ctx.createGain(); fade.gain.value = 1; fade.connect(natMaster);
    var oL = ctx.createOscillator(); oL.type = 'sine';
    oL.frequency.value = BEAT2_CARRIER;
    var oR = ctx.createOscillator(); oR.type = 'sine';
    oR.frequency.value = BEAT2_CARRIER + spec.beat;
    var pL = ctx.createStereoPanner ? ctx.createStereoPanner() : ctx.createGain();
    var pR = ctx.createStereoPanner ? ctx.createStereoPanner() : ctx.createGain();
    if (pL.pan) pL.pan.value = -1;
    if (pR.pan) pR.pan.value = 1;
    var gL = ctx.createGain(); gL.gain.value = 0.5;
    var gR = ctx.createGain(); gR.gain.value = 0.5;
    oL.connect(pL); pL.connect(gL); gL.connect(fade);
    oR.connect(pR); pR.connect(gR); gR.connect(fade);
    oL.start(); oR.start();
    beat2Handle = {
      stop: function (fs) {
        var t = ctx.currentTime;
        fade.gain.cancelScheduledValues(t);
        fade.gain.setValueAtTime(Math.max(fade.gain.value, 0.0002), t);
        fade.gain.exponentialRampToValueAtTime(0.0001, t + (fs || 0.3));
        setTimeout(function () {
          try { oL.stop(); oR.stop(); } catch (e) { /* done */ }
          [pL, pR, gL, gR, fade].forEach(function (n) {
            try { n.disconnect(); } catch (e) { /* gone */ }
          });
        }, (fs || 0.3) * 1000 + 80);
      }
    };
    beat2 = id;
    markAmbience(); updateDot(); armTimer();
  }

  /* Chips + volume, renderable into any container — the panel mounts it
     inline and hemisync.html reuses the same engine via initNatureChips. */
  function renderNatureUI(container) {
    var lab = document.createElement('div');
    lab.style.cssText = 'font-size:12px;color:#7f9cbd;margin:14px 0 6px;letter-spacing:.14em';
    lab.textContent = 'NATURE SOUNDS · layer with a tone or alone';
    container.appendChild(lab);
    var grid = document.createElement('div');
    grid.style.cssText = 'display:flex;flex-wrap:wrap;gap:7px';
    els.natChips = [];
    NATURE.forEach(function (n) {
      var b = document.createElement('button');
      b.type = 'button';
      b.textContent = n.label;
      b.style.cssText =
        'font:inherit;font-size:12px;letter-spacing:.06em;color:#cfe4ff;cursor:pointer;' +
        'padding:7px 12px;border-radius:999px;background:rgba(8,14,24,.6);' +
        'border:1px solid rgba(120,180,255,.35);transition:all .2s';
      b.addEventListener('click', function () { blurSoon(b); natureToggle(n.id); });
      grid.appendChild(b);
      els.natChips.push({ id: n.id, el: b });
    });
    container.appendChild(grid);

    /* meditation drones */
    var dlab = document.createElement('div');
    dlab.style.cssText = 'font-size:12px;color:#7f9cbd;margin:14px 0 6px;letter-spacing:.14em';
    dlab.textContent = 'MEDITATION DRONES · layer freely';
    container.appendChild(dlab);
    var dgrid = document.createElement('div');
    dgrid.style.cssText = 'display:flex;flex-wrap:wrap;gap:7px';
    els.droneChips = [];
    DRONES.forEach(function (n) {
      var b = document.createElement('button');
      b.type = 'button';
      b.textContent = n.label;
      b.style.cssText =
        'font:inherit;font-size:12px;letter-spacing:.06em;color:#cfe4ff;cursor:pointer;' +
        'padding:7px 12px;border-radius:999px;background:rgba(8,14,24,.6);' +
        'border:1px solid rgba(120,180,255,.35);transition:all .2s';
      b.addEventListener('click', function () { blurSoon(b); droneToggle(n.id); });
      dgrid.appendChild(b);
      els.droneChips.push({ id: n.id, el: b });
    });
    container.appendChild(dgrid);

    /* standalone binaural beats (radio behavior: one at a time) */
    var blab = document.createElement('div');
    blab.style.cssText = 'font-size:12px;color:#7f9cbd;margin:14px 0 6px;letter-spacing:.14em';
    blab.textContent = 'BINAURAL BEATS · headphones required · one at a time';
    container.appendChild(blab);
    var bgrid = document.createElement('div');
    bgrid.style.cssText = 'display:flex;flex-wrap:wrap;gap:7px';
    els.beatChips = [];
    BEATS2.forEach(function (n) {
      var b = document.createElement('button');
      b.type = 'button';
      b.textContent = n.label;
      b.style.cssText =
        'font:inherit;font-size:12px;letter-spacing:.06em;color:#cfe4ff;cursor:pointer;' +
        'padding:7px 12px;border-radius:999px;background:rgba(8,14,24,.6);' +
        'border:1px solid rgba(120,180,255,.35);transition:all .2s';
      b.addEventListener('click', function () { blurSoon(b); beat2Toggle(n.id); });
      bgrid.appendChild(b);
      els.beatChips.push({ id: n.id, el: b });
    });
    container.appendChild(bgrid);

    var nlab = document.createElement('div');
    nlab.style.cssText = 'font-size:12px;color:#7f9cbd;margin:10px 0 6px;letter-spacing:.14em';
    nlab.textContent = 'AMBIENCE VOLUME · nature · drones · beats';
    container.appendChild(nlab);
    var nv = document.createElement('input');
    nv.type = 'range'; nv.min = '0'; nv.max = '100';
    nv.value = load(KEY_NVOL, '55');
    nv.style.cssText = 'width:100%;accent-color:#46c46e';
    nv.addEventListener('input', function () {
      save(KEY_NVOL, nv.value);
      if (natMaster) {
        var t = ctx.currentTime;
        natMaster.gain.cancelScheduledValues(t);
        natMaster.gain.setValueAtTime(Math.max(natMaster.gain.value, 0.0002), t);
        natMaster.gain.exponentialRampToValueAtTime(Math.max(natVol(), 0.0002), t + 0.15);
      }
    });
    nv.addEventListener('change', function () { blurSoon(nv); });
    container.appendChild(nv);
    els.nvol = nv;
  }

  window.initNatureChips = function (mount) {
    if (typeof mount === 'string') mount = document.getElementById(mount);
    if (!mount) return;
    renderNatureUI(mount);
  };

  /* ---------- UI ---------- */

  function markRows() {
    els.rows.forEach(function (row, i) {
      var on = i === activeIdx;
      row.el.style.borderColor = on ? row.c.color : 'rgba(120,180,255,.25)';
      row.el.style.background = on ? 'rgba(20,40,70,.55)' : 'rgba(8,14,24,.45)';
      row.btn.textContent = on ? '■' : '▶';
      row.btn.title = on ? 'Stop tone' : 'Play ' + row.c.hz + ' Hz';
    });
  }

  function initHemisyncPanel() {
    if (document.getElementById('hs-panel')) return;

    /* panel */
    var panel = document.createElement('div');
    panel.id = 'hs-panel';
    css(panel, {
      position: 'fixed', top: '0', left: '-332px', width: '320px', height: '100%',
      zIndex: 60, background: 'rgba(10,14,20,.92)',
      borderRight: '1px solid rgba(120,180,255,.35)',
      transition: 'left .28s ease', overflowY: 'auto', padding: '18px 18px 30px',
      color: '#cfe4ff', font: '14px/1.45 system-ui, sans-serif',
      backdropFilter: 'blur(6px)'
    });

    /* tab (right edge of the left panel) — 44px wide so the ~32px sliver
       left visible when closed is an easy target even mid-flight */
    var tab = document.createElement('div');
    tab.id = 'hs-tab';
    css(tab, {
      position: 'absolute', right: '-44px', top: '46px', width: '44px', height: '150px',
      cursor: 'pointer', background: 'rgba(10,14,20,.9)',
      border: '1px solid rgba(120,180,255,.35)', borderLeft: 'none',
      borderRadius: '0 8px 8px 0', display: 'flex', alignItems: 'center',
      justifyContent: 'center', writingMode: 'vertical-rl',
      letterSpacing: '.25em', fontSize: '13px', color: '#8ec2ff',
      userSelect: 'none'
    });
    tab.textContent = '☸ HEMISYNC';
    var tabDot = document.createElement('div');
    tabDot.id = 'hs-tab-dot';
    css(tabDot, {
      display: 'none', position: 'absolute', top: '8px', left: '50%',
      marginLeft: '-4px', width: '8px', height: '8px', borderRadius: '50%',
      background: '#46c46e', boxShadow: '0 0 8px #46c46e'
    });
    tab.appendChild(tabDot);
    panel.appendChild(tab);
    els.tabDot = tabDot;

    /* header */
    var head = document.createElement('div');
    head.style.cssText = 'display:flex;justify-content:space-between;align-items:center;margin-bottom:4px';
    head.innerHTML = '<b style="letter-spacing:.2em;font-size:15px">HEMISYNC</b>';
    var close = document.createElement('button');
    close.textContent = '✕';
    css(close, {
      background: 'none', border: 'none', color: '#8ec2ff', fontSize: '16px',
      cursor: 'pointer', padding: '4px'
    });
    head.appendChild(close);
    panel.appendChild(head);

    var sub = document.createElement('div');
    sub.textContent = 'Chakra tone therapy · headphones recommended for binaural';
    css(sub, { color: '#7f9cbd', fontSize: '12px', marginBottom: '14px' });
    panel.appendChild(sub);

    /* chakra rows */
    els.rows = [];
    CHAKRAS.forEach(function (c, i) {
      var row = document.createElement('div');
      css(row, {
        display: 'flex', alignItems: 'center', gap: '10px',
        border: '1px solid rgba(120,180,255,.25)', borderRadius: '10px',
        padding: '9px 12px', marginBottom: '8px', cursor: 'pointer',
        background: 'rgba(8,14,24,.45)', transition: 'background .2s,border-color .2s'
      });
      var dot = document.createElement('span');
      css(dot, {
        width: '12px', height: '12px', borderRadius: '50%', flex: 'none',
        background: c.color, boxShadow: '0 0 8px ' + c.color
      });
      var label = document.createElement('span');
      label.style.flex = '1';
      label.innerHTML = c.name + ' <span style="color:#7f9cbd;font-size:12px">· ' + c.hz + ' Hz</span>' +
        '<div style="color:#8aa2c4;font-size:11px;line-height:1.35;margin-top:2px">' + c.desc + '</div>';
      var btn = document.createElement('button');
      css(btn, {
        background: 'none', border: '1px solid rgba(120,180,255,.4)',
        borderRadius: '50%', color: '#cfe4ff', width: '26px', height: '26px',
        cursor: 'pointer', fontSize: '11px', lineHeight: '1'
      });
      row.appendChild(dot); row.appendChild(label); row.appendChild(btn);
      row.addEventListener('click', function () {
        blurSoon(row);
        if (activeIdx === i) { clearTimer(true); stopTone(); } else startTone(i);
      });
      panel.appendChild(row);
      els.rows.push({ el: row, btn: btn, c: c });
    });

    /* binaural select */
    var beatWrap = document.createElement('div');
    beatWrap.style.cssText = 'margin:14px 0 8px';
    beatWrap.innerHTML = '<div style="font-size:12px;color:#7f9cbd;margin-bottom:6px">BINAURAL BEAT (right ear offset)</div>';
    var beat = document.createElement('select');
    beat.id = 'hs-beat';
    css(beat, {
      width: '100%', padding: '8px', borderRadius: '8px',
      background: 'rgba(8,14,24,.6)', color: '#cfe4ff',
      border: '1px solid rgba(120,180,255,.35)', font: 'inherit'
    });
    BEATS.forEach(function (b, i) {
      var o = document.createElement('option');
      o.value = String(i); o.textContent = b.label;
      beat.appendChild(o);
    });
    beat.value = load(KEY_BEAT, '0');
    beat.addEventListener('change', function () { save(KEY_BEAT, beat.value); retune(); blurSoon(beat); });
    beatWrap.appendChild(beat);
    panel.appendChild(beatWrap);
    els.beat = beat;

    /* volume */
    var volWrap = document.createElement('div');
    volWrap.style.cssText = 'margin:10px 0 16px';
    volWrap.innerHTML = '<div style="font-size:12px;color:#7f9cbd;margin-bottom:6px">VOLUME</div>';
    var vol = document.createElement('input');
    vol.id = 'hs-vol';
    vol.type = 'range'; vol.min = '0'; vol.max = '100';
    vol.value = load(KEY_VOL, '85');
    css(vol, { width: '100%', accentColor: '#3ea6e8' });
    vol.addEventListener('input', function () {
      save(KEY_VOL, vol.value);
      if (master && activeIdx !== -1) {
        var t = ctx.currentTime;
        master.gain.cancelScheduledValues(t);
        master.gain.setValueAtTime(Math.max(master.gain.value, 0.0002), t);
        master.gain.exponentialRampToValueAtTime(Math.max(volValue(), 0.0002), t + 0.15);
      }
    });
    vol.addEventListener('change', function () { blurSoon(vol); });
    volWrap.appendChild(vol);
    panel.appendChild(volWrap);
    els.vol = vol;

    /* nature sounds — synthesized, layerable, own volume */
    var natSec = document.createElement('div');
    panel.appendChild(natSec);
    renderNatureUI(natSec);

    /* session timer: 15/30/45 min, gentle fade + chime at the end */
    var tWrap = document.createElement('div');
    tWrap.style.cssText = 'margin:10px 0 4px';
    tWrap.innerHTML = '<div style="font-size:12px;color:#7f9cbd;margin-bottom:6px">SESSION TIMER</div>';
    var tsel = document.createElement('select');
    tsel.id = 'hs-timer';
    css(tsel, {
      width: '100%', padding: '8px', borderRadius: '8px',
      background: 'rgba(8,14,24,.6)', color: '#cfe4ff',
      border: '1px solid rgba(120,180,255,.35)', font: 'inherit'
    });
    [['0', 'Off — plays until I stop it'], ['15', '15 minutes'], ['30', '30 minutes'], ['45', '45 minutes']]
      .forEach(function (o) {
        var op = document.createElement('option');
        op.value = o[0]; op.textContent = o[1];
        tsel.appendChild(op);
      });
    tsel.value = '0';
    tsel.addEventListener('change', function () {
      clearTimer(true);
      if (timerMinutes() > 0) armTimer();
      blurSoon(tsel);
    });
    tWrap.appendChild(tsel);
    var rem = document.createElement('div');
    rem.id = 'hs-timer-rem';
    css(rem, { color: '#8ec2ff', fontSize: '12px', marginTop: '6px', minHeight: '16px' });
    tWrap.appendChild(rem);
    panel.appendChild(tWrap);
    els.timer = tsel;
    els.rem = rem;

    /* game music mute — same bridge the Spotify widget uses */
    var muteBtn = document.createElement('button');
    muteBtn.id = 'hs-mute';
    muteBtn.style.cssText =
      'width:100%;padding:11px;border-radius:999px;cursor:pointer;font:inherit;' +
      'letter-spacing:.14em;background:rgba(8,14,24,.6);color:#cfe4ff;' +
      'border:1px solid rgba(120,180,255,.5);transition:all .2s';
    function muteLabel() {
      muteBtn.textContent = gameMuted ? 'GAME MUSIC: MUTED' : 'MUTE GAME MUSIC';
      muteBtn.style.background = gameMuted ? 'rgba(60,20,24,.6)' : 'rgba(8,14,24,.6)';
      muteBtn.style.borderColor = gameMuted ? 'rgba(229,72,77,.7)' : 'rgba(120,180,255,.5)';
    }
    muteBtn.addEventListener('click', function () {
      blurSoon(muteBtn);
      if (window.vhGameMusic) {
        window.vhGameMusic();
        gameMuted = !gameMuted;
      } else {
        // outside the game (or non-web build): still flip the label so the
        // widget is testable standalone
        gameMuted = !gameMuted;
      }
      muteLabel();
    });
    muteLabel();
    panel.appendChild(muteBtn);

    // The mute button only means something when the Godot bridge exists
    // (inside the exported game). On plain pages (game.html etc.) hide it;
    // a watcher syncs visibility so late engine boots reveal it again.
    function syncMuteVisibility() {
      muteBtn.style.display = (typeof window.vhGameMusic === 'function') ? '' : 'none';
    }
    syncMuteVisibility();
    setInterval(syncMuteVisibility, 2000);

    /* RESUME GAME — a visible, guaranteed way back into a paused game:
       the game only hears ESC while the canvas has focus, and (in web
       builds) mouse clicks no longer resume, so this button closes both
       traps. Uses the same bridge as the right panel's pause button.
       Shown only while the game reports it is paused. */
    var resumeBtn = document.createElement('button');
    resumeBtn.id = 'hs-resume';
    resumeBtn.style.cssText =
      'width:100%;padding:11px;border-radius:999px;cursor:pointer;font:inherit;' +
      'letter-spacing:.14em;margin-top:8px;background:rgba(16,40,24,.6);' +
      'color:#b9f0c8;border:1px solid rgba(70,196,110,.6);transition:all .2s;display:none';
    resumeBtn.textContent = '▶ RESUME GAME';
    resumeBtn.addEventListener('click', function () {
      blurSoon(resumeBtn);
      // bridge semantic: vhGamePause(false) = SET paused=false (resume);
      // no-arg = toggle. Either would work here, but explicit is safer.
      if (typeof window.vhGamePause === 'function') window.vhGamePause(false);
    });
    panel.appendChild(resumeBtn);

    function syncResumeVisibility() {
      var on = (typeof window.vhGamePause === 'function') && window._vhLastPaused === true;
      resumeBtn.style.display = on ? '' : 'none';
    }
    setInterval(syncResumeVisibility, 800);
    syncResumeVisibility();

    /* ESC rescue: Godot receives keys only while its canvas is focused.
       When focus is elsewhere the game never hears ESC — this handler
       refocuses the canvas and resumes on the game's behalf. When the
       canvas IS focused it does nothing (Godot handles the key itself,
       and forwarding would double-toggle straight back to paused). */
    document.addEventListener('keydown', function (e) {
      if (e.key !== 'Escape') return;
      var c = document.querySelector('canvas');
      if (c && document.activeElement === c) return;   // game is listening
      if (c && c.focus) { try { c.focus(); } catch (err) { /* ignore */ } }
      if (window._vhLastPaused === true && typeof window.vhGamePause === 'function') {
        window.vhGamePause(false);   // paused AND deaf: resume for it
      }
    }, true);   // capture: runs before the page's other key handlers

    /* Floating RESUME — the platform-proof way back into a paused game.
       Centered, unmistakable, works regardless of where keyboard focus
       lives, which device the player is on, or how the game was paused.
       Appears only while the game reports PAUSED (it un-pauses via the
       bridge; the game hides it again by pushing its new state). */
    var resumeFlo = document.createElement('button');
    resumeFlo.id = 'vh-resume-float';
    resumeFlo.textContent = '\u25B6 RESUME GAME';
    resumeFlo.style.cssText = [
      'position:fixed', 'left:50%', 'bottom:9%', 'transform:translateX(-50%)',
      'z-index:9998', 'display:none', 'align-items:center',
      'padding:15px 38px', 'border-radius:999px', 'font-size:15px',
      'letter-spacing:0.22em', 'font-family:inherit',
      'color:#eaf7ff', 'background:rgba(16,34,52,0.85)',
      'border:1px solid rgba(110,220,150,0.75)', 'cursor:pointer',
      'box-shadow:0 0 26px rgba(70,196,110,0.35)', 'backdrop-filter:blur(6px)'
    ].join(';');
    resumeFlo.addEventListener('click', function () {
      try { resumeFlo.blur(); } catch (e) { /* ignore */ }
      if (typeof window.vhGamePause === 'function') window.vhGamePause(false);
    });
    document.body.appendChild(resumeFlo);
    function syncResumeFloat() {
      var show = (typeof window.vhGamePause === 'function') && window._vhLastPaused === true;
      resumeFlo.style.display = show ? 'flex' : 'none';
    }
    setInterval(syncResumeFloat, 500);
    syncResumeFloat();

    var tip = document.createElement('div');
    tip.style.cssText = 'color:#6f88a8;font-size:11.5px;margin-top:14px;line-height:1.5';
    tip.textContent = 'Tones, nature, drones and binaural beats are generated live — no files, no loops. ' +
      'Muting the game track frees the soundscape; the Spotify panel on the right plays your own playlist.';
    panel.appendChild(tip);

    /* behaviors */
    tab.addEventListener('click', function () {
      panel.style.left = panel.style.left === '0px' ? '-332px' : '0px';
      blurSoon(tab);   // opening the panel shouldn't strand the game's keyboard
    });
    close.addEventListener('click', function () { panel.style.left = '-332px'; blurSoon(close); });

    /* Any click on the panel's empty space (padding, gaps) also hands the
       keyboard back to the game — a button-less click used to leave focus
       on <body>, and the paused game went deaf to ESC until re-clicked.
       Button handlers refocus anyway; this catches everything else. */
    panel.addEventListener('click', function () { backToGame(); });

    document.body.appendChild(panel);
  }

  /* ---------- session timer + end chime ---------- */

  var timerEnds = 0;   // epoch ms when the session should dissolve (0 = none)
  var timerTick = null;

  function timerMinutes() { return parseInt(els.timer.value, 10) || 0; }

  function armTimer() {
    var m = timerMinutes();
    if (m > 0 && (activeIdx !== -1 || Object.keys(nature).length > 0 ||
        Object.keys(drones).length > 0 || !!beat2) && timerEnds === 0) {
      timerEnds = Date.now() + m * 60000;
      startTick();
    }
  }

  function clearTimer(resetLabel) {
    timerEnds = 0;
    if (resetLabel && els.rem) els.rem.textContent = '';
  }

  function startTick() {
    if (timerTick) return;
    timerTick = setInterval(function () {
      if (timerEnds > 0) {
        var left = timerEnds - Date.now();
        if (left <= 0) { endSession(); return; }
        var s = Math.ceil(left / 1000);
        els.rem.textContent = Math.floor(s / 60) + ':' + ('0' + (s % 60)).slice(-2) + ' remaining';
      } else {
        clearInterval(timerTick);
        timerTick = null;
      }
    }, 500);
  }

  function endSession() {
    clearTimer(false);
    els.rem.textContent = 'session complete ♪';
    setTimeout(function () {
      if (els.rem.textContent.indexOf('complete') !== -1) els.rem.textContent = '';
    }, 6000);
    stopTone(9);                  // long, gentle dissolve
    Object.keys(nature).forEach(function (id) { nature[id].stop(6); });
    nature = {};
    Object.keys(drones).forEach(function (id) { drones[id].stop(6); });
    drones = {};
    if (beat2Handle) { beat2Handle.stop(6); beat2Handle = null; beat2 = null; }
    if (els.natChips) markAmbience();
    updateDot();
    setTimeout(playChime, 4200);  // chime drifts in as the tone fades
  }

  /* Soft three-note singing-bowl chime (no audio files, all synthesized). */
  function playChime() {
    if (!ctx) return;
    var t0 = ctx.currentTime + 0.05;
    [
      { f: 528.0, g: 0.10, at: 0.0 },
      { f: 792.0, g: 0.06, at: 0.35 },
      { f: 1056.0, g: 0.035, at: 0.8 },
    ].forEach(function (n) {
      var o = ctx.createOscillator();
      o.type = 'sine';
      o.frequency.value = n.f;
      var g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, t0 + n.at);
      g.gain.exponentialRampToValueAtTime(n.g, t0 + n.at + 0.04);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + n.at + 2.8);
      o.connect(g).connect(ctx.destination);
      o.start(t0 + n.at);
      o.stop(t0 + n.at + 3.0);
    });
  }

  window.initHemisyncPanel = initHemisyncPanel;
})();
