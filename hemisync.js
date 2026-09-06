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
    { hz: 396, name: 'Root',       color: '#e5484d' },
    { hz: 417, name: 'Sacral',     color: '#f07d2e' },
    { hz: 528, name: 'Solar Plexus', color: '#e8c93e' },
    { hz: 639, name: 'Heart',      color: '#46c46e' },
    { hz: 741, name: 'Throat',     color: '#3ea6e8' },
    { hz: 852, name: 'Third Eye',  color: '#6a5be0' },
    { hz: 963, name: 'Crown',      color: '#b45be0' },
  ];
  var BEATS = [
    { label: 'No binaural', hz: 0 },
    { label: 'Alpha · 10 Hz', hz: 10 },
    { label: 'Theta · 6 Hz', hz: 6 },
    { label: 'Delta · 3 Hz', hz: 3 },
  ];
  var KEY_VOL = 'vh_hemisync_vol';
  var KEY_BEAT = 'vh_hemisync_beat';

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
    els.tabDot.style.display = 'block';
    armTimer();
  }

  function stopTone(fadeSec) {
    if (activeIdx === -1) return;
    var idx = activeIdx;
    activeIdx = -1;
    markRows();
    els.tabDot.style.display = 'none';
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
      label.innerHTML = c.name + ' <span style="color:#7f9cbd;font-size:12px">· ' + c.hz + ' Hz</span>';
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

    var tip = document.createElement('div');
    tip.style.cssText = 'color:#6f88a8;font-size:11.5px;margin-top:14px;line-height:1.5';
    tip.textContent = 'Tones are generated live (pure sine, no files). Muting the game track ' +
      'frees the soundscape; the Spotify panel on the right plays your own playlist.';
    panel.appendChild(tip);

    /* behaviors */
    tab.addEventListener('click', function () {
      panel.style.left = panel.style.left === '0px' ? '-332px' : '0px';
      blurSoon(tab);   // opening the panel shouldn't strand the game's keyboard
    });
    close.addEventListener('click', function () { panel.style.left = '-332px'; blurSoon(close); });

    document.body.appendChild(panel);
  }

  /* ---------- session timer + end chime ---------- */

  var timerEnds = 0;   // epoch ms when the session should dissolve (0 = none)
  var timerTick = null;

  function timerMinutes() { return parseInt(els.timer.value, 10) || 0; }

  function armTimer() {
    var m = timerMinutes();
    if (m > 0 && activeIdx !== -1 && timerEnds === 0) {
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
